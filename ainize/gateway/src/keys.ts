/**
 * One ainize API key per person, created with their own session the first time their workspace calls the model,
 * and kept here (0600). The workspace never sees it: the relay adds it on the way out.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

interface Stored {
  key: string
  prefix?: string
  createdAt: string
}

export class KeyStore {
  private readonly file: string
  private readonly ainize: string
  private readonly label: string
  private readonly fetchImpl: typeof fetch
  private keys: Record<string, Stored>
  private creating = new Map<string, Promise<string>>()

  constructor(stateDir: string, ainize: string, label: string, fetchImpl: typeof fetch = fetch) {
    this.file = join(stateDir, "keys.json")
    this.ainize = ainize
    this.label = label
    this.fetchImpl = fetchImpl
    this.keys = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {}
  }

  private save() {
    const tmp = this.file + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.keys, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  has(principal: string): boolean {
    return !!this.keys[principal]
  }

  /** The person's key; created with `cookie` (their ainize cookies) when there is none yet. */
  async get(principal: string, cookie: string | undefined): Promise<string> {
    const have = this.keys[principal]
    if (have) return have.key
    if (!cookie) throw new SessionMissing()
    let pending = this.creating.get(principal)
    if (!pending) {
      pending = this.create(principal, cookie).finally(() => this.creating.delete(principal))
      this.creating.set(principal, pending)
    }
    return pending
  }

  /** Forget a key ainize no longer accepts (revoked on the keys page, say); the next call makes a new one. */
  drop(principal: string, key: string) {
    if (this.keys[principal]?.key !== key) return
    delete this.keys[principal]
    this.save()
  }

  private async create(principal: string, cookie: string): Promise<string> {
    // org_id null: a personal key. It keeps working if an organization suspends the person — which is fine,
    // because what the workspace may change is decided per call by the person's session, not by this key.
    const res = await this.fetchImpl(this.ainize + "/api/keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ label: this.label, org_id: null }),
    })
    const body: any = await res.json().catch(() => null)
    if (res.status === 401) throw new SessionMissing()
    if (!res.ok || !body?.api_key) throw new Error(`ainize would not issue an API key (${res.status}): ${JSON.stringify(body)}`)
    this.keys[principal] = { key: body.api_key, prefix: body.prefix, createdAt: new Date().toISOString() }
    this.save()
    return body.api_key
  }
}

export class SessionMissing extends Error {
  constructor() {
    super("your ainize session is not known to the workspace gateway — reload ainize.ai/code in the browser")
  }
}
