import { For, Show, onMount } from "solid-js"
import type { BuilderApi } from "./mcp-connections"
import { createStore } from "solid-js/store"
type Approval = { id: string; agent: string; platform: string; tool: string; args: unknown; before: unknown; status: string; result?: unknown }
export function McpApprovals(props: { api: BuilderApi; t: (key: string) => string; error: (error: unknown) => void }) {
  const [state, set] = createStore({ items: [] as Approval[], busy: false })
  async function load() {
    set("busy", true)
    try { set("items", (await props.api<{ approvals: Approval[] }>("/mcp/approvals")).approvals) } catch (error) { props.error(error) }
    finally { set("busy", false) }
  }
  async function decide(id: string, approve: boolean) {
    set("busy", true)
    try { await props.api("/mcp/approvals/decide", { id, approve }); await load() } catch (error) { props.error(error) }
    finally { set("busy", false) }
  }
  onMount(() => { if (new URLSearchParams(window.location.search).has("approvals")) void load() })
  return <details class="builder-approvals" open={new URLSearchParams(window.location.search).has("approvals")}>
    <summary>{props.t("mcpApprovals")}</summary><p>{props.t("mcpApprovalsNote")}</p><button disabled={state.busy} onClick={load}>{props.t("refresh")}</button>
    <For each={state.items}>{(item) => <article><h3>{item.agent} · {props.t(item.platform)} · {props.t(`tool.${item.tool}`)}</h3>
      <p>{props.t(`approval.${item.status}`)}</p><pre>{JSON.stringify(item.args, null, 2)}</pre>
      <Show when={item.before !== null}><details><summary>{props.t("mcpBefore")}</summary><pre>{typeof item.before === "string" ? item.before : JSON.stringify(item.before, null, 2)}</pre></details></Show>
      <Show when={item.status === "pending"}><button disabled={state.busy} onClick={() => decide(item.id, false)}>{props.t("mcpReject")}</button><button disabled={state.busy} onClick={() => decide(item.id, true)}>{props.t("mcpApprove")}</button></Show>
      <Show when={item.result !== undefined}><pre>{JSON.stringify(item.result, null, 2)}</pre></Show>
    </article>}</For>
  </details>
}
