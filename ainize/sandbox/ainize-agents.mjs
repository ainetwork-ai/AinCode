#!/usr/bin/env node
/**
 * ainize-agents — keep the ainize agents you may manage as folders in this workspace.
 *
 *   agents/<id>/agent.json   everything about the agent except its prompt and code
 *   agents/<id>/prompt.md    the system prompt
 *   agents/<id>/files/...    code, for `tools` and `handler` agents (index.mjs is the entry)
 *   agents/<id>/.ainize.json what was last pulled or pushed (the version a push is based on)
 *
 * It talks to $AINIZE_API (the sandbox gateway). The gateway signs each call as the person using this workspace,
 * and ainize decides what that person may read or change; this tool holds no credentials.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

const API = (process.env.AINIZE_API || "http://127.0.0.1:4097/api").replace(/\/$/, "")
const ROOT = process.env.AINIZE_AGENTS_DIR || "/home/aincode/agents"
const DEFAULT_MODEL = "Qwen3.8-Flash-Next"
// Fields the node sets itself; never sent back.
const SERVER_FIELDS = new Set([
  "owner", "version", "createdAt", "updatedAt", "created_at", "updated_at", "files", "systemPrompt",
  "status", "error", "live_version", "a2a_url", "card_url", "secrets", "kind", "url",
  "org_id", "updated_by", "updatedBy", "can_manage", "can_delete",
])
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/

class ApiError extends Error {
  constructor(status, body) {
    super(typeof body === "object" && body ? body.error?.message || body.message || body.error || JSON.stringify(body) : String(body))
    this.status = status
  }
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data = text
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) throw new ApiError(res.status, data)
  return data
}

const dirOf = (id) => join(ROOT, id)
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"))
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n")

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function listOf(data) {
  if (Array.isArray(data)) return data
  return data?.agents ?? data?.items ?? data?.data ?? []
}

async function remoteList() {
  // `manageable=1` is my agents plus those shared (visibility "org") with an organization I belong to; its rows carry
  // `can_manage`. A node that predates it ignores the parameter and answers its public list instead, so rows without
  // `can_manage` mean "ask for mine=1" — "created by me", which every node knows.
  const managed = listOf(await api("GET", "/hosted-agents?manageable=1"))
  if (managed.length && managed.every((a) => "can_manage" in a)) return { scope: "yours and your organizations'", agents: managed }
  return { scope: "yours", agents: listOf(await api("GET", "/hosted-agents?mine=1")) }
}

async function remoteGet(id) {
  try {
    const data = await api("GET", `/hosted-agents/${id}`)
    return data?.agent ?? data
  } catch (e) {
    if (e.status === 404) return null
    throw e
  }
}

function writeLocal(spec) {
  const dir = dirOf(spec.id)
  mkdirSync(dir, { recursive: true })
  const meta = {}
  for (const [k, v] of Object.entries(spec)) if (!SERVER_FIELDS.has(k)) meta[k] = v
  // The node answers `org_id`; it takes `orgId` back. Only an `org` agent has one.
  const orgId = spec.orgId ?? spec.org_id ?? null
  if (meta.visibility === "org" && orgId) meta.orgId = orgId
  else delete meta.orgId
  writeJson(join(dir, "agent.json"), meta)
  writeFileSync(join(dir, "prompt.md"), spec.systemPrompt ?? "")
  rmSync(join(dir, "files"), { recursive: true, force: true })
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const p = join(dir, "files", ...rel.split("/"))
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, content)
  }
  writeJson(join(dir, ".ainize.json"), {
    version: spec.version ?? null,
    owner: spec.owner ?? null,
    updatedAt: spec.updated_at ?? spec.updatedAt ?? null,
    pulledAt: new Date().toISOString(),
  })
}

function readLocal(id) {
  const dir = dirOf(id)
  if (!existsSync(join(dir, "agent.json"))) throw new Error(`no agent at ${dir} (run: ainize-agents pull ${id}, or new ${id})`)
  const meta = readJson(join(dir, "agent.json"))
  if (meta.id !== id) throw new Error(`agent.json says id "${meta.id}" but the folder is "${id}"`)
  // An agent.json written before the node's sharing fields: `org` meant "share with this organization".
  if (meta.org && !meta.orgId) Object.assign(meta, { visibility: "org", orgId: meta.org })
  delete meta.org
  const files = {}
  const base = join(dir, "files")
  for (const p of walk(base)) files[relative(base, p).split(sep).join("/")] = readFileSync(p, "utf8")
  const prompt = existsSync(join(dir, "prompt.md")) ? readFileSync(join(dir, "prompt.md"), "utf8") : ""
  const state = existsSync(join(dir, ".ainize.json")) ? readJson(join(dir, ".ainize.json")) : {}
  return { spec: { ...meta, systemPrompt: prompt, files }, state }
}

const HANDLER = `/**
 * A handler agent: ainize calls execute() once per message.
 *   input        the user's text
 *   ctx.llm.chat({ messages })        the agent's model
 *   ctx.fetch(url, init)              the public internet, limited to agent.json allowedHosts
 *   ctx.secret("NAME")                a secret named in agent.json secretNames
 * Return { text } (and optionally { ui } for an A2UI surface).
 */
