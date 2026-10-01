import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
export async function gallery(args, api, root) {
  const [command, id, ...rest] = args
  if (!command || ["help", "--help"].includes(command)) {
    console.log(
      "gallery context | list | new <id> | pull <id> [--force] | validate <id> | push <id> | test <id> <message or JSON file> | status <id> | memory/evolve/update-memory <id> <JSON file or stdin> | logs <id> | rm <id> --yes",
    )
    return
  }
  if (command === "context" || command === "list") {
    console.log(JSON.stringify(await api("GET", "/gallery/" + (command === "list" ? "agents" : "context")), null, 2))
    return
  }
  if (!id || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id))
    throw Error(
      "usage: ainize-agents gallery context|list|new|pull|validate|push|status|memory|evolve|update-memory|logs <id>",
    )
  const dir = join(root, id),
    file = join(dir, "builder.json"),
    state = join(dir, ".gallery.json")
  const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
  if (command === "new") {
    await api("GET", "/gallery/context")
    if (existsSync(dir)) throw Error("Folder exists; use pull")
    mkdirSync(dir, { recursive: true })
    save(file, {
      id,
      name: id,
      description: "",
      prompt: `You are ${id}. Answer helpfully.`,
      useSkills: false,
      skills: [],
      intents: [],
    })
    save(state, { version: null })
    console.log(file)
    return
  }
  if (command === "pull") {
    const data = await api("GET", "/gallery/agents/" + id)
    if (existsSync(file) && !rest.includes("--force"))
      throw Error("Local builder.json exists; review it before pull --force")
    mkdirSync(dir, { recursive: true })
    save(file, data.definition)
    save(state, { version: data.version })
    console.log(file)
    return
  }
  if (command === "validate" || command === "push") {
    const d = JSON.parse(readFileSync(file, "utf8"))
    if (
      d.id !== id ||
      typeof d.prompt !== "string" ||
      !d.prompt.trim() ||
      !Array.isArray(d.skills) ||
      !Array.isArray(d.intents) ||
      d.intents.some((i) => !Array.isArray(i.images) || i.images.length > 3)
    )
      throw Error("Invalid builder.json")
    if (command === "validate") {
      console.log(JSON.stringify(await api("POST", "/gallery/validate", { definition: d }), null, 2))
      return
    }
    const version = JSON.parse(readFileSync(state, "utf8")).version
    const data = await api(version === null ? "POST" : "PUT", "/gallery/agents" + (version === null ? "" : "/" + id), {
      definition: d,
      version,
    })
    save(state, { version: data.version })
    console.log(`${id}: saved in Uncommon Gallery (v${data.version})`)
    return
  }
  if (command === "test") {
    const params =
      rest[0] && existsSync(rest[0]) ? JSON.parse(readFileSync(rest[0], "utf8")) : { text: rest.join(" ") || "Hello" }
    const data = await api("POST", "/gallery/agents/" + id + "/test", params)
    if (data.error) throw Error(data.error.message || JSON.stringify(data.error))
    console.log(JSON.stringify(data, null, 2))
    return
  }
  if (command === "rm") {
    if (!rest.includes("--yes")) throw Error("Use gallery rm <id> --yes to confirm deletion")
    await api("DELETE", "/gallery/agents/" + id, {})
    if (existsSync(state)) save(state, { version: null, deletedAt: new Date().toISOString() })
    console.log(id + ": deleted; local definition retained")
    return
  }
  if (command === "logs") {
    console.log(JSON.stringify(await api("GET", "/gallery/agents/" + id + "/logs"), null, 2))
    return
  }
  const action =
    command === "status"
      ? "status"
      : command === "memory"
        ? "memory.set"
        : command === "evolve"
          ? "thinking.evolve"
          : command === "update-memory"
            ? "memory.update"
            : undefined
  if (!action) throw Error("Unknown gallery command")
  const params = command === "status" ? {} : JSON.parse(readFileSync(rest[0] || 0, "utf8"))
  console.log(JSON.stringify(await api("POST", "/gallery/agents/" + id + "/memory", { action, params }), null, 2))
}
