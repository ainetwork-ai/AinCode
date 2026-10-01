/**
 * Prompt Builder Module
 *
 * Enhances base prompts with intent-based response guidance.
 * When intents are defined, appends structured instructions for intent matching.
 */
/**
 * Build the complete prompt by appending intent instructions if intents exist
 *
 * @deprecated No longer called. Form intents are now classified per-turn by
 * `classifyFormIntent` and the single matched intent is injected via
 * `buildSelectedIntentSection` instead of embedding the full intent catalog
 * in the base prompt. Kept temporarily for reference.
 */
export function buildPromptWithIntents(basePrompt, intents) {
    // If no intents defined, return base prompt as-is
    if (!intents || intents.length === 0) {
        return basePrompt;
    }
    // Intent template to append
    const intentTemplate = `

You respond based on predefined intents.

Each intent has:
- name
- description: when this intent should be used
- prompt: how to respond when triggered

Process:
1. Read the user message.
2. Select the single intent whose description best matches.
3. If matched, answer strictly using that intent's prompt.
4. If no match, respond normally.

Rules:
- Never combine intents.
- Follow each intent's prompt exactly as written.
- If prompts specify tone or format, follow it verbatim.
- Ignore intents whose descriptions do not apply.

Intents:
${JSON.stringify(intents, null, 2)}`;
    return basePrompt + intentTemplate;
}
/**
 * Parse intents from a prompt that was previously built with buildPromptWithIntents
 * This allows editing forms to extract and modify intents
 *
 * @deprecated No longer called. Form intents are now classified per-turn by
 * `classifyFormIntent` and the single matched intent is injected via
 * `buildSelectedIntentSection` instead of embedding the full intent catalog
 * in the base prompt. Kept temporarily for reference.
 */
export function parseIntentsFromPrompt(fullPrompt) {
    // Look for the intent template marker
    const intentMarker = "\n\nYou respond based on predefined intents.";
    const markerIndex = fullPrompt.indexOf(intentMarker);
    if (markerIndex === -1) {
        // No intents in this prompt
        return {
            basePrompt: fullPrompt,
            intents: []
        };
    }
    // Split prompt
    const basePrompt = fullPrompt.substring(0, markerIndex);
    const intentSection = fullPrompt.substring(markerIndex);
    // Extract JSON array from intent section
    const jsonMatch = intentSection.match(/Intents:\s*(\[[\s\S]*\])/);
    if (!jsonMatch) {
        console.warn('⚠️ Intent marker found but no JSON array detected');
        return {
            basePrompt: fullPrompt,
            intents: []
        };
    }
    try {
        const intents = JSON.parse(jsonMatch[1]);
        return {
            basePrompt,
            intents
        };
    }
    catch (error) {
        console.error('❌ Failed to parse intents from prompt:', error);
        return {
            basePrompt: fullPrompt,
            intents: []
        };
    }
}
/**
 * Build a prompt section injecting ONLY the matched intent's guidance.
 * Used when a separate classifier has already selected the intent, so the
 * full intent catalog does not need to be injected every turn.
 */
export function buildSelectedIntentSection(intent) {
    return `

You are responding under a matched intent. Follow this guidance exactly, including any tone or format it specifies:
- Intent: ${intent.name}
- Guidance: ${intent.prompt}`;
}
