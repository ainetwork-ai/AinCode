/**
 * One container per person, started on demand, stopped when idle, its files kept in a volume.
 *
 *   container  aincode-<hash>          hash = sha256(principal)[0:12]
 *   volume     aincode-home-<hash>     /home/aincode — the workspace, AinCode's data, git history
 *   run dir    <state>/run/<hash>      bind-mounted at /run/aincode: in.sock (the container's) and out.sock (ours)
 *
 * The container gets `--network none`: not even Docker's bridge, so it cannot reach this host's services
 * (a bridge network — even an `--internal` one — still reaches every port the host binds on 0.0.0.0 through the
 * bridge gateway address). The two sockets are the only way in or out.
 */
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { join } from "node:path"
import type { GatewayConfig } from "./config.ts"
import { docker, dockerOk } from "./docker.ts"
import { principalHash } from "./identity.ts"

export const SANDBOX_USER = "aincode"
const BASE_LABEL = "ainize.aincode"

export interface Sandbox {
  hash: string
  principal: string
  name: string
  runDir: string
  inSock: string
  outSock: string
  password: string
  lastActive: number
  running: boolean
  /** Open browser connections (requests, event streams, terminals). A workspace with any is not idle. */
  open: number
}

export class Sandboxes {
  private readonly cfg: GatewayConfig
  private readonly beforeStart: (sb: Sandbox) => Promise<void>
  private all = new Map<string, Sandbox>()
  private starting = new Map<string, Promise<Sandbox>>()
  private sweeper: NodeJS.Timeout | undefined

  /** Docker label, container-name and volume-name prefix — namespaced by `cfg.instance`. */
  private get label() {
    return this.cfg.instance ? `${BASE_LABEL}.${this.cfg.instance}` : BASE_LABEL
  }
  private get prefix() {
    return this.cfg.instance ? `aincode-${this.cfg.instance}-` : "aincode-"
  }

  /** `beforeStart` makes sure out.sock is listening before the container can try to use it. */
  constructor(cfg: GatewayConfig, beforeStart: (sb: Sandbox) => Promise<void>) {
    this.cfg = cfg
    this.beforeStart = beforeStart
  }

  private secretFile(hash: string) {
    return join(this.cfg.stateDir, "secrets", hash)
  }

  private entry(principal: string): Sandbox {
    const hash = principalHash(principal)
    let sb = this.all.get(hash)
    if (sb) return sb
    const runDir = join(this.cfg.stateDir, "run", hash)
    const secret = this.secretFile(hash)
    let password: string
    if (existsSync(secret)) password = readFileSync(secret, "utf8").trim()
    else {
      password = randomBytes(24).toString("base64url")
      writeFileSync(secret, password, { mode: 0o600 })
    }
    sb = {
      hash,
      principal,
      name: `${this.prefix}${hash}`,
      runDir,
      inSock: join(runDir, "in.sock"),
      outSock: join(runDir, "out.sock"),
      password,
      lastActive: Date.now(),
      running: false,
      open: 0,
    }
    this.all.set(hash, sb)
    return sb
  }

  /** Pick up containers left running by a previous gateway process. */
  async boot() {
    for (const d of ["run", "secrets"]) mkdirSync(join(this.cfg.stateDir, d), { recursive: true, mode: 0o700 })
    chmodSync(this.cfg.stateDir, 0o700)
    const out = await dockerOk(["ps", "-a", "--filter", `label=${this.label}=1`, "--format", `{{.Names}}\t{{.State}}\t{{.Label "${this.label}.principal"}}`])
    for (const line of out.split("\n").filter(Boolean)) {
      const [, state, principal] = line.split("\t")
      if (!principal) continue
      const sb = this.entry(principal)
      sb.running = state === "running"
      if (sb.running) await this.beforeStart(sb)
    }
    this.sweeper = setInterval(() => void this.sweep(), 30_000)
    this.sweeper.unref()
  }

  stopSweeper() {
    if (this.sweeper) clearInterval(this.sweeper)
  }

  list(): Sandbox[] {
    return [...this.all.values()]
  }

  get(principal: string): Sandbox | undefined {
    return this.all.get(principalHash(principal))
  }

