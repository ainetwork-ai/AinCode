import { homedir } from "node:os"
import { join } from "node:path"

const env = process.env

function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback
}

export interface GatewayConfig {
  /** Where nginx reaches the gateway. Never a public interface. */
  host: string
  port: number
  /** The URL prefix AinCode is served under; must match OPENCODE_BASE_PATH in the image. */
  basePath: string
  /** The ainize web server. Every ainize call goes through it, with the person's own cookies, as the browser would. */
  ainize: string
  /** Keys, per-person container passwords and the unix sockets. Keep the path short: a socket path is ≤ 107 bytes. */
  stateDir: string
  image: string
  /** A workspace nobody has touched for this long is stopped (its files stay in its volume). */
  idleMs: number
  /** At most this many workspaces run at once; starting one more stops the least recently used. */
  maxRunning: number
  memory: string
  cpus: string
  pids: number
  /** e.g. `runsc` for gVisor, when it is installed. Empty: docker's default. */
  runtime: string
  /** The models the relay lets a workspace call. The first is used when a request names none. */
  models: string[]
  startTimeoutMs: number
  keyLabel: string
}

export function loadConfig(): GatewayConfig {
  return {
    host: env.AINCODE_GATEWAY_HOST ?? "127.0.0.1",
    port: num(env.AINCODE_GATEWAY_PORT, 3950),
    basePath: (env.AINCODE_BASE_PATH ?? "/code").replace(/\/+$/, ""),
    ainize: (env.AINIZE_WEB_URL ?? "http://127.0.0.1:3900").replace(/\/+$/, ""),
    stateDir: env.AINCODE_STATE_DIR ?? join(homedir(), ".aincode-gateway"),
    image: env.AINCODE_IMAGE ?? "aincode-sandbox:latest",
    idleMs: num(env.AINCODE_IDLE_MS, 30 * 60_000),
    maxRunning: num(env.AINCODE_MAX_RUNNING, 10),
    memory: env.AINCODE_MEMORY ?? "2g",
    cpus: env.AINCODE_CPUS ?? "2",
    pids: num(env.AINCODE_PIDS, 512),
    runtime: env.AINCODE_DOCKER_RUNTIME ?? "",
    models: (env.AINCODE_MODELS ?? "Qwen3.8-Flash-Next")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    startTimeoutMs: num(env.AINCODE_START_TIMEOUT_MS, 90_000),
    keyLabel: env.AINCODE_KEY_LABEL ?? "aincode",
  }
}
