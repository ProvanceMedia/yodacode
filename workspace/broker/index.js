// Broker core — loads the vault + host/service registries and dispatches a single
// mediated call to either the generic http_call tool or a named service, with a hard
// timeout so a call can never hang. Secrets are injected inside these handlers,
// host-side, and never returned to or seen by the agent.
import { unsealVault, vaultSize, reloadVault } from './vault.js';
import { loadAuthHosts, authHostsCount, authHostsList } from './auth-hosts.js';
import { loadServices, serviceManifest, executeService, hasService } from './services.js';
import { httpCall, httpCallDef } from './http-call.js';
import { slackPost, slackPostDef } from './slack-post.js';
import { slackApi, slackApiDef } from './slack-api.js';
import { sshExec, sshExecDef } from './exec-tools.js';

export { unsealVault, vaultSize, reloadVault } from './vault.js';

// Internal (non-service) tools the broker exposes directly.
const internalTools = new Map([
  [httpCallDef.name, { def: httpCallDef, handler: httpCall }],
  [slackPostDef.name, { def: slackPostDef, handler: slackPost }],
  [slackApiDef.name, { def: slackApiDef, handler: slackApi }],
  [sshExecDef.name, { def: sshExecDef, handler: sshExec }],
]);

/** Load vault + config. Call once at daemon startup (and reloadAll() to refresh). */
export function initBroker() {
  unsealVault();
  loadAuthHosts();
  loadServices();
}

export function reloadAll() {
  reloadVault();
  loadAuthHosts();
  loadServices();
}

/** Combined manifest the agent is shown: internal tools + configured services. */
export function allMediatedManifest() {
  return [...[...internalTools.values()].map((v) => v.def), ...serviceManifest()];
}

export function brokerStatus() {
  return { vaultSize: vaultSize(), authHosts: authHostsCount(), services: serviceManifest().length };
}

export { authHostsList };

// Per-tool hard ceilings — remote ssh commands legitimately run long; plain HTTP
// tools stay on a tight leash.
const TOOL_TIMEOUTS = { ssh_exec: 310_000 };

export async function handleMediatedCall(tool, args, hardTimeoutMs) {
  const internal = internalTools.get(tool);
  let work;
  if (internal) work = internal.handler(args ?? {});
  else if (hasService(tool)) work = executeService(tool, args ?? {});
  else work = Promise.resolve({ ok: false, error: `unknown tool: ${tool}` });

  const limit = hardTimeoutMs ?? TOOL_TIMEOUTS[tool] ?? 18_000;
  return Promise.race([
    work,
    new Promise((res) => setTimeout(() => res({ ok: false, error: 'broker timeout' }), limit)),
  ]);
}
