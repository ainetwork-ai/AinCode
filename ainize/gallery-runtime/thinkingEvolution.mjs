import { LogicalReasoningEngine } from './logicalReasoning.mjs';
import { getAgent, setAgent } from './bridge.mjs';
import { getIntents } from './bridge.mjs';
import { callLLM } from './bridge.mjs';
/**
 * Evolve an agent's thinking about a specific intent using logical reasoning
 */
export async function evolveThinking(config) {
    const { agentId, intent, conversationContext, cycles = 2, modelName = 'gemini-2.5-flash' } = config;
    console.log(`🧬 [ThinkingEvolution] Evolving thinking for agent "${agentId}", intent: "${intent}"`);
    try {
        // Get current agent
        const agent = await getAgent(agentId);
        if (!agent) {
            throw new Error(`Agent not found: ${agentId}`);
        }
        // Get current thinking for this intent
        const thinkingMemories = agent.thinkingMemories || {};
        const previousThinking = thinkingMemories[intent] || '(empty)';
        console.log(`📖 Previous thinking (${previousThinking.length} chars):`, previousThinking.substring(0, 100) + (previousThinking.length > 100 ? '...' : ''));
        // Build ground truth from base prompt + form knowledge
        const intents = await getIntents(agentId);
        const knowledgeContext = intents.map(i => `[${i.name}] ${i.prompt}`).join('\n');
        const groundTruth = knowledgeContext
            ? `${agent.prompt}\n\n${knowledgeContext}`
            : agent.prompt;
        // Initialize reasoning engine with current knowledge
        const reasoningEngine = new LogicalReasoningEngine(modelName, previousThinking !== '(empty)' ? previousThinking : undefined, agent.card.description, 15, groundTruth);
        // Run reasoning cycles
        const newThinking = await reasoningEngine.evolve(intent, cycles, conversationContext);
        const context = reasoningEngine.getContext();
        const factsAdded = context.sharedFacts.length -
            (previousThinking !== '(empty)' ? previousThinking.split('\n').length : 0);
        console.log(`✨ New thinking (${newThinking.length} chars):`, newThinking.substring(0, 100) + (newThinking.length > 100 ? '...' : ''));
        console.log(`📊 Facts: ${context.sharedFacts.length} total, ${factsAdded} new`);
        // Update agent's thinking memory
        thinkingMemories[intent] = newThinking;
        await setAgent(agentId, {
            ...agent,
            thinkingMemories
        });
        return {
            success: true,
            previousThinking,
            newThinking,
            factsAdded
        };
    }
    catch (error) {
        console.error('❌ [ThinkingEvolution] Error:', error);
        return {
            success: false,
            previousThinking: '',
            newThinking: '',
            factsAdded: 0
        };
    }
}
/**
 * Automatically evolve thinking after a conversation
 * This can be called after the agent responds to update its knowledge
 */
export async function autoEvolveAfterConversation(agentId, intent, conversationHistory) {
    // Only evolve if conversation has meaningful content (more than just greetings)
    if (conversationHistory.length < 3) {
        console.log('⏭️ [ThinkingEvolution] Skipping auto-evolution - conversation too short');
        return;
    }
    // Build conversation context from recent messages
    const conversationContext = conversationHistory
        .slice(-6) // Last 6 messages
        .map(msg => `${msg.role}: ${msg.text}`)
        .join('\n');
    // Run one cycle of evolution asynchronously (don't block response)
    evolveThinking({
        agentId,
        intent,
        conversationContext,
        cycles: 1 // Just one cycle for auto-evolution
    }).catch(error => {
        console.error('❌ [ThinkingEvolution] Auto-evolution failed:', error);
    });
    console.log('🔄 [ThinkingEvolution] Auto-evolution started in background');
}
/**
 * Get a summary of an agent's thinking on a specific intent
 */
export async function getThinkingSummary(agentId, intent) {
    const agent = await getAgent(agentId);
    if (!agent) {
        return 'Agent not found';
    }
    const thinkingMemories = agent.thinkingMemories || {};
    const thinking = thinkingMemories[intent];
    if (!thinking || thinking === '(empty)') {
        return `No knowledge about "${intent}" yet.`;
    }
    const facts = thinking.split('\n').filter(f => f.trim());
    return `Knowledge about "${intent}" (${facts.length} facts):\n${facts.slice(0, 5).join('\n')}${facts.length > 5 ? '\n...' : ''}`;
}
/**
 * Compare thinking between two intents to find connections
 */
export async function findIntentConnections(agentId, intent1, intent2) {
    const agent = await getAgent(agentId);
    if (!agent) {
        return [];
    }
    const thinkingMemories = agent.thinkingMemories || {};
    const thinking1 = thinkingMemories[intent1];
    const thinking2 = thinkingMemories[intent2];
    if (!thinking1 || !thinking2) {
        return [];
    }
    // Use LLM to find connections
    const prompt = `Find connections between these two knowledge bases:

Knowledge about "${intent1}":
${thinking1}

Knowledge about "${intent2}":
${thinking2}

List 2-3 meaningful connections or relationships between these topics.
Return as JSON array: ["connection 1", "connection 2"]`;
    try {
        const text = await callLLM([
            { role: "system", content: "You are a helpful assistant that finds connections between topics." },
            { role: "user", content: prompt }
        ]);
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    }
    catch (error) {
        console.error('❌ [ThinkingEvolution] Error finding connections:', error);
    }
    return [];
}
