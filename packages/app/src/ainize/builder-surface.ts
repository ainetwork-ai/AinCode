import { AINUI_CATALOG } from "ain-ui"
import type { A2uiComponent, A2uiMessage } from "ain-ui"
import { BRIEF_LIMITS, type AgentBrief, type BuilderContext } from "../../../../ainize/shared/builder"

export const BUILDER_STEPS = ["purpose", "sources", "response", "sharing", "review"] as const
export type BuilderCopy = (key: string) => string
export const STEP_FIELDS = [["name", "task"], ["sources", "drive", "mcp"], ["response"], ["id", "visibility", "orgId"], []] as const

/** One shared AIN-UI surface; answers travel as action data, never as URLs or executable code. */
export function builderSurface(brief: AgentBrief, step: number, context: BuilderContext, t: BuilderCopy): A2uiMessage[] {
  const components: A2uiComponent[] = []
  const children: string[] = []
  const text = (id: string, value: string) => { components.push({ id, component: "Text", text: value }); return id }
  const button = (id: string, label: string, name: string, extra = {}) => {
    components.push({ id, component: "Button", variant: id === "next" ? "primary" : "default", child: text(id + "-label", label), action: { event: { name, context: { brief: { path: "/brief" }, ...extra } } } })
    return id
  }
  const field = (key: keyof typeof BRIEF_LIMITS, long = false) => {
    children.push(key)
    components.push({ id: key, component: "TextField", label: t(key === "sources" ? "sourcesDetails" : key === "response" ? "responseDetails" : key), value: { path: `/brief/${key}` }, ...(long ? { variant: "longText" } : {}) })
  }
  if (step === 0) {
    children.push(text("workflow-intro", t("workflowIntro")))
    for (const preset of ["knowledge", "meeting", "document"]) children.push(button("preset-" + preset, t("preset." + preset), "preset", { preset }))
    field("name"); field("task", true)
  }
  if (step === 1) { children.push(text("sources-note", t("sourcesNote"))); field("sources", true) }
  if (step === 2) {
    children.push(text("workflow-teams", brief.mcp?.teams ? t("workflowTeams") : t("teams") + " · " + t("mcpSkipped")))
    children.push(text("workflow-mem", brief.mcp?.mem ? t("workflowMem") : t("mem") + " · " + t("mcpSkipped")))
    children.push(text("workflow-drive", brief.drive?.length ? t("workflowDrive") : t("drive") + " · " + t("mcpSkipped")))
    children.push(text("workflow-approval", t("workflowApproval")))
    field("response", true)
  }
  if (step === 3) {
    field("id")
    children.push(text("visibility-note", t("sharingNote")))
    children.push("visibility")
    components.push({ id: "visibility", component: "Segmented", value: { path: "/brief/visibility" },
      options: ["private", "org", "public"].map((value) => ({ value, label: t(value) })),
      action: { event: { name: "visibility", context: { brief: { path: "/brief" } } } },
    })
    if (brief.visibility === "org") {
      children.push(text("org-note", t(context.orgs.length ? "orgId" : "noOrgs")))
      for (const org of context.orgs) children.push(button("org-" + org.id, `${brief.orgId === org.id ? "✓ " : ""}${org.name}`, "org", { orgId: org.id }))
    }
  }
  if (step === 4) {
    for (const key of ["name", "id", "task", "sources", "response"] as const) {
      children.push(text(key + "-heading", t(key === "sources" ? "sourcesDetails" : key === "response" ? "responseDetails" : key)))
      components.push({ id: key, component: "Text", variant: "mono", text: brief[key] || t("default") })
      children.push(key)
    }
    children.push(text("share-review", t(brief.visibility)))
    if (brief.visibility === "org") children.push(text("org-review", context.orgs.find((org) => org.id === brief.orgId)?.name ?? brief.orgId))
    if (brief.drive?.length) {
      children.push(text("drive-heading", t("driveSelected")))
      brief.drive.forEach((item, index) => children.push(text("drive-" + index, `${item.driveId} / ${item.path || "/"}`)))
      children.push(text("drive-consent", t("driveConsent")))
    }
    for (const platform of ["teams", "mem"] as const) {
      const selection = brief.mcp?.[platform]
      children.push(text(platform + "-status", t(platform) + " · " + t(selection ? "mcpConfigured" : "mcpSkipped")))
      if (selection) {
        const targets = platform === "teams" ? brief.mcp!.teams!.channels : brief.mcp!.mem!.pages
        children.push(text(platform + "-targets", targets.map((p) => p.name).join(", ")))
        children.push(text(platform + "-tools", selection.tools.map((tool) => t("tool." + tool)).join(", ")))
      }
    }
    children.push(text("review-note", t("reviewNote")))
  }
  const buttons = []
  if (step > 0) buttons.push(button("back", t("back"), "back"))
  buttons.push(button("next", t(step === 4 ? "create" : "next"), step === 4 ? "create" : "next"))
  components.push({ id: "navigation", component: "Row", children: buttons })
  children.push("navigation")
  components.push({ id: "root", component: "Column", children })
  return [
    { version: "v0.9", createSurface: { surfaceId: "agent-builder", catalogId: AINUI_CATALOG } },
    { version: "v0.9", updateComponents: { surfaceId: "agent-builder", components } },
    { version: "v0.9", updateDataModel: { surfaceId: "agent-builder", path: "/", value: { brief: { ...brief } } } },
  ]
}
