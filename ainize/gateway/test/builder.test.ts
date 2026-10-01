import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { createServer, type RequestListener } from "node:http"
import { AgentBuilder } from "../src/builder.ts"
import { loadConfig } from "../src/config.ts"
import { agentSpec, invalidBrief, editAgentPrompt, type AgentBrief } from "../../shared/builder.ts"
import { signInPage } from "../src/pages.ts"
import { PublicProxy } from "../src/public.ts"
import { IdentityResolver } from "../src/identity.ts"
import { Sessions } from "../src/egress.ts"
import { Sandboxes } from "../src/sandboxes.ts"

const brief: AgentBrief = { id: "research-assistant", name: "Research", task: "Summarize the files provided by the caller.", sources: "Drive folder and Mem notes", response: "Use bullet points and cite sources", visibility: "private", orgId: "" }
const identity = { principal: "sso:test", cookie: "ainize_session=example", display: "Test" }
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}
const post = (url: string, body: unknown, origin = url) => fetch(url + "/code/_builder/agents", { method: "POST", headers: { ...(origin ? { origin } : {}), "content-type": "application/json" }, body: JSON.stringify(body) })

test("brief limits and portable generation preserve runtime tools without granting access", () => {
  assert.deepEqual(invalidBrief(brief), [])
  for (const id of ["../x", "a/b", "Upper", "", "x".repeat(41)]) assert.ok(invalidBrief({ ...brief, id }).includes("id"))
  assert.ok(invalidBrief({ ...brief, task: " " }).includes("task"))
  assert.ok(invalidBrief({ ...brief, sources: "x".repeat(1001) }).includes("sources"))
  assert.ok(invalidBrief({ ...brief, visibility: "org" }).includes("orgId"))
  assert.ok(invalidBrief({ ...brief, orgId: "unauthorized" }).includes("orgId"))
  const spec = agentSpec(brief, "Qwen3.8-Flash-Next")
  assert.equal(spec.mode, "prompt")
  assert.deepEqual(spec.files, {})
  assert.deepEqual(spec.allowedHosts, [])
  assert.equal(spec.a2ui, false)
  assert.match(spec.systemPrompt, /AIN Teams, AIN Mem and AIN Drive/)
  assert.match(spec.systemPrompt, /not an authorization/)
  assert.ok(spec.systemPrompt.length < 8000)
  assert.throws(() => editAgentPrompt("../../oops"))
  assert.match(editAgentPrompt(brief.id), /ainize-agents pull research-assistant/)
})

test("login preserves guided destination and cannot redirect off site", () => {
  assert.match(signInPage("/code", "/code/builder"), /next=%2Fcode%2Fbuilder/)
  assert.doesNotMatch(signInPage("/code", "https://evil.example"), /evil/)
})

test("create forwards only generated spec and caller credentials; response strips secrets", async (t) => {
  const calls: { body: unknown; cookie: string | null }[] = []
  const builder = new AgentBuilder(loadConfig(), async (_input, init) => {
    calls.push({ body: JSON.parse(String(init?.body)), cookie: new Headers(init?.headers).get("cookie") })
    return reply({ agent: { id: brief.id, name: brief.name, status: "ready", version: 1, visibility: "private", secrets: ["never-return"] } }, 201)
  })
  const url = await serve(t, (req, res) => { void builder.handle(req, res, identity) })
  const response = await post(url, { ...brief, owner: "other", model: "override", files: { "index.mjs": "bad" } })
  assert.equal(response.status, 201)
  assert.deepEqual(calls[0].body, agentSpec(brief, "Qwen3.8-Flash-Next"))
  assert.equal(calls[0].cookie, identity.cookie)
  assert.doesNotMatch(await response.text(), /never-return|ainize_session|owner/)
})

test("organization membership is checked before creation", async (t) => {
  let writes = 0
  const builder = new AgentBuilder(loadConfig(), async (_url, init) => {
    if (init?.method === "POST") { writes++; return reply({ agent: { id: brief.id, status: "ready" } }, 201) }
    return reply({ orgs: [{ id: "mine", name: "My org" }] })
  })
  const url = await serve(t, (req, res) => { void builder.handle(req, res, identity) })
  assert.equal((await post(url, { ...brief, visibility: "org", orgId: "other" })).status, 403)
  assert.equal(writes, 0)
  assert.equal((await post(url, { ...brief, visibility: "org", orgId: "mine" })).status, 201)
  assert.equal(writes, 1)
})

test("invalid payload, missing Origin, upstream failure and duplicate ID are not successful creations", async (t) => {
  let calls = 0
  let status = 503
  const builder = new AgentBuilder(loadConfig(), async () => { calls++; return reply({ error: "failure" }, status) })
  const url = await serve(t, (req, res) => { void builder.handle(req, res, identity) })
  assert.equal((await post(url, {}, "")).status, 403)
  assert.equal((await post(url, { ...brief, id: "../x" })).status, 400)
  assert.equal((await post(url, "x".repeat(25_000))).status, 413)
  assert.equal(calls, 0)
  assert.equal((await post(url, brief)).status, 503)
  status = 409
  assert.equal((await post(url, brief)).status, 409)
})

test("PublicProxy protects API and login routing without starting a container", async (t) => {
  const cfg = loadConfig()
  const ids = new IdentityResolver(cfg.ainize, async () => reply({ signedIn: false }), 0)
  const boxes = new Sandboxes(cfg, async () => { throw new Error("must not start") })
  const server = new PublicProxy(cfg, ids, boxes, new Sessions()).server()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(url + "/code/_builder/context")).status, 401)
  assert.equal((await post(url, brief, "https://evil.example")).status, 403)
  const page = await fetch(url + "/code/builder", { headers: { accept: "text/html" } })
  assert.match(await page.text(), /next=%2Fcode%2Fbuilder/)
})

test("AIN SSO linked to a Google principal enters Builder; legacy Google alone does not", async t => {
  const ids = new IdentityResolver("http://web", async () => reply({signedIn:false,sso:{principal:"google:linked-user"}}),0)
  const linked = await ids.identify("ainize_session=verified-sso")
  assert.ok(linked)
  assert.equal(linked.principal,"google:linked-user")
  assert.equal(linked.authType,"sso")
  const builder = new AgentBuilder(loadConfig(),async () => reply({orgs:[]}))
  const url = await serve(t,(req,res)=>{ void builder.handle(req,res,req.headers["x-legacy"] ? {...linked,authType:"google"} : linked) })
  assert.equal((await fetch(url+"/code/_builder/context")).status,200)
  assert.equal((await fetch(url+"/code/_builder/context",{headers:{"x-legacy":"1"}})).status,403)
})
