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

// ─── CLI arg parsing ───────────────────────────────────────────────────────
//
// Supports two interchangeable shapes:
//   1. Sub-commands (preferred):
//        yodacode                       → full wizard
//        yodacode setup                 → full wizard
//        yodacode setup <step>          → re-run one step (auth, slack, persona, dashboard, systemd)
//        yodacode add <surface>         → add a new surface (e.g. whatsapp)
//        yodacode status                → print current install state
//   2. Legacy flags (kept for backward compat):
//        --fresh, --reconfigure <step>, --add <surface>

const rawArgs = process.argv.slice(2);
let isFresh = rawArgs.includes('--fresh');
let reconfigure = rawArgs.find((a, i) => rawArgs[i - 1] === '--reconfigure') || null;
let addSurface = rawArgs.find((a, i) => rawArgs[i - 1] === '--add') || null;
let subcommand = 'setup';

// Filter out flag-style args; what's left is positional.
const positional = rawArgs.filter((a, i) => {
  if (a.startsWith('--')) return false;
  if (i > 0 && (rawArgs[i - 1] === '--reconfigure' || rawArgs[i - 1] === '--add')) return false;
  return true;
});
if (positional[0]) subcommand = positional[0];
if (subcommand === 'setup' && positional[1]) reconfigure = positional[1];
if (subcommand === 'add' && positional[1]) addSurface = positional[1];

// ─── Readline ──────────────────────────────────────────────────────────────
//
// If we're being piped (curl | bash → stdin is the pipe, not a terminal),
// read from /dev/tty instead so prompts actually reach the user.

