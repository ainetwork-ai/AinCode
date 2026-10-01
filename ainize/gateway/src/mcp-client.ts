/** Bounded Streamable HTTP MCP client. A fresh negotiated session is closed after each operation. */
export async function mcpRequest(fetchImpl: typeof fetch, endpoint: string, token: string, method: string, params: unknown = {}) {
  let session: string | null = null
  async function rpc(id: number | undefined, name: string, args: unknown) {
    const response = await fetchImpl(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method: name, params: args }),
    })
    session = response.headers.get("mcp-session-id") ?? session
    if (!response.ok) throw new Error("mcp_unavailable")
    if (id === undefined) { await response.body?.cancel(); return {} }
    const reader = response.body?.getReader()
    if (!reader) throw new Error("mcp_unavailable")
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 2_000_000) { await reader.cancel(); throw new Error("mcp_response_too_large") }
      chunks.push(part.value)
    }
    const text = Buffer.concat(chunks).toString("utf8")
    const body = response.headers.get("content-type")?.includes("text/event-stream") ? text.split(/\r?\n\r?\n/).flatMap((block) => {
      const raw = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
      return raw ? [JSON.parse(raw)] : []
    }).find((r) => r.id === id) : JSON.parse(text)
    if (!body || body.error || body.result?.isError) throw new Error("mcp_unavailable")
    return body.result
  }
  try {
    await rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "AinCode Builder", version: "1.0" } })
    await rpc(undefined, "notifications/initialized", {})
    return await rpc(2, method, params)
  } finally {
    if (session) await fetchImpl(endpoint, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": session, "mcp-protocol-version": "2025-03-26" }, redirect: "error", signal: AbortSignal.timeout(5000) }).catch(() => undefined)
  }
}
export function mcpData(result: { structuredContent?: unknown; content?: { type: string; text?: string }[] }): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") ?? ""
  try { return JSON.parse(text) } catch { return text }
}
