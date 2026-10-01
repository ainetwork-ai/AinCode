# aincode-sandbox — one person's AinCode workspace on ainize.ai/code.
#
# Built by ./build.sh, which stages the AinCode linux-x64 binary and this folder into a small context (the
# repository root is too large, and its .dockerignore drops every dist/).
#
# The container is started by the gateway (ainize/gateway) with `--network none`. It has no network at all; the
# only ways in and out are two unix sockets in /run/aincode, which the gateway owns (see entrypoint.mjs).
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep less procps \
 && rm -rf /var/lib/apt/lists/*

# node:24 already has uid/gid 1000 as `node`; rename it so paths and prompts read as the product.
RUN usermod -l aincode -d /home/aincode -m node && groupmod -n aincode node

COPY aincode /usr/local/bin/aincode
COPY opencode.json /opt/aincode/opencode.json
COPY AGENTS.md /opt/aincode/AGENTS.md
COPY entrypoint.mjs /opt/aincode/entrypoint.mjs
COPY gallery-cli.mjs /opt/aincode/gallery-cli.mjs
COPY ainize-agents.mjs /opt/aincode/ainize-agents.mjs
RUN ln -s /opt/aincode/ainize-agents.mjs /usr/local/bin/ainize-agents && chmod 755 /opt/aincode/*.mjs

ENV OPENCODE_CONFIG=/opt/aincode/opencode.json \
    OPENCODE_BASE_PATH=/code \
    OPENCODE_SERVER_USERNAME=aincode \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_LSP_DOWNLOAD=1 \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
    OPENCODE_DISABLE_CLAUDE_CODE=1 \
    OPENCODE_DISABLE_TERMINAL_TITLE=1 \
    AINIZE_API=http://127.0.0.1:4097/api \
    AINIZE_AGENTS_DIR=/home/aincode/agents \
    HOME=/home/aincode

USER aincode
WORKDIR /home/aincode/agents
ENTRYPOINT ["node", "/opt/aincode/entrypoint.mjs"]