  touch(sb: Sandbox) {
    sb.lastActive = Date.now()
  }

  isStarting(principal: string) {
    return this.starting.has(principalHash(principal))
  }

  /** The person's running, healthy workspace — started (or restarted) when it is not. */
  ensure(principal: string): Promise<Sandbox> {
    const sb = this.entry(principal)
    this.touch(sb)
    if (sb.running) return Promise.resolve(sb)
    let p = this.starting.get(sb.hash)
    if (!p) {
      p = this.start(sb).finally(() => this.starting.delete(sb.hash))
      this.starting.set(sb.hash, p)
    }
    return p
  }

  /** A request failed on a container we believed was up: re-check before the next one. */
  async recheck(sb: Sandbox) {
    const state = await docker(["inspect", "-f", "{{.State.Running}}", sb.name])
    sb.running = state.code === 0 && state.stdout.trim() === "true" && (await this.healthy(sb))
  }

  private async start(sb: Sandbox): Promise<Sandbox> {
    await this.makeRoom(sb)
    mkdirSync(sb.runDir, { recursive: true, mode: 0o700 })
    await this.beforeStart(sb)
    const inspect = await docker(["inspect", "-f", "{{.State.Running}}", sb.name])
    if (inspect.code === 0) {
      if (inspect.stdout.trim() !== "true") await dockerOk(["start", sb.name])
    } else {
      await dockerOk(this.runArgs(sb))
    }
    const until = Date.now() + this.cfg.startTimeoutMs
    while (Date.now() < until) {
      if (await this.healthy(sb)) {
        sb.running = true
        this.touch(sb)
        return sb
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    const logs = await docker(["logs", "--tail", "30", sb.name])
    throw new Error(`workspace ${sb.name} did not become healthy in ${this.cfg.startTimeoutMs} ms\n${logs.stdout}${logs.stderr}`)
  }

  runArgs(sb: Sandbox): string[] {
    const c = this.cfg
    return [
      "run", "-d",
      "--name", sb.name,
      "--hostname", "aincode",
      "--label", `${this.label}=1`,
      "--label", `${this.label}.principal=${sb.principal}`,
      "--network", "none",
      "--init",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", "/tmp:rw,exec,nosuid,size=1g",
      "--pids-limit", String(c.pids),
      "--memory", c.memory,
      "--memory-swap", c.memory,
      "--cpus", c.cpus,
      "--user", "1000:1000",
      "-v", `${this.prefix}home-${sb.hash}:/home/aincode`,
      "-v", `${sb.runDir}:/run/aincode`,
      "-e", `OPENCODE_SERVER_USERNAME=${SANDBOX_USER}`,
      "-e", `OPENCODE_SERVER_PASSWORD=${sb.password}`,
      "-e", `OPENCODE_BASE_PATH=${c.basePath}`,
      ...(c.runtime ? ["--runtime", c.runtime] : []),
      c.image,
    ]
  }

  authHeader(sb: Sandbox) {
    return "Basic " + Buffer.from(`${SANDBOX_USER}:${sb.password}`).toString("base64")
  }

  healthy(sb: Sandbox): Promise<boolean> {
    return new Promise((resolve) => {
      const req = request(
        {
          socketPath: sb.inSock,
          path: `${this.cfg.basePath}/global/health`,
          headers: { authorization: this.authHeader(sb), host: "aincode" },
          timeout: 2000,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        },
      )
      req.on("error", () => resolve(false))
      req.on("timeout", () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }

  async stop(sb: Sandbox, why: string) {
    sb.running = false
    console.log(`[sandbox] stopping ${sb.name} (${why})`)
    await docker(["stop", "-t", "10", sb.name], 60_000)
  }

  private async makeRoom(except: Sandbox) {
    const running = [...this.all.values()].filter((s) => s.running && s !== except)
    running.sort((a, b) => a.lastActive - b.lastActive)
    while (running.length >= this.cfg.maxRunning) await this.stop(running.shift()!, "too many running")
  }

  async sweep() {
    const now = Date.now()
    for (const sb of this.all.values()) {
      if (sb.running && sb.open === 0 && now - sb.lastActive > this.cfg.idleMs) await this.stop(sb, "idle")
    }
  }
}
