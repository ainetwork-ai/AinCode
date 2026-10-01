import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { GatewayConfig } from "./config.ts"
import { MCP_TOOLS, WRITE_TOOLS, validMcp, type McpConfig, type McpPlatform } from "../../shared/mcp.ts"
import { mcpData, mcpRequest } from "./mcp-client.ts"

type Connection = { token: string; generation: string; client?: string; refresh?: string; expires?: number; scope?: string[] }
type Grant = { owner: string; agent: string; config: McpConfig; generations: Partial<Record<McpPlatform, string>> }
type Approval = { id: string; owner: string; agent: string; grant: string; platform: McpPlatform; tool: string; args: Record<string, unknown>; before: unknown; at: number; status: string; result?: unknown }
type State = { connections: Record<string, Connection>; grants: Record<string, Grant>; approvals: Record<string, Approval> }
const hash = (s: string) => createHash("sha256").update(s).digest("hex")
const random = () => randomBytes(32).toString("base64url")
const SCOPES = ["channels:read", "drafts:read", "drafts:write", "messages:write"]
const connectionKey = (owner: string, platform: McpPlatform) => JSON.stringify([owner, platform])
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}

export class BuilderMcp {
  private cfg: GatewayConfig
  private fetchImpl: typeof fetch
  private file: string
  private data: State
  private pending = new Map<string, { owner: string; client: string; verifier: string; at: number }>()
  private refreshing = new Map<string, Promise<string>>()
  constructor(cfg: GatewayConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg
    this.fetchImpl = fetchImpl
    mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
    this.file = join(cfg.stateDir, "builder-mcp.json")
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { connections: {}, grants: {}, approvals: {} }
  }
  private save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.data), { mode: 0o600 })
    renameSync(this.file + ".tmp", this.file)
  }
  private origin(platform: McpPlatform) { return platform === "teams" ? this.cfg.teamsUrl ?? "https://ainteams.ainetwork.ai" : this.cfg.memUrl ?? "https://ainmem.ainetwork.ai" }
  private get callback() { return `${this.cfg.publicUrl ?? "https://ainize.ai"}${this.cfg.basePath}/_builder/mcp/teams/callback` }
  get endpoint() { return `${this.cfg.publicUrl ?? "https://ainize.ai"}${this.cfg.basePath}/_builder/mcp/tool` }
  private async oauth(path: string, body: unknown, form = false) {
    const res = await this.fetchImpl(this.origin("teams") + path, { method: "POST", headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }, body: form ? String(body) : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error("mcp_unavailable")
    const text = await res.text()
    if (text.length > 32_000) throw new Error("mcp_unavailable")
    return JSON.parse(text)
  }
  async start(owner: string) {
    for (const [key, value] of this.pending) if (value.owner === owner || Date.now() - value.at > 600_000) this.pending.delete(key)
    if (this.pending.size >= 1000) throw new Error("mcp_unavailable")
    const client = await this.oauth("/api/mcp/oauth/register", { client_name: "AinCode Builder", redirect_uris: [this.callback], token_endpoint_auth_method: "none" })
    if (typeof client.client_id !== "string") throw new Error("mcp_unavailable")
    const state = random(), verifier = random()
    this.pending.set(state, { owner, client: client.client_id, verifier, at: Date.now() })
    return this.origin("teams") + "/api/mcp/oauth/authorize?" + new URLSearchParams({ client_id: client.client_id, response_type: "code", redirect_uri: this.callback, resource: this.origin("teams") + "/api/mcp", scope: SCOPES.join(" "), state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })
  }
  async callbackFor(owner: string, params: URLSearchParams) {
    const state = params.get("state") ?? "", p = this.pending.get(state)
    if (!p || p.owner !== owner || Date.now() - p.at > 600_000) throw new Error("mcp_unavailable")
    this.pending.delete(state)
    if (!params.get("code") || params.has("error")) throw new Error("mcp_unavailable")
    const token = await this.oauth("/api/mcp/oauth/token", new URLSearchParams({ grant_type: "authorization_code", code: params.get("code")!, client_id: p.client, redirect_uri: this.callback, resource: this.origin("teams") + "/api/mcp", code_verifier: p.verifier }), true)
    const conn = this.tokenConnection(token, p.client)
    this.disconnect(owner, "teams")
    this.data.connections[connectionKey(owner, "teams")] = conn
    this.save()
  }
  private tokenConnection(token: Record<string, unknown>, client: string): Connection {
    if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string" || typeof token.expires_in !== "number" || token.expires_in <= 0 || typeof token.scope !== "string") throw new Error("mcp_unavailable")
    const scope = token.scope.split(/\s+/)
    if (scope.some((s) => !SCOPES.includes(s)) || !scope.includes("channels:read")) throw new Error("mcp_unavailable")
    return { token: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000, client, scope, generation: random() }
  }
  async connectMem(owner: string, token: unknown) {
    if (typeof token !== "string" || !token || token.length > 4096 || /\s/.test(token)) throw new Error("mcp_invalid_token")
    const result = record(mcpData(await mcpRequest(this.fetchImpl, this.origin("mem") + "/api/mcp", token, "tools/call", { name: "app-fetch", arguments: { id: "self" } })))
    if (result.identity !== "agent" || typeof result.userId !== "string" || !result.userId) throw new Error("mcp_agent_token_required")
    this.disconnect(owner, "mem")
    this.data.connections[connectionKey(owner, "mem")] = { token, generation: random() }
    this.save()
  }
  disconnect(owner: string, platform: McpPlatform) {
    delete this.data.connections[connectionKey(owner, platform)]
    // A grant may span both products; removing either connection invalidates that whole published binding.
    for (const [key, value] of Object.entries(this.data.grants)) if (value.owner === owner && value.generations[platform]) delete this.data.grants[key]
    for (const [key, value] of this.pending) if (value.owner === owner && platform === "teams") this.pending.delete(key)
    this.save()
  }
  private async token(owner: string, platform: McpPlatform): Promise<string> {
    const key = connectionKey(owner, platform), conn = this.data.connections[key]
    if (!conn) throw new Error("mcp_not_connected")
    if (!conn.expires || conn.expires > Date.now() + 60_000) return conn.token
    const pending = this.refreshing.get(key)
    if (pending) return pending
    const refresh = (async () => {
      try {
        const token = await this.oauth("/api/mcp/oauth/token", new URLSearchParams({ grant_type: "refresh_token", refresh_token: conn.refresh!, client_id: conn.client!, resource: this.origin(platform) + "/api/mcp" }), true)
        const next = this.tokenConnection(token, conn.client!)
        if (this.data.connections[key] !== conn) throw new Error("mcp_not_connected")
        Object.assign(conn, next, { generation: conn.generation })
        this.save()
        return conn.token
      } catch { if (this.data.connections[key] === conn) this.disconnect(owner, platform); throw new Error("mcp_not_connected") }
      finally { this.refreshing.delete(key) }
    })()
    this.refreshing.set(key, refresh)
    return refresh
  }
  async call(owner: string, platform: McpPlatform, name: string, args: unknown) {
    return mcpData(await mcpRequest(this.fetchImpl, this.origin(platform) + "/api/mcp", await this.token(owner, platform), "tools/call", { name, arguments: args }))
  }
  async status(owner: string, platform: McpPlatform) {
    if (!this.data.connections[connectionKey(owner, platform)]) return { connected: false, tools: [] as string[] }
    const result = await mcpRequest(this.fetchImpl, this.origin(platform) + "/api/mcp", await this.token(owner, platform), "tools/list")
    if (!Array.isArray(result.tools)) throw new Error("mcp_unavailable")
    const advertised = new Set(result.tools.map((t: { name: string }) => t.name))
    const scope = this.data.connections[connectionKey(owner, platform)].scope ?? []
    const required: Record<string, string[]> = { read_channel: ["channels:read"], create_draft: ["drafts:read", "drafts:write"], send_message: ["messages:write"] }
    return { connected: true, tools: MCP_TOOLS[platform].filter((t) => advertised.has(t) && (t !== "create_draft" || advertised.has("list_drafts")) && (platform !== "teams" || required[t].every((s) => scope.includes(s)))) }
  }
  async browse(owner: string, platform: McpPlatform, params: URLSearchParams) {
    if (platform === "teams") return params.has("workspaceId") ? this.call(owner, platform, "list_channels", { workspaceId: params.get("workspaceId") }) : this.call(owner, platform, "list_workspaces", {})
    return this.call(owner, platform, "memory-search", { query: params.get("q") ?? "", limit: 50 })
  }
  async validate(owner: string, config: McpConfig) {
    if (!validMcp(config)) throw new Error("mcp_invalid_selection")
    for (const platform of ["teams", "mem"] as const) {
      const selection = config[platform]
      if (!selection) continue
      const status = await this.status(owner, platform)
      if (!status.connected || selection.tools.some((t) => !status.tools.includes(t))) throw new Error("mcp_missing_tool")
      if (platform === "teams") {
        const rows = await this.call(owner, platform, "list_channels", { workspaceId: config.teams!.workspaceId })
        if (!Array.isArray(rows) || config.teams!.channels.some((c) => !rows.some((r) => record(r).id === c.id))) throw new Error("mcp_invalid_selection")
      } else {
        for (const page of config.mem!.pages) {
          if (page.id === "self") throw new Error("mcp_invalid_selection")
          await this.call(owner, platform, "app-fetch", { id: page.id })
        }
      }
    }
  }
  issue(owner: string, agent: string, config: McpConfig) {
    if (!validMcp(config)) throw new Error("mcp_invalid_selection")
    const generations: Partial<Record<McpPlatform, string>> = {}
    for (const platform of ["teams", "mem"] as const) if (config[platform]) {
      const conn = this.data.connections[connectionKey(owner, platform)]
      if (!conn) throw new Error("mcp_not_connected")
      generations[platform] = conn.generation
    }
    for (const [key, value] of Object.entries(this.data.grants)) if (value.owner === owner && value.agent === agent) delete this.data.grants[key]
    const token = random()
    this.data.grants[hash(token)] = { owner, agent, config: structuredClone(config), generations }
    this.save()
    return token
  }
  revoke(token: string) { delete this.data.grants[hash(token)]; this.save() }
  private grant(key: string) {
    const grant = this.data.grants[key]
    if (!grant || Object.entries(grant.generations).some(([platform, gen]) => this.data.connections[connectionKey(grant.owner, platform as McpPlatform)]?.generation !== gen)) throw new Error("mcp_not_connected")
    return grant
  }
  private arguments(grant: Grant, platform: McpPlatform, tool: string, input: Record<string, unknown>) {
    if (!grant.config[platform]?.tools.includes(tool)) throw new Error("mcp_missing_tool")
    const text = (key: string, max: number) => { const v = input[key]; if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error("mcp_invalid_arguments"); return v }
    if (platform === "teams") {
      const channelId = text("channelId", 128)
      if (!grant.config.teams!.channels.some((c) => c.id === channelId)) throw new Error("mcp_outside_selection")
      if (tool === "read_channel") return { channelId, ...(typeof input.cursor === "string" && input.cursor.length < 2048 ? { cursor: input.cursor } : {}) }
      return { channelId, content: text("content", 8000) }
    }
    if (tool === "memory-search") return { query: text("query", 256), limit: 50 }
    const id = text("id", 1024)
    if (!grant.config.mem!.pages.some((p) => p.id === id)) throw new Error("mcp_outside_selection")
    if (tool === "app-fetch") return { id }
    if (tool === "update-page") return { id, mode: "replace", content: text("content", 8000) }
    return { pages: [{ parent_id: id, title: text("title", 160), content: text("content", 8000) }] }
  }
  async execute(token: string, input: Record<string, unknown>) {
    const key = hash(token), grant = this.grant(key)
    if (input.platform !== "teams" && input.platform !== "mem") throw new Error("mcp_invalid_platform")
    const platform = input.platform, tool = String(input.tool), args = this.arguments(grant, platform, tool, record(input.args))
    if (!WRITE_TOOLS.has(tool)) {
      const result = await this.call(grant.owner, platform, tool, args)
      if (tool === "memory-search") {
        const data = record(result), rows = Array.isArray(data.results) ? data.results : []
        const selected = rows.filter((r) => grant.config.mem!.pages.some((p) => p.id === record(r).id))
        return { results: selected, count: selected.length, limitedToSelectedSources: true, mayBeIncomplete: true }
      }
      return { result }
    }
    const id = hash(JSON.stringify([key, platform, tool, args]))
    const existing = this.data.approvals[id]
    if (existing) return { approvalId: id, status: existing.status, result: existing.result }
    for (const [k, a] of Object.entries(this.data.approvals)) if (Date.now() - a.at > 86_400_000) delete this.data.approvals[k]
    if (Object.values(this.data.approvals).filter((a) => a.owner === grant.owner).length >= 50) throw new Error("mcp_approval_limit")
    const before = await this.before(grant, platform, tool, args)
    this.grant(key)
    // Another identical request may have completed its read while this one awaited it.
    this.data.approvals[id] ??= { id, owner: grant.owner, agent: grant.agent, grant: key, platform, tool, args, before, at: Date.now(), status: "pending" }
    this.save()
    return { approvalId: id, status: "pending", reviewUrl: `${this.cfg.publicUrl ?? "https://ainize.ai"}${this.cfg.basePath}/builder?approvals=1` }
  }
  private async before(grant: Grant, platform: McpPlatform, tool: string, args: Record<string, unknown>) {
    if (tool === "update-page") return this.call(grant.owner, platform, "app-fetch", { id: args.id })
    if (tool === "create_draft") {
      const rows = await this.call(grant.owner, platform, "list_drafts", { workspaceId: grant.config.teams!.workspaceId })
      if (!Array.isArray(rows)) throw new Error("mcp_unavailable")
      return rows.filter((r) => record(r).channelId === args.channelId)
    }
    return null
  }
  approvals(owner: string) {
    return Object.values(this.data.approvals).filter((a) => a.owner === owner && Date.now() - a.at <= 86_400_000).map(({ grant, owner: _owner, ...a }) => a)
  }
  async decide(owner: string, id: string, approve: boolean) {
    const item = this.data.approvals[id]
    if (!item || item.owner !== owner || item.status !== "pending" || Date.now() - item.at > 86_400_000) throw new Error("mcp_approval_unavailable")
    const grant = this.grant(item.grant)
    if (!approve) { item.status = "rejected"; this.save(); return { status: item.status } }
    // Persist before awaiting: double-clicks/restarts cannot replay a write of uncertain outcome.
    item.status = "executing"; this.save()
    try {
      const before = await this.before(grant, item.platform, item.tool, item.args)
      if (JSON.stringify(before) !== JSON.stringify(item.before)) { item.status = "conflict"; this.save(); return { status: item.status } }
      this.grant(item.grant)
      item.result = await this.call(owner, item.platform, item.tool, item.args)
      item.status = "completed"
    } catch { item.status = "unknown" }
    this.save()
    return { status: item.status, result: item.result }
  }
}
