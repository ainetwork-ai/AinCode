import { Show, createEffect, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { AINUI_CATALOG, type A2uiComponent } from "ain-ui"
import { createA2uiRenderer, A2UI_RENDERER_CSS } from "ain-ui/renderer"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import "@/pages/agent-builder.css"

/** AIN-UI is a view of OpenCode's pending question; replies resume its real session. */
export function BuilderQuestion(props: { request: QuestionRequest; onSubmit: () => void }) {
  const sdk = useSDK(), language = useLanguage()
  const [state, setState] = createStore({ picked: [] as string[], custom: "", busy: false, error: false })
  let mount!: HTMLDivElement
  let renderer: ReturnType<typeof createA2uiRenderer> | undefined
  const question = () => props.request.questions[0]
  onMount(() => {
    renderer = createA2uiRenderer(mount, { onAction: async (action) => {
      if (state.busy) return
      const custom = action.context?.custom
      if (typeof custom === "string") setState("custom", custom.slice(0, 4000))
      if (action.name === "pick") {
        const index = action.context?.index
        if (typeof index !== "number" || !Number.isInteger(index)) return
        const option = question().options[index]
        if (!option) return
        setState("picked", question().multiple
          ? state.picked.includes(option.label) ? state.picked.filter(x => x !== option.label) : [...state.picked, option.label]
          : [option.label])
        if (!question().multiple) setState("custom", "")
        return
      }
      if (action.name !== "submit" && action.name !== "dismiss") return
      const answers = state.custom.trim()
        ? question().multiple ? [...state.picked, state.custom.trim()] : [state.custom.trim()]
        : [...state.picked]
      if (action.name === "submit" && !answers.length) return
      setState({ busy: true, error: false })
      try {
        const input = { sessionID: props.request.sessionID, requestID: props.request.id }
        if (action.name === "dismiss") await sdk().api.question.reject(input)
        else await sdk().api.question.reply({ ...input, answers: [answers] })
        props.onSubmit()
      } catch { setState({ busy: false, error: true }) }
    } })
    render()
  })
  onCleanup(() => renderer?.replace([]))
  function render() {
    const q = question()
    const components: A2uiComponent[] = [{ id: "question", component: "Text", text: q.question }]
    const children = ["question"]
    const button = (id: string, label: string, name: string, extra = {}) => {
      components.push({ id: id + "-label", component: "Text", text: label }, { id, component: "Button", child: id + "-label", action: { event: { name, context: { custom: { path: "/custom" }, ...extra } } } })
      children.push(id)
    }
    q.options.forEach((option, index) => button("option-" + index, `${state.picked.includes(option.label) ? "✓ " : ""}${option.label}\n${option.description ?? ""}`, "pick", { index }))
    components.push({ id: "custom", component: "TextField", label: language.t("ui.messagePart.option.typeOwnAnswer"), value: { path: "/custom" } })
    children.push("custom")
    button("submit", language.t("ui.common.submit"), "submit")
    button("dismiss", language.t("ui.common.dismiss"), "dismiss")
    components.push({ id: "root", component: "Column", children })
    renderer?.replace([
      { version: "v0.9", createSurface: { surfaceId: "builder-question", catalogId: AINUI_CATALOG } },
      { version: "v0.9", updateComponents: { surfaceId: "builder-question", components } },
      { version: "v0.9", updateDataModel: { surfaceId: "builder-question", path: "/", value: { custom: state.custom } } },
    ])
  }
  createEffect(render)
  return <section class="ain-agent-builder builder-session-question" aria-label={question().header} aria-busy={state.busy}>
    <style>{A2UI_RENDERER_CSS}</style>
    <div ref={mount} inert={state.busy} />
    <Show when={state.error}><p role="alert">{language.t("common.requestFailed")}</p></Show>
  </section>
}
