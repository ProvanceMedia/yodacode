#!/usr/bin/env node
// Yoda — personal Claude-Code-powered chat agent.
//
// This is the multi-surface coordinator. Loads each enabled surface adapter
// (Slack, WhatsApp, …) from lib/surfaces/<name>.js and wires their incoming
// messages into a single shared dispatcher pipeline.
//
// Architecture:
//   yoda.js (this file)            ──► thin coordinator
//     │
//     ├─ lib/surfaces/slack.js     ──► Socket Mode listener (Slack)
//     ├─ lib/surfaces/whatsapp.js  ──► Baileys listener (WhatsApp)
//     │     ⋮                       (add more surfaces here)
//     │
//     ▼
//   lib/dispatcher.js              ──► generic message → reply pipeline
//     │
//     ├─ lib/stop-handler           (event-driven kill)
//     ├─ lib/queue                  (per-conversation serial lanes)
//     ├─ lib/claude-runner          (spawn claude -p, manage tick state)
//     ├─ lib/stream-translator      (live status updates)
//     └─ lib/reply-policy           (generic policy + surface hooks)
//
// To add a new surface (Telegram, Discord, iMessage, ...):
//   1. Create lib/surfaces/<name>.js implementing the surface contract.
//   2. Add 'name' to the YODA_SURFACES env var.
//   3. Done.

import { logger } from './lib/logger.js';
import { config } from './lib/config.js';
import { handleMessage } from './lib/dispatcher.js';
import { registerSurface } from './lib/surface.js';
import { killAllTicks } from './lib/claude-runner.js';
import { startUI, stopUI } from './ui/server.js';

const startedSurfaces = [];

async function loadSurface(name) {
  const modPath = `./lib/surfaces/${name}.js`;
  let mod;
  try {
    mod = await import(modPath);
  } catch (e) {
    logger.error('failed to load surface', { name, path: modPath, err: e.message });
    return null;
  }
  const surface = mod.default;
  if (!surface || !surface.name) {
    logger.error('surface module has no default export with a name', { name });
    return null;
  }
  return surface;
}

async function startSurface(name) {
  const surface = await loadSurface(name);
  if (!surface) return;
  registerSurface(surface);

  try {
    await surface.start(async (event) => {
      try {
        await handleMessage(event, surface);
      } catch (e) {
        logger.error('handleMessage error', { surface: name, err: e.message });
      }
    });
    startedSurfaces.push(surface);
    logger.info('surface started', { name });
  } catch (e) {
    logger.error('surface failed to start', { name, err: e.message, stack: e.stack });
  }
}

async function main() {
  logger.info('yoda starting', {
    workspace: config.workspace,
    surfaces: config.surfaces,
  });

  // Write .claude/settings.json based on YODA_SANDBOX so that the sandbox
  // configuration always reflects the current env var without manual edits.
  // yoda.js runs outside the sandbox so it can write this file freely.
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const nodePath = await import('node:path');
    const settingsDir = `${config.workspace}/.claude`;
    mkdirSync(settingsDir, { recursive: true });
    const sandboxEnabled = config.sandbox.mode !== 'off';
    const installDir = nodePath.resolve(config.workspace, '..');
    const settings = sandboxEnabled
      ? {
          sandbox: {
            enabled: true,
            mode: 'auto-allow',
            allowUnsandboxedCommands: false,
            failIfUnavailable: true,
            filesystem: {
              allowWrite: [
                '.',
                '/tmp',
                `${installDir}/workspace`,
                `${installDir}/logs`,
                `${installDir}/cron-tasks`,
                `${installDir}/pollers`,
              ],
              denyWrite: [
                `${installDir}/.env`,
                `${installDir}/workspace/.claude/settings.json`,
                `${installDir}/workspace/.claude/settings.local.json`,
              ],
            },
            // Network: merge manually-specified domains with auto-discovered
            // ones from refresh-capabilities.py's SERVICE_MAP base URLs.
            // This means adding a service to the map auto-whitelists its domain.
            ...(() => {
              const domains = new Set(config.sandbox.allowedDomains);
              // Always allow Slack (needed for slack-tools.sh in crons)
              domains.add('slack.com');
              // Auto-discover from CAPABILITIES.md base URLs
              try {
                const caps = readFileSync(`${config.workspace}/CAPABILITIES.md`, 'utf8');
                const urlRegex = /https?:\/\/([a-zA-Z0-9._-]+)/g;
                let match;
                while ((match = urlRegex.exec(caps)) !== null) {
                  if (match[1] && !match[1].includes('$')) domains.add(match[1]);
                }
              } catch (_) {}
              const domainList = [...domains].filter(Boolean).sort();
              return domainList.length > 0 ? { network: { allowedDomains: domainList } } : {};
            })(),
          },
        }
      : { sandbox: { enabled: false } };
    writeFileSync(`${settingsDir}/settings.json`, JSON.stringify(settings, null, 2) + '\n');
    logger.info('wrote .claude/settings.json', { sandboxEnabled });
  } catch (e) {
    logger.warn('failed to write .claude/settings.json (non-fatal)', { err: e.message });
  }

  // Regenerate CAPABILITIES.md from the current .env so the persona stays in
  // sync with what is actually available. Cheap, idempotent, no claude calls.
  try {
    const { execSync } = await import('node:child_process');
    execSync('python3 ./bin/refresh-capabilities.py', { cwd: config.workspace, stdio: 'pipe' });
    logger.info('refreshed capabilities.md');
  } catch (e) {
    logger.warn('refresh-capabilities failed (non-fatal)', { err: e.message });
  }

  if (!config.surfaces.length) {
    logger.error('no surfaces configured (set YODA_SURFACES env var)');
    process.exit(2);
  }

  // Start surfaces in parallel — they're independent
  await Promise.all(config.surfaces.map(startSurface));

  if (!startedSurfaces.length) {
    logger.error('no surfaces started successfully — exiting');
    process.exit(1);
  }

  logger.info('yoda ready', {
    surfaces: startedSurfaces.map((s) => s.name),
  });

  // Start the web dashboard (optional — only if YODA_UI_PORT is set or defaults)
  try {
    startUI();
  } catch (e) {
    logger.warn('ui: failed to start (non-fatal)', { err: e.message });
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown signal received', { sig });
    // Kill any in-flight claude children — they're spawned with detached:true
    // so they don't die with us automatically. Without this they leak across
    // restarts.
    const killed = killAllTicks();
    if (killed) logger.info('killed in-flight ticks on shutdown', { count: killed });
    stopUI();
    await Promise.allSettled(startedSurfaces.map((s) => s.stop()));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('fatal', { err: err.message, stack: err.stack });
  process.exit(1);
});
