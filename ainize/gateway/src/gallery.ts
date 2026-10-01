import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { GatewayConfig } from "./config.ts"
import type { Identity } from "./identity.ts"
import { GALLERY_ORG } from "../../shared/gallery.ts"
import { gallerySpec, galleryDefinition, galleryEditSpec } from "./gallery-spec.ts"
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}
async function input(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > 6_000_000) throw Error("request_too_large")
    chunks.push(Buffer.from(chunk))
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")))
}
export class GalleryBuilder {
  private cfg: GatewayConfig
  private fetchImpl: typeof fetch
  constructor(cfg: GatewayConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg
    this.fetchImpl = fetchImpl
  }
  private async upstream(path: string, id: Identity, body?: unknown, method?: string, version?: number) {
    return this.fetchImpl(this.cfg.ainize + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        cookie: id.cookie,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(version === undefined ? {} : { "if-match": String(version) }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(150000),
      redirect: "error",
    })
  }
  private async membership(id: Identity) {
    const r = await this.upstream("/api/orgs", id)
    if (!r.ok) throw Error("org_unavailable")
    const orgs = object(await r.json()).orgs
    const org = Array.isArray(orgs) ? orgs.map(object).find((o) => o.id === GALLERY_ORG) : undefined
    if (!org || !["admin", "write", "contributor"].includes(String(org.my_role)))
      throw Error("uncommon_gallery_write_access_required")
    return org
  }
  image(req: IncomingMessage, res: ServerResponse): boolean {
    const path = new URL(req.url ?? "/", "http://gateway").pathname
    const match = path.match(
      new RegExp("^" + this.cfg.basePath + "/gallery/images/([a-f0-9]{48})\\.(png|jpg|gif|webp)$"),
    )
    if (!match) return false
    const file = join(this.cfg.stateDir, "gallery-images", match[1] + "." + match[2])
    if (req.method !== "GET" || !existsSync(file)) {
      json(res, 404, { error: "not_found" })
      return true
    }
    res.writeHead(200, {
      "content-type": { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[match[2]]!,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    })
    res.end(readFileSync(file))
    return true
  }
  async handle(req: IncomingMessage, res: ServerResponse, id: Identity, path: string) {
    try {
      if (id.principal.startsWith("google:") && id.authType !== "sso")
        return json(res, 403, { error: "ain_signin_required" })
      const org = await this.membership(id)
      if (path === "/context" && req.method === "GET")
        return json(res, 200, {
          org: { id: GALLERY_ORG, name: org.name, role: org.my_role },
          models: [this.cfg.galleryModel ?? this.cfg.models[0]],
          directory: this.cfg.workspaceDir,
        })
      if (path === "/agents" && req.method === "GET") {
        const r = await this.upstream("/api/hosted-agents?manageable=1", id)
        const body = object(await r.json())
        return json(res, r.status, {
          agents: Array.isArray(body.agents)
            ? body.agents.map(object).filter((a) => a.org_id === GALLERY_ORG && a.mode === "handler")
            : [],
        })
      }
      if (
        req.method !== "GET" &&
        (!req.headers.origin || !String(req.headers["content-type"]).startsWith("application/json"))
      )
        return json(res, 403, { error: "invalid_origin" })
      const body = req.method === "GET" ? {} : await input(req)
      if (path === "/validate" && req.method === "POST") {
        gallerySpec(body.definition, this.cfg.galleryModel ?? this.cfg.models[0])
        return json(res, 200, { valid: true, orgId: GALLERY_ORG })
      }
      if (path === "/images" && req.method === "POST") {
        if (typeof body.data !== "string" || body.data.length > 5_600_000) throw Error("invalid_image")
        const bytes = Buffer.from(body.data, "base64")
        if (!bytes.length || bytes.length > 4_000_000) throw Error("invalid_image")
        const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? "image/png"
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            ? "image/jpeg"
            : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
              ? "image/gif"
              : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
                ? "image/webp"
                : undefined
        if (!mime) throw Error("invalid_image")
        const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[mime]!
        const name = randomBytes(24).toString("hex") + "." + ext
        const dir = join(this.cfg.stateDir, "gallery-images")
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        writeFileSync(join(dir, name), bytes, { mode: 0o600, flag: "wx" })
        return json(res, 201, {
          url: (this.cfg.publicUrl ?? "https://ainize.ai") + this.cfg.basePath + "/gallery/images/" + name,
          mimeType: mime,
          name: typeof body.name === "string" ? body.name.slice(0, 256) : name,
        })
      }
      if (path === "/agents" && req.method === "POST") {
        if (!(this.cfg.galleryModel ?? this.cfg.models[0])) throw Error("model_unavailable")
        const spec = gallerySpec(body.definition, this.cfg.galleryModel ?? this.cfg.models[0])
        const r = await this.upstream("/api/hosted-agents", id, spec)
        const data = object(await r.json())
        return json(
          res,
          r.status,
          r.ok
            ? {
                definition: galleryDefinition(spec),
                version: object(data.agent).version,
                a2aUrl: object(data.agent).a2a_url,
              }
            : { error: data.error ?? "creation_failed" },
        )
      }
      const match = path.match(/^\/agents\/([a-z0-9][a-z0-9-]{0,39})(?:\/(memory|logs|test))?$/)
      if (!match) return json(res, 404, { error: "not_found" })
      const agentId = match[1]
      const response = await this.upstream("/api/hosted-agents/" + agentId, id)
      const raw = object(await response.json()),
        agent = object(raw.agent)
      if (!response.ok) return json(res, response.status, { error: raw.error ?? "agent_unavailable" })
      if (agent.org_id !== GALLERY_ORG || agent.visibility !== "org")
        return json(res, 403, { error: "not_uncommon_gallery_agent" })
      if (match[2] === "logs" && req.method === "GET") {
        const r = await this.upstream("/api/hosted-agents/" + agentId + "/logs", id)
        return json(res, r.status, await r.json())
      }
      if (match[2] === "test" && req.method === "POST") {
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 50000)
          throw Error("invalid_message")
        const contextId =
          typeof body.contextId === "string" && body.contextId.length <= 256
            ? body.contextId
            : randomBytes(16).toString("hex")
        const r = await this.fetchImpl((this.cfg.publicUrl ?? "https://ainize.ai") + "/agents/" + agentId, {
          method: "POST",
          headers: { cookie: id.cookie, "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomBytes(16).toString("hex"),
            method: "message/send",
            params: {
              message: {
                kind: "message",
                messageId: randomBytes(16).toString("hex"),
                role: "user",
                contextId,
                parts: [{ kind: "text", text: body.text }],
                metadata: object(body.metadata),
              },
            },
          }),
          signal: AbortSignal.timeout(150000),
          redirect: "error",
        })
        return json(res, r.status, await r.json())
      }
      if (!match[2] && req.method === "GET") {
        try {
          const definition = galleryDefinition(agent)
          return json(res, 200, { definition, version: agent.version, a2aUrl: agent.a2a_url, status: agent.status })
        } catch {
          return json(res, 200, { kind: "code", id: agentId, name: agent.name, version: agent.version })
        }
      }
      const definition = galleryDefinition(agent)
      if (match[2] === "memory" && req.method === "POST") {
        const r = await this.upstream("/api/hosted-agents/" + agentId + "/builder", id, {
          action: body.action,
          params: object(body.params),
        })
        return json(res, r.status, await r.json())
      }
      if (!match[2] && req.method === "GET")
        return json(res, 200, { definition, version: agent.version, a2aUrl: agent.a2a_url, status: agent.status })
      if (!match[2] && req.method === "PUT") {
        if (!Number.isInteger(body.version) || body.version !== agent.version)
          return json(res, 409, { error: "agent_changed_pull_again" })
        const spec = galleryEditSpec(body.definition, agent)
        if (spec.id !== agentId) throw Error("id_cannot_change")
        const r = await this.upstream("/api/hosted-agents/" + agentId, id, spec, "PUT", body.version as number)
        const data = object(await r.json())
        return json(
          res,
          r.status,
          r.ok
            ? { definition: galleryDefinition(object(data.agent)), version: object(data.agent).version }
            : { error: data.error ?? "update_failed" },
        )
      }
      if (!match[2] && req.method === "DELETE") {
        const r = await this.upstream("/api/hosted-agents/" + agentId, id, {}, "DELETE")
        return json(res, r.status, await r.json())
      }
      return json(res, 405, { error: "method_not_allowed" })
    } catch (error) {
      const message = error instanceof Error ? error.message : "gallery_unavailable"
      return json(res, message === "uncommon_gallery_write_access_required" ? 403 : 400, { error: message })
    }
  }
}
