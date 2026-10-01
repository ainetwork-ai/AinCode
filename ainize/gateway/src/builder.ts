import { GalleryBuilder } from "./gallery.ts"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs"
import { join } from "node:path"
/** Narrow, authenticated builder API. Never accepts code, credentials, arbitrary URLs or a model override. */
import type { IncomingMessage, ServerResponse } from "node:http"
import { AGENT_ID, agentSpec, invalidBrief, type AgentBrief, type BuilderContext } from "../../shared/builder.ts"
import type { GatewayConfig } from "./config.ts"
import { BuilderMcp } from "./mcp.ts"
import { mcpTools } from "../../shared/mcp.ts"
import { BuilderDrive } from "./drive.ts"
import { driveTools, validDrivePath } from "../../shared/drive.ts"
import type { Identity } from "./identity.ts"

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export class AgentBuilder {
  private cfg: GatewayConfig
  private fetchImpl: typeof fetch
  private galleryBuilder?: GalleryBuilder
  private get gallery() { return this.galleryBuilder ??= new GalleryBuilder(this.cfg, this.fetchImpl) }
  private connections?: BuilderMcp
  private get mcp() { return this.connections ??= new BuilderMcp(this.cfg, this.fetchImpl) }
  private connection?: BuilderDrive
  private get drive() { return this.connection ??= new BuilderDrive(this.cfg, this.fetchImpl) }
  constructor(cfg: GatewayConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg
    this.fetchImpl = fetchImpl
  }

  private async upstream(path: string, id: Identity, body?: unknown, method?: string) {
    return this.fetchImpl(this.cfg.ainize + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { cookie: id.cookie, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    })
  }
  async context(id: Identity): Promise<BuilderContext> {
    const res = await this.upstream("/api/orgs", id)
    if (!res.ok) throw new Error("context_unavailable")
    const body = record(await res.json())
    const orgs = Array.isArray(body.orgs) ? body.orgs.flatMap((item: unknown) => {
      const org = record(item)
      return typeof org.id === "string" && typeof org.name === "string" ? [{ id: org.id, name: org.name }] : []
    }) : []
    return { owner: id.principal, directory: this.cfg.workspaceDir, models: this.cfg.models, orgs }
  }
  async mcpTool(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.method !== "POST" || !req.headers.authorization?.startsWith("Bearer ")) return json(res, 401, { error: "unauthorized" })
      return json(res, 200, await this.mcp.execute(req.headers.authorization.slice(7), record(await readBody(req))))
    } catch { return json(res, 403, { error: "mcp_operation_refused" }) }
  }
  async driveTool(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.method !== "POST" || !req.headers.authorization?.startsWith("Bearer ")) return json(res, 401, { error: "unauthorized" })
      return json(res, 200, await this.drive.tool(req.headers.authorization.slice(7), record(await readBody(req))))
    } catch { return json(res, 403, { error: "drive_read_refused" }) }
  }
  async handle(req: IncomingMessage, res: ServerResponse, id: Identity) {
    const path = new URL(req.url ?? "/", "http://gateway").pathname.slice((this.cfg.basePath + "/_builder").length)
    if (id.principal.startsWith("google:") && id.authType !== "sso") return json(res, 403, { error: "ain_signin_required" })
    if (path.startsWith("/gallery/")) return this.gallery.handle(req, res, id, path.slice("/gallery".length))
    if (path === "/connections" || /^\/workspace\/agents\/[a-z0-9-]{1,40}\/connect$/.test(path)) {
      return this.workspaceConnections(req, res, id, path)
    }
    if (path.startsWith("/mcp/")) {
      const query = new URL(req.url ?? "/", "http://gateway").searchParams
      if (path === "/mcp/teams/callback" && req.method === "GET") {
        let status = "connected"
        try { await this.mcp.callbackFor(id.principal, query) } catch { status = "error" }
        res.writeHead(303, { location: this.cfg.basePath + "/builder?mcp=" + status, "cache-control": "no-store", "referrer-policy": "no-referrer" })
        return res.end()
      }
      try {
        if (path === "/mcp/approvals" && req.method === "GET") return json(res, 200, { approvals: this.mcp.approvals(id.principal) })
        const match = path.match(/^\/mcp\/(teams|mem)\/(status|browse|connect|disconnect)$/)
        const platform = match?.[1] as "teams" | "mem" | undefined
        if (match && platform && req.method === "GET") {
          if (match[2] === "status") return json(res, 200, await this.mcp.status(id.principal, platform))
          if (match[2] === "browse") return json(res, 200, { data: await this.mcp.browse(id.principal, platform, query) })
        }
        if (req.method !== "POST" || !req.headers.origin || !String(req.headers["content-type"]).startsWith("application/json")) return json(res, 403, { error: "invalid_origin" })
        const body = record(await readBody(req))
        if (path === "/mcp/approvals/decide" && typeof body.id === "string" && typeof body.approve === "boolean") return json(res, 200, await this.mcp.decide(id.principal, body.id, body.approve))
        if (match && platform) {
          if (match[2] === "disconnect") { this.mcp.disconnect(id.principal, platform); return json(res, 200, { connected: false }) }
          if (match[2] === "connect") {
            if (platform === "teams") return json(res, 200, { url: await this.mcp.start(id.principal) })
            await this.mcp.connectMem(id.principal, body.token)
            return json(res, 200, await this.mcp.status(id.principal, platform))
          }
        }
      } catch { return json(res, 400, { error: "mcp_unavailable" }) }
      return json(res, 404, { error: "not_found" })
    }
    if (path.startsWith("/drive/")) {
      try {
        const query = new URL(req.url ?? "/", "http://gateway").searchParams
        if (path === "/drive/callback" && req.method === "GET") {
          let status = "connected"
          try { await this.drive.callbackFor(id.principal, query) } catch { status = "error" }
          res.writeHead(303, { location: this.cfg.basePath + "/builder?drive=" + status, "cache-control": "no-store", "referrer-policy": "no-referrer" })
          return res.end()
        }
        if (path === "/drive/status" && req.method === "GET") return json(res, 200, { connected: this.drive.connected(id.principal) })
        if (path === "/drive/drives" && req.method === "GET") return json(res, 200, { drives: await this.drive.drives(id.principal) })
        if (path === "/drive/entries" && req.method === "GET") {
          const driveId = query.get("driveId") ?? "", folder = query.get("path") ?? ""
          if (!validDrivePath(folder)) return json(res, 400, { error: "drive_invalid_selection" })
          return json(res, 200, { entries: await this.drive.entries(id.principal, driveId, folder) })
        }
        if (req.method !== "POST" || !req.headers.origin || !String(req.headers["content-type"]).startsWith("application/json")) return json(res, 403, { error: "invalid_origin" })
        if (path === "/drive/connect") return json(res, 200, { url: await this.drive.start(id.principal) })
        if (path === "/drive/disconnect") { this.drive.disconnect(id.principal); return json(res, 200, { connected: false }) }
      } catch { return json(res, 502, { error: "drive_unavailable" }) }
      return json(res, 404, { error: "not_found" })
    }
    if (path === "/context" && req.method === "GET") {
      try { return json(res, 200, await this.context(id)) }
      catch { return json(res, 502, { error: "context_unavailable" }) }
    }
    if (path.startsWith("/agents/") && req.method === "GET") {
      const agentID = path.slice("/agents/".length)
      if (!AGENT_ID.test(agentID)) return json(res, 400, { error: "invalid_id" })
      const response = await this.upstream(`/api/hosted-agents/${agentID}`, id)
      const body = record(await response.json())
      const agent = record(body.agent)
      if (!response.ok) return json(res, response.status, { error: "agent_unavailable" })
      if (agent.owner !== id.principal) return json(res, 403, { error: "not_owner" })
      return json(res, 200, { agent: this.summary(agent) })
    }
    const bind = path.match(/^\/agents\/([a-z0-9-]+)\/(?:drive|connect)$/)
    if ((path !== "/agents" && !bind) || req.method !== "POST") return json(res, 404, { error: "not_found" })
    // Fetch JSON from our page, not a cross-site form (Origin is checked by PublicProxy as well).
    if (!req.headers.origin || !String(req.headers["content-type"]).startsWith("application/json")) return json(res, 403, { error: "invalid_origin" })
    if (Number(req.headers["content-length"]) > 24_000) return json(res, 413, { error: "request_too_large" })
    let brief: AgentBrief
    try {
      const raw = await readBody(req)
      const fields = invalidBrief(raw)
      if (fields.length) return json(res, 400, { error: "invalid_brief", fields })
      brief = raw as AgentBrief
    } catch { return json(res, 400, { error: "invalid_brief" }) }
    if (!this.cfg.models.length) return json(res, 503, { error: "model_unavailable" })
    if (brief.visibility === "org") {
      const context = await this.context(id)
      if (!context.orgs.some((org) => org.id === brief.orgId)) return json(res, 403, { error: "not_org_member" })
    }
    const spec = agentSpec(brief, this.cfg.models[0])
    if (brief.drive?.length) {
      try { await this.drive.validate(id.principal, brief.drive) }
      catch { return json(res, 400, { error: "drive_unavailable" }) }
    }
    const hasMcp = !!(brief.mcp?.teams || brief.mcp?.mem)
    if (hasMcp) {
      try { await this.mcp.validate(id.principal, brief.mcp!) }
      catch { return json(res, 400, { error: "mcp_unavailable" }) }
    }
    const files: Record<string, string> = {}
    if (brief.drive?.length) files["drive.mjs"] = driveTools(this.drive.endpoint)
    if (hasMcp) files["mcp.mjs"] = mcpTools(this.mcp.endpoint, brief.mcp!)
    if (Object.keys(files).length) files["index.mjs"] = [
      brief.drive?.length ? 'import drive from "./drive.mjs";' : 'const drive = { tools: [] };',
      hasMcp ? 'import { tools } from "./mcp.mjs";' : 'const tools = [];',
      'export default { tools: [...drive.tools, ...tools] };',
    ].join("\n")
    if (bind) {
      if (bind[1] !== brief.id || (!brief.drive?.length && !hasMcp)) return json(res, 400, { error: "invalid_brief" })
      const existing = await this.upstream(`/api/hosted-agents/${brief.id}`, id)
      const agent = record(record(await existing.json()).agent)
      // Only bind our generated tools to their owner, not an arbitrary agent edited elsewhere.
      if (!existing.ok || agent.owner !== id.principal || Object.entries(files).some(([name, value]) => record(agent.files)[name] !== value)) return json(res, 403, { error: "not_owner" })
      return json(res, 200, { agent: { ...this.summary(agent), ...await this.bindConnections(id, brief) } })
    }
    const portable = Object.keys(files).length ? { ...spec, mode: "tools", files, allowedHosts: [new URL(hasMcp ? this.mcp.endpoint : this.drive.endpoint).hostname], secretNames: [...(brief.drive?.length ? ["AINDRIVE_BUILDER_GRANT"] : []), ...(hasMcp ? ["AIN_MCP_BUILDER_GRANT"] : [])] } : spec
    const response = await this.upstream("/api/hosted-agents", id, portable)
    if (!response.ok) return json(res, response.status, { error: response.status === 409 ? "agent_exists" : "creation_failed" })
    const agent = record(record(await response.json()).agent)
    if (agent.id !== brief.id) return json(res, 502, { error: "invalid_agent_response" })
    return json(res, 201, { agent: { ...this.summary(agent), ...await this.bindConnections(id, brief) } })
  }
  private async workspaceConnections(req: IncomingMessage, res: ServerResponse, id: Identity, path: string) {
    const directory = join(this.cfg.stateDir, "workspace-connections")
    const file = join(directory, createHash("sha256").update(id.principal).digest("hex") + ".json")
    const empty = { drive: [], driveConsent: false, mcp: { consent: false } }
    const brief = (selection: Record<string, unknown>, agentID = "connections"): AgentBrief => ({
      id: agentID, name: "Connections", task: "Workspace connections", sources: "", response: "", visibility: "private", orgId: "",
      drive: selection.drive as AgentBrief["drive"], driveConsent: selection.driveConsent === true, mcp: selection.mcp as AgentBrief["mcp"],
    })
    try {
      if (req.method === "POST" && (!req.headers.origin || !String(req.headers["content-type"]).startsWith("application/json"))) return json(res, 403, { error: "invalid_origin" })
      if (path === "/connections" && req.method === "POST") {
        const input = brief(record(await readBody(req)))
        if (invalidBrief(input).length) return json(res, 400, { error: "invalid_brief" })
        if (input.drive?.length) await this.drive.validate(id.principal, input.drive)
        if (input.mcp?.teams || input.mcp?.mem) await this.mcp.validate(id.principal, input.mcp)
        const selection = { drive: input.drive ?? [], driveConsent: input.driveConsent, mcp: input.mcp ?? empty.mcp }
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        const tmp = file + "." + randomUUID()
        writeFileSync(tmp, JSON.stringify(selection), { mode: 0o600 })
        renameSync(tmp, file)
        return json(res, 200, { saved: true })
      }
      const selection = existsSync(file) ? record(JSON.parse(readFileSync(file, "utf8"))) : empty
      const input = brief(selection)
      if (invalidBrief(input).length) throw new Error("invalid_connections")
      const files: Record<string, string> = {}
      const secrets: string[] = []
      if (input.drive?.length) { files["drive.mjs"] = driveTools(this.drive.endpoint); secrets.push("AINDRIVE_BUILDER_GRANT") }
      if (input.mcp?.teams || input.mcp?.mem) { files["mcp.mjs"] = mcpTools(this.mcp.endpoint, input.mcp); secrets.push("AIN_MCP_BUILDER_GRANT") }
      const allowedHosts = secrets.length ? [new URL(this.cfg.publicUrl ?? "https://ainize.ai").hostname] : []
      if (path === "/connections" && req.method === "GET") return json(res, 200, { selection, files, secretNames: secrets, allowedHosts })
      const match = path.match(/^\/workspace\/agents\/([a-z0-9-]{1,40})\/connect$/)
      if (!match || req.method !== "POST") return json(res, 405, { error: "method_not_allowed" })
      if (!secrets.length) return json(res, 400, { error: "connections_missing" })
      const response = await this.upstream(`/api/hosted-agents/${match[1]}`, id)
      const agent = record(record(await response.json()).agent)
      if (!response.ok || agent.owner !== id.principal || agent.mode !== "tools" ||
        Object.entries(files).some(([name, code]) => record(agent.files)[name] !== code) ||
        secrets.some((name) => !Array.isArray(agent.secretNames) || !agent.secretNames.includes(name))) return json(res, 403, { error: "not_owner" })
      // OpenCode owns index.mjs and workflow code; only the credential-bearing connector modules must match.
      return json(res, 200, { agent: { ...this.summary(agent), ...await this.bindConnections(id, brief(selection, match[1])) } })
    } catch { return json(res, 400, { error: "connections_unavailable" }) }
  }
  private async bindConnections(id: Identity, brief: AgentBrief) {
    const status: { driveStatus?: string; mcpStatus?: string } = {}
    if (brief.drive?.length) status.driveStatus = await this.bindDrive(id, brief)
    if (brief.mcp?.teams || brief.mcp?.mem) {
      let token: string | undefined
      try {
        await this.mcp.validate(id.principal, brief.mcp)
        token = this.mcp.issue(id.principal, brief.id, brief.mcp)
        const response = await this.upstream(`/api/hosted-agents/${brief.id}/secrets/AIN_MCP_BUILDER_GRANT`, id, { value: token }, "PUT")
        if (!response.ok) throw new Error("mcp_binding_failed")
        status.mcpStatus = "connected"
      } catch { if (token) this.mcp.revoke(token); status.mcpStatus = "failed" }
    }
    return status
  }
  private async bindDrive(id: Identity, brief: AgentBrief) {
    let token: string | undefined
    try {
      await this.drive.validate(id.principal, brief.drive!)
      token = this.drive.issue(id.principal, brief.id, brief.drive!)
      const response = await this.upstream(`/api/hosted-agents/${brief.id}/secrets/AINDRIVE_BUILDER_GRANT`, id, { value: token }, "PUT")
      if (!response.ok) throw new Error("drive_binding_failed")
      return "connected"
    } catch {
      if (token) this.drive.revoke(token)
      return "failed"
    }
  }
  private summary(agent: Record<string, unknown>) {
    return { id: agent.id, name: agent.name, status: agent.status, version: agent.version, visibility: agent.visibility }
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > 24_000) throw new Error("request_too_large")
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}
