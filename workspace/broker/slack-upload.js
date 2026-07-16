// slack_upload — deliver a file the agent generated (spreadsheet, image, PDF) to Slack.
// Slack retired files.upload (2025-11) for a 3-step flow: reserve an upload URL, POST
// the raw bytes to it, then completeUploadExternal to share it. The middle step targets
// files.slack.com (not slack.com/api) with NO auth header, so slack_api can't do it and
// http_call won't (that host isn't allowlisted) — hence a dedicated tool. The bot token
// is injected host-side (never reaches the agent); the agent passes the file base64 —
// the broker socket is text-only.
import { getSecret } from './vault.js';
import { doFetch, ssrfCheck } from './http-fetch.js';

const MAX_FILE_BYTES = 30 * 1024 * 1024; // generous for generated docs/images/charts

/** Decode + validate the agent-supplied base64 file body. Returns { bytes } or { error }. */
export function decodeUploadBody(contentBase64) {
  const b64 = String(contentBase64 ?? '').replace(/\s+/g, '');
  if (!b64) return { error: 'contentBase64 required (base64 of the file bytes)' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return { error: 'contentBase64 is not valid base64' };
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) return { error: 'contentBase64 decoded to nothing' };
  if (bytes.length > MAX_FILE_BYTES) return { error: `file too large (${bytes.length} bytes; max ${MAX_FILE_BYTES})` };
  return { bytes };
}

export async function slackUpload(args) {
  const token = getSecret('SLACK_BOT_TOKEN');
  if (!token) return { ok: false, error: 'vault has no SLACK_BOT_TOKEN' };

  const filename = String(args.filename ?? '').trim();
  if (!filename || /[/\\\x00-\x1f]/.test(filename)) return { ok: false, error: 'filename required (no slashes or control characters)' };

  const dec = decodeUploadBody(args.contentBase64);
  if (dec.error) return { ok: false, error: dec.error };
  const { bytes } = dec;
  const channel = String(args.channel ?? args.channel_id ?? '').trim();

  // Step 1 — reserve an upload URL. length MUST be the exact byte count we send.
  const r1 = await doFetch(new URL('https://slack.com/api/files.getUploadURLExternal'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ filename, length: String(bytes.length) }).toString(),
  }, 20_000);
  const d1 = r1.data;
  if (!r1.ok || !d1 || d1.ok !== true || !d1.upload_url || !d1.file_id) {
    return { ok: false, error: `getUploadURLExternal failed: ${d1?.error ?? r1.error ?? 'unknown'}` };
  }

  // Step 2 — POST the raw bytes to Slack's returned URL, NO auth header (it's pre-signed).
  // Pin the target to an https slack.com host and SSRF-check it: we only ever stream a
  // file to Slack's own infrastructure, never to an arbitrary address a tampered
  // response might name.
  let uploadUrl;
  try { uploadUrl = new URL(d1.upload_url); } catch { return { ok: false, error: 'Slack returned a malformed upload_url' }; }
  if (uploadUrl.protocol !== 'https:' || !/(^|\.)slack\.com$/.test(uploadUrl.hostname)) {
    return { ok: false, error: 'refused: upload_url is not an https slack.com host' };
  }
  const blocked = await ssrfCheck(uploadUrl.hostname);
  if (blocked) return { ok: false, error: `refused: ${blocked}` };
  const r2 = await doFetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  }, 75_000);
  if (!r2.ok) return { ok: false, error: `file byte upload failed: ${r2.error ?? 'unknown'}` };

  // Step 3 — finalize and share. `files` must be a JSON string in a form body.
  const fileEntry = { id: d1.file_id };
  if (args.title) fileEntry.title = String(args.title);
  const form3 = new URLSearchParams({ files: JSON.stringify([fileEntry]) });
  if (channel) form3.set('channel_id', channel);
  if (args.comment) form3.set('initial_comment', String(args.comment));
  if (args.thread_ts) form3.set('thread_ts', String(args.thread_ts));
  const r3 = await doFetch(new URL('https://slack.com/api/files.completeUploadExternal'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form3.toString(),
  }, 20_000);
  const d3 = r3.data;
  if (!r3.ok || !d3 || d3.ok !== true) {
    return { ok: false, error: `completeUploadExternal failed: ${d3?.error ?? r3.error ?? 'unknown'}` };
  }
  const file = Array.isArray(d3.files) ? d3.files[0] : undefined;
  return { ok: true, data: { file_id: d1.file_id, permalink: file?.permalink, file } };
}

export const slackUploadDef = {
  name: 'slack_upload',
  description:
    'Send a file to Slack — a spreadsheet, image, PDF or anything the agent generated. Slack has no simple upload call, so this does the whole flow host-side. Params: channel (channel or DM id to share into — the bot must be a member), filename (e.g. report.xlsx), contentBase64 (base64 of the raw file bytes, max ~30MB), title (optional), comment (optional message posted with the file), thread_ts (optional, to post it into a thread). Returns the file id and permalink.',
  params: {
    channel: { type: 'string', description: 'channel or DM id to share the file into, e.g. C0123ABC' },
    filename: { type: 'string', description: 'file name with extension, e.g. report.xlsx' },
    contentBase64: { type: 'string', description: 'base64 of the raw file bytes (max ~30MB)' },
    title: { type: 'string', description: 'optional file title', optional: true },
    comment: { type: 'string', description: 'optional message posted alongside the file', optional: true },
    thread_ts: { type: 'string', description: 'optional parent message ts to post the file into a thread', optional: true },
  },
};