let _rl = null;
function getReadline() {
  if (_rl) return _rl;
  if (process.stdin.isTTY) {
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return _rl;
  }
  if (fs.existsSync('/dev/tty')) {
    try {
      const ttyIn = fs.createReadStream('/dev/tty');
      const ttyOut = fs.createWriteStream('/dev/tty');
      ttyIn.on('error', () => {}); // swallow async open errors
      _rl = readline.createInterface({ input: ttyIn, output: ttyOut });
      return _rl;
    } catch (_) { /* fall through */ }
  }
  _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
// Backwards-compat shim so existing `rl.question(...)` / `rl.close()` calls work.
// `close()` is a no-op if no readline was ever opened, so commands that don't
// prompt (help, version, status) never trigger a /dev/tty open.
const rl = new Proxy({}, {
  get(_, prop) {
    if (prop === 'close' && !_rl) return () => {};
    const inst = getReadline();
    const v = inst[prop];
    return typeof v === 'function' ? v.bind(inst) : v;
  },
});

// ─── Helpers ───────────────────────────────────────────────────────────────

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
      // --no-save: install into node_modules without modifying package.json,
      // so the user's package.json doesn't drift from origin and block
      // `yodacode update`. require('playwright') still resolves at runtime.
      execSync('npm install --no-save playwright && npx playwright install chromium', { cwd: WORKSPACE, stdio: 'inherit' });
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

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function currentGitTag() {
  try {
    return execSync('git describe --tags --abbrev=0', { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function cmdVersion() {
  const pkgVer = readVersion();
  const tag = currentGitTag();
  const sha = (() => {
    try { return execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); }
    catch { return null; }
  })();
  console.log(`yodacode v${pkgVer}${tag ? ` (${tag})` : ''}${sha ? ` [${sha}]` : ''}`);
  rl.close();
}

function cmdHelp() {
  const lines = [
    '',
    '  YodaCode CLI',
    '',
    '  Usage: yodacode [command] [args]',
    '',
    '  Commands:',
    '    setup                  Run the full setup wizard (default if no command given)',
    '    setup <step>           Re-run one step:',
    '                             auth       Claude Code OAuth token',
    '                             persona    Bot name, user name, timezone',
    '                             slack      Slack app + tokens',
    '                             dashboard  Web dashboard enable / port / basic auth',
    '                             systemd    systemd service install + enable',
    '    add <surface>          Add a new chat surface (e.g. whatsapp)',
    '    model [<name>]         Show or set the primary Claude model',
    '    tools [<name> on|off]  Show or toggle reflectors / guardrails',
    '    usage                  Token + cost summary (today / 7d / 30d / all time)',
    '    update                 git pull, install new deps, restart the service',
    '    status                 Show what is currently configured (.env summary)',
    '    version                Print the installed version',
    '    help                   Print this message',
    '',
    '  Legacy flags (still supported):',
    '    --fresh                Re-run the wizard even if config already exists',
    '    --reconfigure <step>   Same as `setup <step>`',
    '    --add <surface>        Same as `add <surface>`',
    '',
    '  Manage the running service:',
    '    systemctl status yodacode',
    '    journalctl -u yodacode -f',
    '',
  ];
  console.log(lines.join('\n'));
  rl.close();
}

// Drop the `yodacode` wrapper into ~/.local/bin and ensure that dir is on
// PATH (idempotent). Called from cmdUpdate so a stale install (one that
// predates the wrapper) self-heals on `yodacode update` — or, if the user
// can't run yodacode at all yet, on the next `./install.sh`.
function ensureWrapperAndPath() {
  const home = process.env.HOME || '';
  if (!home) return { ok: false, reason: 'no $HOME' };
  const localBin = path.join(home, '.local', 'bin');
  const wrapperPath = path.join(localBin, 'yodacode');
  const wrapperBody = `#!/usr/bin/env bash\nexec node "${ROOT}/scripts/install.js" "$@"\n`;
  let wrapperWritten = false;
  let pathAdded = [];
  try {
    fs.mkdirSync(localBin, { recursive: true });
    // Rewrite if missing or content drifted (e.g. repo moved)
    let current = '';
    try { current = fs.readFileSync(wrapperPath, 'utf8'); } catch (_) {}
    if (current !== wrapperBody) {
      fs.writeFileSync(wrapperPath, wrapperBody);
      fs.chmodSync(wrapperPath, 0o755);
      wrapperWritten = true;
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  for (const rc of ['.bashrc', '.zshrc']) {
    const rcPath = path.join(home, rc);
    if (!fs.existsSync(rcPath)) continue;
    try {
      const body = fs.readFileSync(rcPath, 'utf8');
      if (body.includes('YODACODE_PATH_ADDED')) continue;
      fs.appendFileSync(rcPath, `\n# YODACODE_PATH_ADDED\nexport PATH="${localBin}:$PATH"\n`);
      pathAdded.push(rcPath);
    } catch (_) {}
  }
  return { ok: true, wrapperWritten, pathAdded, wrapperPath, localBin };
}

async function cmdUpdate() {
  heading('Updating YodaCode');

  // If there are local changes, auto-stash them, do the pull, then try to
  // pop. This handles dynamic files (persona docs, regenerated settings,
  // user crons) without making the user wrestle with `git stash` by hand.
  let stashed = false;
  try {
    const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
    if (dirty) {
      console.log('  Local changes detected — stashing them temporarily:');
      for (const line of dirty.split('\n').slice(0, 10)) console.log(`    ${line}`);
      // --include-untracked so persona docs and user cron yaml come along
      const stashOut = execSync('git stash push --include-untracked -m "yodacode-update auto-stash"', {
        cwd: ROOT, encoding: 'utf8',
      });
      if (/No local changes to save/i.test(stashOut)) {
        // Only untracked files; nothing was actually stashed
        stashed = false;
      } else {
        stashed = true;
        ok('Stashed local changes (will restore after pull)');
      }
    }
  } catch (e) {
    fail(`Auto-stash failed: ${e.message}`);
    console.log('\n  Either commit/stash them, or pull manually:  git pull --rebase');
    rl.close();
    process.exit(1);
  }

  const before = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  const beforeTag = currentGitTag();
  const beforeVer = readVersion();

  console.log(`  Current: v${beforeVer}${beforeTag ? ` (${beforeTag})` : ''}`);
  console.log('  Fetching…');
  try { execSync('git fetch --quiet', { cwd: ROOT, stdio: 'inherit' }); }
  catch (e) { fail(`git fetch failed: ${e.message}`); rl.close(); process.exit(1); }

  const behind = execSync('git rev-list --count HEAD..@{upstream}', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (behind === '0') {
    ok('Already up to date.');
    rl.close();
    return;
  }

  console.log(`  ${behind} new commit(s):`);
  const log = execSync('git log --oneline HEAD..@{upstream}', { cwd: ROOT, encoding: 'utf8' });
  for (const line of log.split('\n').filter(Boolean).slice(0, 15)) console.log(`    ${line}`);
  console.log('');

  const ans = (await ask('Pull and restart now? [Y/n]', 'y')).toLowerCase();
  if (ans === 'n') { console.log('  Skipped.'); rl.close(); return; }

  console.log('  Pulling…');
  try { execSync('git pull --ff-only --quiet', { cwd: ROOT, stdio: 'inherit' }); }
  catch (e) { fail(`git pull failed: ${e.message}`); rl.close(); process.exit(1); }

  // npm install only if workspace/package.json changed
  const after = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  let pkgChanged = false;
  try {
    const diff = execSync(`git diff --name-only ${before} ${after}`, { cwd: ROOT, encoding: 'utf8' });
    pkgChanged = diff.split('\n').some((f) => f === 'workspace/package.json' || f === 'package.json');
  } catch (_) {}

  if (pkgChanged) {
    console.log('  Dependencies changed — running npm install…');
    try { execSync('npm install --silent', { cwd: WORKSPACE, stdio: 'inherit' }); ok('Deps updated'); }
    catch (e) { warn(`npm install failed: ${e.message} (continuing)`); }
  } else {
    ok('No dependency changes');
  }

  // Refresh the `yodacode` wrapper + PATH line. Idempotent — only writes
  // when missing/drifted. Lets an install that predates the wrapper
  // self-heal via `yodacode update` (or, the first time, via `./install.sh`).
  const w = ensureWrapperAndPath();
  if (w.ok) {
    if (w.wrapperWritten) ok(`Wrapper installed at ${w.wrapperPath}`);
    for (const rc of w.pathAdded) ok(`Added ${w.localBin} to PATH in ${rc} — open a new shell.`);
  } else {
    warn(`Wrapper refresh skipped: ${w.reason}`);
  }

  // Restore stashed local changes. If git can't auto-merge, leave the
  // stash in place and tell the user how to recover.
  if (stashed) {
    try {
      execSync('git stash pop', { cwd: ROOT, stdio: 'pipe' });
      ok('Restored local changes');
    } catch (e) {
      warn('Could not auto-restore local changes — your edits are saved in the stash.');
      console.log('  Recover with:  git stash list   →   git stash pop');
    }
  }

  // Restart the service if systemd is installed and the unit exists
  if (checkCommand('systemctl')) {
    try {
      execSync('systemctl is-active yodacode.service', { stdio: 'pipe' });
      console.log('  Restarting yodacode.service…');
      execSync('systemctl restart yodacode.service', { stdio: 'pipe' });
      ok('Service restarted');
    } catch (_) {
      warn('yodacode.service not running — start it manually if needed.');
    }
  }

  const afterTag = currentGitTag();
  const afterVer = readVersion();
  const tagChange = beforeTag && afterTag && beforeTag !== afterTag ? ` (${beforeTag} → ${afterTag})` : '';
  const verChange = beforeVer !== afterVer ? ` (v${beforeVer} → v${afterVer})` : ` (v${afterVer})`;
  ok(`Updated${verChange}${tagChange} — now at ${after.slice(0, 7)}`);
  rl.close();
}

async function cmdModel() {
  const env = readEnv(ENV_PATH);
  const arg = positional[1];
  if (!arg) {
    heading('Model');
    console.log(`  Primary:   ${env.YODA_CLAUDE_MODEL || '(default — Claude Code picks)'}`);
    console.log(`  Fallback:  ${env.YODA_CLAUDE_FALLBACK_MODELS || 'claude-haiku-4-5'}`);
    console.log('\n  Set:  yodacode model <name>     e.g. claude-sonnet-4-6 / claude-opus-4-7 / claude-haiku-4-5');
    console.log('  Reset: yodacode model default');
    rl.close();
    return;
  }
  const value = arg === 'default' ? '' : arg;
  mergeEnv(ENV_PATH, { YODA_CLAUDE_MODEL: value });
  ok(value ? `Primary model set to ${value}` : 'Primary model reset to default');
  // Restart if running
  if (checkCommand('systemctl')) {
    try {
      execSync('systemctl is-active yodacode.service', { stdio: 'pipe' });
      execSync('systemctl restart yodacode.service', { stdio: 'pipe' });
      ok('Service restarted');
    } catch (_) {}
  }
  rl.close();
}

async function cmdTools() {
  const env = readEnv(ENV_PATH);
  const toggles = [
    ['YODA_SKILL_REFLECTOR_ENABLED',  'skill-reflector',  'Skill self-generation after notable conversations'],
    ['YODA_MEMORY_REFLECTOR_ENABLED', 'memory-reflector', 'Memory self-generation after notable conversations'],
    ['YODA_GUARDRAIL_ENABLED',        'guardrails',       'Repeat-failure / no-progress / iteration-cap detection (default on)'],
  ];

  const name = positional[1];
  const state = positional[2];

  if (!name) {
    heading('Tools');
    for (const [key, label, desc] of toggles) {
      const raw = env[key];
      const on = key === 'YODA_GUARDRAIL_ENABLED' ? raw !== '0' : raw === '1';
      console.log(`  ${on ? '✓' : '✗'} ${label.padEnd(20)} ${desc}`);
    }
    console.log('\n  Toggle:  yodacode tools <name> on|off');
    console.log('  Names:   skill-reflector | memory-reflector | guardrails');
    rl.close();
    return;
  }

  const match = toggles.find(([, label]) => label === name);
  if (!match) {
    fail(`Unknown tool: ${name}. Try one of: ${toggles.map(([, l]) => l).join(', ')}`);
    rl.close();
    process.exit(1);
  }
  if (state !== 'on' && state !== 'off') {
    fail(`Need on|off, got: ${state || '(nothing)'}`);
    rl.close();
    process.exit(1);
  }
  const [key, label] = match;
  const newVal = state === 'on' ? '1' : '0';
  mergeEnv(ENV_PATH, { [key]: newVal });
  ok(`${label} → ${state}`);
  if (checkCommand('systemctl')) {
    try {
      execSync('systemctl is-active yodacode.service', { stdio: 'pipe' });
      execSync('systemctl restart yodacode.service', { stdio: 'pipe' });
      ok('Service restarted');
    } catch (_) {}
  }
  rl.close();
}

// Per-model pricing in USD per 1M tokens (input / output). Approximate;
// shown only to give users a feel for what's burning their quota.
const MODEL_PRICING = {
  'claude-haiku-4-5':   { in: 1.0,  out: 5.0  },
  'claude-sonnet-4-6':  { in: 3.0,  out: 15.0 },
  'claude-opus-4-7':    { in: 15.0, out: 75.0 },
};

function costOf(model, inputTok, outputTok) {
  const m = model && MODEL_PRICING[model];
  if (!m) return null;
  return (inputTok / 1e6) * m.in + (outputTok / 1e6) * m.out;
}

async function cmdUsage() {
  heading('Usage');
  const usagePath = path.join(WORKSPACE, 'state', 'usage.jsonl');
  if (!fs.existsSync(usagePath)) {
    console.log('  No usage recorded yet. The bot writes entries on each successful claude run.');
    rl.close();
    return;
  }
  const lines = fs.readFileSync(usagePath, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!entries.length) { console.log('  No usage recorded yet.'); rl.close(); return; }

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const buckets = {
    today: { entries: [], cutoff: now - day },
    'last 7d':  { entries: [], cutoff: now - 7 * day },
    'last 30d': { entries: [], cutoff: now - 30 * day },
    'all time': { entries: [], cutoff: 0 },
  };
  for (const e of entries) {
    const ts = new Date(e.ts).getTime();
    for (const b of Object.values(buckets)) {
      if (ts >= b.cutoff) b.entries.push(e);
    }
  }
  const fmt = (n) => n.toLocaleString();
  for (const [name, b] of Object.entries(buckets)) {
    if (!b.entries.length && name !== 'today') continue;
    let inTok = 0, outTok = 0, cost = 0;
    const byModel = {};
    for (const e of b.entries) {
      inTok += e.input_tokens; outTok += e.output_tokens;
      const c = costOf(e.model, e.input_tokens, e.output_tokens);
      if (c) cost += c;
      byModel[e.model] = (byModel[e.model] || 0) + 1;
    }
    const modelStr = Object.entries(byModel).sort((a,b) => b[1]-a[1])
      .map(([m,n]) => `${m.replace('claude-','')}×${n}`).join(', ');
    console.log(`  ${name.padEnd(10)} ${b.entries.length.toString().padStart(5)} calls  in=${fmt(inTok).padStart(10)} out=${fmt(outTok).padStart(8)}  ~$${cost.toFixed(2)}`);
    if (modelStr) console.log(`             ${modelStr}`);
  }
  console.log('\n  Note: $ figures are approximate API-rate estimates. On a Max sub, actual cost is bundled in your subscription / new $200 claude-p credit.');
  console.log('  Raw log: state/usage.jsonl');
  rl.close();
}

async function cmdStatus() {
  heading('YodaCode status');
  const env = readEnv(ENV_PATH);
  const lines = [
    ['Install dir',  ROOT],
    ['Workspace',    WORKSPACE],
    ['Bot name',     env.BOT_NAME || '(unset)'],
    ['Surfaces',     env.YODA_SURFACES || '(unset)'],
    ['Sandbox',      env.YODA_SANDBOX || 'off (default)'],
    ['Auth token',   env.CLAUDE_CODE_OAUTH_TOKEN ? '✓ set' : '✗ missing'],
    ['Slack bot',    env.SLACK_BOT_TOKEN ? '✓ set' : '✗ missing'],
    ['Slack app',    env.SLACK_APP_TOKEN ? '✓ set' : '✗ missing'],
  ];
  for (const [k, v] of lines) console.log(`  ${k.padEnd(14)} ${v}`);
  rl.close();
}

async function runWizard() {
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
  console.log('    yodacode status              → show what is configured');
  console.log('    yodacode setup <step>        → re-run one step (auth/slack/persona/dashboard/systemd)');
  console.log('    systemctl status yodacode    → service health');
  console.log('    journalctl -u yodacode -f    → live logs');
  console.log('');
  console.log('  Edit your bot\'s persona:');
  console.log(`    ${WORKSPACE}/CLAUDE.md`);
  console.log('');

  rl.close();
}

async function main() {
  if (subcommand === 'help' || rawArgs.includes('--help') || rawArgs.includes('-h')) return cmdHelp();
  if (subcommand === 'version' || rawArgs.includes('--version') || rawArgs.includes('-v')) return cmdVersion();
  if (subcommand === 'status') return cmdStatus();
  if (subcommand === 'update') return cmdUpdate();
  if (subcommand === 'model') return cmdModel();
  if (subcommand === 'tools') return cmdTools();
  if (subcommand === 'usage') return cmdUsage();
  // 'setup' (default), 'add', or anything else → run the wizard with the
  // current isFresh / reconfigure / addSurface flags applied.
  return runWizard();
}

main().catch((e) => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
