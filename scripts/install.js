#!/usr/bin/env node
// YodaCode Setup Wizard — interactive TUI installer.
//
// Usage:
//   ./install.sh                       ← recommended (handles Node prereq)
//   node scripts/install.js            ← if you already have Node 20+
//   node scripts/install.js --reconfigure slack
//   node scripts/install.js --add whatsapp
//   node scripts/install.js --fresh

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import { printBanner } from './setup/banner.js';
import { readEnv, mergeEnv } from './setup/env.js';

// Node version check. Must be ≥ 20 for the workspace runtime.
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 20) {
  process.stderr.write(
    `\n❌ YodaCode requires Node 20 or newer. You have ${process.version}.\n\n` +
    `Install Node 20 (pick one):\n\n` +
    `  # NodeSource (Debian/Ubuntu, root or with sudo):\n` +
    `  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -\n` +
    `  sudo apt-get install -y nodejs\n\n` +
    `  # nvm (any Linux/macOS):\n` +
    `  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash\n` +
    `  source ~/.bashrc && nvm install 20\n\n` +
    `Then re-run:  ./install.sh\n\n`
  );
  process.exit(1);
}

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
  // Hard prereqs (we don't install these — user must already have them)
  const hardChecks = [
    ['node', 'Node.js'],
    ['npm', 'npm'],
    ['python3', 'Python 3'],
  ];
  const missingHard = [];
  for (const [cmd, name] of hardChecks) {
    if (checkCommand(cmd)) {
      const ver = execSync(`${cmd} --version 2>&1`, { encoding: 'utf8' }).trim().split('\n')[0];
      ok(`${name} ${ver}`);
    } else {
      fail(`${name} not found`);
      missingHard.push(name);
    }
  }
  let allGood = missingHard.length === 0;

  // Claude Code — auto-offer install (it's just an npm package)
  if (checkCommand('claude')) {
    const ver = execSync('claude --version 2>&1', { encoding: 'utf8' }).trim().split('\n')[0];
    ok(`Claude Code ${ver}`);
  } else {
    fail('Claude Code not found');
    const ans = (await ask('Install Claude Code now via npm? [Y/n]', 'y')).toLowerCase();
    if (ans !== 'n') {
      console.log('  Installing Claude Code (this can take ~30s)...');
      try {
        execSync('npm install -g @anthropic-ai/claude-code', { stdio: 'inherit' });
        if (checkCommand('claude')) {
          const ver = execSync('claude --version 2>&1', { encoding: 'utf8' }).trim().split('\n')[0];
          ok(`Claude Code ${ver}`);
        } else {
          warn('Install ran but `claude` is still not on PATH. Check $PATH and node global bin.');
          allGood = false;
        }
      } catch (e) {
        warn(`Auto-install failed: ${e.message}`);
        console.log('  Try manually:  sudo npm install -g @anthropic-ai/claude-code');
        allGood = false;
      }
    } else {
      console.log('  Skipped. Install manually:  npm install -g @anthropic-ai/claude-code');
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
    fail('Pre-flight failed. Fix the items above and re-run:  ./install.sh');
    if (missingHard.includes('Node.js')) console.log('    → Install Node 20+ via NodeSource or nvm');
    if (missingHard.includes('npm')) console.log('    → npm ships with Node — your Node install may be broken');
    if (missingHard.includes('Python 3')) console.log('    → sudo apt-get install -y python3');
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

  // Pull the bot name from .env (set by setupPersona which runs before us).
  // Falls back to "Yoda" if persona wasn't run yet.
  const botName = (readEnv(ENV_PATH).BOT_NAME || 'Yoda').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 30) || 'Yoda';

  // Render the JSON manifest (Slack's default tab) with the bot name baked in.
  // JSON because the "From a manifest" modal opens with an editable JSON box
  // by default — the user can clear it and paste this in one shot.
  const manifestPath = path.join(ROOT, 'scripts', 'slack-app-manifest.json');
  const manifest = fs.readFileSync(manifestPath, 'utf8')
    .replace(/"YodaCode"/g, JSON.stringify(botName))
    .replace(/"Personal Claude-Code-powered chat agent"/g, JSON.stringify(`${botName} — personal Claude-Code-powered agent`));

  const divider = '  ' + '─'.repeat(70);
  console.log('  Set up your Slack app:\n');
  console.log('  1) Open \x1b[36mhttps://api.slack.com/apps?new_app=1\x1b[0m');
  console.log('  2) Choose \x1b[1m"From a manifest"\x1b[0m → pick your workspace → keep the default');
  console.log('     \x1b[1mJSON\x1b[0m tab → Ctrl-A → Delete → paste this:\n');
  console.log(divider);
  for (const line of manifest.split('\n')) console.log('  ' + line);
  console.log(divider);
  console.log('');
  console.log('  3) Next → Create → \x1b[1m"Install to Workspace"\x1b[0m → authorise.');
  console.log('  4) Copy the \x1b[1mBot User OAuth Token\x1b[0m (xoxb-…) from "OAuth & Permissions".');
  console.log('  5) Left sidebar → \x1b[1mBasic Information\x1b[0m → "App-Level Tokens" →');
  console.log('     "Generate Token and Scopes" → add \x1b[1mconnections:write\x1b[0m → Generate.');
  console.log('     Copy that \x1b[1mApp-Level Token\x1b[0m (xapp-…).\n');

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

  // Persist persona choices to .env so later steps (Slack manifest,
  // dashboard, etc.) and the running bot can read them.
  mergeEnv(ENV_PATH, {
    BOT_NAME: botName,
    USER_NAME: userName,
    TIMEZONE: timezone,
  });

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
  // systemd's StandardOutput=append: doesn't auto-create the parent dir, so
  // ensure it exists. Same for state/ which the agent writes to on startup.
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE, 'state'), { recursive: true });
  execSync('systemctl daemon-reload');
  execSync('systemctl enable --now yodacode.service');
  ok('yodacode.service enabled and started');

  // Wait and verify. is-active exits non-zero for inactive/failed, so we need
  // to handle that without swallowing the diagnostic.
  await new Promise((r) => setTimeout(r, 4000));
  let status = 'unknown';
  try {
    status = execSync('systemctl is-active yodacode.service', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    // is-active returns non-zero for non-active states but still prints the
    // state on stdout. Grab it.
    status = (e.stdout || '').toString().trim() || 'failed';
  }
  if (status === 'active') {
    ok('Service is running');
  } else {
    fail(`Service is ${status} — bot will not respond until this is fixed.`);
    console.log('  Last 25 log lines:\n');
    try {
      const log = execSync('journalctl -u yodacode.service -n 25 --no-pager', { encoding: 'utf8' });
      for (const line of log.split('\n')) console.log('    ' + line);
    } catch (_) {
      console.log('    (couldn\'t read journalctl — run it manually)');
    }
    console.log('\n  Common causes:');
    console.log('    • `claude` command not on systemd\'s PATH → service env is minimal');
    console.log('    • Slack tokens wrong or app not installed to workspace');
    console.log('    • CLAUDE_CODE_OAUTH_TOKEN missing or expired');
    console.log('    • Bot user IDs (YODA_DM_AUTHORIZED_USERS) wrong\n');
    console.log('  Useful commands:');
    console.log('    systemctl status yodacode.service');
    console.log('    journalctl -u yodacode.service -f');
    console.log('    sudo -u root env | grep -E "PATH|CLAUDE"\n');
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
  // Persona first so the bot name + user name are baked into the Slack
  // manifest and any later steps that reference them.
  await setupPersona();
  await setupSlack();
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
