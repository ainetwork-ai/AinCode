import { For, Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { basePath } from "@/utils/base-path"
import { McpConnections } from "@/ainize/mcp-connections"
import { McpApprovals } from "@/ainize/mcp-approvals"
import { type McpConfig } from "../../../../ainize/shared/mcp"
import { type AgentBrief, type BuilderContext } from "../../../../ainize/shared/builder"
import { validSelection, type DriveAccount, type DriveEntry, type DriveSelection } from "../../../../ainize/shared/drive"
import "@/pages/agent-builder.css"

export default function BuilderConnections() {
  const language = useLanguage()
  const t = (key: string) => language.t(`agentBuilder.${key}` as Parameters<typeof language.t>[0])
  const [state, setState] = createStore({
    context: undefined as BuilderContext | undefined, busy: false, error: "", saved: false,
    drive: { connected: false, busy: false, loaded: false, drives: [] as DriveAccount[], entries: [] as DriveEntry[], driveId: "", path: "" },
    brief: { id: "connections", name: "Connections", task: "Workspace connections", sources: "", response: "", visibility: "private", orgId: "", drive: [], driveConsent: false, mcp: { consent: false } } as AgentBrief,
  })
  async function api(path: string, body?: unknown) {
    const response = await fetch(`${basePath()}/_builder${path}`, {
      method: body ? "POST" : "GET", credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? "request_failed")
    return data
  }
  function fail(_error: unknown) { setState("error", t("request_failed")) }
  async function save() {
    setState({ busy: true, error: "", saved: false })
    try { await api("/connections", state.brief); setState("saved", true) }
    catch (error) { fail(error) }
    finally { setState("busy", false) }
  }
  onMount(async () => {
    try {
      setState("context", await api("/context"))
      const stored = await api("/connections")
      setState("brief", { ...state.brief, ...stored.selection })
      const pending = sessionStorage.getItem("aincode-builder-oauth")
      if (pending) {
        sessionStorage.removeItem("aincode-builder-oauth")
        const draft = JSON.parse(pending)
        if (draft.owner === state.context?.owner && Date.now() - draft.at < 600_000) setState("brief", draft.brief)
      }
      await loadDrive()
    } catch (error) { fail(error) }
  })
  async function loadDrive() {
    setState("drive", { busy: true })
    try {
      const status = await api("/drive/status")
      setState("drive", { connected: status.connected === true, loaded: true })
      if (status.connected) setState("drive", "drives", (await api("/drive/drives")).drives)
    } catch (error) { fail(error) }
    finally { setState("drive", "busy", false) }
  }
  function captureSources() {

  }
  function oauth(url: string) {
    captureSources()
    sessionStorage.setItem("aincode-builder-oauth", JSON.stringify({ owner: state.context?.owner, at: Date.now(), brief: state.brief, returnTo: window.location.pathname + window.location.search }))
    window.location.assign(url)
  }
  function mcpChange(value: McpConfig) { captureSources(); setState("brief", "mcp", value) }
  async function connectDrive() {
    if (state.drive.busy) return
    captureSources()
    setState("drive", "busy", true)
    try {
      const { url } = await api("/drive/connect", {})
      oauth(url)
    } catch (error) { fail(error); setState("drive", "busy", false) }
  }
  async function disconnectDrive() {
    if (state.drive.busy) return
    captureSources()
    setState("drive", "busy", true)
    try {
      await api("/drive/disconnect", {})
      setState("brief", { drive: [], driveConsent: false })
      setState("drive", { connected: false, drives: [], entries: [], driveId: "", path: "" })
    } catch (error) { fail(error) }
    finally { setState("drive", "busy", false) }
  }
  async function browseDrive(driveId: string, path: string) {
    if (state.drive.busy) return
    captureSources()
    setState("drive", "busy", true)
    setState("error", "")
    try {
      const data = await api("/drive/entries?" + new URLSearchParams({ driveId, path }))
      setState("drive", { driveId, path, entries: data.entries })
    } catch (error) { fail(error) }
    finally { setState("drive", "busy", false) }
  }
  function chooseDrive(item: DriveSelection) {
    captureSources()
    const selected = state.brief.drive ?? []
    const exists = selected.some((s) => s.driveId === item.driveId && s.path === item.path)
    const next = exists ? selected.filter((s) => s.driveId !== item.driveId || s.path !== item.path) : [...selected, item]
    if (!validSelection(next)) { setState("error", t("driveLimit")); return }
    setState("brief", { drive: next, driveConsent: false })
  }
  return <div class="ain-agent-builder builder-session-connections">
    <p>{t("sessionConnectionsIntro")}</p>
    <Show when={state.error}><p role="alert">{state.error}</p></Show>
    <McpApprovals api={api} t={t} error={fail} />
            <McpConnections value={state.brief.mcp ?? { consent: false }} onChange={mcpChange} api={api} t={t} oauth={oauth} error={fail} />
            <Show when={state.brief.mcp?.teams || state.brief.mcp?.mem}><label class="builder-drive-consent"><input type="checkbox" checked={state.brief.mcp?.consent ?? false} onChange={(e) => mcpChange({ ...state.brief.mcp!, consent: e.currentTarget.checked })} />{t("mcpConsent")}</label></Show>
            <section class="builder-drive" aria-label={t("drive")} aria-busy={state.drive.busy}>
              <h3>{t("drive")}</h3><p>{t("driveNote")}</p>
              <Show when={state.drive.connected} fallback={<button disabled={state.drive.busy} onClick={connectDrive}>{t("driveConnect")}</button>}>
                <p role="status">{t("driveConnected")}</p>
                <div class="builder-actions"><button disabled={state.drive.busy} onClick={loadDrive}>{t("refresh")}</button><button disabled={state.drive.busy} onClick={disconnectDrive}>{t("driveDisconnect")}</button></div>
                <p>{t("driveDisconnectNote")}</p>
                <div class="builder-actions"><For each={state.drive.drives}>{(drive) => <button disabled={state.drive.busy || !drive.online} onClick={() => browseDrive(drive.id, "")}>{drive.name}{drive.online ? "" : ` (${t("driveOffline")})`}</button>}</For></div>
                <Show when={!state.drive.drives.length}><p>{t("driveEmpty")}</p></Show>
                <Show when={state.drive.driveId}>
                  <p><code>{state.drive.path || "/"}</code></p>
                  <div class="builder-actions"><button disabled={state.drive.busy || !state.drive.path} onClick={() => browseDrive(state.drive.driveId, state.drive.path.split("/").slice(0, -1).join("/"))}>{t("driveUp")}</button><button disabled={state.drive.busy} onClick={() => chooseDrive({ driveId: state.drive.driveId, path: state.drive.path, kind: "folder" })}>{t("driveSelectFolder")}</button></div>
                  <ul class="builder-drive-files"><For each={state.drive.entries}>{(entry) => <li>
                    <span>{entry.name}{entry.locked ? ` (${t("driveLocked")})` : ""}</span>
                    <Show when={entry.isDir}><button disabled={state.drive.busy || entry.locked} onClick={() => browseDrive(state.drive.driveId, [state.drive.path, entry.name].filter(Boolean).join("/"))}>{t("driveOpen")}</button></Show>
                    <button disabled={state.drive.busy || entry.locked} onClick={() => chooseDrive({ driveId: state.drive.driveId, path: [state.drive.path, entry.name].filter(Boolean).join("/"), kind: entry.isDir ? "folder" : "file" })}>{t("driveSelect")}</button>
                  </li>}</For></ul>
                </Show>
              </Show>
              <Show when={state.brief.drive?.length}>
                <h4>{t("driveSelected")}</h4>
                <ul><For each={state.brief.drive}>{(item) => <li>{state.drive.drives.find((d) => d.id === item.driveId)?.name ?? item.driveId} / {item.path || "/"} <button onClick={() => chooseDrive(item)}>{t("driveRemove")}</button></li>}</For></ul>
                <label class="builder-drive-consent"><input type="checkbox" checked={state.brief.driveConsent} onChange={(e) => { const checked = e.currentTarget.checked; captureSources(); setState("brief", "driveConsent", checked) }} />{t("driveConsent")}</label>
              </Show>
            </section>
    <button disabled={state.busy} onClick={save}>{t("saveConnections")}</button>
    <Show when={state.saved}><p role="status">{t("connectionsSaved")}</p></Show>
  </div>
}
