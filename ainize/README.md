# ainize.ai/code

This folder runs AinCode as a web app at `https://ainize.ai/code/`. Every signed-in ainize user gets their own
sandboxed workspace, where they can build and manage the ainize agents they own (and, once the node supports it,
the agents of their organizations). The model is Qwen3.8-Flash-Next through ainize's OpenAI-compatible API, which
relays to the GPU peer.

```
browser ─https─▶ nginx  location /code/ ─▶ aincode-gateway 127.0.0.1:3950
                                              │  signs the request in with ainize (/api/auth/me, the browser's cookies)
                                              │  starts / reuses that person's container
                                              ▼
                              ┌─ container aincode-<hash> ── --network none ─────────────┐
                              │  aincode serve (127.0.0.1:4096, OPENCODE_BASE_PATH=/code)  │
                              │  /home/aincode = volume aincode-home-<hash> (git workspace)│
                              │  /run/aincode/in.sock  ◀── gateway (HTTP, SSE, WebSocket)  │
                              │  127.0.0.1:4097 ─▶ /run/aincode/out.sock ─▶ gateway egress │
                              └────────────────────────────────────────────────────────────┘
gateway egress ─▶ ainize web 127.0.0.1:3900 ─▶ node
    /v1/chat/completions, /v1/models   with the person's API key (created once with their session, kept 0600)
    /api/hosted-agents…, /api/linked-agents…, /api/models, /api/agents, /api/auth/me, GET /api/orgs…
                                       with the person's own session cookie
```

| Path | What it is |
|---|---|
| `sandbox/Dockerfile`, `sandbox/build.sh` | The `aincode-sandbox` image: the AinCode linux-x64 binary, git, ripgrep, node, the config and the CLI. |
| `sandbox/opencode.json` | The only provider is `ainize` (`@ai-sdk/openai-compatible`, bundled in the binary), at `127.0.0.1:4097/v1`. Context is 262144. Auto-update, sharing, LSP and formatter downloads are all off. |
| `sandbox/entrypoint.mjs` | Creates the git workspace, the two socket bridges, and `aincode serve`. |
| `sandbox/ainize-agents.mjs` | `ainize-agents list/pull/push/new/logs/secret/rm/whoami`: agents as folders (`agent.json`, `prompt.md`, `files/`). |
| `sandbox/AGENTS.md` | What the model is told about the workspace. |
| `gateway/` | The gateway, in Node 24 with TypeScript run directly, and no dependencies. |
| `deploy/` | A systemd user unit and the nginx `location` block. |

## Security model

- **Identity.** Identity comes only from ainize. The gateway replays the browser's `ainize_session` /
  `ainize_google_session` cookies to `/api/auth/me` (or `/api/auth/google/session`). The principal is the SSO
  principal, else the wallet address, else `google:<sub>`.
- **One person, one container.** Each person gets their own container, volume and socket directory, with
  `hash = sha256(principal)[0:12]`. Each person's out.sock is their identity, so there is no token to steal.
- **Network.** The container has none at all (`--network none`). It cannot reach the internet, this host's
  services, or the LAN. An `--internal` bridge would not be enough, because a container on a bridge still reaches
  every host port bound on 0.0.0.0 through the bridge gateway address.
- **Container hardening.** `--cap-drop ALL`, `no-new-privileges`, `--read-only` with a tmpfs `/tmp`, uid 1000,
  pids/memory/cpu limits, no published ports, and no docker socket. Set `AINCODE_DOCKER_RUNTIME=runsc` once gVisor
  is installed.
- **Credentials.** The workspace never sees the person's ainize session or API key; the gateway adds them on the way
  out. The inner server has its own random Basic-auth password, which the gateway injects. The browser's ainize
  cookies and `Authorization` header are stripped on the way in.
- **What a workspace can reach.** It can only call an allowlist of ainize routes. It cannot mint keys, change
  organizations, sign out, or reach operator routes. **ainize decides every permission:** a workspace can do
  exactly what its owner could do on ainize.ai.
