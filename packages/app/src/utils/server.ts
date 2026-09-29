import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OpenCodeClient {
  return OpenCode.make({
    baseUrl: input.server.url,
    fetch: keepBasePath(input.server.url, input.fetch),
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
  })
}

/**
 * The vendored client resolves absolute request paths against `baseUrl`, which drops a path prefix
 * such as `/code` (OPENCODE_BASE_PATH). Re-apply the prefix to same-origin requests that lost it.
 */
export function keepBasePath(baseUrl: string, fetch?: typeof globalThis.fetch): typeof globalThis.fetch | undefined {
  const base = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
  const prefix = base?.pathname.replace(/\/+$/, "") ?? ""
  if (!base || !prefix) return fetch
  const next = fetch ?? globalThis.fetch
  const prefixed = (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) return next(input, init)
    const url = new URL(input)
    if (url.origin !== base.origin || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) return next(input, init)
    url.pathname = prefix + url.pathname
    return next(url, init)
  }
  return Object.assign(prefixed, { preconnect: next.preconnect })
}

export type ServerApi = OpenCodeClient
