import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { AgentBuilder } from "../src/builder.ts"
import { loadConfig } from "../src/config.ts"

test("workspace selections persist, isolate owners, exclude credentials and never create an agent", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "builder-workspace-"))
  let calls = 0
  const transport: typeof fetch = async () => { calls++; throw new Error("must not create remotely") }
  const cfg = { ...loadConfig(), stateDir }
  let builder = new AgentBuilder(cfg, transport)
  const server = createServer((req,res) => { void builder.handle(req,res,{ principal: String(req.headers["x-owner"] ?? "sso:alice"), cookie: "test", display: "Test" }) })
  await new Promise<void>(r => server.listen(0,"127.0.0.1",r))
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(stateDir,{recursive:true,force:true}) })
  const addr=server.address(); assert.ok(addr && typeof addr !== "string")
  const url=`http://127.0.0.1:${addr.port}/code/_builder/connections`
  const send=(body:unknown, origin=true)=>fetch(url,{method:"POST",headers:{"content-type":"application/json",...(origin?{origin:"http://localhost"}:{})},body:JSON.stringify(body)})
  assert.equal((await send({},false)).status,403)
  assert.equal((await send({mcp:{consent:false,mem:{pages:[{id:"p1",name:"P"}],tools:["app-fetch"]}}})).status,400)
  assert.equal((await send({drive:[],driveConsent:true,mcp:{consent:true},token:"MUST_NOT_PERSIST",owner:"someone-else"})).status,200)
  builder=new AgentBuilder(cfg,transport)
  const data=await (await fetch(url)).json()
  assert.equal(data.selection.driveConsent,true)
  assert.deepEqual(data.files,{})
  assert.deepEqual(data.secretNames,[])
  assert.doesNotMatch(JSON.stringify(data),/MUST_NOT_PERSIST|someone-else/)
  assert.equal((await (await fetch(url,{headers:{"x-owner":"sso:bob"}})).json()).selection.driveConsent,false)
  assert.equal(calls,0)
})

test("OpenCode CLI imports scoped tools without replacing workflow code or publishing", async t => {
  const { spawn } = await import("node:child_process")
  const { writeFileSync, readFileSync, mkdirSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "builder-cli-"))
  const calls: string[] = []
  const server = createServer((req,res) => {
    calls.push(`${req.method} ${req.url}`)
    res.setHeader("content-type","application/json")
    res.end(JSON.stringify({ selection:{drive:[]}, files:{"mcp.mjs":"export const tools = []"}, allowedHosts:["ainize.ai"], secretNames:["AIN_MCP_BUILDER_GRANT"] }))
  })
  await new Promise<void>(r => server.listen(0,"127.0.0.1",r))
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(root,{recursive:true,force:true}) })
  const addr=server.address(); assert.ok(addr && typeof addr !== "string")
  mkdirSync(join(root,"example","files"),{recursive:true})
  writeFileSync(join(root,"example","agent.json"),JSON.stringify({mode:"tools",allowedHosts:["existing.example"],secretNames:[]}))
  writeFileSync(join(root,"example","files","index.mjs"),"// OpenCode wrote this workflow")
  const child=spawn("node",[new URL('../../sandbox/ainize-agents.mjs',import.meta.url).pathname,"connections","example"],{
    env:{...process.env,AINIZE_API:`http://127.0.0.1:${addr.port}/api`,AINIZE_AGENTS_DIR:root},stdio:"pipe",
  })
  let stderr=""; child.stderr.on("data",chunk=>stderr+=chunk)
  const code=await new Promise<number|null>((resolve,reject)=>{child.on("exit",resolve);child.on("error",reject)})
  assert.equal(code,0,stderr)
  assert.equal(readFileSync(join(root,"example","files","index.mjs"),"utf8"),"// OpenCode wrote this workflow")
  assert.equal(readFileSync(join(root,"example","files","mcp.mjs"),"utf8"),"export const tools = []")
  assert.deepEqual(JSON.parse(readFileSync(join(root,"example","agent.json"),"utf8")).allowedHosts,["existing.example","ainize.ai"])
  assert.deepEqual(calls,["GET /api/builder/connections"])
})
