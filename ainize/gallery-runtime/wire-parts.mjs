/** Normalize original v0.3 replies for Ainize's v1 runtime; its adapter returns v0.3 to old callers. */
export function toRuntimePart(part){
 if(part.content)return part;
 if(part.kind==='file'){
  const file=part.file||{};
  if(typeof file.uri==='string')return {content:{$case:'url',value:file.uri},mediaType:file.mimeType||'',filename:file.name||'',metadata:part.metadata};
  if(typeof file.bytes==='string')return {content:{$case:'raw',value:Buffer.from(file.bytes,'base64')},mediaType:file.mimeType||'',filename:file.name||'',metadata:part.metadata};
  throw new Error('Original file part has neither a URI nor bytes');
 }
 if(part.kind==='data')return {content:{$case:'data',value:part.data},metadata:part.metadata};
 if(part.kind==='text')return {content:{$case:'text',value:part.text},metadata:part.metadata};
 throw new Error('Unsupported original response part');
}
