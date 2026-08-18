// Assembling the persona for an engine that has no `@`-imports.
//
// On Claude, workspace/CLAUDE.md loads nine documents by reference — identity,
// voice, the operator's own context, tools, capabilities, memory, the skills
// index. Codex has no equivalent: it reads ONE instructions file and ignores
// `@./file.md` lines entirely, so the same persona has to be flattened into a
// single document.
//
// Two things about that file, both established by capturing the request Codex
// actually sends:
//
//   1. `AGENTS.override.md` REPLACES `AGENTS.md` — it does not supplement it.
//      A workspace with both sends only the override. So the assembled file has
//      to include what AGENTS.md says, or those rules vanish with no error.
//   2. The content arrives as a user message headed
//      `# AGENTS.md instructions for <dir>`, not as the system prompt. Codex
//      keeps its own instructions; ours are additional context.
//
// The failure mode this guards against is silence: a missing document doesn't
// error, the agent just quietly stops sounding like itself.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Codex truncates the instructions file at project_doc_max_bytes. yodacode
 *  raises that in the generated config.toml, but assembly still refuses to
 *  produce something larger than the limit it was told about — truncation here
 *  would cut the persona off mid-sentence with nothing to show for it. */
export const DEFAULT_MAX_BYTES = 256 * 1024;

const IMPORT_RE = /^@(\.\/)?([A-Za-z0-9_./-]+)\s*$/;

/** The referenced document paths, in order, from an `@`-import block. */
export function parseImports(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(IMPORT_RE);
    if (m) out.push(m[2]);
  }
  return out;
}

/**
 * Flatten CLAUDE.md and everything it imports into one document.
 *
 * @param {object} opts
 * @param {string} opts.workspace   workspace directory
 * @param {string} [opts.source]    the file to flatten (default CLAUDE.md)
 * @param {number} [opts.maxBytes]
 * @returns {{text: string, missing: string[], included: string[], bytes: number, truncated: boolean}}
 */
export function assemblePersona({ workspace, source = 'CLAUDE.md', maxBytes = DEFAULT_MAX_BYTES }) {
  const sourcePath = path.join(workspace, source);
  if (!existsSync(sourcePath)) {
    return { text: '', missing: [source], included: [], bytes: 0, truncated: false };
  }

  const root = readFileSync(sourcePath, 'utf8');
  const refs = parseImports(root);
  const missing = [];
  const included = [];
  const parts = [];

  // The root document first, with its now-meaningless import lines removed —
  // leaving them would tell the model to load files it cannot load.
  parts.push(root.split('\n').filter((l) => !IMPORT_RE.test(l.trim())).join('\n').trim());

  for (const ref of refs) {
    const p = path.join(workspace, ref);
    let body = '';
    try {
      body = readFileSync(p, 'utf8').trim();
    } catch {
      missing.push(ref);
      continue;
    }
    if (!body) { missing.push(ref); continue; }
    included.push(ref);
    // Each document keeps its own heading so the model can tell them apart and
    // so a human reading the generated file can see where content came from.
    parts.push(`\n---\n\n<!-- from ${ref} -->\n\n${body}`);
  }

  const text = `${parts.join('\n')}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  return { text, missing, included, bytes, truncated: bytes > maxBytes };
}

/**
 * Write the assembled persona to AGENTS.override.md.
 *
 * Returns the assembly report so the caller can log what was missing. It does
 * NOT throw on missing documents: a partial persona is better than no agent,
 * and the operator needs to be told rather than stopped.
 */
export function writePersona({ workspace, maxBytes = DEFAULT_MAX_BYTES, target = 'AGENTS.override.md' }) {
  const report = assemblePersona({ workspace, maxBytes });
  if (report.text) writeFileSync(path.join(workspace, target), report.text);
  return { ...report, target };
}
