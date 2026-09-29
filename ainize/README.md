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

- **Organizations.** Today's node lets only an agent's creator change it. Hosted agents also need a wallet session,
  so AIN SSO and Google users can read their workspace but cannot yet create hosted agents. The CLI already asks for
  `?manageable=1` and sends `org`/`visibility`; organization editing arrives when the node supports it.
- **Signing in from the landing page.** The sign-in page's wallet and Google routes return with an in-app
  navigation, which can land on the site's own 404 for `/code/` until the page is reloaded. "Sign in with AIN" is a
  full redirect and returns to `/code/` directly.
