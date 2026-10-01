import {AsyncLocalStorage} from 'node:async_hooks';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
const active=new AsyncLocalStorage();
const turns=new Map();
export async function withTurn(value,fn){
 const key=(value.stateRoot||'')+'/'+value.targetId;
 const prior=turns.get(key)||Promise.resolve();
 const run=prior.catch(()=>{}).then(()=>active.run(value,fn));turns.set(key,run);
 try{return await run}finally{if(turns.get(key)===run)turns.delete(key)}
}
function current(){const v=active.getStore();if(!v)throw new Error('No agent turn context');return v;}
function storagePath(){const v=current();if(!v.stateRoot)throw new Error('Durable state directory is required');return join(v.stateRoot,v.targetId+'.json');}
function read(){const p=storagePath();const v=current();const d=existsSync(p)?JSON.parse(readFileSync(p,'utf8')):structuredClone({agent:v.source.rawState,sentImages:{}});d.agent={...d.agent,card:v.source.rawState.card,prompt:v.source.prompt,useSkills:v.source.useSkills,modelName:v.ctx.spec.model};return d;}
function save(d){const p=storagePath();mkdirSync(dirname(p),{recursive:true,mode:0o700});const tmp=p+'.tmp';writeFileSync(tmp,JSON.stringify(d),{mode:0o600});renameSync(tmp,p);}
export async function getAgent(id){const v=current();if(id!==v.source.id)throw new Error('Cross-agent state access denied');return read().agent;}
export async function setAgent(id,agent){await getAgent(id);const d=read();d.agent=agent;save(d);}
export async function getIntents(id){await getAgent(id);return structuredClone(current().source.intents||[]);}
export async function getSkillInstructions(id){await getAgent(id);return Object.fromEntries((current().source.skills||[]).filter(s=>s.instructions).map(s=>[s.id,s.instructions]));}
export async function getSentImageIntents(id,context){await getAgent(id);const item=read().sentImages?.[context];return item&&item.expiresAt>Date.now()?item.names:[];}
export async function markImageIntentSent(id,context,intent){const prior=await getSentImageIntents(id,context);const d=read();d.sentImages??={};d.sentImages[context]={names:[...new Set([...prior,intent])],expiresAt:Date.now()+86400000};save(d);}
export async function callLLM(messages,maxTokens=16384){const response=await current().ctx.llm.chat({messages,max_tokens:maxTokens});if(typeof response.message.content!=='string')throw new Error('Expected a text response from the selected Ainize model');return response.message.content;}
export async function getConversationHistory(context){const history=read().histories?.[context];return Array.isArray(history)?history:undefined;}
export async function saveConversationHistory(context,history){const d=read();d.histories??={};d.histories[context]=history;save(d);}
