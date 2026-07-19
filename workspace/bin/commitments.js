#!/usr/bin/env node
// @yoda-tool
// name: commitments.js
// summary: The commitments ledger — things the user promised people and things people promised them, captured by the daily sweep. In chat: list what's open, mark items done, dismiss noise, log a chase. When the user says "chase 3", FIRST prep the nudge (a draft for email items, suggested text for Slack items), THEN run `chase 3` here to stamp it so tomorrow's digest says "chased" instead of nagging.
// tags: productivity
// requires:
// usage:
//   ./bin/commitments.js add --text "<the commitment>" --who <mine|theirs> --source <slack|email|meeting> [--ref "<link/thread/msg id>"] [--due "<when>"] [--draft "<where the draft is>"]
//   ./bin/commitments.js list [--all]
//   ./bin/commitments.js done <id> | dismiss <id> | chase <id>
//   ./bin/commitments.js open-json
//   ./bin/commitments.js prune
// examples:
//   ./bin/commitments.js list
//   ./bin/commitments.js done 3
//   ./bin/commitments.js chase 7
// @end
//
// Used two ways:
//  - The daily commitments cron (cron-tasks/commitments.yaml) calls `add` for each
//    commitment it extracts (dedupe is handled here, so re-seeing the same promise
//    tomorrow is a no-op) and `open-json` to build the digest.
//  - Normal chat turns call list/done/dismiss when the user says "done 3" /
//    "dismiss 7" / "what's open?".
//
// State lives in state/commitments.json. Writes are atomic (temp + rename) so a
// crash mid-write can never wipe the ledger.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.YODA_STATE_DIR
  ? path.resolve(ROOT, process.env.YODA_STATE_DIR)
  : path.join(ROOT, 'state');
const FILE = path.join(STATE_DIR, 'commitments.json');
const PRUNE_AFTER_MS = 30 * 24 * 3600 * 1000; // closed items linger 30 days for "what did I do?"

function load() {
  try {
    const d = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;
    if (d && typeof d === 'object' && Array.isArray(d.items)) return d;
  } catch { /* fall through to fresh */ }
  return { nextId: 1, items: [] };
}

function save(db) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, FILE);
}

// Dedupe key: same source + same normalised text = the same commitment, however
// many sweeps re-encounter it. Case/whitespace/punctuation-insensitive so minor
// rephrasing by the extractor doesn't create ghosts.
function keyOf(source, text) {
  const norm = String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(`${source}|${norm}`).digest('hex').slice(0, 16);
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function fmtItem(it) {
  const who = it.who === 'mine' ? 'you promised' : 'waiting on them';
  const due = it.due ? `  due: ${it.due}` : '';
  const draft = it.draft ? `  draft: ${it.draft}` : '';
  return `  ${it.id}. [${it.source}] ${it.text}  (${who})${due}${draft}`;
}

function requireItem(db, idRaw) {
  const id = parseInt(idRaw, 10);
  const it = db.items.find((x) => x.id === id);
  if (!it) {
    console.log(`NOT_FOUND ${idRaw}`);
    process.exit(1);
  }
  return it;
}

const cmd = process.argv[2];
const db = load();

switch (cmd) {
  case 'add': {
    const text = arg('--text');
    const who = arg('--who');
    const source = arg('--source');
    if (!text || !['mine', 'theirs'].includes(who) || !['slack', 'email', 'meeting'].includes(source)) {
      console.log('usage: add --text "<t>" --who <mine|theirs> --source <slack|email|meeting> [--ref ..] [--due ..] [--draft ..]');
      process.exit(1);
    }
    const key = keyOf(source, text);
    const twins = db.items.filter((x) => x.key === key);
    // Dismissed wins: the user said "stop showing me this", so a sweep re-finding
    // the same commitment must NOT resurrect it. (Dismissals age out with prune
    // after 30 days — if it's still coming up by then, it's worth showing again.)
    const dismissed = twins.find((x) => x.status === 'dismissed');
    if (dismissed) {
      console.log(`SUPPRESSED ${dismissed.id}`);
      break;
    }
    // An OPEN twin is the same commitment re-seen — refresh it, don't duplicate.
    // Merge any newly-supplied detail onto it (a draft created this sweep, a due
    // date the extractor spotted today) so "DUP" never silently drops --draft —
    // without the merge, the sweep would re-create the same Gmail draft daily.
    // A DONE twin does NOT block: "send the weekly report", completed last week
    // and promised again today, is a genuinely new instance.
    const open = twins.find((x) => x.status === 'open');
    if (open) {
      open.lastSeen = Date.now();
      for (const f of ['draft', 'due', 'ref']) {
        const v = arg(`--${f}`);
        if (v) open[f] = v;
      }
      save(db);
      console.log(`DUP ${open.id}`);
      break;
    }
    const item = {
      id: db.nextId++,
      key,
      text: String(text).slice(0, 500),
      who,
      source,
      ref: arg('--ref') || '',
      due: arg('--due') || '',
      draft: arg('--draft') || '',
      status: 'open',
      created: Date.now(),
      lastSeen: Date.now(),
    };
    db.items.push(item);
    save(db);
    console.log(`ADDED ${item.id}`);
    break;
  }

  case 'list': {
    const all = process.argv.includes('--all');
    const items = db.items.filter((x) => all || x.status === 'open');
    if (!items.length) {
      console.log(all ? 'No commitments recorded.' : 'Nothing open — clean slate.');
      break;
    }
    for (const it of items) {
      console.log(all ? `${fmtItem(it)}  [${it.status}]` : fmtItem(it));
    }
    break;
  }

  case 'open-json':
    console.log(JSON.stringify(db.items.filter((x) => x.status === 'open')));
    break;

  case 'done':
  case 'dismiss': {
    const it = requireItem(db, process.argv[3]);
    it.status = cmd === 'done' ? 'done' : 'dismissed';
    it.closed = Date.now();
    save(db);
    console.log(`${cmd.toUpperCase()} ${it.id}`);
    break;
  }

  case 'chase': {
    // Mark that a chase was sent so tomorrow's digest says "chased yesterday"
    // instead of nagging again.
    const it = requireItem(db, process.argv[3]);
    it.lastChased = Date.now();
    save(db);
    console.log(`CHASED ${it.id}`);
    break;
  }

  case 'prune': {
    const before = db.items.length;
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    db.items = db.items.filter((x) => x.status === 'open' || (x.closed || x.created) > cutoff);
    save(db);
    console.log(`PRUNED ${before - db.items.length}`);
    break;
  }

  default:
    console.log('usage: commitments.js {add|list|open-json|done|dismiss|chase|prune} — see ./bin/commitments.js header for flags');
    process.exit(cmd ? 1 : 0);
}
