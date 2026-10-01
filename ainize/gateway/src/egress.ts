/**
 * The only door out of a workspace: an HTTP server on the workspace's own out.sock.
 *
 * Because each person has their own socket, the socket IS the identity — there is no token for the workspace to
 * leak or guess. What it may reach:
 *
 *   /v1/chat/completions, /v1/models   the model, with the person's ainize API key (added here, never inside)
 *   /api/...                           a short allowlist of ainize API routes, with the person's own session
 *
 * ainize decides every permission. The gateway adds only credentials the person already holds in their browser, so
 * a workspace can do nothing its owner could not do on ainize.ai themselves.
 */
import { chmodSync, existsSync, unlinkSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
import type { GatewayConfig } from "./config.ts"
import { KeyStore, SessionMissing } from "./keys.ts"
import type { Sandbox } from "./sandboxes.ts"

const LLM_MAX_BODY = 48 * 1024 * 1024
const API_MAX_BODY = 4 * 1024 * 1024

/** [method, path pattern] a workspace may call on ainize. `*` = any method. */
export const API_ALLOW: [string, RegExp][] = [
  ["GET", /^\/api\/auth\/me$/],
  ["GET", /^\/api\/models$/],
  ["GET", /^\/api\/agents$/],
  ["*", /^\/api\/hosted-agents(\/[a-z0-9-]{1,40}(\/(logs|secrets\/[A-Z][A-Z0-9_]{0,63}))?)?$/],
  ["*", /^\/api\/linked-agents(\/[a-z0-9-]{1,40})?$/],
  ["GET", /^\/api\/orgs(\/[A-Za-z0-9_.-]{1,80}(\/(members|groups))?)?$/],
]

export function apiAllowed(method: string, pathname: string): boolean {
  return API_ALLOW.some(([m, re]) => (m === "*" || m === method) && re.test(pathname))
}

/** The person's ainize cookies, as last seen from their browser. In memory only: a restart asks for a reload. */
export class Sessions {
  private map = new Map<string, { cookie: string; at: number }>()
  set(principal: string, cookie: string) {
    this.map.set(principal, { cookie, at: Date.now() })
  }
  get(principal: string): string | undefined {
    return this.map.get(principal)?.cookie
  }
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    req.on("data", (c: Buffer) => {
      n += c.length
      if (n > max) {
        reject(new TooLarge())
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

class TooLarge extends Error {}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return res.end()
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function openaiError(res: ServerResponse, status: number, code: string, message: string) {
  send(res, status, { error: { message, type: "invalid_request_error", code } })
}

const PASS_RESPONSE_HEADERS = ["content-type", "cache-control", "x-ainize-served-by", "retry-after"]

async function relay(res: ServerResponse, upstream: Response) {
  const headers: Record<string, string> = {}
  for (const h of PASS_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) headers[h] = v
  }
  res.writeHead(upstream.status, headers)
  res.flushHeaders()
  if (!upstream.body) return res.end()
  const body = Readable.fromWeb(upstream.body as any)
  body.on("error", () => res.destroy())
  res.on("close", () => body.destroy())
  body.pipe(res)
}

export class Egress {
  private readonly cfg: GatewayConfig
  private readonly keys: KeyStore
  private readonly sessions: Sessions
  private readonly fetchImpl: typeof fetch
  private servers = new Map<string, Server>()
  private readonly onActivity: (sb: Sandbox) => void

  constructor(cfg: GatewayConfig, keys: KeyStore, sessions: Sessions, onActivity: (sb: Sandbox) => void, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg
    this.keys = keys
    this.sessions = sessions
    this.onActivity = onActivity
    this.fetchImpl = fetchImpl
  }

  /** Make sure the workspace's out.sock is listening (idempotent). */
  async listen(sb: Sandbox) {
    if (this.servers.has(sb.hash)) return
    if (existsSync(sb.outSock)) unlinkSync(sb.outSock)
    const server = createServer((req, res) => {
      this.onActivity(sb)
      this.handle(sb, req, res).catch((e) => {
        if (e instanceof TooLarge) return send(res, 413, { error: "request too large" })
        if (e instanceof SessionMissing) return send(res, 401, { error: e.message })
        console.error(`[egress ${sb.hash}]`, e)
        send(res, 502, { error: `the workspace gateway could not reach ainize: ${e.message ?? e}` })
      })
    })
    server.requestTimeout = 0
    server.headersTimeout = 60_000
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(sb.outSock, () => resolve())
    })
    chmodSync(sb.outSock, 0o600)
    this.servers.set(sb.hash, server)
  }

  async closeAll() {
    for (const s of this.servers.values()) s.close()
    this.servers.clear()
  }

  private async handle(sb: Sandbox, req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://sandbox")
    const method = (req.method ?? "GET").toUpperCase()
    if (url.pathname === "/v1/chat/completions" && method === "POST") return this.chat(sb, req, res)
    if (url.pathname === "/v1/models" && method === "GET") return this.models(res)
    const galleryPath = /^\/api\/gallery\/(context|validate|agents(?:\/[a-z0-9][a-z0-9-]{0,39}(?:\/(memory|logs|test))?)?|images)$/.test(url.pathname) ? "/gallery" + url.pathname.slice("/api/gallery".length) : undefined
    const builderPath = galleryPath ?? (url.pathname === "/api/builder/connections" && method === "GET"
      ? "/connections"
      : /^\/api\/builder\/agents\/[a-z0-9-]{1,40}\/connect$/.test(url.pathname) && method === "POST"
        ? "/workspace" + url.pathname.slice("/api/builder".length) : undefined)
    if (builderPath) {
      const cookie = this.sessions.get(sb.principal)
      if (!cookie) throw new SessionMissing()
      const body = !["GET", "HEAD"].includes(method) ? await readBody(req, galleryPath ? 6_000_000 : 24_000) : undefined
      const upstream = await this.fetchImpl(`http://${this.cfg.host}:${this.cfg.port}${this.cfg.basePath}/_builder${builderPath}`, {
        method, headers: { cookie, origin: `http://${this.cfg.host}:${this.cfg.port}`, "content-type": "application/json" },
        body: body as BodyInit | undefined, signal: abortOnClose(res), redirect: "error",
      })
      return relay(res, upstream)
    }
    if (url.pathname.startsWith("/api/")) {
      if (!apiAllowed(method, url.pathname)) return send(res, 403, { error: `${method} ${url.pathname} is not available from a workspace` })
      return this.api(sb, req, res, method, url)
    }
    send(res, 404, { error: "not found" })
  }

  private models(res: ServerResponse) {
    send(res, 200, { object: "list", data: this.cfg.models.map((id) => ({ id, object: "model", owned_by: "ainize" })) })
  }

  private async chat(sb: Sandbox, req: IncomingMessage, res: ServerResponse) {
    let body: any
    try {
      body = JSON.parse((await readBody(req, LLM_MAX_BODY)).toString("utf8"))
    } catch (e) {
      if (e instanceof TooLarge) throw e
      return openaiError(res, 400, "invalid_json", "the request body is not JSON")
    }
    if (!body || typeof body !== "object") return openaiError(res, 400, "invalid_request", "expected a JSON object")
    const model = typeof body.model === "string" ? body.model.replace(/^ainize\//, "") : this.cfg.models[0]
    if (!this.cfg.models.includes(model)) {
      return openaiError(res, 403, "model_not_allowed", `this workspace may use ${this.cfg.models.join(", ")}, not ${body.model}`)
    }
    // Keep the workspace model name stable while routing its large prompts to the configured long-context peer.
    body.model = model === this.cfg.models[0] && this.cfg.galleryModel ? this.cfg.galleryModel : model
    const payload = JSON.stringify(body)
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = await this.keys.get(sb.principal, this.sessions.get(sb.principal))
      const upstream = await this.fetchImpl(this.cfg.ainize + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: req.headers.accept ?? "*/*" },
        body: payload,
        signal: abortOnClose(res),
      })
      if (upstream.status === 401 && attempt === 0) {
        // The key was revoked; make another with the person's session and try once more.
        await upstream.body?.cancel()
        this.keys.drop(sb.principal, key)
        continue
      }
      return relay(res, upstream)
    }
  }

  private async api(sb: Sandbox, req: IncomingMessage, res: ServerResponse, method: string, url: URL) {
    const cookie = this.sessions.get(sb.principal)
    if (!cookie) throw new SessionMissing()
    const hasBody = !["GET", "HEAD"].includes(method)
    const body = hasBody ? await readBody(req, API_MAX_BODY) : undefined
    const headers: Record<string, string> = { cookie, accept: "application/json" }
    if (hasBody) headers["content-type"] = String(req.headers["content-type"] ?? "application/json")
    const upstream = await this.fetchImpl(this.cfg.ainize + url.pathname + url.search, {
      method,
      headers,
      body: body as any,
      signal: abortOnClose(res),
    })
    // A 401 here is ainize's own answer (an ended session, or a route that needs another kind of sign-in); its
    // message is relayed as it is so the workspace can say which.
    return relay(res, upstream)
  }
}

function abortOnClose(res: ServerResponse): AbortSignal {
  const ac = new AbortController()
  res.on("close", () => {
    if (!res.writableFinished) ac.abort()
  })
  return ac.signal
}
