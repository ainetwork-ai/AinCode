import { AsyncLocalStorage } from 'node:async_hooks';
export const HEADER_THREAD_ID = 'X-Thread-Id';
export const HEADER_AGENT_ID = 'X-Agent-Id';
export const llmRoutingStorage = new AsyncLocalStorage();
export function getLLMRoutingContext() {
    return llmRoutingStorage.getStore() ?? {};
}
export function withLLMRouting(request, ctx, fn) {
    const threadId = request.headers.get(HEADER_THREAD_ID) ?? undefined;
    return llmRoutingStorage.run({ threadId, agentId: ctx.agentId }, fn);
}
// Drop all routing affinity for short/sub-task LLM calls (intent classification,
// logical verifier) where prefix cache gain is negligible. Lets nginx fall back
// to $request_id for natural load balancing across vLLM instances.
export function withoutLLMRouting(fn) {
    return llmRoutingStorage.run({}, fn);
}
