import assert from "node:assert/strict"
import { test } from "node:test"
import type { IncomingMessage } from "node:http"
import { loadConfig } from "../src/config.ts"
import { apiAllowed } from "../src/egress.ts"
import { ainizeCookies, IdentityResolver, principalHash, withoutAinizeCookies } from "../src/identity.ts"
import { inboundHeaders, sameOrigin } from "../src/public.ts"
import { Sandboxes } from "../src/sandboxes.ts"

test("ainize cookies are picked out, and never forwarded into a workspace", () => {
  const header = "theme=dark; ainize_session=tok; x=1; ainize_google_session=g"
  assert.equal(ainizeCookies(header), "ainize_session=tok; ainize_google_session=g")
  assert.equal(withoutAinizeCookies(header), "theme=dark; x=1")
  assert.equal(withoutAinizeCookies("ainize_session=tok"), undefined)
  const h = inboundHeaders({ cookie: header, authorization: "Bearer browser", host: "ainize.ai", connection: "keep-alive" }, "Basic inner", false)
  assert.equal(h.cookie, "theme=dark; x=1")
  assert.equal(h.authorization, "Basic inner")
  assert.equal(h.connection, undefined)
  const up = inboundHeaders({ connection: "Upgrade", upgrade: "websocket" }, "Basic inner", true)
  assert.equal(up.upgrade, "websocket")
})

test("a workspace reaches only the allowlisted ainize routes", () => {
  assert.ok(apiAllowed("GET", "/api/hosted-agents"))
  assert.ok(apiAllowed("PUT", "/api/hosted-agents/my-agent"))
  assert.ok(apiAllowed("PUT", "/api/hosted-agents/my-agent/secrets/API_KEY"))
  assert.ok(apiAllowed("DELETE", "/api/linked-agents/x"))
  assert.ok(apiAllowed("GET", "/api/orgs/comcom"))
  assert.ok(!apiAllowed("POST", "/api/orgs"), "no organization changes")
  assert.ok(!apiAllowed("POST", "/api/keys"), "no key minting")
  assert.ok(!apiAllowed("GET", "/api/keys"))
  assert.ok(!apiAllowed("POST", "/api/auth/logout"))
  assert.ok(!apiAllowed("POST", "/api/peers"))
  assert.ok(!apiAllowed("GET", "/api/hosted-agents/../keys"))
})

test("cross-origin writes and websocket handshakes are refused", () => {
  const req = (h: Record<string, string>) => ({ headers: h }) as unknown as IncomingMessage
  assert.ok(sameOrigin(req({ host: "ainize.ai" })))
  assert.ok(sameOrigin(req({ host: "ainize.ai", origin: "https://ainize.ai" })))
  assert.ok(!sameOrigin(req({ host: "ainize.ai", origin: "https://evil.example" })))
  assert.ok(!sameOrigin(req({ host: "ainize.ai", origin: "null" })))
})

test("identity: SSO principal first, then a wallet session, then Google; nobody without ainize cookies", async () => {
  const answers: Record<string, unknown> = {}
  const fake = (async (url: string) =>
    new Response(JSON.stringify(answers[new URL(url).pathname]), { status: 200 })) as unknown as typeof fetch
  const ids = new IdentityResolver("http://web", fake, 0)
  assert.equal(await ids.identify("theme=dark"), null)
  answers["/api/auth/me"] = { signedIn: true, subject: "sso:abc", sso: { principal: "sso:abc", email: "a@comcom.ai" } }
  assert.equal((await ids.identify("ainize_session=t"))?.principal, "sso:abc")
  answers["/api/auth/me"] = { signedIn: true, subject: "0xABC", sso: null }
  assert.equal((await ids.identify("ainize_session=t"))?.principal, "0xabc")
  answers["/api/auth/me"] = { signedIn: false, subject: null, sso: null }
  assert.equal(await ids.identify("ainize_session=dead"), null)
  answers["/api/auth/google/session"] = { identity: { sub: "123", email: "g@x" } }
  const g = await ids.identify("ainize_google_session=c")
  assert.equal(g?.principal, "google:123")
  assert.equal(g?.cookie, "ainize_google_session=c")
})

test("containers run with no network, no capabilities, read-only, as the unprivileged user", () => {
  const cfg = { ...loadConfig(), stateDir: "/tmp/x" }
  const boxes = new Sandboxes(cfg, async () => {})
  const sb = {
    hash: principalHash("sso:abc"), principal: "sso:abc", name: "aincode-x", runDir: "/tmp/x/run/h",
    inSock: "", outSock: "", password: "pw", lastActive: 0, running: false, open: 0,
  }
  const args = boxes.runArgs(sb).join(" ")
  for (const want of ["--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--read-only", "--user 1000:1000", "--init"]) {
    assert.ok(args.includes(want), `missing ${want}`)
  }
  assert.ok(!/-p |--publish/.test(args), "no published ports")
  assert.ok(!args.includes("docker.sock"))
})
