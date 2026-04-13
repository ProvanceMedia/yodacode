// Surface-agnostic stream translator. Reads Claude Code's `--output-format
// stream-json` from a Readable stream and turns it into:
//   - throttled live status updates (called via onStatus(text))
//   - a final reply text (called once via onFinal(text))
//
// Replaces translator.py with a pure-Node implementation so the same logic
// powers both the Slack and WhatsApp surfaces (and any future ones).
//
// Status text examples it produces:
//   "💭 thinking…"
//   "⚡ Slack post"
//   "🌐 curl api.hubapi.com"
//   "📖 reading SOUL.md"
//   "✍️ Found 3 contacts named Stuart Dixon..."
// Final text is the assistant's last text block (or the result.result field).

import readline from 'node:readline';
import path from 'node:path';

const THROTTLE_MS = 800;

/**
 * Translate a Claude Code stream-json stdout into live status + final text.
 *
 * @param {Readable} stdin              The claude process stdout
 * @param {object}   handlers
 * @param {(text: string) => Promise<void>} handlers.onStatus  Called for live updates (throttled)
 * @param {(text: string) => Promise<void>} handlers.onFinal   Called once with final text
 * @param {number}   [handlers.maxRetries] Bail when Claude reports this many consecutive api_retry events
 * @param {() => void} [handlers.onMaxRetries] Called once when retry threshold is exceeded
 * @returns {Promise<{ ok: boolean, finalText: string, error?: string, throttled?: boolean }>}
 */
export async function translateStream(stdin, { onStatus, onFinal, maxRetries = Infinity, onMaxRetries }) {
  let lastUpdateAt = 0;
  let lastTextSent = '';
  const finalChunks = [];
  let finalText = '';
  let errorText = null;
  let currentStatus = '💭 thinking…';
  let retryCount = 0;
  let throttled = false;

  const send = async (text, force = false) => {
    if (text === lastTextSent && !force) return;
    const now = Date.now();
    if (!force && now - lastUpdateAt < THROTTLE_MS) return;
    try {
      await onStatus(text);
      lastUpdateAt = now;
      lastTextSent = text;
    } catch (_) {
      // Swallow status update errors so the stream keeps flowing.
      // The final update is what matters.
    }
  };

  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });

  // Send the initial "thinking" status immediately
  await send(currentStatus, true);

  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }

    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          currentStatus = '💭 starting up…';
          await send(currentStatus);
        } else if (ev.subtype === 'api_retry') {
          // Anthropic throttled us — show progress so the user knows we're
          // not silently dead. Force the update through the throttle.
          retryCount++;
          const attempt = ev.attempt || retryCount;
          const status = ev.error_status || ev.error || 'unknown';
          currentStatus = `⏳ Anthropic throttled (${status}) — retry ${attempt}`;
          await send(currentStatus, true);

          // Bail out if we've exceeded our local cap. Continuing past this
          // point just deepens the cooldown without helping.
          if (retryCount >= maxRetries) {
            throttled = true;
            errorText = `Anthropic is overloaded (${status}). Bailed after ${retryCount} retries — try again in a minute or two.`;
            if (onMaxRetries) {
              try { onMaxRetries(); } catch (_) {}
            }
            rl.close();
          }
        }
        break;

      case 'assistant': {
        const content = ev.message?.content || [];
        for (const block of content) {
          if (block.type === 'text') {
            const txt = (block.text || '').trim();
            if (txt) {
              finalChunks.push(txt);
              currentStatus = `✍️ ${shorten(txt, 80)}`;
              await send(currentStatus);
            }
          } else if (block.type === 'tool_use') {
            currentStatus = describeToolUse(block.name, block.input || {});
            await send(currentStatus);
          }
        }
        break;
      }

      case 'user':
        // tool_result event — append a tick to current status to indicate
        // the tool returned. The next event will overwrite this.
        await send(`${currentStatus} ✓`);
        break;

      case 'result':
        if (ev.is_error) {
          errorText = ev.result || '(unknown error)';
        } else {
          finalText = (ev.result || '').trim();
        }
        // The result event marks the end of the stream
        rl.close();
        break;

      case 'rate_limit_event': {
        const info = ev.rate_limit_info || {};
        if (info.status && info.status !== 'allowed') {
          currentStatus = `⚠️ rate limited (${info.status})`;
          await send(currentStatus, true);
        }
        break;
      }

      default:
        break;
    }
  }

  // Compose the final text
  let final;
  if (errorText) {
    final = `⚠️ ${shorten(errorText, 500)}`;
  } else if (finalText) {
    final = finalText;
  } else if (finalChunks.length) {
    final = finalChunks.join('\n').trim();
  } else {
    final = '_(no output)_';
  }

  try {
    await onFinal(final);
  } catch (_) {
    // Final update failure is logged by the caller
  }

  return { ok: !errorText, finalText: final, error: errorText || undefined, throttled };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function shorten(s, n = 80) {
  s = (s || '').replace(/\n/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function describeToolUse(name, input) {
  if (name === 'Bash') {
    const cmd = input.command || '';
    const slackMatch = cmd.match(/\.\/slack-tools\.sh\s+(\S+)/);
    if (slackMatch) return `⚡ Slack ${slackMatch[1]}`;
    if (cmd.startsWith('curl')) {
      const urlMatch = cmd.match(/https?:\/\/[^\s'"]+/);
      const host = urlMatch ? urlMatch[0].replace(/^https?:\/\//, '').split('/')[0] : '';
      return host ? `🌐 curl ${host}` : '🌐 curl';
    }
    if (cmd.startsWith('sudo ')) {
      const rest = cmd.replace(/^sudos+-us+S+s+/, ''); return `⚡ ${shorten(rest, 60)}`;
    }
    if (cmd.includes('./bin/browser-tools.sh')) {
      const m = cmd.match(/\.\/browser-tools\.sh\s+(\S+)/);
      return m ? `🌐 browser ${m[1]}` : '🌐 browser';
    }
    return `⚡ ${shorten(cmd, 60)}`;
  }
  if (name === 'Read') {
    const p = input.file_path || '';
    return `📖 reading ${path.basename(p) || p}`;
  }
  if (name === 'Write') {
    const p = input.file_path || '';
    return `✏️ writing ${path.basename(p) || p}`;
  }
  if (name === 'Edit') {
    const p = input.file_path || '';
    return `✏️ editing ${path.basename(p) || p}`;
  }
  if (name === 'Glob') return `🔎 glob ${input.pattern || ''}`;
  if (name === 'Grep') return `🔎 grep ${shorten(input.pattern || '', 40)}`;
  if (name === 'WebFetch') return `🌐 fetching ${shorten(input.url || '', 60)}`;
  if (name === 'WebSearch') return `🔎 searching ${shorten(input.query || '', 50)}`;
  if (name === 'Task') {
    const subagent = input.subagent_type || 'agent';
    return `🤖 spawn ${subagent}`;
  }
  return `🔧 ${name}`;
}
