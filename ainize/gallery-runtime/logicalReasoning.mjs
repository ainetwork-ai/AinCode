import { callLLM } from './bridge.mjs';
import { withoutLLMRouting } from './requestContext.mjs';
export const DEFAULT_MAX_FACTS = 15;
/**
 * Memory Class: Manages logical propositions and reasoning paths
 *
 * This class acts as the knowledge store and orchestrator for multiple
 * reasoning paths, allowing the agent to explore different lines of thought
 * while maintaining a shared base of verified facts.
 */
export class ThinkingMemory {
    searchPaths;
    sharedVerifiedFacts;
    maxPaths;
    maxFacts;
    constructor(initialProposition, maxPaths = 3, maxFacts = DEFAULT_MAX_FACTS) {
        this.maxPaths = maxPaths;
        this.maxFacts = maxFacts;
        this.searchPaths = new Map();
        this.sharedVerifiedFacts = new Set();
        if (initialProposition) {
            this.searchPaths.set('path-1', {
                id: 'path-1',
                propositions: [initialProposition],
                confidence: 1.0
            });
            this.sharedVerifiedFacts.add(initialProposition);
        }
    }
    /**
     * Get current reasoning context including all paths and shared facts
     */
    getContext() {
        const paths = [];
        for (const path of this.searchPaths.values()) {
            paths.push({
                id: path.id,
                propositions: [...path.propositions],
                confidence: path.confidence
            });
        }
        return {
            sharedFacts: Array.from(this.sharedVerifiedFacts),
            paths
        };
    }
    /**
     * Add a new proposition to a specific reasoning path
     */
    addPropositionToPath(pathId, proposition) {
        const path = this.searchPaths.get(pathId);
        if (path && !path.propositions.includes(proposition)) {
            path.propositions.push(proposition);
        }
    }
    /**
     * Add a verified fact to the shared knowledge base
     * This fact will be propagated to all reasoning paths
     */
    addVerifiedFact(fact, confidence = 1.0) {
        console.log(`🧠 [ThinkingMemory] New verified fact: "${fact}" (confidence: ${confidence})`);
        this.sharedVerifiedFacts.add(fact);
        // Propagate to all paths
        for (const path of this.searchPaths.values()) {
            if (!path.propositions.includes(fact)) {
                path.propositions.push(fact);
            }
        }
    }
    /**
     * Create a new reasoning path (e.g., for exploring alternative hypotheses)
     */
    createNewPath(basePropositions) {
        const pathId = `path-${this.searchPaths.size + 1}`;
        if (this.searchPaths.size >= this.maxPaths) {
            // Remove lowest confidence path
            let lowestConfidence = Infinity;
            let lowestPathId = '';
            for (const [id, path] of this.searchPaths) {
                if (path.confidence < lowestConfidence) {
                    lowestConfidence = path.confidence;
                    lowestPathId = id;
                }
            }
            if (lowestPathId) {
                this.searchPaths.delete(lowestPathId);
                console.log(`🗑️ [ThinkingMemory] Removed low confidence path: ${lowestPathId}`);
            }
        }
        this.searchPaths.set(pathId, {
            id: pathId,
            propositions: [...basePropositions],
            confidence: 0.5
        });
        console.log(`🌱 [ThinkingMemory] Created new reasoning path: ${pathId}`);
        return pathId;
    }
    replaceFacts(facts) {
        this.sharedVerifiedFacts.clear();
        facts.forEach(fact => this.sharedVerifiedFacts.add(fact));
        for (const path of this.searchPaths.values()) {
            path.propositions = [...facts];
        }
    }
    isOverLimit() {
        return this.sharedVerifiedFacts.size > this.maxFacts;
    }
    getFacts() {
        return Array.from(this.sharedVerifiedFacts);
    }
    /**
     * Export all verified facts as a single string
     */
    exportFacts() {
        return Array.from(this.sharedVerifiedFacts).join('\n');
    }
    /**
     * Import facts from a string (used for persistence)
     */
    static fromFacts(factsString, maxFacts = DEFAULT_MAX_FACTS) {
        const memory = new ThinkingMemory(undefined, 3, maxFacts);
        if (factsString && factsString !== '(empty)') {
            const facts = factsString.split('\n').filter(f => f.trim());
            facts.forEach(fact => memory.addVerifiedFact(fact));
        }
        return memory;
    }
}
/**
 * Prompt Class: Creative reasoning engine
 *
 * Generates new propositions based on existing knowledge using LLM.
 * This class is responsible for creative thinking and hypothesis generation.
 */
