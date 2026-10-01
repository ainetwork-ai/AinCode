import { callLLM } from './bridge.mjs';
/** Pure parser for the classifier LLM response. */
export function parseFormIntentResponse(text) {
    const intentMatch = text.match(/INTENT:\s*(.+?)(?=\n|$)/i);
    const sendMatch = text.match(/SEND_IMAGE:\s*(.+?)(?=\n|$)/i);
    let intent = null;
    if (intentMatch) {
        const raw = intentMatch[1].trim();
        if (raw && raw.toUpperCase() !== 'NONE') {
            intent = raw;
        }
    }
    const sendImage = !!sendMatch && sendMatch[1].trim().toLowerCase() === 'yes';
    return { intent, sendImage };
}
/**
 * Classify the user's message against the agent's form intents and decide
 * whether to send the matched intent's images this turn. Returns
 * {intent:null, sendImage:false} on any parse/call failure.
 */
export async function classifyFormIntent(intents, conversationText, alreadySentIntentNames) {
    if (!intents || intents.length === 0) {
        return { intent: null, sendImage: false };
    }
    const catalog = intents
        .map(i => `- ${i.name}: ${i.description}`)
        .join('\n');
    const alreadySent = alreadySentIntentNames.length > 0
        ? alreadySentIntentNames.join(', ')
        : '(none)';
    const systemPrompt = `You classify a user's latest message against a list of predefined intents, and decide whether an image should be attached to the reply this turn.

Intents (name: when to use):
${catalog}

Rules for INTENT:
- Choose the single intent whose description best matches the user's latest message.
- If none clearly apply, answer NONE.

Rules for SEND_IMAGE (only meaningful when an intent is chosen):
- Answer "yes" if the user is asking about this topic for the first time, or explicitly asks to see the image again.
- Answer "no" if the conversation is simply continuing on the same topic and the image was already shown.
- Intents whose images were already shown in this conversation: [${alreadySent}]

Respond in EXACTLY this format, nothing else:
INTENT: <intent name or NONE>
SEND_IMAGE: <yes or no>`;
    try {
        const response = await callLLM([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: conversationText },
        ]);
        return parseFormIntentResponse(response);
    }
    catch (error) {
        console.error('Error classifying form intent:', error);
        return { intent: null, sendImage: false };
    }
}
