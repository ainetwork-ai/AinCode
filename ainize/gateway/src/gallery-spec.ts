import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { GALLERY_ORG, validateGallery } from "../../shared/gallery.ts"
export function gallerySpec(value: unknown, model: string, original?: Record<string, unknown>) {
  const d = validateGallery(value)
  const state = original?.rawState as Record<string, unknown> | undefined
  const card = {
    ...(state?.card as Record<string, unknown> | undefined),
    name: d.name,
    description: d.description,
    skills: d.skills.map(({ instructions, ...s }) => s),
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    capabilities: { streaming: true },
    version: "1.0.0",
    protocolVersion: "0.3.0",
  }
  const source = {
    id: typeof original?.id === "string" ? original.id : d.id,
    name: d.name,
    prompt: d.prompt,
    useSkills: d.useSkills,
    skills: d.skills,
    intents: d.intents,
    rawState: {
      ...state,
      card,
      prompt: d.prompt,
      useSkills: d.useSkills,
      modelProvider: "ainize",
      modelName: model,
      thinkingMemories: state?.thinkingMemories ?? {},
      caringMemories: state?.caringMemories ?? {},
      intentPatterns: state?.intentPatterns ?? {},
      ...((original?.rawState as Record<string, unknown>)
        ? { _migration: (original?.rawState as Record<string, unknown>)._migration }
        : {}),
    },
  }
  const directory = fileURLToPath(new URL("../../gallery-runtime/", import.meta.url))
  const files = Object.fromEntries(
    readdirSync(directory)
      .filter((f) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.mjs$/.test(f))
      .map((f) => [f, readFileSync(directory + f, "utf8")]),
  )
  files["source.json"] = JSON.stringify(source)
  if (Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 1024 * 1024)
    throw new Error("definition_too_large")
  return {
    id: d.id,
    name: d.name,
    description: d.description.slice(0, 500),
    model,
    mode: "handler",
    systemPrompt: "",
    files,
    a2ui: false,
    skills: card.skills.map((s) => ({ ...s, name: s.name || s.id })),
    allowedHosts: [],
    secretNames: [],
    visibility: "org",
    orgId: GALLERY_ORG,
  }
}
export function galleryDefinition(spec: Record<string, unknown>) {
  const files = spec.files as Record<string, string> | undefined
  if (!files?.["source.json"]) throw new Error("not_a_builder_agent")
  const source = JSON.parse(files["source.json"])
  if (
    !source.rawState ||
    typeof source.prompt !== "string" ||
    !Array.isArray(source.skills) ||
    !Array.isArray(source.intents)
  )
    throw new Error("not_a_builder_agent")
  return {
    id: spec.id,
    name: spec.name,
    description: source.rawState.card?.description ?? spec.description ?? "",
    prompt: source.prompt,
    useSkills: source.useSkills ?? false,
    skills: (source.skills ?? []).map((s: Record<string, unknown>) => ({ ...s, instructions: s.instructions ?? "" })),
    intents: (source.intents ?? []).map((i: Record<string, unknown>) => ({ ...i, images: i.images ?? [] })),
  }
}
/** Editing fields must not replace code or connector permissions subsequently customized in AinCode. */
export function galleryEditSpec(value: unknown, agent: Record<string, unknown>) {
  const files = agent.files as Record<string, string>
  const original = JSON.parse(files["source.json"])
  const next = gallerySpec(value, String(agent.model), original)
  const updatedFiles: Record<string, string> = { ...files, "source.json": next.files["source.json"] }
  return {
    ...next,
    files: updatedFiles,
    allowedHosts: agent.allowedHosts ?? [],
    secretNames: agent.secretNames ?? [],
    a2ui: agent.a2ui ?? false,
    media: agent.media,
  }
}
