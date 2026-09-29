import type { IncomingMessage } from "node:http"
import { Flag } from "@opencode-ai/core/flag/flag"

/**
 * Optional URL prefix (e.g. `/code`) for serving the web UI and API behind a
 * reverse proxy that mounts this server under a sub-path.
 *
 * Requests arriving with the prefix have it stripped before routing, and
 * requests without it are routed unchanged, so both prefix-preserving and
 * prefix-stripping proxies work. The web UI learns the prefix from the
 * `<base href>` rewritten into its index.html.
 */
export function normalize(value: string | undefined) {
  const trimmed = value?.trim().replace(/\/+$/, "") ?? ""
  if (!trimmed) return ""
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

export function current() {
  return normalize(Flag.OPENCODE_BASE_PATH)
}

export function strip(url: string, base: string) {
  if (!base) return url
  if (url === base) return "/"
  if (url.startsWith(`${base}/`)) return url.slice(base.length)
  if (url.startsWith(`${base}?`)) return `/${url.slice(base.length)}`
  return url
}

/** Registers ahead of the HTTP framework so routing and websocket upgrades both see the stripped path. */
export function install(server: { prependListener(event: "request" | "upgrade", fn: (req: IncomingMessage) => void): unknown }) {
  const base = current()
  if (!base) return
  const rewrite = (req: IncomingMessage) => {
    req.url = strip(req.url ?? "/", base)
  }
  server.prependListener("request", rewrite)
  server.prependListener("upgrade", rewrite)
}

export function rewriteHtml(body: string, base: string) {
  if (!base) return body
  return body.replace(/<base\s+href=(["'])\/\1/i, `<base href=$1${base}/$1`)
}

export * as BasePath from "./base-path"