export default {
  async execute(input, ctx) {
    const answer = await ctx.llm.chat({ messages: [{ role: "user", content: input }] })
    return { text: answer.message.content }
  },
}
`

const commands = {
  async list() {
    const { scope, agents } = await remoteList()
    const local = existsSync(ROOT) ? readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, "agent.json"))) : []
    const seen = new Set()
    console.log(`# ainize agents you can manage (${scope})`)
    for (const a of agents) {
      seen.add(a.id)
      const where = local.includes(a.id) ? "pulled" : "remote only"
      const orgId = a.org_id ?? a.orgId
      const org = orgId ? ` org=${orgId}` : ""
      const vis = a.visibility ? ` ${a.visibility}` : ""
      const mineFlag = a.can_delete === false ? " (organization's)" : ""
      console.log(`${a.id}\t${a.mode ?? "prompt"}\tv${a.version ?? "?"}${org}${vis}${mineFlag}\t${where}\t${a.name ?? ""}`)
    }
    for (const id of local) if (!seen.has(id)) console.log(`${id}\t-\t-\tlocal only (not on ainize yet: ainize-agents push ${id})`)
  },

  async pull(args) {
    const ids = args.includes("--all") ? (await remoteList()).agents.map((a) => a.id) : args.filter((a) => !a.startsWith("--"))
    if (!ids.length) throw new Error("usage: ainize-agents pull <id...> | --all")
    for (const id of ids) {
      const spec = await remoteGet(id)
      if (!spec) throw new Error(`${id}: not found on ainize (or not yours to read)`)
      if (existsSync(join(dirOf(id), "agent.json")) && !args.includes("--force")) {
        const { state } = readLocal(id)
        if (state.version != null && spec.version != null && state.version === spec.version) {
          console.log(`${id}: already at v${spec.version}`)
          continue
        }
      }
      writeLocal(spec)
      console.log(`${id}: pulled v${spec.version ?? "?"} → ${dirOf(id)}`)
    }
  },

  async push(args) {
    const id = args.find((a) => !a.startsWith("--"))
    if (!id) throw new Error("usage: ainize-agents push <id> [--force]")
    const { spec, state } = readLocal(id)
    const remote = await remoteGet(id)
    let saved
    if (!remote) {
      saved = await api("POST", "/hosted-agents", spec)
    } else {
      if (state.version != null && remote.version != null && remote.version !== state.version && !args.includes("--force")) {
        throw new Error(
          `${id}: ainize has v${remote.version} but this folder is based on v${state.version}. ` +
            `Someone changed it since you pulled. Pull again (your edits are in git), or push --force to overwrite.`,
        )
      }
      saved = await api("PUT", `/hosted-agents/${id}`, spec)
    }
    const fresh = (await remoteGet(id)) ?? saved?.agent ?? saved
    writeJson(join(dirOf(id), ".ainize.json"), {
      version: fresh?.version ?? null,
      owner: fresh?.owner ?? null,
      updatedAt: fresh?.updated_at ?? fresh?.updatedAt ?? null,
      pushedAt: new Date().toISOString(),
    })
    console.log(`${id}: ${remote ? "updated" : "created"} on ainize (v${fresh?.version ?? "?"})`)
  },

  async new(args) {
    const id = args.find((a) => !a.startsWith("--") && !isFlagValue(args, a))
    if (!id || !ID.test(id)) throw new Error("usage: ainize-agents new <id> [--mode prompt|tools|handler] [--name <name>] [--org <org>]\n  id: 1–40 lower-case letters, digits, hyphens")
    if (existsSync(dirOf(id))) throw new Error(`${dirOf(id)} already exists`)
    const mode = flag(args, "--mode") ?? "prompt"
    if (!["prompt", "tools", "handler"].includes(mode)) throw new Error("--mode is prompt, tools or handler")
    let model = DEFAULT_MODEL
    try {
      const models = listOf(await api("GET", "/models")).filter((m) => (m.modality ?? "chat") === "chat" && m.available !== false)
      if (models.length && !models.some((m) => m.id === DEFAULT_MODEL)) model = models[0].id
    } catch {}
    const meta = {
      id,
      name: flag(args, "--name") ?? id,
      description: "",
      model,
      mode,
      a2ui: false,
      allowedHosts: [],
      secretNames: [],
      media: { transcription: false, image: false },
      skills: [],
    }
    // Shared with an organization: its members may then change it too (only you may remove it or change this).
    const org = flag(args, "--org")
    const visibility = flag(args, "--visibility") ?? (org ? "org" : "private")
    if (!["public", "org", "private", "unlisted"].includes(visibility)) throw new Error("--visibility is public, org, private or unlisted")
    if (visibility === "org" && !org) throw new Error("--visibility org needs --org <organization id>")
    Object.assign(meta, { visibility, ...(visibility === "org" ? { orgId: org } : {}) })
    mkdirSync(dirOf(id), { recursive: true })
    writeJson(join(dirOf(id), "agent.json"), meta)
    writeFileSync(join(dirOf(id), "prompt.md"), `You are ${meta.name}. Answer helpfully and concisely.\n`)
    if (mode !== "prompt") {
      mkdirSync(join(dirOf(id), "files"), { recursive: true })
      writeFileSync(join(dirOf(id), "files", "index.mjs"), HANDLER)
    }
    writeJson(join(dirOf(id), ".ainize.json"), { version: null })
    console.log(`${id}: scaffolded ${mode} agent in ${dirOf(id)} — edit it, then: ainize-agents push ${id}`)
  },

  async connections(args) {
    const data = await api("GET", "/builder/connections")
    const id = args[0]
    if (!id) { console.log(JSON.stringify(data.selection, null, 2)); return }
    if (!ID.test(id) || !existsSync(join(dirOf(id), "agent.json"))) throw new Error("Create a local tools agent first")
    const manifest = readJson(join(dirOf(id), "agent.json"))
    if (manifest.mode !== "tools") throw new Error("Builder connections require tools mode")
    const files = data.files ?? {}
    for (const [name, code] of Object.entries(files)) {
      if (!["drive.mjs", "mcp.mjs"].includes(name) || typeof code !== "string") throw new Error("Invalid connector module")
      const file = join(dirOf(id), "files", name)
      if (existsSync(file) && readFileSync(file, "utf8") !== code) throw new Error(`${name} differs: review and move it before importing`)
    }
    mkdirSync(join(dirOf(id), "files"), { recursive: true })
    for (const [name, code] of Object.entries(files)) writeFileSync(join(dirOf(id), "files", name), code)
    manifest.allowedHosts = [...new Set([...(manifest.allowedHosts ?? []), ...data.allowedHosts])]
    manifest.secretNames = [...new Set([...(manifest.secretNames ?? []), ...data.secretNames])]
    writeJson(join(dirOf(id), "agent.json"), manifest)
    writeJson(join(dirOf(id), "builder-connections.json"), data.selection)
    console.log(`${id}: imported ${Object.keys(files).join(", ") || "no connectors"}. Write files/index.mjs yourself. Not deployed.`)
  },
  async connect(args) {
    const id = args[0]
    if (!id || !ID.test(id)) throw new Error("usage: ainize-agents connect <id>")
    const data = await api("POST", `/builder/agents/${id}/connect`, {})
    console.log(JSON.stringify(data, null, 2))
    if (data.agent?.driveStatus === "failed" || data.agent?.mcpStatus === "failed") throw new Error("Connection binding failed; inspect saved permissions before retrying")
  },

  async logs(args) {
    const id = args[0]
    if (!id) throw new Error("usage: ainize-agents logs <id>")
    const data = await api("GET", `/hosted-agents/${id}/logs`)
    const lines = Array.isArray(data) ? data : data?.logs ?? data?.lines ?? [data]
    for (const l of lines) console.log(typeof l === "string" ? l : JSON.stringify(l))
  },

  async secret(args) {
    const [id, name] = args
    if (!id || !name) throw new Error("usage: echo -n VALUE | ainize-agents secret <id> <NAME>   (empty input removes it)")
    const value = readFileSync(0, "utf8")
    await api("PUT", `/hosted-agents/${id}/secrets/${name}`, { value: value.length ? value : null })
    console.log(`${id}: secret ${name} ${value.length ? "set" : "removed"}`)
  },

  async rm(args) {
    const id = args.find((a) => !a.startsWith("--"))
    if (!id) throw new Error("usage: ainize-agents rm <id> --yes")
    if (!args.includes("--yes")) throw new Error(`this deletes ${id} from ainize for everyone. Re-run with --yes to confirm.`)
    await api("DELETE", `/hosted-agents/${id}`)
    if (existsSync(join(dirOf(id), ".ainize.json"))) writeJson(join(dirOf(id), ".ainize.json"), { version: null, deletedAt: new Date().toISOString() })
    console.log(`${id}: deleted on ainize (the local folder is kept)`)
  },

  async whoami() {
    const me = await api("GET", "/auth/me")
    console.log(JSON.stringify({ signedIn: me.signedIn, subject: me.subject, sso: me.sso ? { principal: me.sso.principal, email: me.sso.email, orgs: me.sso.orgs } : null }, null, 2))
  },
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
function isFlagValue(args, a) {
  const i = args.indexOf(a)
  return i > 0 && args[i - 1].startsWith("--") && !["--force", "--yes", "--all"].includes(args[i - 1])
}

const [cmd, ...rest] = process.argv.slice(2)
if (!cmd || !commands[cmd]) {
  console.log(`usage: ainize-agents <command>
  list                         agents you can manage, and which are pulled here
  pull <id...> | --all         fetch into ${ROOT}/<id>
  push <id> [--force]          create or update on ainize from the folder
  new <id> [--mode prompt|tools|handler] [--name N] [--org ORG] [--visibility public|org|private|unlisted]
  connections [id]             inspect saved connections or import scoped tools locally
  connect <id>                 bind saved connections after pushing
  logs <id>                    recent runtime logs
  secret <id> <NAME>           set a secret from stdin
  rm <id> --yes                delete on ainize
  whoami                       who ainize thinks you are`)
  process.exit(cmd ? 2 : 0)
}
try {
  await commands[cmd](rest)
} catch (e) {
  console.error(`ainize-agents ${cmd}: ${e.message}`)
  if (e.status === 401) console.error("(if your ainize session ended, reload ainize.ai/code in the browser and try again)")
  process.exit(1)
}
