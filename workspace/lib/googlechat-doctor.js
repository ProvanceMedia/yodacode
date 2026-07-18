// Live health check for the Google Chat surface, run by `yodacode doctor` inside
// the agent container (which holds the SA key + google-auth-library). It proves
// the two things that silently break Chat delivery: the service-account key is
// valid, and the Pub/Sub subscription is actually reachable. Importing config.js
// also runs the key/subscription validation (which exits 2 on a malformed value).
//
// Non-destructive: any message pulled to prove access is released immediately
// (ackDeadline 0) and never acked, so no real message is consumed or delayed.
//
// Exit 0 = healthy. Exit 1 with a one-line reason on stdout = unhealthy.
import { config } from './config.js';

const PUBSUB = 'https://pubsub.googleapis.com/v1';

async function main() {
  const sub = config.googlechat.subscription; // validated shape (or process.exit(2))
  const key = config.googlechat.serviceAccountKey; // validated fields (or process.exit(2))

  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/pubsub'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) {
    console.log('could not mint a Pub/Sub token from the service-account key');
    process.exit(1);
  }

  const res = await fetch(`${PUBSUB}/${sub}:pull`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxMessages: 1, returnImmediately: true }),
  });
  const txt = await res.text();
  if (!res.ok) {
    let reason = `subscription pull failed: HTTP ${res.status}`;
    try { reason += ` — ${JSON.parse(txt)?.error?.message || ''}`; } catch { /* keep status only */ }
    console.log(reason.trim().slice(0, 200));
    process.exit(1);
  }

  // Release anything we happened to lease so no real message is delayed.
  let data = {};
  try { data = JSON.parse(txt); } catch { /* empty pull */ }
  const ackIds = (data.receivedMessages || []).map((m) => m.ackId).filter(Boolean);
  if (ackIds.length) {
    await fetch(`${PUBSUB}/${sub}:modifyAckDeadline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ackIds, ackDeadlineSeconds: 0 }),
    }).catch(() => {});
  }
  console.log('ok');
  process.exit(0);
}

main().catch((e) => {
  console.log(`googlechat check error: ${e.message}`);
  process.exit(1);
});