- **Model allowlist.** A workspace may only call the models in `AINCODE_MODELS`.
- **Cross-site requests.** Non-GET requests and WebSocket handshakes with a foreign `Origin` are refused.

## Operating

| Env | Default | |
|---|---|---|
| `AINCODE_GATEWAY_HOST` / `_PORT` | `127.0.0.1` / `3950` | never a public interface |
| `AINCODE_BASE_PATH` | `/code` | must match the image's `OPENCODE_BASE_PATH` |
| `AINIZE_WEB_URL` | `http://127.0.0.1:3900` | the ainize web server (it relays `/api` and `/v1` to the node) |
| `AINCODE_STATE_DIR` | `~/.aincode-gateway` | keys, passwords, sockets. Keep the path short: a socket path must fit in 107 bytes |
| `AINCODE_IMAGE` | `aincode-sandbox:latest` | |
| `AINCODE_IDLE_MS` | `1800000` | stop a workspace with no open connection after this long (its files stay) |
| `AINCODE_MAX_RUNNING` | `10` | starting one more stops the least recently used |
| `AINCODE_MEMORY` / `_CPUS` / `_PIDS` | `2g` / `2` / `512` | per workspace |
| `AINCODE_MODELS` | `Qwen3.8-Flash-Next` | comma-separated |
| `AINCODE_DOCKER_RUNTIME` | *(docker default)* | e.g. `runsc` |
| `AINCODE_INSTANCE` | *(empty)* | namespace for a second gateway on the same host (staging/tests): its containers, volumes and label carry the name, so it never adopts or stops the production workspaces |

- **Tests:** `cd ainize/gateway && node --test test/*.test.ts`.
- **Updating the image:** run `ainize/sandbox/build.sh --rebuild-binary`, then remove the old containers with
  `docker rm -f $(docker ps -aq --filter label=ainize.aincode=1)`. The volumes keep everyone's files, and each
  workspace is recreated from the new image on its next visit.

## Going live (needs sudo once)

