import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { BuilderDrive } from "../src/drive.ts"
import { AgentBuilder } from "../src/builder.ts"
import { loadConfig } from "../src/config.ts"
import { driveTools, validSelection, withinSelection } from "../../shared/drive.ts"
import { invalidBrief } from "../../shared/builder.ts"
const principal = "sso:alice"
const selection = [{ driveId: "d1", path: "docs", kind: "folder" as const }]
const brief = { id: "drive-helper", name: "Helper", task: "Answer with sources", sources: "", response: "", visibility: "private", orgId: "", drive: selection, driveConsent: true }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
function fixture(t: TestContext, expires = 3600) {
  const stateDir = mkdtempSync(join(tmpdir(), "builder-drive-test-"))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const cfg = { ...loadConfig(), stateDir, driveUrl: "https://drive.example", publicUrl: "https://builder.example" }
  let refreshes = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    assert.equal(new Headers(init?.headers).get("cookie"), null)
    if (url.endsWith("/api/oauth/register")) return reply({ client_id: "client1" })
    if (url.endsWith("/api/oauth/token")) {
      const params = new URLSearchParams(String(init?.body))
      if (params.get("grant_type") === "refresh_token") refreshes++
      if (params.get("grant_type") === "authorization_code") assert.equal(params.get("code_verifier")?.length, 43)
      return reply({ access_token: "private-access", refresh_token: "private-refresh", scope: "drives:read", expires_in: refreshes ? 3600 : expires })
    }
    if (url.endsWith("/api/oauth/drives")) return reply({ drives: [{ id: "d1", name: "Project", online: true }] })
    const body = JSON.parse(String(init?.body))
    if (body.params.name === "stat") return reply({ result: { structuredContent: { name: "docs", isDir: true } } })
    if (body.params.name === "list_files") return reply({ result: { structuredContent: { entries: [{ name: "a.txt", isDir: false }, { name: ".aindrive", isDir: true }] }, _meta: { token: "never-forward" } } })
    return reply({ result: { structuredContent: { content: "source text" }, _meta: { token: "never-forward" } } })
  }
  const drive = new BuilderDrive(cfg, fetchImpl)
  async function connect() {
    const url = new URL(await drive.start(principal))
    assert.equal(url.searchParams.get("scope"), "drives:read")
    assert.equal(url.searchParams.get("code_challenge_method"), "S256")
    assert.equal(url.searchParams.get("redirect_uri"), "https://builder.example/code/_builder/drive/callback")
    await drive.callbackFor(principal, new URLSearchParams({ state: url.searchParams.get("state")!, code: "code1" }))
  }
  return { drive, cfg, fetchImpl, connect, refreshes: () => refreshes }
}
test("selection requires consent and canonical paths with segment boundaries", () => {
  assert.equal(validSelection(selection), true)
  for (const path of ["../x", "docs/../x", "docs//x", "/docs", "docs%2Fx", "docs\\x", "docs/.aindrive/key"]) assert.equal(validSelection([{ ...selection[0], path }]), false)
  assert.equal(withinSelection(selection, "d1", "docs/a", "read_file"), true)
  assert.equal(withinSelection(selection, "d1", "docs-other/a", "read_file"), false)
  assert.equal(withinSelection(selection, "other", "docs/a", "read_file"), false)
  assert.equal(withinSelection([{ driveId: "d1", path: "one.txt", kind: "file" }], "d1", "one.txt/child", "read_file"), false)
  assert.deepEqual(invalidBrief(brief), [])
  assert.ok(invalidBrief({ ...brief, driveConsent: false }).includes("drive"))
})
test("OAuth state is principal-bound, single use, PKCE; credentials use private storage", async (t) => {
  const f = fixture(t)
  const url = new URL(await f.drive.start(principal))
  const params = new URLSearchParams({ state: url.searchParams.get("state")!, code: "ok" })
  await assert.rejects(f.drive.callbackFor("other", params))
  await f.drive.callbackFor(principal, params)
  await assert.rejects(f.drive.callbackFor(principal, params))
  assert.equal(f.drive.connected(principal), true)
  assert.equal(statSync(join(f.cfg.stateDir, "builder-drive.json")).mode & 0o777, 0o600)
  assert.deepEqual(await new BuilderDrive(f.cfg, f.fetchImpl).drives(principal), [{ id: "d1", name: "Project", online: true }])
})
test("reads stay within selected paths; disconnect and reconnect never resurrect grants", async (t) => {
  const f = fixture(t)
  await f.connect()
  await f.drive.validate(principal, selection)
  const token = f.drive.issue(principal, "helper", selection)
  assert.doesNotMatch(readFileSync(join(f.cfg.stateDir, "builder-drive.json"), "utf8"), new RegExp(token))
  assert.deepEqual(await f.drive.tool(token, { tool: "list_files" }), { sources: selection })
  assert.deepEqual(await f.drive.tool(token, { tool: "list_files", driveId: "d1", path: "docs" }), { entries: [{ name: "a.txt", isDir: false, locked: false }] })
  assert.deepEqual(await f.drive.tool(token, { tool: "read_file", driveId: "d1", path: "docs/a.txt" }), { content: "source text" })
  for (const input of [{ tool: "write_file", driveId: "d1", path: "docs/a" }, { tool: "read_file", driveId: "d1", path: "secret" }, { tool: "read_file", driveId: "d2", path: "docs/a" }]) await assert.rejects(f.drive.tool(token, input))
  f.drive.disconnect(principal)
  await assert.rejects(f.drive.tool(token, { tool: "list_files" }))
  await f.connect()
  await assert.rejects(f.drive.tool(token, { tool: "list_files" }))
})
test("concurrent reads serialize refresh-token rotation", async (t) => {
  const f = fixture(t, 1)
  await f.connect()
  await Promise.all([f.drive.drives(principal), f.drive.drives(principal), f.drive.drives(principal)])
  assert.equal(f.refreshes(), 1)
})
test("generated module uses a secret and returns tool results", async (t) => {
  const f = fixture(t)
  const file = join(f.cfg.stateDir, "agent.mjs")
  writeFileSync(file, driveTools("https://builder.example/code/_builder/drive/tool"))
  const module = await import(file)
  const result = await module.default.tools[1].run({ driveId: "d1", path: "docs/a.txt" }, { secret: (key: string) => { assert.equal(key, "AINDRIVE_BUILDER_GRANT"); return "capability" }, fetch: async (_url: string, init: RequestInit) => { assert.equal(new Headers(init.headers).get("authorization"), "Bearer capability"); return reply({ content: "ok" }) } })
  assert.deepEqual(result, { content: "ok" })
})
test("builder installs a tools agent and write-only secret; failed binding can retry", async (t) => {
  const f = fixture(t)
  await f.connect()
  let spec: Record<string, unknown> = {}
  let failSecret = true
  const builder = new AgentBuilder(f.cfg, async (url, init) => {
    if (String(url).startsWith("https://drive.example")) return f.fetchImpl(url, init)
    if (init?.method === "PUT") return reply({}, failSecret ? 503 : 200)
    if (init?.method === "POST") spec = JSON.parse(String(init.body))
    return reply({ agent: { ...spec, owner: principal, status: "starting" } }, 200)
  })
  const server = createServer((req, res) => { void builder.handle(req, res, { principal, cookie: "ainize_session=local", display: "Alice" }) })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  t.after(() => { server.closeAllConnections(); server.close() })
  const addr = server.address(); assert.ok(addr && typeof addr !== "string")
  const url = `http://127.0.0.1:${addr.port}`
  const post = (path: string) => fetch(url + "/code/_builder" + path, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(brief) })
  const created = await (await post("/agents")).json() as { agent: { driveStatus: string } }
  assert.equal(created.agent.driveStatus, "failed")
  assert.equal(spec.mode, "tools")
  assert.deepEqual(spec.allowedHosts, ["builder.example"])
  assert.deepEqual(spec.secretNames, ["AINDRIVE_BUILDER_GRANT"])
  failSecret = false
  const retried = await (await post("/agents/drive-helper/drive")).json() as { agent: { driveStatus: string } }
  assert.equal(retried.agent.driveStatus, "connected")
})
