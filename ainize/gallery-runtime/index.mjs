import {toRuntimePart} from './wire-parts.mjs';
import source from './source.json' with {type:'json'};
import {DynamicAgentExecutor} from './executor.mjs';
import {manageMemory} from './manage.mjs';
import {withTurn,getConversationHistory,saveConversationHistory} from './bridge.mjs';
const executor=new DynamicAgentExecutor(source.id,source.prompt,'ainize','Qwen3.8-Flash-Next');
export async function execute(text,ctx){
 text=ctx.input.textParts?.[0]??text;
 const metadata=ctx.input.metadata||{};
 return withTurn({source,ctx,targetId:ctx.spec.id,stateRoot:process.env.AINIZE_AGENT_STATE_DIR?.startsWith('b64:')?Buffer.from(process.env.AINIZE_AGENT_STATE_DIR.slice(4),'base64').toString():process.env.AINIZE_AGENT_STATE_DIR},async()=>{
  const key=executor.getContextKey(ctx.input.contextId);
  if(!DynamicAgentExecutor.historyStore[key]){const previous=await getConversationHistory(ctx.input.contextId);if(previous)DynamicAgentExecutor.historyStore[key]=previous;}
  let reply;
  await executor.execute({contextId:ctx.input.contextId,userMessage:{kind:'message',messageId:crypto.randomUUID(),role:'user',contextId:ctx.input.contextId,parts:[{kind:'text',text}],metadata}}, {publish:message=>{reply=message},finished:()=>{}});
  if(DynamicAgentExecutor.historyStore[key])await saveConversationHistory(ctx.input.contextId,DynamicAgentExecutor.historyStore[key]);
  if(!reply)throw new Error('Original executor produced no reply');
  return {text:reply.parts.filter(p=>p.kind==='text').map(p=>p.text).join('\n'),parts:reply.parts.filter(p=>p.kind!=='text').map(toRuntimePart),metadata:reply.metadata};
 });
}

export async function manage(action,params,ctx){return withTurn({source,ctx,targetId:ctx.spec.id,stateRoot:process.env.AINIZE_AGENT_STATE_DIR?.startsWith('b64:')?Buffer.from(process.env.AINIZE_AGENT_STATE_DIR.slice(4),'base64').toString():process.env.AINIZE_AGENT_STATE_DIR},()=>manageMemory(source,action,params));}
