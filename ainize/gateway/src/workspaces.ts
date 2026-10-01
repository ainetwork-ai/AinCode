import type { Identity } from "./identity.ts"

const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/
const PREFIX = "workspace-org:"

export type Organization = { id: string; name: string; role: string }

export function orgPrincipal(id: string) {
  if (!ORG_ID.test(id)) throw new Error("invalid organization")
  return PREFIX + id
}

export function workspaceOrg(principal: string) {
  return principal.startsWith(PREFIX) ? principal.slice(PREFIX.length) : undefined
}

export function workspaceBase(base: string, principal: string) {
  const org = workspaceOrg(principal)
  return org ? `${base}/org/${org}` : base
}

export function workspaceRoute(base: string, url: string) {
  const path = new URL(url, "http://gateway").pathname
  if (!path.startsWith(base + "/org/")) return { base }
  const id = path.slice((base + "/org/").length).split("/")[0]
  if (!ORG_ID.test(id)) throw new Error("invalid organization")
  return { base: `${base}/org/${id}`, org: id }
}

export function canWrite(org: Organization) {
  return org.role === "admin" || org.role === "write"
}

/** Never infer membership from a URL, browser field, or another member's cached session. */
export async function organizations(ainize: string, cookie: string, fetchImpl: typeof fetch = fetch): Promise<Organization[]> {
  const response = await fetchImpl(ainize + "/api/orgs", {
    headers: { cookie, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("organization membership unavailable")
  const body = await response.json() as { orgs?: { id?: unknown; name?: unknown; my_role?: unknown }[] }
  return Array.isArray(body.orgs) ? body.orgs.flatMap(org =>
    typeof org.id === "string" && ORG_ID.test(org.id) && typeof org.name === "string" &&
    typeof org.my_role === "string" && ["read", "contributor", "write", "admin"].includes(org.my_role)
      ? [{ id: org.id, name: org.name, role: org.my_role }] : []) : []
}

/** One explicit, time-limited execution account. Merely viewing a workspace cannot replace it. */
export class WorkspaceExecutors {
  private actors = new Map<string, { id: Identity; until: number }>()
  activate(org: string, id: Identity) {
    const prior = this.get(org)
    if (prior && prior.principal !== id.principal) throw new Error("another execution account is active")
    this.actors.set(org, { id, until: Date.now() + 30 * 60_000 })
  }
  release(org: string, principal: string) {
    if (this.get(org)?.principal === principal) this.actors.delete(org)
  }
  get(org: string) {
    const actor = this.actors.get(org)
    if (!actor || actor.until <= Date.now()) return undefined
    return actor.id
  }
}

export function agentInOrg(value: unknown, org: string): boolean {
  if (!value || typeof value !== "object") return false
  const agent = value as Record<string, unknown>
  return agent.visibility === "org" && (agent.orgId ?? agent.org_id) === org
}