```bash
# 1. image + gateway (no sudo)
cd /mnt/newdata/git/AinCode && git pull && ainize/sandbox/build.sh --rebuild-binary
mkdir -p ~/aincode-gateway && ln -sfn /mnt/newdata/git/AinCode ~/aincode-gateway/current
cp ainize/deploy/aincode-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now aincode-gateway
curl -s -o /dev/null -w '%{http_code}\n' -H 'accept: text/html' http://127.0.0.1:3950/code/   # 200 (sign-in page)

# 2. nginx (sudo)
echo "map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }" | sudo tee /etc/nginx/conf.d/websocket-upgrade.conf
sudo cp /etc/nginx/sites-available/ainize.ai /etc/nginx/sites-available/ainize.ai.bak-$(date +%Y%m%d)
#    paste ainize/deploy/nginx-code.conf into the 443 server block, above `location / {`
sudo nginx -t && sudo systemctl reload nginx
```

## Known gaps

- **Organizations.** The node (ainize-node #40, #41) lets wallet and AIN SSO sessions create hosted agents, and
  members of an AIN organization change the agents shared with it (`visibility: "org"`, `orgId`); only the creator
  deletes or re-shares. `ainize-agents list` uses `?manageable=1`. Google-only sessions are not yet agent owners on
  the node.
- **Signing in from the landing page.** The sign-in page's wallet and Google routes return with an in-app
  navigation, which can land on the site's own 404 for `/code/` until the page is reloaded. "Sign in with AIN" is a
  full redirect and returns to `/code/` directly.


## Guided agent builder

`/code/builder` opens a five-step AIN-UI surface inside the AinCode application: purpose, requested sources,
response preferences, sharing, and review. AIN Teams uses its configured Ainize URL plus this path for both
its desktop and mobile Builder entry points. AIN sign-in returns to the builder. Google-only sessions receive
an explicit unsupported-owner message.

The final **Create agent** action publishes an agent using the signed-in person's session, through the
existing hosted-agent API. The gateway accepts a bounded brief, not arbitrary code, model overrides, ownership
fields or URLs. It verifies organization membership again before an organization-scoped create; the node is
still the authorization authority. There is no auto-share, auto-invite or token handoff to Teams.

Without selected Drive sources, prompt mode preserves the node's conversation history, attachment and delegated-file tools.
Generated agents advertise text output, not UI capabilities they do not implement. The guidance UI itself uses
`ain-ui/renderer`; this does not require every generated agent to return UI. Requested sources written as text do not grant access. Drive sources selected in the builder use the connection below; other sources still need authorization in the host app. Custom tools and AIN-UI agent responses can be added
in the existing AinCode editor afterwards.

After creation, the result shows the node's actual startup status and a status-refresh action. **Continue in
AinCode** creates a normal draft containing the command to pull this agent and review its files; sending that
draft starts the coding agent. A push remains an explicit deployment. If a create response is lost, do not blindly
create a new ID: inspect the existing agent list first. The node rejects duplicate IDs.

### Validation and rollout

- Gateway: `cd ainize/gateway && bun test test/ && bun run typecheck`.
- UI: `cd packages/app && bun test --preload ./happydom.ts ./src/ainize/builder-surface.test.ts && bun run typecheck`.
- Consumer contract: from `ainize/gateway`, run `bun ../test-consumers.ts <ainize-node> <ainteams> <ainmem> <aindrive>`.
  The check imports those installed checkouts' real schema, catalogue adapter, A2A callers and Drive accumulator.
  It uses a fixture transport and verifies separate product conversation contexts; it is not a live integration test.
- Deploy the gateway **and rebuilt AinCode app/binary** before deploying the Teams link. Older gateways do not expose
  `/_builder`, and older app bundles do not have the builder route. Follow the normal image update process above.
- On a staging instance, sign in through Teams Builder, create an organization-visible test agent, refresh/import
  the organization's agent list in Teams, Mem and Drive, and send the same text request from each. Check unauthorized
  users cannot discover the organization entry. File access requires a separately authorized attachment/delegation.

Implementation checks used a local fixture with real builder components and gateway code. Production deployment,
real model output and the three products' live organization configuration remain rollout checks.

### AIN Drive connection during creation

The Sources step now starts the Drive account OAuth flow (`drives:read` only, PKCE S256), restores the current
brief after the redirect, lists drives and browses folders via Drive's existing MCP API. Select up to 20 files
or folders; a selected folder includes future descendants. Locked/offline sources are not selectable in the
browser, and the gateway rechecks live access and file/folder type before creation and binding.

The user must explicitly consent to serving selected contents to agent callers. **Ainize visibility is a listing
rule, not A2A invocation authorization**: even a private listing must not be described as private file access.
This is an owner-authorized knowledge source shared through this agent, not per-caller Drive authorization.

A selection generates a `tools` agent (Docker-enabled Ainize required), keeping the standard runtime's history,
attachment tools and text output. Generated `index.mjs` exposes only `aindrive_list_files`/`aindrive_read_file`.
The gateway installs a separate opaque capability via the hosted-agent write-only secret API. OAuth tokens
never enter the browser, agent files, prompt, model or sandbox. The public bearer-only `/code/_builder/drive/tool`
endpoint enforces the exact selected file or folder-prefix boundaries, rejects noncanonical paths and writes,
and calls Drive with live permissions. Text reads are bounded to 2 MB of response; larger/binary sources may
need the host's attachment/delegation flow instead.

`AINCODE_DRIVE_URL` defaults to `https://aindrive.ainetwork.ai`; `AINCODE_PUBLIC_URL` defaults to `https://ainize.ai`
and must be the externally reachable origin. OAuth redirects to `${AINCODE_PUBLIC_URL}/code/_builder/drive/callback`
(using the configured base path). The agent's egress allowlist must resolve that public host; loopback endpoints
are fixture-only. Configure these values before deployment. The existing Drive DCR, token and MCP endpoints
must be deployed. No Drive backend change is needed.

The single gateway process stores connections and hashed capabilities atomically in `builder-drive.json`
(mode 0600) under its private state directory, using the same storage protection as gateway API keys. Preserve
this state across deploys and protect its backups. Refreshes are serialized per account to avoid rotating-token
reuse. Disconnect deletes the local credentials and all this connection's agent grants; ongoing reads may finish.
It does not remove the connected-app record at Drive. Reconnecting does not resurrect old grants: existing agents
need an explicit binding again (`POST /code/_builder/agents/:id/drive` with their owner-approved brief).

If creation succeeds but secret installation fails, the result identifies the partial success and offers
**Retry agent connection** against that same agent. It does not create a duplicate. Refreshing/reloading the page
loses the current result; existing agent edits and rebinding remain available through the authenticated APIs.
OAuth state is short-lived and not persisted across gateway restarts; restart an interrupted login.

Validation: gateway tests cover state ownership/replay, private persistence, scoped reads, revocation, refresh
serialization, generated tool execution and failed-binding retry. A local browser fixture exercised OAuth round
trip, restored answers, folder selection, consent gating and successful binding. No real Drive accounts or files
were used. Production OAuth, Docker startup, model tool calls and cross-app live reads remain rollout checks.

### Platform-specific MCP builder (Teams, Mem and Drive)

The first step offers concrete workflow examples instead of requiring a blank prompt. The connection step
configures **all three products independently**; A2A host compatibility is separate from these MCP client
connections. Each connected Teams/Mem server negotiates MCP and supplies `tools/list`; only supported,
advertised tools (and, for Teams, granted OAuth scopes) are selectable. Missing connections confer no access.

- **Teams:** `AINCODE_TEAMS_URL` (default `https://ainteams.ainetwork.ai`). OAuth DCR + PKCE with RFC 8707
  resource `/api/mcp`; callback `/code/_builder/mcp/teams/callback`. The consent request asks for channel read,
  draft read/write and message write. The user chooses workspaces at Teams consent, then up to 20 concrete
  channels in Builder. Supported tools: `read_channel`, `create_draft`, `send_message`. No DM, reaction,
  workspace-wide search, arbitrary thread ID, background subscription or automatic trigger is installed.
- **Mem:** `AINCODE_MEM_URL` (default `https://ainmem.ainetwork.ai`). The checked-in MCP server currently has
  no OAuth flow. Enter an existing agent bearer token; Builder verifies `app-fetch {id: "self"}` reports an
  agent identity. Service tokens are refused. The token belongs to the Mem agent, not the current human's
  identity. It is used only against the operator-configured Mem origin and is never saved in the brief,
  browser storage, generated code or model prompt. Choose up to 20 pages/databases from live `memory-search`
  results. Supported tools: `app-fetch`, `memory-search`, `memory-create-pages`, `update-page`. The runtime
  filters search output to selected IDs; its upstream limit is 50, so results can be incomplete. New pages
  require a selected parent ID; page writes may fail if the selected entity is a database or access changed.
- **Drive:** retains the selected file/folder read-only connection described above. Its tools are combined
  with Teams/Mem tools in the same generated agent; it does not gain write/delete access.

Teams/Mem generation validates chosen targets again and installs a separate write-only
`AIN_MCP_BUILDER_GRANT` secret. `/code/_builder/mcp/tool` enforces the stored tool and target allowlist;
model-supplied arguments cannot expand it. MCP sessions are negotiated and closed per request; credentials
remain in private gateway state (`builder-mcp.json`, 0600). Use a single process per state directory. Mem agent
tokens remain valid until revoked at Mem; disconnect forgets the local credential and invalidates existing
combined bindings. Reconnect does not resurrect grants. The generated `index.mjs` combines `drive.mjs` and
`mcp.mjs`; the standard hosted tools runtime keeps history and attachment handling.

All supported Teams/Mem writes create an **owner review request**, not a completed mutation. The model receives
a pending status and the Builder review URL. The authenticated owner opens “Review pending MCP writes”, refreshes,
reads the exact target/content and previous text, then approves or rejects. Only approval executes the MCP tool.
Draft/page replacement compares the source snapshot again before writing; changes cause a conflict instead of
an overwrite. This is a best-effort stale-write check: the upstream MCP APIs have no atomic compare-and-swap,
so a concurrent edit between that check and the write remains possible. State is persisted as `executing` before
network I/O; failures become `unknown`, never an automatic retry. Inspect the destination before issuing another
write. Requests are capped at 50 per owner and expire after 24 hours. No direct-send tool bypasses this queue.

Use the existing “Retry agent connection” action for partial binding failures. It validates the owner's agent
and generated modules before installing secrets, instead of recreating the agent. On reload, the creation result
is not retained; the review queue is durable and can be opened at `/code/builder?approvals=1`.

Validation added: real generated tool-module execution; OAuth ownership/replay; MCP tool discovery; selected
resource enforcement and filtered search; owner-only approval, duplicate-decision rejection, stale source checks,
unknown-outcome handling and revocation. The browser fixture completed all three connection paths and generated
one combined agent. App/gateway typechecks and the standalone Builder bundle pass. **Live provider authentication,
Docker startup, actual model-driven tool calls and the full production app bundle remain rollout checks.**

### OpenCode-session Builder (supersedes the standalone creation wizard)

`/code/builder` now opens a normal OpenCode draft with the guided builder prompt. Submitting it starts the real
coding agent. Its `question` calls with a single `AIN Builder` header render through AIN-UI and reply through
OpenCode's question API; multiple-question requests retain the native question dock. Answers resume the same
coding session, rather than triggering hosted-agent creation in the gateway.

Both new drafts and active sessions have an expandable Teams/Mem/Drive connections panel. It saves validated,
owner-scoped workspace selections; credentials remain in gateway storage. Settings are shared by this owner's
workspace sessions, not independently scoped to each chat. OAuth returns to the originating session and restores
the in-progress selection. The panel includes the existing owner write-review queue.

The coding agent uses `ainize-agents new`, writes its workflow and tests locally, then imports connector modules
with `ainize-agents connections <id>`. This command preserves workflow index.mjs and merges required hosts and
secret names. It refuses to overwrite differing connector modules. Only an explicit deployment request leads
to `push`, followed by `connect <id>`; the latter checks owner, tools mode, declared secrets and exact connector
modules before installing grants. OpenCode owns workflow code; the gateway manages authentication and grants.

The workspace egress adds only GET `/api/builder/connections` and POST `/api/builder/agents/:id/connect`.
It derives identity from the workspace socket and current browser session. It cannot save user consent or
approve writes. Publishing still uses the existing Ainize CLI, not the legacy template-create API.

Deployment requires updated app assets, gateway and sandbox CLI/AGENTS.md. The previous standalone localhost
preview is not a valid end-to-end test for this flow. Verify real OpenCode question replies, local file writes,
CLI module import, tests, explicit push, binding and each platform's actual A2A invocation before declaring E2E
success. A draft being opened does not prove that a model ran or an agent was created.

## Uncommon Gallery / AINSpace Builder

Opening `/code/` now shows the organization Builder. `/code/gallery` provides manual role, skill, situation-rule, image, chat and memory controls; `/code/builder?gallery=1` starts an ordinary scoped AinCode conversation. The existing connector Builder and Code workspace remain available. New Builder agents always publish to `uncommon-gallery`; membership and native owner/write/admin permissions still apply.

Set `AINCODE_GALLERY_MODEL` to the long-context model used by the organization. The gateway routes the workspace's primary model alias to that configured peer, without exposing credentials in the workspace. The native node must support durable per-agent state, Unix gateway transport and the authenticated `POST /api/hosted-agents/:id/builder` management endpoint. Memory enumeration and changes require the agent owner or organization admin.

`ainize-agents gallery help` documents creation, full server-side validation, editing, actual A2A tests, memory operations, logs and removal. For running older workspaces, deploy the two CLI modules into their writable `.ainize-tools` folder; sessions do not need to be stopped. Future workspace images prepare those tools automatically. Do not replace an active workspace just to upgrade this feature.

Configuration edits preserve durable history, learned memory, migration provenance, customized runtime files and existing connector permissions. Long private role descriptions remain complete while the public listing uses its normal 500-character summary. Historical private memories from the old service are not claimed imported unless its provenance flag confirms this.
