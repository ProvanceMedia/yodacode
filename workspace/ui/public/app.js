// YodaCode Dashboard v3 — with editing

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(path) { return (await fetch(`/api/${path}`)).json(); }
async function apiPost(path, body) {
  return (await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
}

function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtBytes(b) {
  return b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(1)} KB` : `${(b/1048576).toFixed(1)} MB`;
}
function fmtAgo(iso) {
  if (!iso) return '-';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m/60)}h ago` : `${Math.floor(m/1440)}d ago`;
}

// ─── Navigation ────────────────────────────────────────────────────────────
function initNav() {
  document.querySelectorAll('.nav-link[data-page]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = el.dataset.page;
      if (p === 'crons') loadCrons();
      if (p === 'logs') loadLogsList();
      if (p === 'memory') loadMemory();
      if (p === 'persona') loadPersona();
      if (p === 'cron-editor') loadCronFiles();
    });
  });
}

// ─── Dashboard ─────────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const d = await api('status');
    $('#m-uptime').textContent = fmtUptime(d.uptime);
    $('#uptime-text').textContent = `up ${fmtUptime(d.uptime)}`;
    $('#m-surfaces').textContent = d.surfaces.join(', ');
    $('#m-model').textContent = (d.model || '').replace(' (default)', '');
    $('#m-fallback').textContent = `fallback: ${d.fallbackModels.join(' → ') || 'none'}`;
    $('#m-ticks').textContent = d.activeTicks;
    $('#m-ticks').className = `value ${d.activeTicks > 0 ? 'yellow' : 'green'}`;
    $('#m-ticks-sub').textContent = d.activeTicks > 0 ? 'working...' : 'idle';
    $('#m-status').textContent = 'Online';
    $('#m-status').className = 'value green';
    $('#health-dot').className = 'dot';
  } catch (e) {
    $('#m-status').textContent = 'Offline';
    $('#m-status').className = 'value red';
    $('#health-dot').className = 'dot offline';
  }
}

async function loadAlerts() {
  const alerts = await api('alerts');
  const el = $('#alerts-list');
  if (!alerts.length) {
    el.innerHTML = '<div class="alert alert-success">✅ All clear - no issues detected</div>';
    return;
  }
  el.innerHTML = alerts.map((a) => {
    const cls = a.type === 'error' ? 'alert-danger' : 'alert-warning';
    return `<div class="alert ${cls}">${a.type === 'error' ? '🔴' : '⚠️'} ${a.message}</div>`;
  }).join('');
}

async function loadActivity() {
  const items = await api('activity');
  const el = $('#activity-list');
  if (!items.length) {
    el.innerHTML = '<div class="p-4 text-center text-muted">No recent activity</div>';
    return;
  }
  el.innerHTML = '<div class="list-group list-group-flush">' + items.map((a) => `
    <div class="list-group-item d-flex align-items-center gap-3">
      <span class="badge bg-blue-lt text-uppercase" style="font-size:10px;min-width:48px;">${a.surface}</span>
      <code class="small">${a.userId}</code>
      <span class="ms-auto text-muted small">${fmtAgo(a.time)}</span>
    </div>
  `).join('') + '</div>';
}

