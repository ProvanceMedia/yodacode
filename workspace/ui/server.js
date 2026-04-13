// Yoda Web UI — lightweight admin dashboard.
//
// Runs inside the same yoda.js process as an optional module. Provides:
//   - Status dashboard (surfaces, model, uptime, active ticks)
//   - Cron management (list/start/stop timers, run now)
//   - Live log streaming (WebSocket)
//   - Memory viewer (browse + read memory files)
//
// Tech: Node built-in http + ws for WebSocket. Zero frontend build tooling —
// the dashboard is a single HTML file + vanilla JS served as static files.
//
// Auth: HTTP Basic Auth. Credentials in env (YODA_UI_USER / YODA_UI_PASS).
// Tailscale-only access is the recommended network-level gate on top.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

const PORT = parseInt(process.env.YODA_UI_PORT || '7890', 10);
const UI_USER = process.env.YODA_UI_USER || 'yoda';
const UI_PASS = process.env.YODA_UI_PASS || '';
const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
const LOGS_DIR = path.resolve(config.workspace, '..', 'logs');
const WORKSPACE = config.workspace;
const START_TIME = Date.now();

// MIME types for static file serving
const MIMES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ─── Auth ──────────────────────────────────────────────────────────────────

function checkAuth(req) {
  if (!UI_PASS) return true; // no password = no auth required
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':');
  return user === UI_USER && pass === UI_PASS;
}

function sendUnauth(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="YodaCode"',
    'Content-Type': 'text/plain',
  });
  res.end('Unauthorized');
}

// ─── API handlers ──────────────────────────────────────────────────────────

function apiStatus() {
  let ticks = {};
  try {
    ticks = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'state', 'current-ticks.json'), 'utf8'));
  } catch (_) {}

  return {
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    surfaces: config.surfaces,
    model: config.claude.model || 'claude-sonnet-4-6 (default)',
    fallbackModels: config.claude.fallbackModels,
    activeTicks: Object.keys(ticks).length,
    ticks,
    workspace: WORKSPACE,
    nodeVersion: process.version,
  };
}

function apiCrons() {
  try {
    const raw = execSync('systemctl list-timers --no-pager --output=json 2>/dev/null || systemctl list-timers --no-pager', {
      encoding: 'utf8',
      timeout: 5000,
    });
    // Try JSON parse first (newer systemd), fall back to text parsing
    try {
      const timers = JSON.parse(raw);
      return timers.filter((t) => t.unit && t.unit.startsWith('yoda-'));
    } catch (_) {
      // Text output parsing
      const lines = raw.split('\n').filter((l) => l.includes('yoda-'));
      return lines.map((line) => {
        const parts = line.trim().split(/\s{2,}/);
        return {
          next: parts[0] || '',
          left: parts[1] || '',
          last: parts[2] || '',
          passed: parts[3] || '',
          unit: parts[4] || '',
          activates: parts[5] || '',
        };
      });
    }
  } catch (e) {
    return { error: e.message };
  }
}

function apiCronAction(name, action) {
  const allowed = ['start', 'stop', 'restart'];
  if (!allowed.includes(action)) return { error: 'invalid action' };
  // Sanitise name: must match yoda-* pattern, no path traversal
  if (!/^yoda-[\w-]+\.(timer|service)$/.test(name)) {
    return { error: 'invalid unit name' };
  }
  try {
    execSync(`systemctl ${action} ${name}`, { timeout: 10000 });
    return { ok: true, unit: name, action };
  } catch (e) {
    return { error: e.message };
  }
}

function apiLogs() {
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({
        name: f,
        size: fs.statSync(path.join(LOGS_DIR, f)).size,
        modified: fs.statSync(path.join(LOGS_DIR, f)).mtime.toISOString(),
      }))
      .sort((a, b) => b.modified.localeCompare(a.modified));
    return files;
  } catch (e) {
    return { error: e.message };
  }
}

