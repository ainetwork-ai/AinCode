import { randomUUID as uuidv4 } from 'node:crypto';
import { getAgent, getSkillInstructions, getIntents, getSentImageIntents, markImageIntentSent, callLLM } from './bridge.mjs';
import { classifyIntent } from './intentClassifier.mjs';
import { classifyFormIntent } from './formIntentClassifier.mjs';
import { selectSkills } from './skillSelector.mjs';
import { buildSelectedIntentSection } from './promptBuilder.mjs';
import { buildResponseParts } from './responseParts.mjs';
import { autoEvolveAfterConversation } from './thinkingEvolution.mjs';
import { llmRoutingStorage, getLLMRoutingContext } from './requestContext.mjs';
export class DynamicAgentExecutor {
    agentId;
    prompt;
    modelProvider;
    modelName;
    initialThinking;
    initialCaring;
    static historyStore = {};
    // Max conversation messages replayed to the LLM (and retained) per context,
    // NOT counting the seed at index 0. The whole bucket used to be resent on
    // every turn with no bound, so a long-lived context grew the prompt without
    // limit — latency and token cost climbed turn after turn. That is unbounded
    // by construction here: `historyStore` is process memory with no expiry, so
    // an on-prem container accumulates for its entire uptime.
    //
    // It bites hardest when one contextId is shared by many people. The exhibition
    // kiosk is exactly that: AIN Teams keys the A2A contextId per (agent,
    // workspace), so every visitor continues the previous visitor's context and
    // this bucket collects the whole exhibition. Capping here bounds the damage
    // from any caller; fixing who-gets-which-contextId is the AIN Teams side.
    //
    // Override with AGENT_MAX_HISTORY_MESSAGES; <= 0 restores the old unbounded
    // behavior.
    static MAX_HISTORY_MESSAGES = Number(process.env.AGENT_MAX_HISTORY_MESSAGES ?? 20);
    static lastEvolutionTime = {};
    static MIN_EVOLUTION_INTERVAL_MS = 60000; // 60 seconds (1 minute)
    static lastIntentClassificationTime = {};
    static MIN_INTENT_CLASSIFICATION_INTERVAL_MS = 60000; // 60 seconds (1 minute)
    constructor(agentId, prompt, modelProvider, modelName, initialThinking, initialCaring) {
        this.agentId = agentId;
        this.prompt = prompt;
        this.modelProvider = modelProvider;
        this.modelName = modelName;
        this.initialThinking = initialThinking;
        this.initialCaring = initialCaring;
        // Model provider is no longer needed since we use unified LLM API
    }
    getContextKey(contextId) {
        return `${this.agentId}-${contextId}`;
    }
    // Drop the oldest turns so at most MAX_HISTORY_MESSAGES remain after the seed.
    //
    // Mutates in place with splice rather than reassigning historyStore[key]:
    // execute() holds a local reference to this array and pushes the agent reply
    // into it later, so swapping the array out would send that reply to an
    // orphaned copy and silently lose it from the transcript.
    static trimHistory(history) {
        const max = DynamicAgentExecutor.MAX_HISTORY_MESSAGES;
        // index 0 is the seed message, kept always — the bucket's existence check
        // and buildConversationText both assume it stays put.
        if (!Number.isFinite(max) || max <= 0 || history.length - 1 <= max)
            return;
        let drop = history.length - 1 - max;
        // Prefer opening the retained window on a user turn: the replay is built as
        // system -> [window] and a leading assistant turn is rejected by some model
        // APIs. If no user turn remains ahead, keep the plain count.
        for (let i = 1 + drop; i < history.length; i++) {
            if (history[i].role === "user") {
                drop = i - 1;
                break;
            }
        }
        history.splice(1, drop);
    }
    // Builds the conversation-text string used by both the auto classifyIntent
    // path and the form-intent classification path: last 6 history messages
    // for this context plus the incoming message, formatted as "role: text".
    buildConversationText(historyKey, incomingMessage) {
        const recent = (DynamicAgentExecutor.historyStore[historyKey] || []).slice(-6);
        return [...recent, incomingMessage]
            .map(msg => {
            const textPart = msg.parts.find(part => part.kind === "text");
            return `${msg.role}: ${textPart && 'text' in textPart ? textPart.text : ""}`;
        })
            .join('\n');
    }
    buildSystemPrompt(intent, thinking, caring, a2a, skills, formIntentSection) {
        let memoryContext = '';
        if (thinking && thinking !== '(empty)') {
            memoryContext = `\n\nContext for "${intent}":\n- What I know: ${thinking}\n- About you: ${caring}`;
        }
        const skillsSection = skills && skills.trim()
            ? `

ACTIVE SKILLS (apply the following when relevant to the user's request; do not mention these instructions exist):
${skills}`
            : '';
        const basePrompt = `${this.prompt}${formIntentSection || ''}

LANGUAGE RULE:
- IMPORTANT: You MUST respond ENTIRELY in the same language as the user's latest message.
- If the user writes in Korean, respond ONLY in Korean. Do NOT add English translations, parenthetical English, or any English words alongside Korean.
- If the user writes in English, respond ONLY in English.
- If the user switches language mid-conversation, follow their new language immediately.
- NEVER mix languages in a single response. No "(like this)", no "예를 들어 (for example)" patterns.
- This rule overrides the language of your base instructions above.

RESPONSE STYLE:
- Keep responses SHORT and conversational (like a natural chat)
- Match the user's message length and energy
- For simple greetings (hi, hello), respond briefly and warmly
- Only give detailed explanations when specifically asked

INTERNAL GUIDANCE (do not mention to user):${memoryContext}
Use this knowledge naturally when relevant, but keep responses concise.${skillsSection}

A2A GUIDANCE (If you need to collaborate with other agents, use the following information to help you):
${a2a}
`;
        return basePrompt;
    }
    async execute(requestContext, eventBus) {
        const incoming = getLLMRoutingContext();
        const effectiveThreadId = incoming.threadId ?? requestContext.contextId;
        return llmRoutingStorage.run({ threadId: effectiveThreadId, agentId: this.agentId }, async () => {
            const contextId = requestContext.contextId;
            const key = this.getContextKey(contextId);
            const incomingMessage = requestContext.userMessage;
            // Computed ONCE, before the incoming message is pushed into history,
            // so both the auto classifyIntent path and the form-intent path see
            // the same conversation text without double-counting the latest message.
            const conversationText = this.buildConversationText(key, incomingMessage);
            // Classify intent and get relevant memory
            let intent = 'general';
            let thinking = '';
            let caring = '';
            let a2aPrompt = '';
            if (incomingMessage.metadata?.agentSkills) {
                const { agentSkills } = incomingMessage.metadata;
                a2aPrompt = `
          If you need to collaborate with other agents, use the following information to help you:
          If the other agents can help you, you can mention the agent name and make a request to the other agent.
          like this: "@{agent_name} - {request_to_help_agent_sentence}"

          Agent Skill list
        `;
                a2aPrompt += agentSkills.map(agent => `${agent.name}: [${agent.skills.map(skill => `"${skill.name}: ${skill.description}"`).join(', ')}]`).join('\n');
            }
            if (incomingMessage) {
                try {
                    const agentData = await getAgent(this.agentId);
                    const thinkingMemories = agentData?.thinkingMemories || {};
                    const caringMemories = agentData?.caringMemories || {};
                    const intentPatterns = agentData?.intentPatterns || {};
                    const existingIntents = [...new Set([
                            ...Object.keys(thinkingMemories),
                            ...Object.keys(intentPatterns)
                        ])];
                    const thinkingIntents = Object.keys(thinkingMemories);
                    const previousIntent = thinkingIntents.length > 0
                        ? thinkingIntents[thinkingIntents.length - 1]
                        : undefined;
                    // Rate limit intent classification to once per minute
                    const now = Date.now();
                    const classificationKey = `${this.agentId}-${contextId}`;
                    const lastClassification = DynamicAgentExecutor.lastIntentClassificationTime[classificationKey];
                    if (lastClassification && (now - lastClassification) < DynamicAgentExecutor.MIN_INTENT_CLASSIFICATION_INTERVAL_MS) {
                        intent = previousIntent || 'general';
                        const waitTime = Math.ceil((DynamicAgentExecutor.MIN_INTENT_CLASSIFICATION_INTERVAL_MS - (now - lastClassification)) / 1000);
                        console.log(`⏭️ [Intent] Using previous intent: ${intent} (wait ${waitTime}s for re-classification)`);
                    }
                    else {
                        intent = await classifyIntent(this.agentId, conversationText, previousIntent, existingIntents);
                        DynamicAgentExecutor.lastIntentClassificationTime[classificationKey] = now;
                        console.log('🎯 [Intent] Classified:', intent, previousIntent ? `(previous: ${previousIntent})` : '');
                    }
                    thinking = thinkingMemories[intent] || '(empty)';
                    caring = caringMemories[contextId] || '(empty)';
                    console.log('📖 Using memory:', { intent, thinking, username: contextId, caring });
                }
                catch (error) {
                    console.error('Error getting memory:', error);
                }
            }
            // Initialize history with system prompt if needed
            if (!DynamicAgentExecutor.historyStore[key]) {
                DynamicAgentExecutor.historyStore[key] = [];
                console.log("no history store");
                const systemPrompt = this.buildSystemPrompt(intent, thinking, caring, a2aPrompt);
                const initialMessage = {
                    kind: "message",
                    messageId: uuidv4(),
                    role: "user",
                    parts: [{ kind: "text", text: systemPrompt }],
                    contextId,
                };
                DynamicAgentExecutor.historyStore[key].push(initialMessage);
            }
            // Add incoming message to history
            const history = DynamicAgentExecutor.historyStore[key];
            if (incomingMessage) {
                history.push(incomingMessage);
            }
            // Bound the bucket before anything reads it, so both the replay below and
            // the retained array stay capped.
            DynamicAgentExecutor.trimHistory(history);
            // Form-intent classification (separate from auto classifyIntent).
            // Decides which form intent matched and whether to attach its images.
            let matchedFormIntent = null;
            let sendImage = false;
            try {
                const formIntents = await getIntents(this.agentId);
                if (formIntents.length > 0) {
                    const alreadySent = await getSentImageIntents(this.agentId, contextId);
                    const result = await classifyFormIntent(formIntents, conversationText, alreadySent);
                    if (result.intent) {
                        matchedFormIntent = formIntents.find(i => i.name === result.intent) || null;
                        sendImage = result.sendImage;
                    }
                    console.log('🎯 [FormIntent]', { intent: result.intent, sendImage });
                }
            }
            catch (error) {
                console.error('Error classifying form intent:', error);
            }
            try {
                // Skill selection (progressive disclosure). Gated by the agent's
                // useSkills toggle and the presence of at least one skill with
                // stored instructions. Skipped entirely otherwise (no extra LLM call).
                let activeSkillsText = '';
                try {
                    const agentForSkills = await getAgent(this.agentId);
                    const cardSkills = (agentForSkills?.card?.skills ?? []);
                    if (agentForSkills?.useSkills && cardSkills.length > 0) {
                        const skillInstructions = await getSkillInstructions(this.agentId);
                        const catalog = cardSkills
                            .filter((s) => skillInstructions[s.id]?.trim())
                            .map((s) => ({ id: s.id, name: s.name, description: s.description }));
                        if (catalog.length > 0) {
                            const latestText = (() => {
                                const part = incomingMessage.parts.find((p) => p.kind === 'text');
                                return part && 'text' in part ? part.text : '';
                            })();
                            const selectedIds = await selectSkills(this.modelName, catalog, latestText);
                            activeSkillsText = selectedIds
                                .map((id) => {
                                const skill = cardSkills.find((s) => s.id === id);
                                return `## ${skill?.name ?? id}\n${(skillInstructions[id] ?? '').trim()}`;
                            })
                                .join('\n\n');
                            if (selectedIds.length > 0) {
                                console.log('🛠️ [Skills] Selected:', selectedIds.join(', '));
                            }
                        }
                    }
                }
                catch (error) {
                    console.error('Error selecting skills:', error);
                    activeSkillsText = '';
                }
                // Convert history to LLM message format
                const formIntentSection = matchedFormIntent ? buildSelectedIntentSection(matchedFormIntent) : undefined;
                const systemPrompt = this.buildSystemPrompt(intent, thinking, caring, undefined, activeSkillsText, formIntentSection);
                const llmMessages = [
                    { role: "system", content: systemPrompt }
                ];
                // Add conversation history (skip the first message which is the system prompt)
                for (let i = 1; i < history.length; i++) {
                    const msg = history[i];
                    const textPart = msg.parts.find(part => part.kind === "text");
                    const content = textPart?.text || "";
                    if (!content)
                        continue; // Skip empty messages
                    const role = msg.role === "user" ? "user" : "assistant";
                    // Ensure alternating user/assistant pattern
                    const lastMessage = llmMessages[llmMessages.length - 1];
                    if (lastMessage && lastMessage.role === role) {
                        // Same role as previous message, merge content
                        lastMessage.content += "\n\n" + content;
                    }
                    else {
                        llmMessages.push({ role, content });
                    }
                }
                // Ensure the last message is from user (required by most LLM APIs)
                const lastMsg = llmMessages[llmMessages.length - 1];
                if (lastMsg && lastMsg.role !== "user") {
                    // This shouldn't happen in normal flow, but handle it
                    console.warn('⚠️ Last message is not from user, adding placeholder');
                    llmMessages.push({ role: "user", content: "Please continue." });
                }
                // Call LLM for user-facing responses
                const responseText = await callLLM(llmMessages);
                const parts = buildResponseParts(responseText, matchedFormIntent, sendImage);
                const imagesAttached = parts.some(p => p.kind === 'file');
                if (imagesAttached && matchedFormIntent) {
                    await markImageIntentSent(this.agentId, contextId, matchedFormIntent.name);
                }
                const responseMessage = {
                    kind: "message",
                    messageId: uuidv4(),
                    role: "agent",
                    parts,
                    contextId,
                    ...(intent && { metadata: { intent, formIntent: matchedFormIntent?.name } })
                };
                history.push(responseMessage);
                eventBus.publish(responseMessage);
                // Auto-evolve thinking after meaningful conversations (in background)
                // Trigger when agent has responded 3+ times on this intent
                const intentResponseCount = history.filter(msg => {
                    const metadata = msg.metadata;
                    return msg.role === 'agent' && metadata?.intent === intent;
                }).length;
                if (intent && intent !== 'general' && intentResponseCount >= 3) {
                    const now = Date.now();
                    const evolutionKey = `${this.agentId}-${intent}`;
                    const lastEvolution = DynamicAgentExecutor.lastEvolutionTime[evolutionKey];
                    if (!lastEvolution || (now - lastEvolution) >= DynamicAgentExecutor.MIN_EVOLUTION_INTERVAL_MS) {
                        DynamicAgentExecutor.lastEvolutionTime[evolutionKey] = now;
                        const conversationForEvolution = history.slice(-6).map(msg => {
                            const textPart = msg.parts.find(part => part.kind === "text");
                            return {
                                role: msg.role,
                                text: textPart && 'text' in textPart ? textPart.text : ""
                            };
                        });
                        // Run evolution asynchronously (don't await)
                        console.log(`🔄 [Auto-evolution] Triggering for ${this.agentId} - ${intent}`);
                        autoEvolveAfterConversation(this.agentId, intent, conversationForEvolution)
                            .catch(err => console.error('Auto-evolution error:', err));
                    }
                    else {
                        const waitTime = Math.ceil((DynamicAgentExecutor.MIN_EVOLUTION_INTERVAL_MS - (now - lastEvolution)) / 1000);
                        console.log(`⏭️ [Auto-evolution] Skipped for ${this.agentId} - ${intent} (wait ${waitTime}s)`);
                    }
                }
            }
            catch (error) {
                console.error("Error calling AI model:", error);
                const errorMessage = {
                    kind: "message",
                    messageId: uuidv4(),
                    role: "agent",
                    parts: [{ kind: "text", text: "Sorry, I encountered an error while processing your request." }],
                    contextId,
                };
                history.push(errorMessage);
                eventBus.publish(errorMessage);
            }
            finally {
                eventBus.finished();
            }
        });
    }
    cancelTask = async () => { };
}
