// slack_api — generic Slack Web API proxy for the de-rooted agent. The agent names a
// method + params; the broker calls https://slack.com/api/<method> with the bot token
// from the vault. Gives bin/slack-tools.sh full functionality (fetch/react/upload/...)
// without the token ever reaching the agent. Parity note: the agent previously held
// this token outright, so an open method proxy is not a privilege increase — the
// token's own scopes are the limit. admin.* is refused as a cheap belt-and-brace.
import { getSecret } from './vault.js';
import { doFetch } from './http-fetch.js';

export async function slackApi(args) {
  const method = String(args.method ?? '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9._]*$/.test(method)) return { ok: false, error: 'bad method name' };
  if (method.startsWith('admin.')) return { ok: false, error: 'refused: admin.* methods are not proxied' };
  const token = getSecret('SLACK_BOT_TOKEN');
  if (!token) return { ok: false, error: 'vault has no SLACK_BOT_TOKEN' };

  let params = args.params;
  if (typeof params === 'string') {
    try {
      params = JSON.parse(params);
    } catch {
      return { ok: false, error: 'params must be a JSON object' };
    }
  }
  if (params == null) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'params must be a JSON object' };

  const http = String(args.http ?? 'POST').toUpperCase();
  let url;
  let init;
  if (http === 'GET') {
    url = new URL(`https://slack.com/api/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    init = { method: 'GET', headers: { Authorization: `Bearer ${token}` } };
  } else {
    url = new URL(`https://slack.com/api/${method}`);
    init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(params),
    };
  }
  const res = await doFetch(url, init, 30_000);
  // Slack returns HTTP 200 with {ok:false} on logical errors — pass its body through
  // either way; callers check the Slack-level `ok` themselves (matches raw curl).
  if (res.ok) return { ok: true, data: res.data };
  return res;
}

export const slackApiDef = {
  name: 'slack_api',
  description:
    'Call any Slack Web API method with the bot token injected host-side (you never see it). Params: method (e.g. conversations.history), params (JSON object), http (GET or POST, default POST). Returns the raw Slack JSON in data. Prefer slack_post for simple messages.',
  params: {
    method: { type: 'string', description: 'Slack API method, e.g. reactions.add' },
    params: { type: 'string', description: 'JSON object of arguments for the method' },
    http: { type: 'string', description: 'GET or POST (default POST)', optional: true },
  },
};