function apiLogTail(name, lines = 100) {
  if (!/^[\w.-]+\.log$/.test(name)) return { error: 'invalid log name' };
  const p = path.join(LOGS_DIR, name);
  if (!fs.existsSync(p)) return { error: 'not found' };
  try {
    const content = execSync(`tail -${lines} "${p}"`, { encoding: 'utf8', timeout: 5000 });
    return { name, lines: content.split('\n') };
  } catch (e) {
    return { error: e.message };
  }
}

function apiMemory() {
  const files = [];
  // Main memory
  for (const f of ['MEMORY.md', 'LEGACY_MEMORY.md']) {
    const p = path.join(WORKSPACE, f);
    if (fs.existsSync(p)) {
      files.push({ name: f, size: fs.statSync(p).size, path: f });
    }
  }
  // memory/ subdir
  const memDir = path.join(WORKSPACE, 'memory');
  if (fs.existsSync(memDir)) {
    for (const f of fs.readdirSync(memDir)) {
      if (f.endsWith('.md')) {
        files.push({ name: `memory/${f}`, size: fs.statSync(path.join(memDir, f)).size, path: `memory/${f}` });
      }
    }
  }
  return files;
}

function apiMemoryRead(filePath) {
  // Prevent path traversal
  const resolved = path.resolve(WORKSPACE, filePath);
  if (!resolved.startsWith(WORKSPACE)) return { error: 'path traversal denied' };
  if (!fs.existsSync(resolved)) return { error: 'not found' };
  return { name: filePath, content: fs.readFileSync(resolved, 'utf8') };
}

function apiPersona() {
  const files = [];
  for (const f of ['CLAUDE.md', 'IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'AGENTS.md', 'CAPABILITIES.md']) {
    const p = path.join(WORKSPACE, f);
    if (fs.existsSync(p)) {
      files.push({
        name: f,
        size: fs.statSync(p).size,
        editable: f !== 'CAPABILITIES.md', // auto-generated, don't hand-edit
      });
    }
  }
  return files;
}

function apiFileWrite(filePath, content) {
  const resolved = path.resolve(WORKSPACE, filePath);
  if (!resolved.startsWith(WORKSPACE)) return { error: 'path traversal denied' };
  // Only allow writing .md files in safe locations
  if (!filePath.endsWith('.md')) return { error: 'only .md files can be edited' };
  const allowedPrefixes = ['MEMORY.md', 'IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'AGENTS.md', 'CLAUDE.md', 'memory/'];
  if (!allowedPrefixes.some((p) => filePath.startsWith(p))) {
    return { error: 'file not in editable path' };
  }
  try {
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true, path: filePath, size: content.length };
  } catch (e) {
    return { error: e.message };
  }
}

function apiAlerts() {
  const alerts = [];
  // Check for failed systemd services
  try {
    const failed = execSync('systemctl list-units --state=failed --no-pager --plain 2>/dev/null', {
      encoding: 'utf8', timeout: 5000,
    });
    const yodaFailed = failed.split('\n').filter((l) => l.includes('yoda-'));
    for (const line of yodaFailed) {
      const unit = line.trim().split(/\s+/)[0];
      if (unit) alerts.push({ type: 'error', message: `Failed: ${unit}`, unit });
    }
  } catch (_) {}
  // Check active ticks that are too old (> 5 min = possible stuck)
  try {
    const ticks = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'state', 'current-ticks.json'), 'utf8'));
    for (const [id, tick] of Object.entries(ticks)) {
      const age = (Date.now() - tick.startedAt) / 1000;
      if (age > 300) {
        alerts.push({ type: 'warn', message: `Tick running ${Math.round(age)}s: ${id}` });
      }
    }
  } catch (_) {}
  return alerts;
}

function apiCronFiles() {
  const cronDir = path.resolve(WORKSPACE, '..', 'cron-tasks');
  try {
    return fs.readdirSync(cronDir)
      .filter((f) => f.endsWith('.sh'))
      .map((f) => ({
        name: f,
        size: fs.statSync(path.join(cronDir, f)).size,
        content: fs.readFileSync(path.join(cronDir, f), 'utf8'),
      }));
  } catch (e) {
    return { error: e.message };
  }
}

