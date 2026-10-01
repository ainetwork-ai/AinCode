import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gallerySpec, galleryDefinition, galleryEditSpec } from "../src/gallery-spec.ts"
import { validateGallery, gallerySessionPrompt } from "../../shared/gallery.ts"
import { galleryPage } from "../src/gallery-page.ts"
const d = {
  id: "gallery-test",
  name: "Gallery",
  description: "Guide",
  prompt: "BASE",
  useSkills: false,
  skills: [],
  intents: [
    {
      name: "image",
      description: "picture",
      prompt: "PICTURE",
      images: [{ url: "https://example.com/a.png", mimeType: "image/png" }],
    },
  ],
}
test("factory preserves definition, legacy identity, historical flag and blocks invalid images", () => {
  const s = gallerySpec(d, "peer", { id: "original", rawState: { _migration: { fullSourceStateImported: false } } })
  assert.equal(s.orgId, "uncommon-gallery")
  assert.equal(s.visibility, "org")
  assert.equal(s.model, "peer")
  assert.deepEqual(galleryDefinition(s), d)
  const source = JSON.parse(s.files["source.json"])
  assert.equal(source.id, "original")
  assert.equal(source.rawState._migration.fullSourceStateImported, false)
  assert.ok(s.files["manage.mjs"])
  assert.ok(Object.keys(s.files).every((f) => !f.startsWith(".")))
  assert.throws(() =>
    validateGallery({
      ...d,
      intents: [{ ...d.intents[0], images: [{ url: "javascript:bad", mimeType: "image/png" }] }],
    }),
  )
  assert.throws(() =>
    validateGallery({
      ...d,
      intents: [{ ...d.intents[0], images: [{ ...d.intents[0].images[0], name: { bad: true } }] }],
    }),
  )
})
test("generated runtime serializes durable memories, preserves history across edits and sends images once", async () => {
  const root = mkdtempSync(join(tmpdir(), "gallery-runtime-")),
    prior = process.env.AINIZE_AGENT_STATE_DIR
  process.env.AINIZE_AGENT_STATE_DIR = "b64:" + Buffer.from(root).toString("base64")
  try {
    const s = gallerySpec(d, "fixture")
    for (const [file, code] of Object.entries(s.files)) writeFileSync(join(root, file), code)
    const mod = await import(pathToFileURL(join(root, "index.mjs")).href)
    const ctx = {
      spec: { id: d.id, model: "fixture" },
      input: { contextId: "visitor", textParts: ["picture"] },
      llm: {
        chat: async ({ messages }: { messages: { content: string }[] }) => ({
          message: {
            content: messages[0].content.startsWith("You classify")
              ? messages[0].content.includes("conversation: [image]")
                ? "INTENT: image\nSEND_IMAGE: no"
                : "INTENT: image\nSEND_IMAGE: yes"
              : "response",
          },
        }),
      },
    }
    await Promise.all([
      mod.manage("memory.set", { kind: "thinking", key: "topic", text: "KNOWN" }, ctx),
      mod.manage("memory.set", { kind: "caring", key: "visitor", text: "USER" }, ctx),
    ])
    const reply = await mod.execute("picture", ctx)
    assert.equal(reply.metadata.formIntent, "image")
    assert.equal(reply.parts[0].content.value, "https://example.com/a.png")
    const second = await mod.execute("picture", ctx)
    assert.equal(second.parts.length, 0)
    const fresh = join(root, "fresh")
    mkdirSync(fresh)
    const edited = gallerySpec({ ...d, prompt: "EDITED" }, "fixture")
    for (const [file, code] of Object.entries(edited.files)) writeFileSync(join(fresh, file), code)
    const cold = await import(pathToFileURL(join(fresh, "index.mjs")).href)
    const status = await cold.manage("status", { contextId: "visitor" }, ctx)
    assert.equal(status.thinking.topic, "KNOWN")
    assert.equal(status.caring.visitor, "USER")
    assert.equal(status.contextHistory.filter((m: { role: string }) => m.role === "user").length, 3)
    assert.equal(status.contextHistory.filter((m: { role: string }) => m.role === "agent").length, 2)
    await assert.rejects(cold.manage("memory.set", { kind: "bad", key: "topic", text: "x" }, ctx))
  } finally {
    if (prior === undefined) delete process.env.AINIZE_AGENT_STATE_DIR
    else process.env.AINIZE_AGENT_STATE_DIR = prior
    rmSync(root, { recursive: true, force: true })
  }
})
test("page script parses and AI instructions use org-bound CLI", () => {
  const html = galleryPage("/code")
  assert.doesNotThrow(() => new Function(html.split("<script>")[1].split("</script>")[0]))
  assert.match(gallerySessionPrompt(), /ainize-agents gallery/)
  assert.match(html, /memory.update/)
  assert.doesNotMatch(html, /innerHTML/)
})

import { galleryAiPage } from "../src/gallery-ai-page.ts"
test("AI launch page starts a real scoped Code session and escapes user descriptions", () => {
  const html = galleryAiPage("/code", "/home/aincode/agents", "</script><script>bad()</script>")
  assert.equal(html.split("<script>").length, 2)
  assert.doesNotThrow(() => new Function(html.split("<script>")[1].split("</script>")[0]))
  assert.match(html, /prompt_async/)
  assert.match(html, /x-opencode-directory/)
  assert.match(html, /\.ainize-tools/)
  assert.doesNotMatch(html, /bad\(\)<\/script>/)
})

test("legacy missing instructions/images and blank draft labels remain editable", () => {
  const spec = gallerySpec(d, "fixture")
  const source = JSON.parse(spec.files["source.json"])
  source.skills = [{ id: "legacy", name: "", description: "", tags: [] }]
  source.intents = [{ name: "", description: "", prompt: "" }]
  spec.files["source.json"] = JSON.stringify(source)
  const editable = galleryDefinition(spec)
  const rebuilt = gallerySpec(editable, "fixture", source)
  const saved = JSON.parse(rebuilt.files["source.json"])
  assert.equal(saved.skills[0].instructions, "")
  assert.equal(saved.skills[0].name, "")
  assert.equal(rebuilt.skills[0].name, "legacy")
  assert.deepEqual(saved.intents[0].images, [])
})

test("long legacy descriptions survive edits while the public listing stays concise", () => {
  const full = { ...d, description: "role ".repeat(230) }
  const spec = gallerySpec(full, "fixture")
  assert.equal(spec.description.length, 500)
  assert.equal(galleryDefinition(spec).description, full.description)
  const original = JSON.parse(spec.files["source.json"])
  original.rawState.card.customField = "preserved"
  const rebuilt = gallerySpec(galleryDefinition(spec), "fixture", original)
  assert.equal(JSON.parse(rebuilt.files["source.json"]).rawState.card.customField, "preserved")
})

test("field editing preserves customized runtime code and existing connector permissions", () => {
  const original = {
    ...gallerySpec(d, "fixture"),
    files: { ...gallerySpec(d, "fixture").files, "custom.mjs": "custom", "index.mjs": "custom entry" },
    allowedHosts: ["example.com"],
    secretNames: ["EXISTING"],
    a2ui: true,
  }
  const edited = galleryEditSpec({ ...d, prompt: "UPDATED" }, original)
  assert.equal(edited.files["index.mjs"], "custom entry")
  assert.equal(edited.files["custom.mjs"], "custom")
  assert.deepEqual(edited.allowedHosts, ["example.com"])
  assert.deepEqual(edited.secretNames, ["EXISTING"])
  assert.equal(edited.a2ui, true)
  assert.equal(JSON.parse(edited.files["source.json"]).prompt, "UPDATED")
})
