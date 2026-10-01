import { For, Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { McpConfig, McpPlatform, McpTarget } from "../../../../ainize/shared/mcp"
import { MCP_TOOLS, WRITE_TOOLS } from "../../../../ainize/shared/mcp"

export type BuilderApi = <T = unknown>(path: string, body?: unknown) => Promise<T>
export function McpConnections(props: {
  value: McpConfig; onChange: (value: McpConfig) => void; t: (key: string) => string
  api: BuilderApi; oauth: (url: string) => void; error: (error: unknown) => void
}) {
  const empty = () => ({ connected: false, busy: false, loaded: false, tools: [] as string[] })
  const [state, set] = createStore({ teams: empty(), mem: empty(), workspaces: [] as McpTarget[], channels: [] as McpTarget[], workspaceId: props.value.teams?.workspaceId ?? "", pages: [] as McpTarget[], token: "", query: "" })
  function targets(data: unknown): McpTarget[] {
    return Array.isArray(data) ? data.flatMap((v) => v && typeof v.id === "string" && typeof (v.name ?? v.title) === "string" ? [{ id: v.id, name: (v.name ?? v.title).slice(0, 256) }] : []) : []
  }
  async function refresh(platform: McpPlatform) {
    set(platform, "busy", true)
    try {
      const result = await props.api<{ connected: boolean; tools: string[] }>(`/mcp/${platform}/status`)
      set(platform, { ...result, loaded: true })
      if (platform === "teams" && result.connected) {
        set("workspaces", targets((await props.api<{ data: unknown }>("/mcp/teams/browse")).data))
        if (state.workspaceId) set("channels", targets((await props.api<{ data: unknown }>("/mcp/teams/browse?" + new URLSearchParams({ workspaceId: state.workspaceId }))).data))
      }
    } catch (error) { props.error(error) }
    finally { set(platform, "busy", false) }
  }
  onMount(() => { void refresh("teams"); void refresh("mem") })
  async function connect(platform: McpPlatform) {
    if (state[platform].busy) return
    set(platform, "busy", true)
    try {
      const token = state.token
      set("token", "")
      const response = await props.api<{ url: string }>(`/mcp/${platform}/connect`, platform === "mem" ? { token } : {})
      if (platform === "teams") { props.oauth(response.url); return }
      await refresh(platform)
    } catch (error) { props.error(error) }
    finally { set(platform, "busy", false) }
  }
  async function disconnect(platform: McpPlatform) {
    set(platform, "busy", true)
    try {
      await props.api(`/mcp/${platform}/disconnect`, {})
      const config = { ...props.value, consent: false }
      delete config[platform]
      props.onChange(config)
      set(platform, empty())
      if (platform === "teams") set({ channels: [], workspaces: [], workspaceId: "" })
      if (platform === "mem") set("pages", [])
    } catch (error) { props.error(error) }
    finally { set(platform, "busy", false) }
  }
  async function browse(platform: McpPlatform, workspaceId = state.workspaceId) {
    set(platform, "busy", true)
    try {
      const query = platform === "teams" ? new URLSearchParams({ workspaceId }) : new URLSearchParams({ q: state.query })
      const response = await props.api<{ data: { results?: unknown } }>(`/mcp/${platform}/browse?${query}`)
      if (platform === "teams") {
        if (workspaceId !== state.workspaceId) { const config = { ...props.value, consent: false }; delete config.teams; props.onChange(config) }
        set({ workspaceId, channels: targets(response.data) })
      } else set("pages", targets(response.data?.results))
    } catch (error) { props.error(error) }
    finally { set(platform, "busy", false) }
  }
  function choose(platform: McpPlatform, target: McpTarget) {
    const current = platform === "teams" ? props.value.teams?.channels ?? [] : props.value.mem?.pages ?? []
    const next = current.some((t) => t.id === target.id) ? current.filter((t) => t.id !== target.id) : [...current, target]
    if (next.length > 20) { props.error(new Error("mcp_limit")); return }
    const tools = props.value[platform]?.tools ?? [platform === "teams" ? "read_channel" : "app-fetch"]
    const config = { ...props.value, consent: false }
    if (!next.length) delete config[platform]
    else if (platform === "teams") config.teams = { workspaceId: state.workspaceId, channels: next, tools }
    else config.mem = { pages: next, tools }
    props.onChange(config)
  }
  function toggle(platform: McpPlatform, tool: string) {
    const config = { ...props.value }, selected = config[platform]
    const selection = selected ? { ...selected, tools: [...selected.tools] } : undefined
    if (!selection) return
    selection.tools = selection.tools.includes(tool) ? selection.tools.filter((t) => t !== tool) : [...selection.tools, tool]
    if (platform === "teams") config.teams = selection as McpConfig["teams"]
    else config.mem = selection as McpConfig["mem"]
    config.consent = false
    props.onChange(config)
  }
  return <div class="builder-mcp-grid"><For each={["teams", "mem"] as const}>{(platform) => <section class="builder-drive" aria-label={props.t(platform)} aria-busy={state[platform].busy}>
    <h3>{props.t(platform)}</h3><p>{props.t(`${platform}Use`)}</p>
    <p class="builder-connection-status">{props.t(state[platform].connected ? "mcpConnected" : "mcpDisconnected")}</p>
    <Show when={!state[platform].connected}>
      <Show when={platform === "mem"}><p>{props.t("memTokenNote")}</p><label>{props.t("memToken")}<input type="password" autocomplete="off" value={state.token} onInput={(e) => set("token", e.currentTarget.value)} /></label></Show>
      <button disabled={state[platform].busy || (platform === "mem" && !state.token)} onClick={() => connect(platform)}>{props.t(platform === "teams" ? "teamsConnect" : "memConnect")}</button>
    </Show>
    <Show when={state[platform].connected}>
      <div class="builder-actions"><button disabled={state[platform].busy} onClick={() => refresh(platform)}>{props.t("mcpDiscover")}</button><button disabled={state[platform].busy} onClick={() => disconnect(platform)}>{props.t("mcpDisconnect")}</button></div>
      <p>{props.t("mcpDisconnectNote")}</p>
      <Show when={platform === "teams"}><h4>{props.t("teamsWorkspace")}</h4><div class="builder-actions"><For each={state.workspaces}>{(w) => <button aria-pressed={state.workspaceId === w.id} disabled={state.teams.busy} onClick={() => browse("teams", w.id)}>{w.name}</button>}</For></div></Show>
      <Show when={platform === "mem"}><label>{props.t("memSearch")}<input value={state.query} onInput={(e) => set("query", e.currentTarget.value)} /></label><button disabled={state.mem.busy} onClick={() => browse("mem")}>{props.t("mcpSearch")}</button></Show>
      <h4>{props.t(platform === "teams" ? "teamsChannels" : "memPages")}</h4>
      <ul class="builder-mcp-targets"><For each={platform === "teams" ? state.channels : state.pages}>{(target) => <li><label><input type="checkbox" checked={(platform === "teams" ? props.value.teams?.channels : props.value.mem?.pages)?.some((t) => t.id === target.id) ?? false} onChange={() => choose(platform, target)} />{target.name}</label></li>}</For></ul>
      <Show when={props.value[platform]}><h4>{props.t("mcpPermissions")}</h4><For each={MCP_TOOLS[platform]}>{(tool) => <label class="builder-tool-choice"><input type="checkbox" disabled={!state[platform].tools.includes(tool)} checked={props.value[platform]?.tools.includes(tool) ?? false} onChange={() => toggle(platform, tool)} /><span>{props.t(`tool.${tool}`)}<small>{props.t(!state[platform].tools.includes(tool) ? "mcpToolUnavailable" : WRITE_TOOLS.has(tool) ? "mcpApprovalRequired" : "mcpReadOnly")}</small></span></label>}</For>
      <p>{props.t("mcpSelected")}: {(platform === "teams" ? props.value.teams?.channels : props.value.mem?.pages)?.map((t) => t.name).join(", ")}</p></Show>
    </Show>
  </section>}</For></div>
}
