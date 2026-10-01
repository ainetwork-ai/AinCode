/**
 * What nginx sends to: `/code/*` from browsers. Every request is signed in by ainize (identity.ts), then proxied
 * to that person's own workspace over its in.sock — HTTP, server-sent events and WebSocket upgrades alike.
 *
 * On the way in, the browser's ainize cookies and any Authorization header are removed (the workspace must never
 * hold the person's ainize session), and the workspace's own Basic auth is added. On the way out,
 * `www-authenticate` is removed so a browser never shows a password prompt for the inner server.
 */
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import net from "node:net"
import type { Duplex } from "node:stream"
import type { GatewayConfig } from "./config.ts"
import type { Sessions } from "./egress.ts"
import { IdentityResolver, withoutAinizeCookies, type Identity } from "./identity.ts"
import { GalleryBuilder } from "./gallery.ts"
import { galleryAiPage } from "./gallery-ai-page.ts"
import { galleryPage } from "./gallery-page.ts"
import { AgentBuilder } from "./builder.ts"
import { errorPage, signInPage, startingPage } from "./pages.ts"
import type { Sandbox, Sandboxes } from "./sandboxes.ts"

const HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
])

export function inboundHeaders(headers: IncomingHttpHeaders, auth: string, upgrade: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue
    const key = k.toLowerCase()
    if (key === "cookie" || key === "authorization") continue
    if (HOP.has(key) && !(upgrade && (key === "connection" || key === "upgrade"))) continue
    out[key] = v
  }
  const cookie = withoutAinizeCookies(headers.cookie)
  if (cookie) out.cookie = cookie
  out.authorization = auth
  return out
}

function wantsPage(req: IncomingMessage) {
  return (req.method === "GET" || req.method === "HEAD") && String(req.headers.accept ?? "").includes("text/html")
}

