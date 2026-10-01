import { describe, expect, test } from "bun:test"
import { createA2uiRenderer } from "ain-ui/renderer"
import type { A2uiAction } from "ain-ui"
import { builderSurface, BUILDER_STEPS } from "./builder-surface"
import { agentSpec, type AgentBrief } from "../../../../ainize/shared/builder"

const brief: AgentBrief = { id: "research", name: "Research", task: "Summarize", sources: "", response: "", visibility: "private", orgId: "" }
const context = { models: ["Qwen3.8-Flash-Next"], directory: "/home/aincode/agents", orgs: [{ id: "comcom", name: "ComCom" }] }
const copy = (key: string) => key
function render(step: number, input = brief) {
  const container = document.createElement("div")
  const actions: A2uiAction[] = []
  const renderer = createA2uiRenderer(container, { onAction: (a: A2uiAction) => actions.push(a) })
  renderer.replace(builderSurface(input, step, context, copy))
  return { container, actions }
}
function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label)
  expect(button).toBeDefined()
  button!.click()
}

describe("guided AIN-UI surface", () => {
  test("each step renders with the real AIN-UI renderer", () => {
    for (let step = 0; step < BUILDER_STEPS.length; step++) {
      const { container } = render(step)
      expect(container.querySelector(".a2ui-surface")).not.toBeNull()
      expect(container.querySelectorAll(".a2ui-missing").length).toBe(0)
      expect(container.querySelectorAll(".a2ui-unknown").length).toBe(0)
      expect(container.textContent).toContain(step === 4 ? "create" : "next")
    }
  })
  test("edited answers travel with next/back actions without mutating the previous brief", () => {
    const { container, actions } = render(0)
    const input = container.querySelector("input")!
    input.value = "My agent"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    click(container, "next")
    expect(actions[0].name).toBe("next")
    expect(actions[0].context?.brief).toMatchObject({ name: "My agent", task: "Summarize" })
    expect(brief.name).toBe("Research")
    const previous = render(1, actions[0].context!.brief as AgentBrief)
    click(previous.container, "back")
    expect(previous.actions[0].context?.brief).toMatchObject({ name: "My agent" })
  })
  test("sharing selects only a listed organization and retains entered ID", () => {
    const { container, actions } = render(3)
    click(container, "org")
    expect(actions[0]).toMatchObject({ name: "visibility", context: { value: "org" } })
    const organizations = render(3, { ...brief, visibility: "org" })
    click(organizations.container, "ComCom")
    expect(organizations.actions[0]).toMatchObject({ name: "org", context: { orgId: "comcom", brief: { id: "research" } } })
  })
  test("workflow choices are concrete actions and review preserves all platform settings", () => {
    const first = render(0)
    click(first.container, "preset.knowledge")
    expect(first.actions[0]).toMatchObject({ name: "preset", context: { preset: "knowledge" } })
    const input = { ...brief, mcp: { consent: true, teams: { workspaceId: "w1", channels: [{ id: "c1", name: "Project" }], tools: ["read_channel", "send_message"] }, mem: { pages: [{ id: "p1", name: "Policy" }], tools: ["app-fetch"] } } }
    const review = render(4, input)
    expect(review.container.textContent).toContain("Project")
    expect(review.container.textContent).toContain("Policy")
    expect(review.container.textContent).toContain("tool.send_message")
    click(review.container, "create")
    expect(review.actions[0].context?.brief).toMatchObject({ mcp: input.mcp })
  })
  test("review includes selected Drive sources and the sharing consent", () => {
    const input = { ...brief, drive: [{ driveId: "d1", path: "docs", kind: "folder" as const }], driveConsent: true }
    const { container, actions } = render(4, input)
    expect(container.textContent).toContain("d1 / docs")
    expect(container.textContent).toContain("driveConsent")
    click(container, "create")
    expect(actions[0].context?.brief).toMatchObject({ drive: input.drive, driveConsent: true })
  })
  test("review is inert data and creates exactly the reviewed brief", () => {
    const input = { ...brief, task: '<img src=x onerror="alert(1)">', sources: "**do not execute**" }
    const { container, actions } = render(4, input)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain(input.task)
    click(container, "create")
    expect(actions[0].context?.brief).toEqual(input)
    expect(agentSpec(actions[0].context!.brief as AgentBrief, context.models[0]).systemPrompt).toContain(input.task)
  })
})
