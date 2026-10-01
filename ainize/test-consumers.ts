/** Run from ainize/gateway: bun ../test-consumers.ts <node-root> <teams-root> <mem-root> <drive-root>.
 * Uses actual consumer modules with a fixture A2A transport; never contacts production.
 */
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { mcpTools } from "./shared/mcp.ts"
import { driveTools } from "./shared/drive.ts"
import { agentSpec } from "./shared/builder.ts"
const [nodeRoot, teamsRoot, memRoot, driveRoot] = process.argv.slice(2)
if (!nodeRoot || !teamsRoot || !memRoot || !driveRoot) throw new Error("Provide node, teams, mem and drive checkout roots")
const load = (root: string, path: string) => import(pathToFileURL(resolve(root, path)).href)
const { hostedAgentSpecInput } = await load(nodeRoot, "src/hosted-agent-types.ts")
const { hostedAgentRef } = await load(memRoot, "app/src/lib/ain-integration/agents.ts")
const { agentRefToAinizeAgent } = await load(teamsRoot, "web/src/lib/ain-integration/agents.ts")
const { invokeAgent: teamsInvoke } = await load(teamsRoot, "web/src/lib/ain-integration/a2a.ts")
const { invokeAgent: memInvoke } = await load(memRoot, "app/src/lib/ain-integration/a2a.ts")
const { A2aChatAccumulator } = await load(driveRoot, "web/node_modules/ain-ui/dist/chat.js")
const spec=hostedAgentSpecInput.parse(agentSpec({id:'builder-check',name:'Builder Check',task:'Summarize project files',sources:'Drive and Mem',response:'Cite sources',visibility:'org',orgId:'comcom'},'Qwen3.8-Flash-Next'))
hostedAgentSpecInput.parse({...spec, mode:'tools',files:{'index.mjs':driveTools('https://ainize.ai/code/_builder/drive/tool')},allowedHosts:['ainize.ai'],secretNames:['AINDRIVE_BUILDER_GRANT']})
hostedAgentSpecInput.parse({...spec,mode:'tools',files:{'index.mjs':'import {tools} from "./mcp.mjs"; export default {tools};','mcp.mjs':mcpTools('https://ainize.ai/code/_builder/mcp/tool',{consent:true,teams:{workspaceId:'w1',channels:[{id:'c1',name:'Project'}],tools:['read_channel']},mem:{pages:[{id:'p1',name:'Knowledge'}],tools:['app-fetch']}})},allowedHosts:['ainize.ai'],secretNames:['AIN_MCP_BUILDER_GRANT']})
const row={...spec,owner:'sso:fixture',version:1,status:'ready',org_id:spec.orgId,a2a_url:'https://node.example/agents/'+spec.id}
const agent=hostedAgentRef('https://node.example',row)
assert.equal(agentRefToAinizeAgent(agent).id,spec.id)
assert.deepEqual(agent.outputModes,['text/plain'])
const task={kind:'task',id:'task-1',contextId:'ctx-1',status:{state:'completed'},artifacts:[{artifactId:'answer',parts:[{kind:'text',text:'Project summary with sources.'}]}]}
const requests=[]
for(const [product,invoke] of [['ainteams',teamsInvoke],['ainmem',memInvoke]]){
 const result=await invoke({agent,text:'Summarize',files:[],scope:{account:'user-1',org:'comcom',product,room:null,conversation:'thread-1'},idempotencyKey:'idempotency-1',fetch:async(url,init)=>{const body=JSON.parse(init.body);requests.push(body);assert.equal(body.method,'message/send');return Response.json({jsonrpc:'2.0',id:body.id,result:task})}})
 assert.equal(result.text,'Project summary with sources.');assert.equal(result.task.status,'completed')
}
assert.notEqual(requests[0].params.message.contextId,requests[1].params.message.contextId)
const drive=new A2aChatAccumulator().push(task)
assert.equal(drive.text,'Project summary with sources.');assert.equal(drive.state,'completed')
console.log('PASS: actual Ainize schema, Teams catalogue + invocation, Mem reference + invocation, Drive A2A accumulator; product conversation boundaries preserved. Fixture transport only, no production calls.')
