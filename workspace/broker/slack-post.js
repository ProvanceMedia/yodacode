// slack_post — host-side Slack posting for the de-rooted agent. The agent gives a
// channel + text; the broker posts via chat.postMessage using SLACK_BOT_TOKEN from the
// vault. The token never reaches the agent. Replaces `./bin/slack-tools.sh post` in
// brokered/de-rooted contexts (that script needs the raw token in its env).
import { getSecret } from './vault.js';
import { doFetch } from './http-fetch.js';

export async function slackPost(args) {
  const channel = String(args.channel ?? '').trim();
  const text = String(args.text ?? '');
  if (!channel || !text) return { ok: false, error: 'both channel and text are required' };
  const token = getSecret('SLACK_BOT_TOKEN');
  if (!token) return { ok: false, error: 'vault has no SLACK_BOT_TOKEN' };

  const url = new URL('https://slack.com/api/chat.postMessage');
  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text, ...(args.thread_ts ? { thread_ts: String(args.thread_ts) } : {}) }),
  };
  const res = await doFetch(url, init, 15_000);
  // Slack returns HTTP 200 even on logical failure — surface its own ok/error field.
  if (res.ok && res.data && typeof res.data === 'object') {
    if (res.data.ok) return { ok: true, data: { ts: res.data.ts, channel: res.data.channel } };
    return { ok: false, error: `slack: ${res.data.error ?? 'unknown error'}` };
  }
  return res;
}

export const slackPostDef = {
  name: 'slack_post',
  description:
    'Post a message to a Slack channel or DM. The broker uses the bot token for you (you never see it). Params: channel (C…/G…/D… id), text (Slack mrkdwn), thread_ts (optional, to reply in a thread).',
  params: {
    channel: { type: 'string', description: 'Slack channel id (C…/G…) or DM id (D…)' },
    text: { type: 'string', description: 'message text in Slack mrkdwn' },
    thread_ts: { type: 'string', description: 'optional parent ts to thread under', optional: true },
  },
};
