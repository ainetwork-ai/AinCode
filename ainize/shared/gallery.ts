/** The editable AINSpace Builder definition; execution uses the original Builder algorithms. */
export const GALLERY_ORG = "uncommon-gallery"
export interface GallerySkill {
  id: string
  name: string
  description: string
  tags: string[]
  instructions: string
}
export interface GalleryImage {
  url: string
  mimeType: string
  name?: string
}
export interface GalleryIntent {
  name: string
  description: string
  prompt: string
  images: GalleryImage[]
}
export interface GalleryDefinition {
  id: string
  name: string
  description: string
  prompt: string
  useSkills: boolean
  skills: GallerySkill[]
  intents: GalleryIntent[]
}
const text = (v: unknown, limit: number, required = false): v is string =>
  typeof v === "string" && v.length <= limit && (!required || !!v.trim())
export function validateGallery(value: unknown): GalleryDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_definition")
  const d = value as GalleryDefinition
  if (
    !text(d.id, 40, true) ||
    !/^[a-z0-9][a-z0-9-]{0,39}$/.test(d.id) ||
    !text(d.name, 80, true) ||
    !text(d.description, 50000) ||
    !text(d.prompt, 131072, true) ||
    typeof d.useSkills !== "boolean"
  )
    throw new Error("invalid_definition")
  if (!Array.isArray(d.skills) || d.skills.length > 100 || !Array.isArray(d.intents) || d.intents.length > 100)
    throw new Error("invalid_definition")
  if (
    d.skills.some(
      (s) =>
        !s ||
        !text(s.id, 80, true) ||
        !text(s.name, 120) ||
        !text(s.description, 2000) ||
        !text(s.instructions, 50000) ||
        !Array.isArray(s.tags) ||
        s.tags.length > 30 ||
        s.tags.some((t) => !text(t, 80)),
    )
  )
    throw new Error("invalid_skills")
  if (new Set(d.skills.map((s) => s.id)).size !== d.skills.length) throw new Error("duplicate_skill")
  if (
    d.intents.some(
      (i) =>
        !i ||
        !text(i.name, 256) ||
        !text(i.description, 5000) ||
        !text(i.prompt, 50000) ||
        !Array.isArray(i.images) ||
        i.images.length > 3 ||
        i.images.some(
          (img) =>
            !img ||
            (img.name !== undefined && !text(img.name, 256)) ||
            !text(img.url, 8192, true) ||
            !/^https:\/\//.test(img.url) ||
            !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(img.mimeType),
        ),
    )
  )
    throw new Error("invalid_intents")
  if (
    new Set(d.intents.filter((i) => i.name.trim()).map((i) => i.name)).size !==
    d.intents.filter((i) => i.name.trim()).length
  )
    throw new Error("duplicate_intent")
  if (JSON.stringify(d).length > 650000) throw new Error("definition_too_large")
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    prompt: d.prompt,
    useSkills: d.useSkills,
    skills: d.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
      instructions: s.instructions,
    })),
    intents: d.intents.map((i) => ({
      name: i.name,
      description: i.description,
      prompt: i.prompt,
      images: i.images.map((img) => ({
        url: img.url,
        mimeType: img.mimeType,
        ...(img.name ? { name: img.name } : {}),
      })),
    })),
  }
}
export function gallerySessionPrompt(description = "") {
  return `Build or edit an AINSpace-compatible agent in this AinCode workspace. Use the user's language.\nNew agents must be created in Uncommon Gallery (orgId=uncommon-gallery, visibility=org). Confirm the authenticated user is a contributor or administrator through ainize-agents gallery context; do not bypass membership.\nGather name, description, system prompt, skills (id/name/description/tags/instructions and enabled toggle), and manually defined intents (name/trigger description/instructions/up to three images). Explain Thinking (intent knowledge) and Caring (user memory), stable user/context IDs, and image sent-once behavior. Preserve them when editing. Generate missing name/description/prompt/skills from the description; do not silently invent intents.\nUse ainize-agents gallery new <id> to create a builder.json definition locally, or gallery pull <id> for an existing migrated Builder agent. Edit builder.json and run gallery validate <id>. The original intent/skill/image/memory algorithms are generated as native handler code by gallery push <id>. Do not flatten them into a system prompt. User-uploaded images and manual editing are available at /code/gallery.\nFor a native agent without source.json, use the ordinary ainize-agents pull/push commands to edit its existing code; preserve its original behavior and Uncommon Gallery scope. Test actual A2A replies with ainize-agents gallery test <id> <message or JSON file>. The workspace has no direct internet; use this authenticated test relay rather than curl, environment inspection or system files. Test the actual files and show results. When the user requests publication, run gallery push <id>, then gallery status <id> and test its A2A URL. Keep past memories and conversation histories intact. Memory actions are gallery memory, gallery evolve and gallery update-memory; all go through the authenticated owner/admin management API. Do not claim historical source memories are imported unless status confirms it.\nOptional Teams/Mem/Drive connector workflows remain available separately; requested sources are not permission. Never ask for credentials in chat.\nUser's initial description:\n${description.slice(0, 10000)}`
}
