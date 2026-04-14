#!/usr/bin/env node
// YodaCode Setup Wizard — interactive TUI installer.
//
// Usage:
//   npx yodacode install
//   node scripts/install.js
//   node scripts/install.js --reconfigure slack
//   node scripts/install.js --add whatsapp
//   node scripts/install.js --fresh

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import { printBanner } from './setup/banner.js';
import { readEnv, mergeEnv } from './setup/env.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENV_PATH = path.join(ROOT, '.env');
const WORKSPACE = path.join(ROOT, 'workspace');
const TEMPLATES = path.join(ROOT, 'templates');

const args = process.argv.slice(2);
const isFresh = args.includes('--fresh');
const reconfigure = args.find((a, i) => args[i - 1] === '--reconfigure') || null;
const addSurface = args.find((a, i) => args[i - 1] === '--add') || null;

// ─── Helpers ───────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question, defaultVal = '') {
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` (${defaultVal})` : '';
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}
function askSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(`  ${question}: `);
    const old = process.stdin.isRaw;
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    let buf = '';
    const onData = (ch) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        if (process.stdin.setRawMode) process.stdin.setRawMode(old);
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (c === '\u007F' || c === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += c;
        process.stdout.write('•');
      }
    };
    process.stdin.on('data', onData);
  });
}
function heading(text) {
  console.log(`\n\x1b[1m▸ ${text}\x1b[0m\n`);
}
function ok(text) { console.log(`  \x1b[32m✓\x1b[0m ${text}`); }
function warn(text) { console.log(`  \x1b[33m⚠\x1b[0m ${text}`); }
function fail(text) { console.log(`  \x1b[31m✗\x1b[0m ${text}`); }

function renderTemplate(templatePath, vars) {
  let content = fs.readFileSync(templatePath, 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    content = content.replaceAll(`{{${k}}}`, v);
  }
  return content;
}

function checkCommand(cmd) {
  try { execSync(`which ${cmd}`, { stdio: 'pipe' }); return true; } catch { return false; }
}

// ─── Steps ─────────────────────────────────────────────────────────────────

async function preflight() {
  heading('Pre-flight checks');
  const checks = [
    ['node', 'Node.js'],
    ['npm', 'npm'],
    ['python3', 'Python 3'],
    ['claude', 'Claude Code'],
  ];
  let allGood = true;
  for (const [cmd, name] of checks) {
    if (checkCommand(cmd)) {
      const ver = execSync(`${cmd} --version 2>&1`, { encoding: 'utf8' }).trim().split('\n')[0];
      ok(`${name} ${ver}`);
    } else {
      fail(`${name} not found`);
      allGood = false;
    }
  }
  // systemd
  if (checkCommand('systemctl')) {
    ok('systemd available');
  } else {
    warn('systemd not available (manual startup required)');
  }
  // Sandbox dependencies (bubblewrap + socat for Linux)
  const isLinux = process.platform === 'linux';
  if (isLinux) {
    if (checkCommand('bwrap') && checkCommand('socat')) {
      ok('Sandbox deps (bubblewrap + socat) installed');
    } else {
      console.log('  Installing sandbox dependencies (bubblewrap + socat)...');
      try {
        execSync('apt-get install -y bubblewrap socat', { stdio: 'pipe', timeout: 30000 });
        ok('Sandbox deps installed');
      } catch {
        warn('Could not install bubblewrap/socat. Sandbox will be unavailable.');
      }
    }
  }

  // Sandbox runtime (@anthropic-ai/sandbox-runtime)
  try {
    execSync('node -e "require(\'@anthropic-ai/sandbox-runtime\')"', { stdio: 'pipe' });
    ok('Sandbox runtime installed');
  } catch {
    console.log('  Installing sandbox runtime...');
    try {
      execSync('npm install -g @anthropic-ai/sandbox-runtime', { stdio: 'pipe', timeout: 30000 });
      ok('Sandbox runtime installed');
    } catch {
      warn('Could not install sandbox runtime. Sandbox may not function.');
    }
  }

  // Fix seccomp binary permissions (npm installs it without +x)
  const seccompPaths = [
    '/usr/lib/node_modules/@anthropic-ai/claude-code/vendor/seccomp/x64/apply-seccomp',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/vendor/seccomp/x64/apply-seccomp',
  ];
  for (const p of seccompPaths) {
    if (fs.existsSync(p)) {
      try { fs.chmodSync(p, 0o755); ok('Seccomp binary permissions fixed'); } catch {}
    }
  }

  // Playwright
  try {
    execSync('node -e "require(\'playwright\')"', { stdio: 'pipe', cwd: WORKSPACE });
    ok('Playwright installed');
  } catch {
    warn('Playwright not installed (optional - for browser automation)');
    const install = await ask('Install Playwright now? (~120MB) [y/N]', 'n');
    if (install.toLowerCase() === 'y') {
      console.log('  Installing Playwright...');
      execSync('npm install playwright && npx playwright install chromium', { cwd: WORKSPACE, stdio: 'inherit' });
      ok('Playwright installed');
    }
  }
  if (!allGood) {
    fail('Missing required tools. Install them and re-run.');
    process.exit(1);
  }
}

