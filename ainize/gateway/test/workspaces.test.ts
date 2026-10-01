import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"
import { IdentityResolver, principalHash } from "../src/identity.ts"
import { Egress, Sessions } from "../src/egress.ts"
import { KeyStore } from "../src/keys.ts"
import { PublicProxy } from "../src/public.ts"
import { Sandboxes, type Sandbox } from "../src/sandboxes.ts"
import { orgPrincipal, WorkspaceExecutors } from "../src/workspaces.ts"

async function listen(t: TestContext, server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}

test("two organization members route to the same workspace; outsiders, revoked and read-only writers are refused", async t => {
  let revoked = false
  const upstream = await listen(t, createServer((req, res) => {
    const actor = req.headers.cookie?.split("=")[1]
    res.setHeader("content-type", "application/json")
    if (req.url === "/api/auth/me") return res.end(JSON.stringify({ sso: { principal: `sso:${actor}` } }))
    res.end(JSON.stringify({ orgs: actor === "outside" || revoked ? [] : [{ id: "team-a", name: "Team A", my_role: actor === "reader" ? "read" : "write" }] }))
  }))
  const dir = mkdtempSync(join(tmpdir(), "org-routing-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const socket = join(dir, "in.sock")
  const inner = createServer((_req, res) => res.end("shared-session-history"))
  await new Promise<void>(resolve => inner.listen(socket, resolve))
  t.after(() => { inner.closeAllConnections(); inner.close() })
  const seen: string[] = []
  const sb = { principal: orgPrincipal("team-a"), inSock: socket, running: true, open: 0 } as Sandbox
  const boxes = {
    get(principal: string) { seen.push(principal); return sb },
    authHeader() { return "Basic workspace" }, touch() {},
  } as unknown as Sandboxes
  const cfg = { ...loadConfig(), ainize: upstream, stateDir: dir }
  const publicUrl = await listen(t, new PublicProxy(cfg, new IdentityResolver(upstream, fetch, 0), boxes, new Sessions()).server())
  const read = (actor: string, method = "GET") => fetch(publicUrl + "/code/org/team-a/session", { method, headers: { cookie: `ainize_session=${actor}` } })
  assert.equal(await (await read("alice")).text(), "shared-session-history")
  assert.equal(await (await read("bob")).text(), "shared-session-history")
  assert.deepEqual(seen, [orgPrincipal("team-a"), orgPrincipal("team-a")])
  assert.equal((await read("outside")).status, 403)
  assert.equal((await read("reader", "POST")).status, 403)
  assert.equal(await (await read("reader")).text(), "shared-session-history")
  const activate = publicUrl + "/code/org/team-a/_workspace/activate"
  assert.equal((await fetch(activate, { method: "POST", headers: { cookie: "ainize_session=alice" } })).status, 403)
  assert.equal((await fetch(activate, { method: "POST", headers: { cookie: "ainize_session=alice", origin: "https://elsewhere.example" } })).status, 403)
  assert.equal((await fetch(activate, { method: "POST", headers: { cookie: "ainize_session=alice", origin: publicUrl }, redirect: "manual" })).status, 303)
  assert.equal((await fetch(activate, { method: "POST", headers: { cookie: "ainize_session=bob", origin: publicUrl }, redirect: "manual" })).status, 409)
  revoked = true
  assert.equal((await read("alice")).status, 403)
  assert.equal(seen.length, 3, "refused requests never reach the sandbox")
})

test("CLI scaffolds organization agents without opting them into a personal or public scope", async t => {
  const { execFileSync } = await import("node:child_process")
  const { readFileSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "org-cli-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync("node", [new URL("../../sandbox/ainize-agents.mjs", import.meta.url).pathname, "new", "shared-example", "--mode", "tools"], {
    env: { ...process.env, AINIZE_AGENTS_DIR: root, AINCODE_ORG_ID: "team-a" },
  })
  const manifest = JSON.parse(readFileSync(join(root, "shared-example", "agent.json"), "utf8"))
  assert.equal(manifest.visibility, "org")
  assert.equal(manifest.orgId, "team-a")
})

test("organization containers share a stable volume and URL namespace, independent of personal volumes", () => {
  const boxes = new Sandboxes(loadConfig(), async () => {})
  const principal = orgPrincipal("team-a")
  const sb = { principal, hash: principalHash(principal), password: "test", name: "test", runDir: "/tmp/test" } as Sandbox
  const args = boxes.runArgs(sb)
  assert.ok(args.includes(`aincode-home-${principalHash(principal)}:/home/aincode`))
  assert.ok(args.includes("OPENCODE_BASE_PATH=/code/org/team-a"))
  assert.ok(args.includes("AINCODE_ORG_ID=team-a"))
  assert.notEqual(principalHash(principal), principalHash("sso:alice"))
  assert.notEqual(principalHash(principal), principalHash(orgPrincipal("team-b")))
})

test("shared execution cannot replace an active person's account by visiting, and requires an explicit lease", () => {
  const actors = new WorkspaceExecutors()
  assert.equal(actors.get("team-a"), undefined)
  const alice = { principal: "sso:alice", cookie: "ainize_session=a", display: "Alice" }
  actors.activate("team-a", alice)
  assert.throws(() => actors.activate("team-a", { ...alice, principal: "sso:bob" }))
  actors.release("team-a", "sso:bob")
  assert.equal(actors.get("team-a")?.principal, "sso:alice")
  actors.release("team-a", "sso:alice")
  assert.equal(actors.get("team-a"), undefined)
})

test("organization egress excludes private agents, cross-org writes and deletes, and checks membership on every use", async t => {
  const dir = mkdtempSync(join(tmpdir(), "org-egress-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let revoked = false
  const calls: string[] = []
  const agents = [
    { id: "shared", visibility: "org", orgId: "team-a", can_manage: true },
    { id: "private", visibility: "private", can_manage: true },
    { id: "other", visibility: "org", orgId: "team-b", can_manage: true },
  ]
  const origin = await listen(t, createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    res.setHeader("content-type", "application/json")
    if (req.url === "/api/orgs") return res.end(JSON.stringify({ orgs: revoked ? [] : [{ id: "team-a", name: "A", my_role: "write" }] }))
    if (req.url?.startsWith("/api/hosted-agents?")) return res.end(JSON.stringify({ agents }))
    const agent = agents.find(a => req.url === `/api/hosted-agents/${a.id}`)
    res.end(JSON.stringify({ agent }))
  }))
  const cfg = { ...loadConfig(), ainize: origin, stateDir: dir }
  const actors = new WorkspaceExecutors()
  actors.activate("team-a", { principal: "sso:alice", cookie: "ainize_session=a", display: "Alice" })
  const egress = new Egress(cfg, new KeyStore(dir, origin, "test"), new Sessions(), () => {}, fetch, actors)
  const sb = { principal: orgPrincipal("team-a") } as Sandbox
  // Use the real HTTP handler, including body parsing, rather than duplicate the policy in the test.
  const server = await listen(t, createServer((req, res) => {
    void (egress as unknown as { handle: (s: Sandbox, q: typeof req, r: typeof res) => Promise<void> }).handle(sb, req, res)
  }))
  const list = await (await fetch(server + "/api/hosted-agents?mine=1")).json() as { agents: { id: string }[] }
  assert.deepEqual(list.agents.map(a => a.id), ["shared"])
  assert.equal((await fetch(server + "/api/hosted-agents/private")).status, 403)
  assert.equal((await fetch(server + "/api/hosted-agents/shared", { method: "DELETE" })).status, 403)
  assert.equal((await fetch(server + "/api/hosted-agents", { method: "POST", body: JSON.stringify(agents[2]) })).status, 403)
  assert.equal((await fetch(server + "/api/hosted-agents/shared", { method: "PUT", body: JSON.stringify(agents[1]) })).status, 403)
  assert.ok(!calls.some(call => /^(POST|PUT|DELETE) /.test(call)))
  revoked = true
  assert.equal((await fetch(server + "/api/hosted-agents")).status, 403)
  assert.equal(actors.get("team-a"), undefined)
})
