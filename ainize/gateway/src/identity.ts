/**
 * Who is asking — decided by ainize, from the browser's own ainize cookies, never by anything the gateway keeps.
 *
 * `GET /api/auth/me` answers 200 whether or not anyone is signed in, so the body decides. A wallet or AIN SSO
 * session is the node's (`ainize_session`); a legacy Google sign-in lives only in the web server's cookie
 * (`ainize_google_session`) and is read from `/api/auth/google/session`.
 */
import { createHash } from "node:crypto"

export const AINIZE_COOKIES = ["ainize_session", "ainize_google_session"]

export interface Identity {
  /** Authentication evidence is separate from the stable (possibly legacy-linked) principal. */
  authType?: "sso" | "wallet" | "google"
  /** Stable name of the person: `sso:<sub>`, `google:<sub>` or a lower-case wallet address. */
  principal: string
  display: string
  /** Only the ainize cookies, as a Cookie header — what the gateway replays to ainize on the person's behalf. */
  cookie: string
}

function parseCookies(header: string | undefined): [string, string][] {
  if (!header) return []
  return header
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=")
      return (i < 0 ? [p, ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]) as [string, string]
    })
}

/** The ainize cookies from a Cookie header, re-joined; empty when there are none. */
export function ainizeCookies(header: string | undefined): string {
  return parseCookies(header)
    .filter(([k]) => AINIZE_COOKIES.includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")
}

/** A Cookie header without the ainize cookies (so they never reach a workspace), or undefined if nothing is left. */
export function withoutAinizeCookies(header: string | undefined): string | undefined {
  const rest = parseCookies(header)
    .filter(([k]) => !AINIZE_COOKIES.includes(k))
    .map(([k, v]) => `${k}=${v}`)
  return rest.length ? rest.join("; ") : undefined
}

export function principalHash(principal: string): string {
  return createHash("sha256").update(principal).digest("hex").slice(0, 12)
}

interface Me {
  signedIn?: boolean
  subject?: string | null
  sso?: { principal?: string; name?: string | null; email?: string | null } | null
}

type Fetch = typeof fetch

export class IdentityResolver {
  private cache = new Map<string, { at: number; id: Identity | null }>()
  private readonly ainize: string
  private readonly fetchImpl: Fetch
  private readonly ttlMs: number

  constructor(ainize: string, fetchImpl: Fetch = fetch, ttlMs = 15_000) {
    this.ainize = ainize
    this.fetchImpl = fetchImpl
    this.ttlMs = ttlMs
  }

  async identify(cookieHeader: string | undefined): Promise<Identity | null> {
    const cookie = ainizeCookies(cookieHeader)
    if (!cookie) return null
    const key = createHash("sha256").update(cookie).digest("hex")
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.id
    const id = await this.resolve(cookie)
    this.cache.set(key, { at: Date.now(), id })
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!)
    return id
  }

  private async get(path: string, cookie: string): Promise<any> {
    const res = await this.fetchImpl(this.ainize + path, { headers: { cookie, accept: "application/json" } })
    if (!res.ok) throw new Error(`ainize ${path} answered ${res.status}`)
    return res.json()
  }

  private async resolve(cookie: string): Promise<Identity | null> {
    if (cookie.includes("ainize_session=")) {
      const me = (await this.get("/api/auth/me", cookie)) as Me
      if (me.sso?.principal) {
        return { principal: me.sso.principal, display: me.sso.email || me.sso.name || me.sso.principal, cookie, authType: "sso" }
      }
      if (me.signedIn && me.subject) return { principal: String(me.subject).toLowerCase(), display: String(me.subject), cookie, authType: "wallet" }
    }
    if (cookie.includes("ainize_google_session=")) {
      const g = (await this.get("/api/auth/google/session", cookie)) as { identity?: { sub?: string; email?: string } | null }
      if (g.identity?.sub) return { principal: `google:${g.identity.sub}`, display: g.identity.email || g.identity.sub, cookie, authType: "google" }
    }
    return null
  }
}