export class ReasoningPrompt {
    modelName;
    domain;
    constructor(modelName, domain) {
        this.modelName = modelName;
        this.domain = domain;
    }
    /**
     * Generate next logical propositions based on current memory context
     */
    async generateNextPropositions(memoryContext, intent, conversationContext) {
        console.log("💡 [ReasoningPrompt] Generating next logical propositions...");
        const domainContext = this.domain ? `\nDomain: ${this.domain}` : '';
        const conversationCtx = conversationContext ? `\n\nRecent conversation:\n${conversationContext}` : '';
        const prompt = `You are an advanced reasoning system. Given the current knowledge base and intent, generate 2-3 new logical propositions.

Intent: ${intent}${domainContext}

# Current verified facts:
${memoryContext.sharedFacts.length > 0 ? memoryContext.sharedFacts.join('\n') : '(No facts yet)'}

# Current reasoning paths:
${memoryContext.paths.map(p => `## Path ${p.id} (confidence: ${p.confidence})\n${p.propositions.join('\n')}`).join('\n\n')}${conversationCtx}

# Your task:
Generate 2-3 new propositions that:
1. Build upon existing knowledge
2. Are relevant to the intent "${intent}"
3. Use first-order logic style natural language
4. Are specific and actionable (not vague generalizations)
5. Could be examples, deeper insights, or logical consequences
- Only extract knowledge relevant to "${intent}". Ignore unrelated parts of the conversation.

Return ONLY a JSON array of strings, no other text:
["proposition 1", "proposition 2", "proposition 3"]`;
        try {
            // Use LLM for background reasoning tasks
            const text = await callLLM([
                { role: "system", content: "You are an advanced reasoning system that generates logical propositions." },
                { role: "user", content: prompt }
            ]);
            console.log('📝 [ReasoningPrompt] Raw response:', text.substring(0, 200));
            // Extract JSON array from response
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const jsonString = jsonMatch[0];
                console.log('🔍 [ReasoningPrompt] Extracted JSON:', jsonString);
                try {
                    // Clean up JSON string before parsing
                    const cleanedJson = jsonString
                        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove control characters
                        .replace(/\n/g, '\\n') // Escape newlines within strings
                        .replace(/\r/g, '\\r'); // Escape carriage returns
                    const propositions = JSON.parse(cleanedJson);
                    console.log(`💡 Generated ${propositions.length} propositions`);
                    return propositions;
                }
                catch (parseError) {
                    console.error('❌ [ReasoningPrompt] JSON parse error:', parseError);
                    console.error('Failed JSON string:', jsonString);
                    // Fallback: try to extract propositions manually
                    const fallbackMatch = jsonString.match(/"([^"]+)"/g);
                    if (fallbackMatch) {
                        const fallbackProps = fallbackMatch.map(s => s.replace(/^"|"$/g, ''));
                        console.log(`🔧 [ReasoningPrompt] Fallback extracted ${fallbackProps.length} propositions`);
                        return fallbackProps;
                    }
                    return [];
                }
            }
            console.warn("⚠️ [ReasoningPrompt] No valid JSON found in response");
            return [];
        }
        catch (error) {
            console.error("❌ [ReasoningPrompt] Error generating propositions:", error);
            return [];
        }
    }
    /**
     * Generate an initial proposition from a conversation or topic
     */
    async generateInitialProposition(intent, conversationContext) {
        const prompt = `Based on this conversation about "${intent}", create ONE clear, foundational proposition that captures the core concept.

Conversation:
${conversationContext}

Return ONLY the proposition as a single sentence, nothing else.`;
        try {
            const text = await callLLM([
                { role: "system", content: "You are an advanced reasoning system." },
                { role: "user", content: prompt }
            ]);
            return text.trim();
        }
        catch (error) {
            console.error("❌ [ReasoningPrompt] Error generating initial proposition:", error);
            return `Core concept: ${intent}`;
        }
    }
}
/**
 * Verifier Class: Logical consistency checker
 *
 * Validates that new propositions are logically consistent with
 * existing knowledge and don't introduce contradictions.
 */
export class LogicalVerifier {
    modelName;
    constructor(modelName) {
        this.modelName = modelName;
    }
    /**
     * Verify if a proposition is logically consistent with existing facts
     */
    async verify(memoryContext, proposition, groundTruth, conversationContext) {
        console.log(`🛡️ [LogicalVerifier] Verifying: "${proposition}"`);
        const prompt = `You are a strict logical consistency checker. Verify if the candidate proposition is logically consistent with all available evidence.

# Agent's core knowledge (ground truth):
${groundTruth || '(none)'}

# Source conversation:
${conversationContext || '(none)'}

# Established facts from previous reasoning:
${memoryContext.sharedFacts.length > 0 ? memoryContext.sharedFacts.join('\n') : '(No facts yet)'}

# Candidate proposition:
"${proposition}"

# Your task:
Determine if this proposition:
1. Is consistent with the agent's core knowledge (no contradictions with ground truth)
2. Is grounded in the source conversation (not hallucinated)
3. Is consistent with established facts (no contradictions)
4. Adds meaningful information (not redundant)

Respond in this EXACT format:
VERDICT: [VALID/INVALID/UNCERTAIN]
CONFIDENCE: [0.0-1.0]
REASON: [brief explanation]

Examples:
VERDICT: VALID
CONFIDENCE: 0.9
REASON: Logically follows from existing facts and adds new insight

VERDICT: INVALID
CONFIDENCE: 0.8
REASON: Contradicts established fact about X`;
        try {
            const text = await withoutLLMRouting(() => callLLM([
                { role: "system", content: "You are a strict logical consistency checker." },
                { role: "user", content: prompt }
            ]));
            // Parse verification result
            const verdictMatch = text.match(/VERDICT:\s*(VALID|INVALID|UNCERTAIN)/i);
            const confidenceMatch = text.match(/CONFIDENCE:\s*(0?\.\d+|1\.0|0|1)/);
            const reasonMatch = text.match(/REASON:\s*(.+?)$/s);
            const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'UNCERTAIN';
            const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5;
            const reason = reasonMatch ? reasonMatch[1].trim() : 'Unable to determine';
            const valid = verdict === 'VALID' && confidence >= 0.7;
            console.log(`🛡️ [LogicalVerifier] Result: ${verdict} (confidence: ${confidence})`);
            return { valid, confidence, reason };
        }
        catch (error) {
            console.error("❌ [LogicalVerifier] Error during verification:", error);
            return { valid: false, confidence: 0, reason: 'Verification failed' };
        }
    }
}
/**
 * Main Reasoning Engine
 *
 * Orchestrates the Memory-Prompt-Verifier cycle to evolve agent thinking
 */
export class LogicalReasoningEngine {
    memory;
    prompt;
    verifier;
    groundTruth;
    maxFacts;
    constructor(modelName, initialKnowledge, domain, maxFacts = DEFAULT_MAX_FACTS, groundTruth) {
        this.groundTruth = groundTruth;
        this.maxFacts = maxFacts;
        this.memory = initialKnowledge
            ? ThinkingMemory.fromFacts(initialKnowledge, maxFacts)
            : new ThinkingMemory(undefined, 3, maxFacts);
        this.prompt = new ReasoningPrompt(modelName, domain);
        this.verifier = new LogicalVerifier(modelName);
    }
    async consolidateFacts(intent) {
        const facts = this.memory.getFacts();
        const maxFacts = this.maxFacts;
        console.log(`📦 [ReasoningEngine] Consolidating ${facts.length} facts for "${intent}" (limit: ${maxFacts})`);
        const prompt = `You have ${facts.length} facts about "${intent}". Consolidate them into ${maxFacts} or fewer facts.

Rules:
- Merge similar or overlapping facts into one
- Remove outdated facts that are superseded by newer ones
- Keep the most actionable and specific facts
- Preserve the most important insights
- Do NOT add new information that isn't in the original facts

Current facts:
${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Return ONLY a JSON array of consolidated facts, no other text:
["fact 1", "fact 2", ...]`;
        try {
            const text = await callLLM([
                { role: "system", content: "You consolidate knowledge into concise, non-redundant facts." },
                { role: "user", content: prompt }
            ]);
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const consolidated = JSON.parse(jsonMatch[0]);
                this.memory.replaceFacts(consolidated);
                console.log(`✅ [ReasoningEngine] Consolidated ${facts.length} → ${consolidated.length} facts`);
            }
            else {
                console.warn('⚠️ [ReasoningEngine] Consolidation parse failed, keeping original facts');
            }
        }
        catch (error) {
            console.error('❌ [ReasoningEngine] Consolidation error, keeping original facts:', error);
        }
    }
    /**
     * Run one cycle of reasoning: generate propositions and verify them
     */
    async runCycle(intent, conversationContext) {
        console.log(`\n🌀 [ReasoningEngine] Running cycle for intent: "${intent}"`);
        const context = this.memory.getContext();
        // If no facts exist yet, generate an initial proposition
        if (context.sharedFacts.length === 0 && conversationContext) {
            const initialProp = await this.prompt.generateInitialProposition(intent, conversationContext);
            this.memory.addVerifiedFact(initialProp);
            console.log(`🌱 [ReasoningEngine] Created initial proposition: "${initialProp}"`);
        }
        // Generate candidate propositions
        const candidates = await this.prompt.generateNextPropositions(context, intent, conversationContext);
        if (candidates.length === 0) {
            console.log("⚠️ [ReasoningEngine] No candidates generated");
            return { factsAdded: 0, totalFacts: context.sharedFacts.length };
        }
        let factsAdded = 0;
        const verifications = await Promise.all(candidates.map(candidate => this.verifier.verify(context, candidate, this.groundTruth, conversationContext)
            .then(result => ({ candidate, result }))));
        for (const { candidate, result } of verifications) {
            if (result.valid) {
                this.memory.addVerifiedFact(candidate, result.confidence);
                factsAdded++;
            }
            else {
                console.log(`❌ [ReasoningEngine] Rejected: "${candidate}" - ${result.reason}`);
            }
        }
        const finalContext = this.memory.getContext();
        console.log(`✅ [ReasoningEngine] Cycle complete. Added ${factsAdded} facts. Total: ${finalContext.sharedFacts.length}`);
        return { factsAdded, totalFacts: finalContext.sharedFacts.length };
    }
    /**
     * Run multiple cycles of reasoning
     */
    async evolve(intent, cycles = 2, conversationContext) {
        console.log(`🚀 [ReasoningEngine] Starting evolution for "${intent}" (${cycles} cycles)`);
        for (let i = 0; i < cycles; i++) {
            const result = await this.runCycle(intent, conversationContext);
            if (result.factsAdded === 0) {
                console.log("⏹️ [ReasoningEngine] No new facts added, stopping early");
                break;
            }
        }
        if (this.memory.isOverLimit()) {
            await this.consolidateFacts(intent);
        }
        return this.memory.exportFacts();
    }
    /**
     * Get current knowledge as a string
     */
    getKnowledge() {
        return this.memory.exportFacts();
    }
    /**
     * Get current reasoning context
     */
    getContext() {
        return this.memory.getContext();
    }
}
