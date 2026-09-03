# YodaCode container image — used by both services in compose.yaml:
#   broker  → runs workspace/broker/brokerd.js (holds the vault)
#   agent   → runs the supervisor (yoda.js) + in-container cron scheduler
# node + claude are baked in and world-executable, so the unprivileged agent
# can always run them — the binary-reachability problem of a host install is gone.
FROM node:22-bookworm-slim

# Runtime deps: git/ssh for the agent's tools, python3 for the helper scripts,
# gosu to drop privileges cleanly in the entrypoint, tini as PID 1, jq for prompts.
# util-linux supplies flock(1), which serialises credential refresh for the
# Codex engine — its refresh tokens are single-use, so two turns refreshing at
# the same moment invalidate each other.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client python3 bash curl jq gosu tini util-linux \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI, installed globally → /usr/local/bin/claude (world-executable).
# Used for auth setup (`claude setup-token`) and health checks; the runtime
# agent runs through the Claude Agent SDK, which bundles its own pinned engine
# (see workspace/package.json).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# OpenAI Codex CLI → /usr/local/bin/codex. Both engines are baked in so that
# switching engines is a config change and a restart, not a rebuild — the
# operator switching is usually one whose current engine has just stopped
# working, and a multi-minute rebuild is the wrong thing to hand them.
# Installed globally rather than as a workspace dependency: the node_modules
# volume shadows the image's copy, so a workspace dep would never reach an
# existing install.
# NOT pinned to an old version deliberately — an out-of-date CLI fails to parse
# the live model catalogue (it rejects reasoning levels added since its release)
# and floods stderr with the whole catalogue on every successful turn.
RUN npm install -g @openai/codex && npm cache clean --force

# Playwright: the MODULE and Chromium's SYSTEM LIBRARIES (~325MB layer) are baked
# in — both need root. The browser itself (~300MB download / ~650MB on disk) is
# not: it installs on demand into the agent-home volume with
# `yodacode install-browsers`, so it survives container recreation and rebuilds.
# PINNED: each playwright version expects a specific chromium revision in the
# volume — a floating version would orphan installed browsers on every rebuild.
RUN npm install -g playwright@1.61.1 && npm cache clean --force \
    && npx playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/home/yoda/.cache/ms-playwright

# Unprivileged runtime user/group (uid/gid remappable at runtime via PUID/PGID).
# 1001 avoids the base image's existing node user at 1000.
RUN groupadd --gid 1001 yodacode \
    && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash yoda

WORKDIR /app

# Install workspace deps first (better layer caching). At runtime node_modules is
# a named volume, which Docker fills from the image only when the volume is NEW —
# so a pristine copy is staged outside the mount path (hard links, same layer:
# no extra size) with a stamp of the package.json it came from. The entrypoint
# copies it over an existing volume whose stamp differs (docker/refresh-deps.sh).
# The stamp also ships inside node_modules so a fresh volume starts in sync.
COPY workspace/package.json workspace/package-lock.json* ./workspace/
RUN cd workspace && (npm ci --omit=dev 2>/dev/null || npm install --omit=dev) \
    && mkdir -p /opt/yodacode && cp -al node_modules /opt/yodacode/node_modules \
    && sha256sum package.json | cut -c1-64 | tee /opt/yodacode/deps.stamp > node_modules/.yodacode-deps.stamp

# Copy the rest of the project.
COPY . .

# Entry scripts + a sane default for where the broker socket lives.
RUN chmod +x docker/entrypoint.sh docker/refresh-deps.sh workspace/bin/broker workspace/broker/brokerd.js \
    && ln -sf /app/workspace/bin/broker /usr/local/bin/broker
ENV YODA_BROKER_SOCK=/run/yodacode-broker/broker.sock \
    YODA_WORKSPACE=/app/workspace \
    NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
