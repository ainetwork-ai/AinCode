import{getAgent,setAgent,getConversationHistory}from'./bridge.mjs';
import{evolveThinking}from'./thinkingEvolution.mjs';
import{LogicalReasoningEngine}from'./logicalReasoning.mjs';
import{classifyIntent}from'./intentClassifier.mjs';
const recentUpdates=new Map();
function key(v){if(typeof v!=='string'||!v.trim()||v.length>256)throw Error('invalid_memory_key');return v;}
export async function manageMemory(source,action,p){
 const a=await getAgent(source.id);
 if(action==='status')return {thinking:a.thinkingMemories||{},caring:a.caringMemories||{},intentPatterns:a.intentPatterns||{},contextHistory:p.contextId?await getConversationHistory(key(p.contextId)):undefined,historicalMemoryImported:a._migration?.fullSourceStateImported??true};
 if(action==='memory.set'){
  if(!['thinking','caring'].includes(p.kind)||typeof p.text!=='string'||p.text.length>131072)throw Error('invalid_memory');
  const field=p.kind==='thinking'?'thinkingMemories':'caringMemories';await setAgent(source.id,{...a,[field]:{...(a[field]||{}),[key(p.key)]:p.text}});return {saved:true};
 }
 if(action==='thinking.evolve'){
  if(p.cycles!==undefined&&(!Number.isInteger(p.cycles)||p.cycles<1||p.cycles>5))throw Error('invalid_cycles');
  return evolveThinking({agentId:source.id,intent:key(p.intent),conversationContext:typeof p.conversationContext==='string'?p.conversationContext.slice(0,50000):'',cycles:p.cycles||2});
 }
 if(action!=='memory.update')throw Error('unsupported_action');
 const context=key(p.contextId),username=p.username?key(p.username):context;
 if(!Array.isArray(p.conversationHistory)||p.conversationHistory.length>100)throw Error('invalid_history');
 const recent=p.conversationHistory.slice(-6).map(m=>{if(!m||!['user','agent','assistant'].includes(m.role))throw Error('invalid_history');const text=(m.parts||[]).find(p=>p.kind==='text'||p.type==='text')?.text??m.text;if(typeof text!=='string'||text.length>50000)throw Error('invalid_history');return `${m.role}: ${text}`;}).join('\n');
 const last=recentUpdates.get(source.id)||0;if(Date.now()-last<60000)return {success:true,skipped:true,waitSeconds:Math.ceil((60000-Date.now()+last)/1000)};
 recentUpdates.set(source.id,Date.now());
 const intent=p.intent?key(p.intent):await classifyIntent(source.id,recent,Object.keys(a.thinkingMemories||{}).at(-1));
 const thinking=await evolveThinking({agentId:source.id,intent,conversationContext:recent,cycles:1});
 const original=a.caringMemories?.[username];const engine=new LogicalReasoningEngine(undefined,original,`Understanding how user "${username}" thinks and reasons`);
 const caring=await engine.evolve(`user_${username}_thinking`,1,recent);const latest=await getAgent(source.id);
 const caringUpdated=!!caring&&caring!==original&&caring!=='(empty)';if(caringUpdated)await setAgent(source.id,{...latest,caringMemories:{...(latest.caringMemories||{}),[username]:caring}});
 return {success:thinking.success,intent,username,thinking:thinking.newThinking,caring,updated:{thinkingUpdated:thinking.factsAdded>0,caringUpdated}};
}
