import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BuilderMcp } from "../src/mcp.ts"
import { loadConfig } from "../src/config.ts"
import { mcpTools, validMcp, type McpConfig } from "../../shared/mcp.ts"
const owner = "sso:alice"
const config: McpConfig = { consent: true, teams: { workspaceId: "w1", channels: [{ id: "c1", name: "Project" }], tools: ["read_channel", "create_draft", "send_message"] }, mem: { pages: [{ id: "p1", name: "Knowledge" }], tools: ["app-fetch", "memory-search", "memory-create-pages", "update-page"] } }
const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
function fixture(t: TestContext) {
  const stateDir = mkdtempSync(join(tmpdir(), "ain-mcp-test-"))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const cfg = { ...loadConfig(), stateDir, teamsUrl: "https://teams.example", memUrl: "https://mem.example", publicUrl: "https://builder.example" }
  const writes: string[] = []
  let source = "Original page"
  let fail = false
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    assert.equal(new Headers(init?.headers).get("cookie"), null)
    if (url.endsWith("/register")) return reply({ client_id: "client1" })
    if (url.endsWith("/token")) return reply({ access_token: "teams-access", refresh_token: "refresh", expires_in: 3600, scope: "channels:read drafts:read drafts:write messages:write" })
    if (init?.method === "DELETE") return new Response(null, { status: 204 })
    const body = JSON.parse(String(init?.body))
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
    if (body.method === "initialize") return reply({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } })
    const result = (data: unknown) => reply({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] } })
    if (body.method === "tools/list") return reply({ jsonrpc: "2.0", id: body.id, result: { tools: ["read_channel", "create_draft", "send_message", "list_drafts", "app-fetch", "memory-search", "memory-create-pages", "update-page"].map((name) => ({ name, inputSchema: { type: "object" } })) } })
    const { name, arguments: args } = body.params
    if (name === "list_workspaces") return result([{ id: "w1", name: "Workspace" }])
    if (name === "list_channels") return result([{ id: "c1", name: "Project" }])
    if (name === "read_channel") return result({ messages: ["Hello"] })
    if (name === "list_drafts") return result([{ channelId: "c1", content: source }])
    if (name === "app-fetch") return result(args.id === "self" ? { identity: "agent", userId: "agent1" } : source)
    if (name === "memory-search") return result({ results: [{ id: "p1", title: "Knowledge" }, { id: "private-other", title: "Must not leak" }] })
    writes.push(name)
    if (fail) throw new Error("network lost after write")
    return result({ ok: true })
  }
  const mcp = new BuilderMcp(cfg, fetchImpl)
  async function connect() {
    const auth = new URL(await mcp.start(owner))
    assert.equal(auth.searchParams.get("resource"), "https://teams.example/api/mcp")
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256")
    const params = new URLSearchParams({ code: "fixture", state: auth.searchParams.get("state")! })
    await assert.rejects(mcp.callbackFor("other", params))
    await mcp.callbackFor(owner, params)
    await assert.rejects(mcp.callbackFor(owner, params))
    await mcp.connectMem(owner, "rat_fixture")
  }
  return { mcp, cfg, connect, writes, change: () => { source = "Edited by a human" }, fail: () => { fail = true } }
}
test("MCP config requires explicit source-sharing consent and rejects unknown tools", () => {
  assert.equal(validMcp(config), true)
  assert.equal(validMcp({ ...config, consent: false }), false)
  assert.equal(validMcp({ ...config, unknown: {} }), false)
  assert.equal(validMcp({ consent: true, teams: { ...config.teams, tools: ["delete_draft"] } }), false)
})
test("OAuth + Mem token discovery, exact selected resources and filtered search", async (t) => {
  const f = fixture(t); await f.connect(); await f.mcp.validate(owner, config)
  assert.equal((await f.mcp.status(owner, "teams")).connected, true)
  const token = f.mcp.issue(owner, "helper", config)
  assert.doesNotMatch(readFileSync(join(f.cfg.stateDir, "builder-mcp.json"), "utf8"), new RegExp(token))
  assert.deepEqual(await f.mcp.execute(token, { platform: "teams", tool: "read_channel", args: { channelId: "c1" } }), { result: { messages: ["Hello"] } })
  await assert.rejects(f.mcp.execute(token, { platform: "teams", tool: "read_channel", args: { channelId: "c2" } }))
  await assert.rejects(f.mcp.execute(token, { platform: "mem", tool: "app-fetch", args: { id: "p2" } }))
  const search = await f.mcp.execute(token, { platform: "mem", tool: "memory-search", args: { query: "knowledge" } })
  assert.doesNotMatch(JSON.stringify(search), /private-other|Must not leak/)
})
test("writes are review requests; owner-only decisions, one execution and conflict protection", async (t) => {
  const f = fixture(t); await f.connect(); const token = f.mcp.issue(owner, "helper", config)
  const queued = await f.mcp.execute(token, { platform: "teams", tool: "send_message", args: { channelId: "c1", content: "Approved reply" } })
  assert.ok("approvalId" in queued); const id = queued.approvalId!
  assert.equal(f.writes.length, 0)
  assert.deepEqual(f.mcp.approvals("other"), [])
  await assert.rejects(f.mcp.decide("other", id, true))
  assert.equal((await f.mcp.decide(owner, id, true)).status, "completed")
  await assert.rejects(f.mcp.decide(owner, id, true))
  assert.deepEqual(f.writes, ["send_message"])
  const edit = await f.mcp.execute(token, { platform: "mem", tool: "update-page", args: { id: "p1", content: "New page" } })
  assert.ok("approvalId" in edit)
  f.change()
  assert.equal((await f.mcp.decide(owner, edit.approvalId!, true)).status, "conflict")
  assert.deepEqual(f.writes, ["send_message"])
})
test("uncertain writes are never automatically retried; revocation stops existing grants", async (t) => {
  const f = fixture(t); await f.connect(); const token = f.mcp.issue(owner, "helper", config)
  const input = { platform: "teams", tool: "send_message", args: { channelId: "c1", content: "Once" } }
  const queued = await f.mcp.execute(token, input); assert.ok("approvalId" in queued)
  f.fail()
  assert.equal((await f.mcp.decide(owner, queued.approvalId!, true)).status, "unknown")
  assert.equal((await f.mcp.execute(token, input)).status, "unknown")
  assert.equal(f.writes.length, 1)
  f.mcp.disconnect(owner, "mem")
  await assert.rejects(f.mcp.execute(token, { platform: "teams", tool: "read_channel", args: { channelId: "c1" } }))
})
test("generated MCP module delegates to the scoped gateway with a separate secret", async (t) => {
  const f = fixture(t), file = join(f.cfg.stateDir, "mcp.mjs")
  writeFileSync(file, mcpTools(f.mcp.endpoint, config))
  const module = await import(file)
  const tool = module.tools.find((t: { name: string }) => t.name === "teams_send_message")
  const result = await tool.run({ channelId: "c1", content: "Review me" }, { secret: (name: string) => { assert.equal(name, "AIN_MCP_BUILDER_GRANT"); return "grant" }, fetch: async (_url: string, init: RequestInit) => { assert.equal(new Headers(init.headers).get("authorization"), "Bearer grant"); return reply({ status: "pending" }) } })
  assert.deepEqual(result, { status: "pending" })
})
