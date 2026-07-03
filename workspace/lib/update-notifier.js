// Update notifier. Once a day (plus once shortly after startup), check the
// public repo for a newer tagged version; when one appears, DM the operator
// through any surface that supports notifyOperator() — the user's attention
// already lives in chat, so that's where "there's an update" belongs. Each
// version is announced exactly once (state/update-check.json remembers).
//
// Fail-quiet by design: offline, rate-limited, or missing-surface conditions
// log at debug and try again next interval. Disable with YODA_UPDATE_CHECK=0;
// forks can point YODA_UPDATE_REPO at their own repo (owner/name).

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { surfaces } from './surface.js';

const STATE_FILE = path.join(config.stateDir, 'update-check.json');
const STARTUP_DELAY_MS = 2 * 60 * 1000;   // don't compete with boot
const CHECK_INTERVAL_MS = 24 * 3600 * 1000;
const MAX_HIGHLIGHTS = 6;

// Versions announced by THIS process — dedupe backstop when state
// persistence fails (never DM the operator daily about the same release).
const announcedInProcess = new Set();

function repoSlug() {
  return process.env.YODA_UPDATE_REPO || 'ProvanceMedia/yodacode';
}

/** Installed version, from the repo root package.json (bumped by releases). */
export function currentVersion() {
  try {
    const p = path.resolve(config.workspace, '..', 'package.json');
    const v = JSON.parse(readFileSync(p, 'utf8')).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Compare two versions ("v2.1.0"/"2.1.0"): -1, 0, 1. Semver rule for
 * suffixes: a prerelease ("2.1.0-beta.1") sorts BELOW its plain release, so
 * a dev install still gets told when the real release lands.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v).replace(/^v/, '');
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
    const nums = m ? [+m[1], +m[2], +m[3]] : s.split('.').map((n) => parseInt(n, 10) || 0);
    return { nums, pre: /^\d+\.\d+\.\d+[-+]/.test(s) };
  };
  const pa = parse(a); const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pa.nums[i] || 0) !== (pb.nums[i] || 0)) return (pa.nums[i] || 0) < (pb.nums[i] || 0) ? -1 : 1;
  }
  if (pa.pre !== pb.pre) return pa.pre ? -1 : 1;
  return 0;
}

/** Newest release tag (vX.Y.Z) on the public repo, or null. */
export function fetchLatestTag(repo = repoSlug()) {
  return new Promise((resolve) => {
    execFile('git', ['ls-remote', '--tags', `https://github.com/${repo}.git`, 'v*'],
      { timeout: 15000, encoding: 'utf8' }, (err, out) => {
        if (err || !out) return resolve(null);
        const tags = out.split('\n')
          .map((l) => l.split('/').pop())
          .filter((t) => /^v\d+\.\d+\.\d+$/.test(t || '')); // drops ^{} peel lines
        if (!tags.length) return resolve(null);
        tags.sort(compareVersions);
        resolve(tags[tags.length - 1]);
      });
  });
}

/** Bullet highlights for a version from the repo's CHANGELOG, or null. */
export async function fetchHighlights(version, repo = repoSlug()) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${repo}/main/CHANGELOG.md`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const md = await r.text();
    const lines = md.split('\n');
    // Anchored heading match: "## v2.2.2" must not pick up "## v2.2.20".
    const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
    if (start === -1) return null;
    // Escape Slack mrkdwn controls and cap bullet length — on forks
    // (YODA_UPDATE_REPO) this content isn't ours, and it must render as
    // text, never as mentions or channel pings.
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const bullets = [];
    for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
      if (lines[i].startsWith('- ')) bullets.push(`• ${esc(lines[i].slice(2)).slice(0, 200)}`);
      if (bullets.length >= MAX_HIGHLIGHTS) break;
    }
    return bullets.length ? bullets.join('\n') : null;
  } catch {
    return null;
  }
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function saveState(st) {
  try {
    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  } catch (e) {
    logger.debug('update-check state persist failed', { err: e.message });
  }
}

async function notifyOperator(text) {
  for (const surface of surfaces.values()) {
    if (typeof surface.notifyOperator !== 'function') continue;
    try {
      if (await surface.notifyOperator(text)) return true;
    } catch (e) {
      logger.debug('notifyOperator failed', { surface: surface.name, err: e.message });
    }
  }
  return false;
}

/**
 * One check pass. Returns what it found (also used by tests); announces at
 * most once per version.
 */
export async function runUpdateCheck() {
  const cur = currentVersion();
  if (!cur) return { checked: false };

  const latest = await fetchLatestTag();
  if (!latest) return { checked: false };

  const st = loadState();
  st.checkedAt = Date.now();
  st.latest = latest;

  const newer = compareVersions(latest, cur) > 0;
  let announced = false;
  // announcedInProcess backs up the disk state: if state persistence is
  // broken, the DM still fires at most once per process instead of daily.
  if (newer && st.announced !== latest && !announcedInProcess.has(latest)) {
    const highlights = await fetchHighlights(latest);
    const lines = [
      `:arrow_up: A new version of me is available: *${latest}* (this server runs v${cur}).`,
      ...(highlights ? ['', "What's new:", highlights] : []),
      '',
      'Update whenever suits — on the server, run: `yodacode update`',
    ];
    if (await notifyOperator(lines.join('\n'))) {
      announcedInProcess.add(latest);
      st.announced = latest;
      announced = true;
      logger.info('update available — operator notified', { latest, current: cur });
    } else if (st.undeliverableWarned !== latest) {
      // Visible at the default log level, once per version — an update the
      // operator can't hear about must not be silent.
      st.undeliverableWarned = latest;
      logger.warn('update available but no operator notification could be delivered', {
        latest, current: cur, hint: 'set YODA_DM_AUTHORIZED_USERS / check Slack surface',
      });
    }
  }
  saveState(st);
  return { checked: true, current: cur, latest, newer, announced };
}

/** Kick off the daily check loop (call once after surfaces have started). */
export function startUpdateNotifier() {
  if (process.env.YODA_UPDATE_CHECK === '0') {
    logger.info('update check disabled (YODA_UPDATE_CHECK=0)');
    return;
  }
  const kick = () => {
    runUpdateCheck().catch((e) => logger.debug('update check failed', { err: e.message }));
  };
  setTimeout(kick, STARTUP_DELAY_MS).unref();
  setInterval(kick, CHECK_INTERVAL_MS).unref();
}
