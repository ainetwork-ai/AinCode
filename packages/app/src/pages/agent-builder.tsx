import { onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { basePath } from "@/utils/base-path"
import { builderSessionPrompt } from "../../../../ainize/shared/builder-session"

/** Teams Builder enters the ordinary OpenCode draft; no hosted agent is created here. */
export default function AgentBuilderPage() {
  const language = useLanguage(), server = useServer(), tabs = useTabs()
  const [state, setState] = createStore({ error: "", busy: false })
  async function start() {
    if (state.busy) return
    setState({ busy: true, error: "" })
    try {
      const pending = sessionStorage.getItem("aincode-builder-oauth")
      if (pending && /[?&](mcp|drive)=/.test(location.search)) {
        const saved = JSON.parse(pending)
        const url = new URL(saved.returnTo, location.origin)
        if (url.origin === location.origin && url.pathname.startsWith(basePath() + "/") && url.pathname !== basePath() + "/builder") {
          url.searchParams.set("builderConnections", "1")
          window.location.replace(url.pathname + url.search); return
        }
      }
      if (new URLSearchParams(location.search).has("approvals")) sessionStorage.setItem("aincode-builder-open-connections", "1")
      const res = await fetch(`${basePath()}/_builder/context`, { credentials: "same-origin" })
      if (!res.ok) throw new Error(res.status === 403 ? "ain_signin_required" : "context_unavailable")
      const context = await res.json()
      await tabs.newDraft({ server: server.key, directory: context.directory }, builderSessionPrompt())
    } catch (error) { setState({ error: language.t(error instanceof Error && error.message === "ain_signin_required" ? "agentBuilder.ain_signin_required" : "agentBuilder.context_unavailable"), busy: false }) }
  }
  onMount(start)
  return <div class="p-6" aria-busy={state.busy}>
    <Show when={state.error} fallback={<p role="status">{language.t("agentBuilder.startingSession")}</p>}>
      <p role="alert">{state.error}</p>
      <button onClick={start}>{language.t("agentBuilder.retry")}</button>
    </Show>
  </div>
}
