# YodaCode container image — used by both services in compose.yaml:
#   broker  → runs workspace/broker/brokerd.js (holds the vault)
#   agent   → runs the supervisor (yoda.js) + in-container cron scheduler
# node + claude are baked in and world-executable, so the unprivileged agent
# can always run them — the binary-reachability problem of a host install is gone.
FROM node:22-bookworm-slim

# Runtime deps: git/ssh for the agent's tools, python3 for the helper scripts,
# gosu to drop privileges cleanly in the entrypoint, tini as PID 1, jq for prompts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client python3 bash curl jq gosu tini \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI, installed globally → /usr/local/bin/claude (world-executable).
# Used for auth setup (`claude setup-token`) and health checks; the runtime
# agent runs through the Claude Agent SDK, which bundles its own pinned engine
# (see workspace/package.json).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

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

# Install workspace deps first (better layer caching).
COPY workspace/package.json workspace/package-lock.json* ./workspace/
RUN cd workspace && (npm ci --omit=dev 2>/dev/null || npm install --omit=dev)

# Copy the rest of the project.
COPY . .

# Entry scripts + a sane default for where the broker socket lives.
RUN chmod +x docker/entrypoint.sh workspace/bin/broker workspace/broker/brokerd.js \
    && ln -sf /app/workspace/bin/broker /usr/local/bin/broker
ENV YODA_BROKER_SOCK=/run/yodacode-broker/broker.sock \
    YODA_WORKSPACE=/app/workspace \
    NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
