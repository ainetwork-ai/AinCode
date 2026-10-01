import { lazy, Show, Suspense, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { basePath } from "@/utils/base-path"
const BuilderConnections = lazy(() => import("./builder-connections"))

export function SessionBuilderPanel() {
  const language = useLanguage()
  const [state, setState] = createStore({ open: new URLSearchParams(location.search).has("builderConnections") || sessionStorage.getItem("aincode-builder-open-connections") === "1" })
  onMount(() => sessionStorage.removeItem("aincode-builder-open-connections"))
  return <Show when={basePath().startsWith("/code")}>
    <section class="border-b border-border-base px-4 py-2 shrink-0">
      <button type="button" aria-expanded={state.open} onClick={() => setState("open", !state.open)}>
        {language.t("agentBuilder.sessionConnections")}
      </button>
      <Show when={state.open}><div style={{ "max-height": "50vh", overflow: "auto" }}>
        <Suspense fallback={<p>{language.t("agentBuilder.loading")}</p>}><BuilderConnections /></Suspense>
      </div></Show>
    </section>
  </Show>
}