async function setupAuth() {
  heading('Claude Code authentication');
  const existing = readEnv(ENV_PATH);
  if (existing.CLAUDE_CODE_OAUTH_TOKEN && !isFresh && reconfigure !== 'auth') {
    ok('OAuth token already configured');
    // Verify it works
    try {
      const out = execSync(`claude -p "say OK" --output-format json`, {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: existing.CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY: '' },
        cwd: WORKSPACE,
      });
      const r = JSON.parse(out);
      if (r.result === 'OK') { ok('Token verified'); return; }
    } catch { warn('Token verification failed - re-enter'); }
  }

  console.log('  YodaCode runs on your Claude Max subscription (no API key needed).');
  console.log('  You need a long-lived OAuth token from Claude Code.\n');
  console.log('  1. Install Claude Code if needed: npm install -g @anthropic-ai/claude-code');
  console.log('  2. On a machine with a browser, run: claude setup-token');
  console.log('  3. Sign in and paste the token below (starts with sk-ant-oat01-).\n');

  const token = await askSecret('Paste token (sk-ant-oat01-...)');
  if (!token.startsWith('sk-ant-oat01-')) {
    fail('Token should start with sk-ant-oat01-');
    process.exit(1);
  }
  console.log('  Verifying...');
  try {
    const out = execSync(`claude -p "say OK" --output-format json`, {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: '' },
      cwd: WORKSPACE,
    });
    const r = JSON.parse(out);
    if (r.result !== 'OK') throw new Error(r.result);
    const model = Object.keys(r.modelUsage || {})[0] || 'unknown';
    ok(`Token works (model: ${model})`);
  } catch (e) {
    fail(`Token verification failed: ${e.message}`);
    process.exit(1);
  }
  mergeEnv(ENV_PATH, { CLAUDE_CODE_OAUTH_TOKEN: token });
}

async function setupSlack() {
  heading('Slack setup');
  const existing = readEnv(ENV_PATH);
  if (existing.SLACK_BOT_TOKEN && !isFresh && reconfigure !== 'slack') {
    ok('Slack already configured');
    return;
  }

  console.log('  Create a Slack app with the right scopes pre-configured:');
  console.log('  1. Go to https://api.slack.com/apps?new_app=1');
  console.log('  2. Choose "From a manifest" and paste the contents of');
  console.log(`     ${path.join(ROOT, 'scripts', 'slack-app-manifest.yaml')}`);
  console.log('  3. Create → Install to Workspace → copy the tokens below.\n');

  const botToken = await askSecret('Bot User OAuth Token (xoxb-...)');
  const appToken = await askSecret('App-Level Token (xapp-...)');

  // Verify
  console.log('  Verifying...');
  try {
    const out = execSync(`curl -sS -H "Authorization: Bearer ${botToken}" https://slack.com/api/auth.test`, { encoding: 'utf8', timeout: 10000 });
    const r = JSON.parse(out);
    if (!r.ok) throw new Error(r.error);
    ok(`Connected as @${r.user} (${r.team})`);
  } catch (e) {
    fail(`Slack verification failed: ${e.message}`);
    process.exit(1);
  }

  const userId = await ask('Your Slack user ID (profile → ⋯ → "Copy member ID")');

  mergeEnv(ENV_PATH, {
    SLACK_BOT_TOKEN: botToken,
    SLACK_APP_TOKEN: appToken,
    YODA_SURFACES: 'slack',
    YODA_DM_AUTHORIZED_USERS: userId,
    YODA_STOP_AUTHORIZED_USERS: userId,
  });
}