// ─── Crons ─────────────────────────────────────────────────────────────────
async function loadCrons() {
  const data = await api('crons');
  const tbody = $('#crons-tbody');
  if (data.error) { tbody.innerHTML = `<tr><td colspan="4" class="dim">${data.error}</td></tr>`; return; }
  $('#cron-count').textContent = data.length;
  tbody.innerHTML = data.map((t) => {
    const unit = t.unit || t.activates || '?';
    const timer = unit.replace('.service', '.timer');
    const name = unit.replace('yoda-', '').replace('.service', '').replace('.timer', '');
    return `<tr>
      <td><code class="text-primary">${name}</code></td>
      <td class="text-muted">${t.next || t.left || '-'}</td>
      <td class="text-muted">${t.last || t.passed || '-'}</td>
      <td>
        <div class="btn-list">
          <button onclick="cronRun('${unit}')" class="btn btn-success btn-sm">▶ Run</button>
          <button onclick="cronAction('${timer}','stop')" class="btn btn-outline-danger btn-sm">⏹</button>
          <button onclick="cronAction('${timer}','start')" class="btn btn-outline-secondary btn-sm">▶</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

window.cronRun = async (unit) => {
  await apiPost('cron/action', { unit, action: 'start' });
  setTimeout(loadCrons, 1000);
};
window.cronAction = async (unit, action) => {
  await apiPost('cron/action', { unit, action });
  setTimeout(loadCrons, 1000);
};

// ─── Cron Editor ───────────────────────────────────────────────────────────
async function loadCronFiles() {
  const data = await api('cron/files');
  const ul = $('#cron-files-list');
  if (data.error) { ul.innerHTML = `<li class="dim">${data.error}</li>`; return; }
  ul.innerHTML = data.map((f) => `
    <a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" onclick="editCronFile('${f.name}')" style="cursor:pointer;">
      <code class="text-primary small">${f.name}</code>
      <span class="text-muted small">${fmtBytes(f.size)}</span>
    </a>
  `).join('');
}

window.editCronFile = async (name) => {
  const data = await api('cron/files');
  const file = (Array.isArray(data) ? data : []).find((f) => f.name === name);
  if (!file) return;
  $('#cron-editor-title').textContent = name;
  const editor = $('#cron-editor-textarea');
  editor.value = file.content;
  editor.dataset.filename = name;
  $('#cron-editor-area').style.display = 'block';
  // highlight active
  $$('#cron-files-list li').forEach((li) => li.classList.remove('active'));
  event.target.closest('li')?.classList.add('active');
};

window.saveCronFile = async () => {
  const editor = $('#cron-editor-textarea');
  const name = editor.dataset.filename;
  if (!name) return;
  const result = await apiPost('cron/file/write', { name, content: editor.value });
  if (result.ok) {
    showToast(`Saved ${name}`);
    loadCronFiles();
  } else {
    showToast(`Error: ${result.error}`, 'error');
  }
};

// ─── Logs ──────────────────────────────────────────────────────────────────
let ws = null;
async function loadLogsList() {
  const data = await api('logs');
  if (data.error) return;
  const sel = $('#log-select');
  sel.innerHTML = data.map((f) => `<option value="${f.name}">${f.name} (${fmtBytes(f.size)})</option>`).join('');
  if (data.length) openLog(data[0].name);
  sel.onchange = () => openLog(sel.value);
}
async function openLog(name) {
  if (ws) { ws.close(); ws = null; }
  const out = $('#log-output');
  out.innerHTML = '';
  const data = await api(`logs/tail?name=${encodeURIComponent(name)}&lines=80`);
  if (data.lines) out.innerHTML = data.lines.map(colorize).join('\n');
  out.scrollTop = out.scrollHeight;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/logs?log=${encodeURIComponent(name)}&token=`);
  ws.onmessage = (e) => {
    out.innerHTML += '\n' + e.data.split('\n').filter(Boolean).map(colorize).join('\n');
    out.scrollTop = out.scrollHeight;
  };
}
function colorize(line) {
  if (!line) return '';
  const e = line.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (e.includes('"error"') || e.includes('ERROR')) return `<span class="l-error">${e}</span>`;
  if (e.includes('"warn"') || e.includes('WARN')) return `<span class="l-warn">${e}</span>`;
  if (e.includes('"info"')) return `<span class="l-info">${e}</span>`;
  return e;
}
window.clearLog = () => { $('#log-output').innerHTML = ''; };

// ─── Memory (with edit) ───────────────────────────────────────────────────
async function loadMemory() {
  const data = await api('memory');
  const ul = $('#memory-files');
  if (data.error) { ul.innerHTML = `<div class="list-group-item text-muted">${data.error}</div>`; return; }
  ul.innerHTML = data.map((f) => `
    <a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" onclick="openFileEditor('${f.path}', 'memory')" style="cursor:pointer;">
      <code class="text-primary small">${f.name}</code>
      <span class="text-muted small">${fmtBytes(f.size)}</span>
    </a>
  `).join('');
}

// ─── Persona (with edit) ──────────────────────────────────────────────────
async function loadPersona() {
  const data = await api('persona');
  const ul = $('#persona-files');
  ul.innerHTML = data.map((f) => `
    <a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" onclick="openFileEditor('${f.name}', 'persona')" style="cursor:pointer;">
      <code class="text-primary small">${f.name}</code>
      <span class="text-muted small">${fmtBytes(f.size)}${f.editable === false ? ' · read-only' : ''}</span>
    </a>
  `).join('');
}

// ─── Generic file editor ──────────────────────────────────────────────────
window.openFileEditor = async (filePath, context) => {
  const viewerId = context === 'persona' ? 'persona-editor' : 'memory-editor';
  const titleId = context === 'persona' ? 'persona-editor-title' : 'memory-editor-title';
  const area = $(`#${viewerId}`);
  const title = $(`#${titleId}`);
  const textarea = area.querySelector('textarea');
  const saveBtn = area.querySelector('.btn-save');

  title.textContent = filePath;
  area.style.display = 'block';

  const data = await api(`memory/read?path=${encodeURIComponent(filePath)}`);
  if (data.error) {
    textarea.value = `Error: ${data.error}`;
    saveBtn.style.display = 'none';
    return;
  }
  textarea.value = data.content;
  textarea.dataset.filepath = filePath;

  // Check if editable
  const isReadOnly = filePath === 'CAPABILITIES.md' || filePath.startsWith('LEGACY');
  saveBtn.style.display = isReadOnly ? 'none' : 'inline-flex';
  textarea.readOnly = isReadOnly;
  textarea.style.opacity = isReadOnly ? '0.6' : '1';

  // highlight active
  const listId = context === 'persona' ? 'persona-files' : 'memory-files';
  $$(`#${listId} li`).forEach((li) => li.classList.remove('active'));
  event?.target?.closest('li')?.classList.add('active');
};

window.saveFile = async (editorId) => {
  const textarea = $(`#${editorId} textarea`);
  const filePath = textarea.dataset.filepath;
  if (!filePath) return;
  const result = await apiPost('memory/write', { path: filePath, content: textarea.value });
  if (result.ok) {
    showToast(`Saved ${filePath}`);
  } else {
    showToast(`Error: ${result.error}`, 'error');
  }
};

// ─── Toast notifications ──────────────────────────────────────────────────
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}

// ─── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  loadStatus();
  loadAlerts();
  loadActivity();
  setInterval(loadStatus, 8000);
  setInterval(loadAlerts, 30000);
  setInterval(loadActivity, 15000);
});