function apiCronFileWrite(name, content) {
  if (!/^[\w.-]+\.sh$/.test(name)) return { error: 'invalid filename' };
  const cronDir = path.resolve(WORKSPACE, '..', 'cron-tasks');
  const p = path.join(cronDir, name);
  if (!fs.existsSync(p)) return { error: 'file not found' };
  try {
    fs.writeFileSync(p, content, 'utf8');
    return { ok: true, name, size: content.length };
  } catch (e) {
    return { error: e.message };
  }
}

function apiRecentActivity() {
  // Read last 20 lines from yoda.log that contain "replying"
  const logPath = path.join(LOGS_DIR, 'yoda.log');
  if (!fs.existsSync(logPath)) return [];
  try {
    const raw = execSync(`grep '"replying"' "${logPath}" | tail -15`, { encoding: 'utf8', timeout: 5000 });
    return raw.split('\n').filter(Boolean).map((line) => {
      try {
        const d = JSON.parse(line);
        return {
          time: d.t,
          surface: d.surface,
          conversationId: d.conversationId,
          userId: d.userId,
        };
      } catch (_) { return null; }
    }).filter(Boolean).reverse();
  } catch (_) { return []; }
}

// ─── HTTP Server ───────────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (!checkAuth(req)) return sendUnauth(res);

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // API routes
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    let body = '';

    if (req.method === 'POST') {
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch (_) {}
        let result;
        if (pathname === '/api/cron/action') {
          result = apiCronAction(data.unit, data.action);
        } else if (pathname === '/api/memory/write') {
          result = apiFileWrite(data.path, data.content);
        } else if (pathname === '/api/cron/file/write') {
          result = apiCronFileWrite(data.name, data.content);
        } else {
          result = { error: 'not found' };
        }
        res.end(JSON.stringify(result));
      });
      return;
    }

    let result;
    switch (pathname) {
      case '/api/status': result = apiStatus(); break;
      case '/api/crons': result = apiCrons(); break;
      case '/api/logs': result = apiLogs(); break;
      case '/api/logs/tail':
        result = apiLogTail(url.searchParams.get('name'), parseInt(url.searchParams.get('lines') || '100'));
        break;
      case '/api/memory': result = apiMemory(); break;
      case '/api/memory/read':
        result = apiMemoryRead(url.searchParams.get('path') || '');
        break;
      case '/api/persona': result = apiPersona(); break;
      case '/api/alerts': result = apiAlerts(); break;
      case '/api/cron/files': result = apiCronFiles(); break;
      case '/api/activity': result = apiRecentActivity(); break;
      default: result = { error: 'not found' };
    }
    res.end(JSON.stringify(result));
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIMES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ─── WebSocket (live log streaming) ────────────────────────────────────────

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/logs' });

  wss.on('connection', (ws, req) => {
    // Auth check for WS — token in query param since WS can't send Basic Auth headers
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const token = url.searchParams.get('token');
    if (UI_PASS && token !== UI_PASS) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const logName = url.searchParams.get('log') || 'yoda.log';
    if (!/^[\w.-]+\.log$/.test(logName)) {
      ws.close(4002, 'Invalid log name');
      return;
    }

    const logPath = path.join(LOGS_DIR, logName);
    if (!fs.existsSync(logPath)) {
      ws.close(4003, 'Log not found');
      return;
    }

    // Spawn tail -f and stream to websocket
    const tail = spawn('tail', ['-f', '-n', '50', logPath]);
    tail.stdout.on('data', (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data.toString());
      }
    });

    ws.on('close', () => { tail.kill(); });
    ws.on('error', () => { tail.kill(); });
  });
}

// ─── Exports ───────────────────────────────────────────────────────────────

let server = null;

export function startUI() {
  if (!PORT) return;
  server = http.createServer(handleRequest);
  setupWebSocket(server);
  server.listen(PORT, '0.0.0.0', () => {
    logger.info('ui: dashboard listening', { port: PORT, auth: UI_PASS ? 'basic' : 'none' });
  });
}

export function stopUI() {
  if (server) {
    server.close();
    server = null;
  }
}