async function setupPersona() {
  heading('Persona');
  const userName = await ask('What should the bot call you?', 'User');
  const botName = await ask('Bot display name?', 'Yoda');
  const timezone = await ask('Your timezone?', 'UTC');

  const vars = {
    BOT_NAME: botName,
    USER_NAME: userName,
    TIMEZONE: timezone,
    INSTALL_DIR: ROOT,
    DATE: new Date().toISOString().split('T')[0],
  };

  // Generate persona files from templates
  for (const [tpl, out] of [
    ['CLAUDE.md.template', 'CLAUDE.md'],
    ['IDENTITY.md.template', 'IDENTITY.md'],
    ['USER.md.template', 'USER.md'],
    ['MEMORY.md.template', 'MEMORY.md'],
  ]) {
    const tplPath = path.join(TEMPLATES, tpl);
    const outPath = path.join(WORKSPACE, out);
    if (fs.existsSync(outPath) && !isFresh) {
      ok(`${out} already exists (skipped)`);
      continue;
    }
    fs.writeFileSync(outPath, renderTemplate(tplPath, vars));
    ok(`Generated ${out}`);
  }

  // Copy static files if missing
  for (const f of ['SOUL.md', 'TOOLS.md', 'AGENTS.md']) {
    const dst = path.join(WORKSPACE, f);
    if (!fs.existsSync(dst)) {
      // Already in workspace from the repo
      ok(`${f} ready`);
    }
  }
}

async function setupDashboard() {
  heading('Web dashboard');
  const enable = await ask('Enable web dashboard? [Y/n]', 'Y');
  if (enable.toLowerCase() === 'n') return;

  const port = await ask('Dashboard port?', '7890');
  const pass = await ask('Dashboard password (blank = no auth)?', '');

  mergeEnv(ENV_PATH, {
    YODA_UI_PORT: port,
    YODA_UI_USER: 'yoda',
    YODA_UI_PASS: pass,
  });
  ok(`Dashboard will run on port ${port}`);
}

async function setupSystemd() {
  heading('systemd service');
  if (!checkCommand('systemctl')) {
    warn('systemd not available. Start manually: node workspace/yoda.js');
    return;
  }

  const servicePath = '/etc/systemd/system/yodacode.service';
  const template = fs.readFileSync(path.join(ROOT, 'systemd', 'yodacode.service.template'), 'utf8');
  const service = template.replaceAll('{{INSTALL_DIR}}', ROOT);
  fs.writeFileSync(servicePath, service);
  execSync('systemctl daemon-reload');
  execSync('systemctl enable --now yodacode.service');
  ok('yodacode.service enabled and started');

  // Wait and verify
  await new Promise((r) => setTimeout(r, 4000));
  try {
    const status = execSync('systemctl is-active yodacode', { encoding: 'utf8' }).trim();
    if (status === 'active') {
      ok('Service is running');
    } else {
      warn(`Service status: ${status}`);
    }
  } catch {
    warn('Could not verify service status');
  }
}

async function installDeps() {
  heading('Installing dependencies');
  execSync('npm install', { cwd: WORKSPACE, stdio: 'inherit' });
  ok('npm dependencies installed');
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  await preflight();
  await installDeps();
  await setupAuth();
  await setupSlack();
  await setupPersona();
  await setupDashboard();
  await setupSystemd();

  heading('Done!');
  console.log('  Try it now:');
  console.log('    Slack: DM your bot in your workspace');
  console.log('');
  console.log('  Manage:');
  console.log('    systemctl status yodacode');
  console.log('    journalctl -u yodacode -f');
  console.log('');
  console.log('  Edit your bot\'s persona:');
  console.log(`    ${WORKSPACE}/CLAUDE.md`);
  console.log('');

  rl.close();
}

main().catch((e) => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
