#!/usr/bin/env node
/**
 * PID 1's child in an aincode-sandbox container (docker runs it under --init).
 *
 * The container is started with `--network none`: no interface but loopback. Two unix sockets in the bind-mounted
 * /run/aincode are its only connection to anything, and both are the gateway's:
 *
 *   in.sock   created HERE. The gateway connects to it to reach AinCode, which listens on 127.0.0.1:4096.
 *   out.sock  created by the GATEWAY. Everything inside that wants the model or the ainize API talks plain HTTP to
 *             127.0.0.1:4097, and this file pipes those connections to out.sock. The gateway adds the person's
 *             credentials on its side; nothing in here ever holds them.
 *
 * Both directions are byte pipes, so HTTP streaming (SSE) and WebSocket upgrades pass through untouched.
 */
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import net from "node:net"

const RUN = process.env.AINCODE_RUN_DIR || "/run/aincode"
const IN_SOCK = `${RUN}/in.sock`
const OUT_SOCK = `${RUN}/out.sock`
const APP_PORT = 4096
const EGRESS_PORT = 4097
const WORKSPACE = process.env.AINIZE_AGENTS_DIR || "/home/aincode/agents"

function pipe(a, b) {
  a.on("error", () => b.destroy())
  b.on("error", () => a.destroy())
  a.pipe(b)
  b.pipe(a)
}

function prepareWorkspace() {
  mkdirSync(WORKSPACE, { recursive: true })
  // AinCode snapshots and undo work on git; a workspace that is a repository also gives the person history. It needs
  // one commit: AinCode names a project after its first commit, and without one the workspace is not a project.
  if (!existsSync(`${WORKSPACE}/.git`)) {
    const git = (...args) => spawnSync("git", ["-C", WORKSPACE, ...args], { stdio: "inherit" })
    spawnSync("git", ["init", "-q", "-b", "main", WORKSPACE], { stdio: "inherit" })
    git("config", "user.name", "AinCode")
    git("config", "user.email", "aincode@ainize.ai")
    writeFileSync(
      `${WORKSPACE}/README.md`,
      "# My ainize agents\n\nEach folder here is one agent. `ainize-agents list` shows what you can manage;\n" +
        "`ainize-agents pull --all` brings them here; `ainize-agents push <id>` deploys a change.\n",
    )
    git("add", "README.md")
    git("commit", "-q", "-m", "Start the workspace")
  }
}

/** Open the workspace as a project once, so the web UI lists it instead of starting empty. */
async function registerProject() {
  const base = process.env.OPENCODE_BASE_PATH || ""
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  const auth = "Basic " + Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD || ""}`).toString("base64")
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}${base}/project/current`, {
        headers: { authorization: auth, "x-opencode-directory": WORKSPACE },
      })
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
}

function listen(server, target, label) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(target, () => {
      console.error(`[sandbox] ${label} listening on ${typeof target === "string" ? target : `127.0.0.1:${target.port}`}`)
      resolve()
    })
  })
}

prepareWorkspace()

// Inbound: gateway → in.sock → AinCode.
if (existsSync(IN_SOCK)) unlinkSync(IN_SOCK)
const inbound = net.createServer((sock) => pipe(sock, net.connect(APP_PORT, "127.0.0.1")))
await listen(inbound, IN_SOCK, "inbound")
chmodSync(IN_SOCK, 0o600)

// Outbound: anything here → 127.0.0.1:4097 → out.sock → gateway.
const outbound = net.createServer((sock) => pipe(sock, net.connect(OUT_SOCK)))
await listen(outbound, { port: EGRESS_PORT, host: "127.0.0.1" }, "egress")

const app = spawn("aincode", ["serve", "--hostname", "127.0.0.1", "--port", String(APP_PORT)], {
  cwd: WORKSPACE,
  stdio: "inherit",
  env: process.env,
})
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => app.kill(sig))
void registerProject()
app.on("exit", (code, signal) => {
  inbound.close()
  outbound.close()
  try {
    unlinkSync(IN_SOCK)
  } catch {}
  process.exit(code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1))
})