/** Requests that change things, and WebSocket handshakes, must come from ainize.ai's own pages. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim()
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  res.end(body)
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

export class PublicProxy {
  private readonly gallery: GalleryBuilder
  private readonly builder: AgentBuilder
  private readonly cfg: GatewayConfig
  private readonly ids: IdentityResolver
  private readonly boxes: Sandboxes
  private readonly sessions: Sessions

  constructor(cfg: GatewayConfig, ids: IdentityResolver, boxes: Sandboxes, sessions: Sessions) {
    this.gallery = new GalleryBuilder(cfg)
    this.builder = new AgentBuilder(cfg)
    this.cfg = cfg
    this.ids = ids
    this.boxes = boxes
    this.sessions = sessions
  }

  server(): Server {
    const server = createServer((req, res) => {
      this.onRequest(req, res).catch((e) => {
        console.error("[public]", e)
        if (!res.headersSent) json(res, 502, { error: "workspace gateway error" })
        else res.destroy()
      })
    })
    server.on("upgrade", (req, socket, head) => {
      this.onUpgrade(req, socket, head).catch((e) => {
        console.error("[public upgrade]", e)
        socket.destroy()
      })
    })
    server.requestTimeout = 0
    server.headersTimeout = 60_000
    return server
  }

  private inPrefix(url: string) {
    const base = this.cfg.basePath
    return url === base || url.startsWith(base + "/") || url.startsWith(base + "?")
  }

  private async who(req: IncomingMessage): Promise<Identity | null> {
    const id = await this.ids.identify(req.headers.cookie)
    if (id) this.sessions.set(id.principal, id.cookie)
    return id
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? "/"
    if (!this.inPrefix(url)) return json(res, 404, { error: "not found" })
    if (url === this.cfg.basePath || url.startsWith(this.cfg.basePath + "?")) {
      res.writeHead(302, { location: this.cfg.basePath + "/" + url.slice(this.cfg.basePath.length) })
      return res.end()
    }
    if (new URL(url, "http://gateway").pathname === this.cfg.basePath + "/_builder/mcp/tool") return this.builder.mcpTool(req, res)
    if (new URL(url, "http://gateway").pathname === this.cfg.basePath + "/_builder/drive/tool") return this.builder.driveTool(req, res)
    if (this.gallery.image(req, res)) return
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" })
    const id = await this.who(req)
    if (!id) {
      if (wantsPage(req)) return html(res, 200, signInPage(this.cfg.basePath, url))
      return json(res, 401, { error: "sign in to ainize first" })
    }
    const target = new URL(url, "http://gateway")
    if (req.method === "GET" && target.pathname === this.cfg.basePath + "/builder" && target.searchParams.has("gallery")) return html(res, 200, galleryAiPage(this.cfg.basePath, this.cfg.workspaceDir, target.searchParams.get("description") ?? ""))
    if (req.method === "GET" && url === this.cfg.basePath + "/" && wantsPage(req)) return html(res, 200, galleryPage(this.cfg.basePath, this.cfg.workspaceDir))
    if (req.method === "GET" && new URL(url, "http://gateway").pathname === this.cfg.basePath + "/gallery") return html(res, 200, galleryPage(this.cfg.basePath, this.cfg.workspaceDir))
    if (url.startsWith(this.cfg.basePath + "/_builder/")) {
      return this.builder.handle(req, res, id)
    }
    let sb = this.boxes.get(id.principal)
    if (!sb?.running) {
      if (wantsPage(req)) {
        // Start in the background and show a page that reloads itself, rather than hold the navigation open.
        let failed = false
        const starting = this.boxes.ensure(id.principal)
        starting.catch((e) => {
          failed = true
          console.error(`[sandbox] start failed for ${id.principal}:`, e.message)
        })
        const ready = await Promise.race([starting.then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 1500))])
        if (!ready) return html(res, failed ? 503 : 200, failed ? errorPage("the workspace failed to start") : startingPage())
      }
      try {
        sb = await this.boxes.ensure(id.principal)
      } catch (e: any) {
        console.error(`[sandbox] start failed for ${id.principal}:`, e.message)
        return json(res, 503, { error: "your workspace could not start" })
      }
    }
    // A bare /code/ page load goes to a new session in the workspace. The app's home only lists projects this
    // browser has opened before, so a first visit would otherwise show an empty page with nothing to start from.
    if (req.method === "GET" && wantsPage(req) && url === this.cfg.basePath + "/") {
      res.writeHead(302, { location: workspaceSessionPath(this.cfg.basePath, this.cfg.workspaceDir) })
      return res.end()
    }
    this.forward(sb!, req, res)
  }

  private forward(sb: Sandbox, req: IncomingMessage, res: ServerResponse, retried = false) {
    this.boxes.touch(sb)
    sb.open++
    const upstream = request(
      { socketPath: sb.inSock, method: req.method, path: req.url, headers: inboundHeaders(req.headers, this.boxes.authHeader(sb), false) },
      (up) => {
        const headers: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined || HOP.has(k) || k === "www-authenticate") continue
          headers[k] = v
        }
        if (String(up.headers["content-type"] ?? "").includes("text/event-stream")) headers["x-accel-buffering"] = "no"
        res.writeHead(up.statusCode ?? 502, headers)
        res.flushHeaders()
        up.pipe(res)
        up.on("error", () => res.destroy())
      },
    )
    let counted = true
    const done = () => {
      if (!counted) return
      counted = false
      sb.open = Math.max(0, sb.open - 1)
      this.boxes.touch(sb)
      // The browser went away (or the response finished): end the inner request too, or an event stream would
      // keep running — and the workspace would never look idle.
      if (!upstream.destroyed) upstream.destroy()
    }
    res.once("close", done)
    upstream.on("error", async (e: any) => {
      if (res.headersSent) return res.destroy()
      // The container went away under us (stopped, crashed): check, and start it again once.
      await this.boxes.recheck(sb)
      if (!retried && !sb.running && ["ENOENT", "ECONNREFUSED"].includes(e.code) && (req.method === "GET" || req.method === "HEAD")) {
        res.removeListener("close", done)
        counted = false
        sb.open = Math.max(0, sb.open - 1)
        try {
          await this.boxes.ensure(sb.principal)
          return this.forward(sb, req, res, true)
        } catch {}
      }
      json(res, 502, { error: "your workspace is not answering; reload to restart it" })
    })
    // A retried GET's request stream has already ended; piping it again would never end the new request.
    if (req.readableEnded) upstream.end()
    else req.pipe(upstream)
  }

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    const url = req.url ?? "/"
    if (!this.inPrefix(url)) return refuse(404, "Not Found")
    if (!sameOrigin(req)) return refuse(403, "Forbidden")
    const id = await this.who(req)
    if (!id) return refuse(401, "Unauthorized")
    let sb: Sandbox
    try {
      sb = await this.boxes.ensure(id.principal)
    } catch {
      return refuse(503, "Service Unavailable")
    }
    const inner = net.connect(sb.inSock)
    const headers = inboundHeaders(req.headers, this.boxes.authHeader(sb), true)
    let raw = `${req.method} ${url} HTTP/1.1\r\n`
    for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) raw += `${k}: ${one}\r\n`
    raw += "\r\n"
    sb.open++
    let last = 0
    const activity = () => {
      const now = Date.now()
      if (now - last > 10_000) {
        last = now
        this.boxes.touch(sb)
      }
    }
    inner.on("connect", () => {
      inner.write(raw)
      if (head.length) inner.write(head)
      inner.pipe(socket)
      socket.pipe(inner)
    })
    inner.on("data", activity)
    socket.on("data", activity)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      sb.open = Math.max(0, sb.open - 1)
      this.boxes.touch(sb)
      inner.destroy()
      socket.destroy()
    }
    inner.on("error", close)
    inner.on("close", close)
    socket.on("error", close)
    socket.on("close", close)
  }
}

/** The app's new-session route for a directory: `/<base>/<base64url(dir)>/session`, as the web app encodes it. */
export function workspaceSessionPath(basePath: string, dir: string) {
  const b64 = Buffer.from(dir, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${basePath}/${b64}/session`
}
