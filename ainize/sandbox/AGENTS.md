# AinCode on ainize.ai

You are working in a person's private AinCode workspace on ainize.ai. The workspace is a sandbox. It has no
internet access. The model and the ainize API are reached only through the workspace gateway, which acts as the
signed-in person. Everything here exists to help that person build and manage **their ainize agents**, meaning the
agents they created and the agents of organizations they may edit.

## Layout

The workspace root is `/home/aincode/agents` (a git repository). Each agent is one folder:

```
<id>/agent.json    name, description, model, mode, allowedHosts, secretNames, skills, media, a2ui (and visibility, orgId)
<id>/prompt.md     the system prompt
<id>/files/        code, for `tools` and `handler` agents; files/index.mjs is the entry point
<id>/.ainize.json  the version last pulled or pushed; do not edit
```

## Syncing with ainize: `ainize-agents`

Run these in the terminal or through the shell tool:

- `ainize-agents list`: the agents this person can manage, and which of them are pulled here.
- `ainize-agents pull <id>` or `ainize-agents pull --all`: fetches agents into folders. Pull before editing.
- `ainize-agents new <id> --mode prompt|tools|handler [--name "Name"] [--org <org id>]`: scaffolds a new agent
  locally. It is not on ainize until you push it. It is `private` by default; with `--org` it is shared with that
  AIN organization (`visibility: "org"`, `orgId`), and every member of it may then change it. Only its creator may
  delete it or change `visibility`/`orgId`.
- `ainize-agents push <id>`: creates the agent on ainize or updates it. This is what deploys a change. It refuses to
  push if someone else changed the agent since the pull; in that case pull again and merge (your edits are in git).
- `ainize-agents logs <id>`: shows recent runtime output of a code agent.
- `echo -n VALUE | ainize-agents secret <id> NAME`: sets a secret. The name must also be listed in `secretNames`.
  Never write secret values into files.
- `ainize-agents rm <id> --yes`: deletes the agent on ainize for everyone. Ask the person first.

## Rules the node enforces (respect them before pushing)

- `id` is 1–40 characters of lower-case letters, digits and hyphens, and cannot change once created.
- `prompt` mode runs no code, so `files/` must be empty. `tools` and `handler` modes need `files/index.mjs`.
- Code files total at most 1 MB. A path has at most 4 segments of plain characters. An optional
  `files/package.json` is installed without running scripts.
- `allowedHosts` are domain names or `*.domain`, never IP addresses. Agents can only reach those hosts.
- `systemPrompt` (prompt.md) is at most 8000 characters. `name` is at most 80 characters and `description` at most
  500 characters.
- A handler looks like this:

  ```js
  export default {
    async execute(input, ctx) {
      const r = await ctx.llm.chat({ messages: [{ role: "user", content: input }] })
      return { text: r.message.content }
    },
  }
  ```

  In a handler, `ctx.fetch(url)` reaches the public internet limited to `allowedHosts`, and `ctx.secret("NAME")`
  reads a secret.

## Working style

- Show the person what you will change, and push only when they want the change live. A push is a deployment.
- Commit to git in this workspace before large edits so they can be undone.
- If a command says the session has ended, tell the person to reload ainize.ai/code.

## Guided building inside OpenCode

Use the question tool to gather concrete behavior for all three platforms in this session. Prefix question
headers with `AIN Builder`. Ask one question at a time, with useful choices and custom answers. Credentials
and consent belong in the session’s connections panel, never in chat.

- `ainize-agents connections` reads this workspace owner's saved target and tool selections.
- `ainize-agents connections <id>` imports connector modules into an existing local tools agent and merges
  required hosts and secret names. It does not write index.mjs, create credentials or deploy.
- Write workflow code, prompt and tests yourself. Import drive.mjs as a default export (drive.tools), and
  mcp.mjs as named tools when present. Preserve these scoped connector modules.
- After user-requested push, use `ainize-agents connect <id>` to bind saved connections. Check returned status.
- Do not use the legacy builder create API instead of local development. Distinguish local tests from live
  MCP calls and actual host-specific A2A verification. Continue development in this same OpenCode session.

## Uncommon Gallery Builder
When asked to create or edit an AINSpace/A2A Builder agent, use `ainize-agents gallery context`, `new`, `pull`, `validate`, `push`. New agents are always stored in Uncommon Gallery. Edit `agents/<id>/builder.json`; skills and intents remain separate fields, not flattened into the prompt. Preserve existing memories and context history. Manual image upload and authoring are at `/code/gallery`. Memory commands are `gallery status`, `memory`, `evolve`, `update-memory` (JSON file or stdin). Do not invent successful imports of old memories. Test actual A2A replies and report model-related differences.
