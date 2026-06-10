// Host-side exec tools for credentials that aren't plain HTTP.
//
//   ssh_exec — runs a command on a host defined in workspace/.ssh/config using a key
//              that stays root-readable only. The de-rooted agent could not read the
//              key directly; it asks the broker to run the command for it.
//
// This is the place to add other "run a host-side CLI that needs a secret" tools
// (a cloud CLI, a vendor CLI with a keyring, etc.) following the same shape: validate
// argv, execFile (no shell), return {stdout, stderr, exitCode}, never expose the secret.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');

function run(cmd, argv, timeoutMs, cwd) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      argv,
      { cwd: cwd ?? WORKSPACE, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        const timedOut = Boolean(err && err.killed);
        resolve({
          ok: exitCode === 0,
          data: { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode, ...(timedOut ? { timedOut: true } : {}) },
          ...(exitCode !== 0 ? { error: timedOut ? 'timed out' : `exit ${exitCode}: ${String(stderr ?? '').slice(0, 200)}` } : {}),
        });
      },
    );
  });
}

export async function sshExec(args) {
  const command = String(args.command ?? '').trim();
  if (!command) return { ok: false, error: 'command required' };
  const host = String(args.host ?? '').trim();
  // Only hosts defined in workspace/.ssh/config are reachable; fail-closed on a bad alias.
  if (!host || !/^[a-zA-Z0-9_.-]+$/.test(host)) return { ok: false, error: 'a valid ssh config host alias is required' };
  const cfg = path.join(WORKSPACE, '.ssh', 'config');
  return run('ssh', ['-F', cfg, '-o', 'BatchMode=yes', host, command], Number(args.timeoutMs) > 0 ? Math.min(Number(args.timeoutMs), 300_000) : 60_000);
}

export const sshExecDef = {
  name: 'ssh_exec',
  description:
    'Run a shell command on a host defined in workspace/.ssh/config — the broker holds the SSH key host-side. Params: command (required), host (alias from your ssh config, required), timeoutMs (default 60000, max 300000). Returns {stdout, stderr, exitCode}.',
  params: {
    command: { type: 'string', description: 'shell command to run remotely' },
    host: { type: 'string', description: 'ssh config host alias' },
    timeoutMs: { type: 'string', description: 'timeout in ms (default 60000)', optional: true },
  },
};
