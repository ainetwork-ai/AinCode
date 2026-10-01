import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import type { GatewayConfig } from "./config.ts"
import { validSelection, withinSelection, validDrivePath, type DriveSelection, type DriveAccount, type DriveEntry } from "../../shared/drive.ts"

type Connection = { client: string; access: string; refresh: string; expires: number; generation: string }
type Pending = { principal: string; verifier: string; client: string; expires: number }
type Grant = { principal: string; agent: string; generation: string; selection: DriveSelection[] }
type Store = { connections: Record<string, Connection>; grants: Record<string, Grant> }
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const random = () => randomBytes(32).toString("base64url")

/** Single gateway process owns this store and serializes refresh rotation. Tokens stay outside sandboxes. */
export class BuilderDrive {
  private cfg: GatewayConfig
  private fetchImpl: typeof fetch
  private file: string
  private data: Store
  private pending = new Map<string, Pending>()
  private refreshing = new Map<string, Promise<string>>()
  constructor(cfg: GatewayConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg
    this.fetchImpl = fetchImpl
    mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
    this.file = join(cfg.stateDir, "builder-drive.json")
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { connections: {}, grants: {} }
  }
  private save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.data), { mode: 0o600 })
    renameSync(this.file + ".tmp", this.file)
  }
  private get origin() { return this.cfg.driveUrl ?? "https://aindrive.ainetwork.ai" }
  private get callback() { return `${this.cfg.publicUrl ?? "https://ainize.ai"}${this.cfg.basePath}/_builder/drive/callback` }
  get endpoint() { return `${this.cfg.publicUrl ?? "https://ainize.ai"}${this.cfg.basePath}/_builder/drive/tool` }
  connected(principal: string) { return !!this.data.connections[principal] }
  private async request(path: string, init: RequestInit) {
    const response = await this.fetchImpl(this.origin + path, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error("drive_unavailable")
    // Bound metadata and file responses; never return credentials or MCP UI metadata to the model.
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (!reader) throw new Error("drive_unavailable")
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 2_000_000) { await reader.cancel(); throw new Error("drive_response_too_large") }
      chunks.push(part.value)
    }
    const text = Buffer.concat(chunks).toString("utf8")
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const messages = text.split(/\r?\n\r?\n/).flatMap((block) => {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
        return data ? [JSON.parse(data)] : []
      })
      return messages.find((m) => m.id === 1) ?? {}
    }
    return JSON.parse(text)
  }
  async start(principal: string) {
    for (const [key, value] of this.pending) if (value.expires < Date.now() || value.principal === principal) this.pending.delete(key)
    if (this.pending.size >= 1000) throw new Error("drive_unavailable")
    const client = await this.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "AinCode Builder", redirect_uris: [this.callback], token_endpoint_auth_method: "none" }) })
    if (typeof client.client_id !== "string") throw new Error("drive_unavailable")
    const state = random(), verifier = random()
    this.pending.set(state, { principal, verifier, client: client.client_id, expires: Date.now() + 600_000 })
    const url = new URL(this.origin + "/oauth/authorize")
    url.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: this.callback, scope: "drives:read", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString()
    return url.href
  }
  async callbackFor(principal: string, params: URLSearchParams) {
    const state = params.get("state") ?? ""
    const pending = this.pending.get(state)
    if (!pending || pending.principal !== principal || pending.expires < Date.now()) throw new Error("drive_oauth_failed")
    this.pending.delete(state)
    const code = params.get("code")
    if (!code || params.has("error")) throw new Error("drive_oauth_failed")
    const token = await this.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: pending.client, redirect_uri: this.callback, code_verifier: pending.verifier }) })
    this.validateToken(token)
    // Reconnecting cannot silently reactivate old published agents.
    this.disconnect(principal)
    this.data.connections[principal] = { client: pending.client, access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000, generation: random() }
    this.save()
  }
  private validateToken(token: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown }) {
    if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string" || typeof token.expires_in !== "number" || token.expires_in <= 0 || token.scope !== "drives:read") throw new Error("drive_oauth_failed")
  }
  disconnect(principal: string) {
    delete this.data.connections[principal]
    for (const [key, value] of Object.entries(this.data.grants)) if (value.principal === principal) delete this.data.grants[key]
    for (const [key, value] of this.pending) if (value.principal === principal) this.pending.delete(key)
    this.save()
  }
  private async access(principal: string): Promise<string> {
    const conn = this.data.connections[principal]
    if (!conn) throw new Error("drive_not_connected")
    if (conn.expires > Date.now() + 60_000) return conn.access
    const existing = this.refreshing.get(principal)
    if (existing) return existing
    const refresh = (async () => {
      try {
        const token = await this.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: conn.refresh, client_id: conn.client }) })
        this.validateToken(token)
        if (this.data.connections[principal] !== conn) throw new Error("drive_not_connected")
        Object.assign(conn, { access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000 })
        this.save()
        return conn.access
      } catch { if (this.data.connections[principal] === conn) this.disconnect(principal); throw new Error("drive_not_connected") }
      finally { this.refreshing.delete(principal) }
    })()
    this.refreshing.set(principal, refresh)
    return refresh
  }
  async drives(principal: string): Promise<DriveAccount[]> {
    const body = await this.request("/api/oauth/drives", { headers: { authorization: `Bearer ${await this.access(principal)}` } })
    if (!Array.isArray(body.drives)) throw new Error("drive_unavailable")
    return body.drives.filter((d: DriveAccount) => typeof d.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(d.id) && typeof d.name === "string").map((d: DriveAccount) => ({ id: d.id, name: d.name, online: d.online === true }))
  }
  async call(principal: string, driveId: string, tool: string, path: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(driveId) || !validDrivePath(path) || !["list_files", "read_file", "stat"].includes(tool)) throw new Error("drive_invalid_selection")
    const body = await this.request(`/mcp/d/${driveId}`, { method: "POST", headers: { authorization: `Bearer ${await this.access(principal)}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { path } } }) })
    if (body.error || body.result?.isError || !body.result?.structuredContent) throw new Error("drive_unavailable")
    return body.result.structuredContent
  }
  async entries(principal: string, driveId: string, path: string): Promise<DriveEntry[]> {
    const body = await this.call(principal, driveId, "list_files", path)
    if (!Array.isArray(body.entries)) throw new Error("drive_unavailable")
    return body.entries.filter((e: DriveEntry) => typeof e.name === "string" && !e.name.includes("/") && validDrivePath(e.name) && e.name !== "").map((e: DriveEntry) => ({ name: e.name, isDir: e.isDir === true, locked: e.locked === true }))
  }
  async validate(principal: string, selection: DriveSelection[]) {
    if (!validSelection(selection) || !selection.length) throw new Error("drive_invalid_selection")
    for (const item of selection) {
      if (!item.path) { await this.entries(principal, item.driveId, ""); continue }
      const stat = await this.call(principal, item.driveId, "stat", item.path)
      if (stat.locked || (stat.isDir === true) !== (item.kind === "folder")) throw new Error("drive_invalid_selection")
    }
  }
  issue(principal: string, agent: string, selection: DriveSelection[]) {
    const conn = this.data.connections[principal]
    if (!conn || !validSelection(selection) || !selection.length) throw new Error("drive_not_connected")
    for (const [key, value] of Object.entries(this.data.grants)) if (value.principal === principal && value.agent === agent) delete this.data.grants[key]
    const token = random()
    this.data.grants[hash(token)] = { principal, agent, generation: conn.generation, selection: structuredClone(selection) }
    this.save()
    return token
  }
  revoke(token: string) { delete this.data.grants[hash(token)]; this.save() }
  async tool(token: string, input: { tool?: unknown; driveId?: unknown; path?: unknown }) {
    const grant = this.data.grants[hash(token)]
    if (!grant || this.data.connections[grant.principal]?.generation !== grant.generation) throw new Error("drive_not_connected")
    if (input.tool === "list_files" && input.driveId === undefined) return { sources: grant.selection }
    if (typeof input.driveId !== "string" || typeof input.path !== "string" || !["list_files", "read_file"].includes(String(input.tool)) || !withinSelection(grant.selection, input.driveId, input.path, String(input.tool))) throw new Error("drive_outside_selection")
    if (input.tool === "list_files") return { entries: await this.entries(grant.principal, input.driveId, input.path) }
    return this.call(grant.principal, input.driveId, "read_file", input.path)
  }
}
