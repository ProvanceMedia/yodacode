# Connecting Google (Gmail, Calendar, Drive, …)

`yodacode connect google` signs your bot into your Google account through a **Google
OAuth client that you create yourself**. That "bring your own client" model is the
ecosystem standard for self-hosted tools (n8n, Home Assistant, rclone all do it) and it
keeps the deal clean: your mail flows only between your server and Google — no third
party, no shared app, nothing for anyone else to verify or audit.

The wizard walks you through everything; this page is the same walkthrough with more
detail, plus troubleshooting.

## What you'll end up with

- A Google Cloud **project** (free) containing an **OAuth client** (type: *Desktop app*).
- The client ID + secret and one **refresh token** stored in `.env` — the broker's
  vault. The bot itself never sees any of them; it calls Google through the broker.
- One sign-in covering every Google service you selected (Gmail, Calendar, Drive…).

## The one-time Google Cloud setup (~10 minutes)

Do these in a browser on your laptop, signed in as the Google account you're connecting:

1. **Create a project**: <https://console.cloud.google.com/projectcreate> — any name
   (e.g. `yodacode`). Free; no billing account needed for these APIs.
2. **Enable the APIs** for the services you're connecting. The wizard prints a direct
   "enable" link per service (e.g. the Gmail API). One click each.
3. **Configure the consent screen**: <https://console.cloud.google.com/auth/branding> —
   if this is a fresh project you'll get a short wizard: app name (anything), your email,
   audience/user type **External**, your email again as developer contact.
4. **Publish the app** — the step people miss: <https://console.cloud.google.com/auth/audience>
   → click **Publish app** so the status reads **In production**.

   > **Why this matters:** while an app's status is *Testing*, Google expires every
   > sign-in after **7 days**. Your bot would break weekly. Publishing does NOT require
   > Google's verification review — an unverified, published app is fine for personal
   > use; the only cost is clicking through a warning once during sign-in.

   (On a Google Workspace account you can instead set the audience to **Internal**:
   no warning screen at all. Personal @gmail.com accounts can't use Internal.)
5. **Create the OAuth client**: <https://console.cloud.google.com/auth/clients> →
   *Create client* → application type **Desktop app**. Copy the **Client ID** (ends in
   `.apps.googleusercontent.com`) and the **Client secret** — the wizard asks for both.

## The sign-in itself

The server has no browser, so the wizard prints a link:

1. Open the link **on your laptop**, pick the account, and approve.
2. Google warns *"Google hasn't verified this app"* — expected: it's **your** app,
   created 2 minutes ago. Click **Advanced → Go to … (unsafe)** and continue.
3. After approving, the browser tries to load `http://127.0.0.1:8765/...` and fails
   with *"This site can't be reached"* — **also expected** (that address only means
   something on the machine the flow was designed for). Copy the **entire URL from the
   address bar** and paste it into the wizard.

The wizard exchanges that code for tokens on the server, shows you **which account**
signed in, test-calls each service, and only then stores anything.

## Choosing services and access levels

- One Google sign-in covers many services with **one** token. Google's desktop-app flow
  has no "add a scope later" — adding a service means redoing the (2-minute) sign-in.
  So when the wizard asks, tick everything you might want.
- Each service has plain-English access tiers (e.g. Gmail: *read-only* vs *read, send +
  organise*). The bot can see which tier it has (in its `CAPABILITIES.md`), so it won't
  try to send mail with a read-only grant.
- To **reduce** access or disconnect: revoke the app at
  <https://myaccount.google.com/permissions>, then re-run `yodacode connect google`
  if you want a narrower grant.

## When the sign-in dies

Google kills refresh tokens on: a consent screen left in **Testing** (7 days — see
above), **revocation** at myaccount.google.com, a **password change** (for accounts
with Gmail scopes granted), and ~6 months of disuse. When that happens:

- The bot's Google calls fail with *"authorization has expired or been revoked"* and it
  will tell you the fix.
- Run **`yodacode connect google --renew`** on the server: no Cloud-console steps, just
  the browser link + paste again. ~2 minutes.
- `yodacode doctor` checks every connected provider and diagnoses the 7-day pattern.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `redirect_uri_mismatch` during sign-in | The OAuth client isn't a **Desktop app** — create a new client with that type. |
| *"the code expired or was already used"* | Codes last ~10 min and work once. The wizard prints a fresh link — redo the browser step. |
| *"API not enabled in your Google Cloud project"* | Click the enable link the wizard printed, wait ~1 minute, re-run. |
| Sign-in dies every 7 days | Consent screen still in **Testing** — publish to **In production** (step 4), then `--renew`. |
| *"Google hasn't verified this app"* blocks you (no Advanced link) | Make sure you're signing in with the same account that owns the Cloud project, or add your account under Audience → test users. |
| Bot says it has read-only access but you need more | Re-run `yodacode connect google` and pick the higher tier for that service. |

## Security notes

- The client secret of a Desktop-type OAuth client is [not treated as confidential by
  Google](https://developers.google.com/identity/protocols/oauth2/native-app) — the
  security boundary is the **refresh token**, which lives only in the broker vault
  (`.env`, mounted read-only into the broker container; the agent container never sees it).
- The consent link the wizard prints contains a one-time state nonce and a PKCE
  challenge bound to that terminal session — a pasted redirect from anywhere else is
  rejected.
- The bot can *request* a Google connection (it writes a small pending file naming the
  provider + services), but the catalog in this repo decides every endpoint and scope,
  and only a human at the server terminal can approve and complete a sign-in.
