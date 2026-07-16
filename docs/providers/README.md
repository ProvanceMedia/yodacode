# OAuth providers

`yodacode connect` signs the bot into services that use browser-based OAuth instead of
pasteable API keys. Guides per provider:

- **[Google](google.md)** — Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs, YouTube.
- **[Microsoft 365](microsoft.md)** — Outlook Mail, Calendar, OneDrive, Excel, Contacts, Teams meetings.

## How it works (any provider)

- **Bring your own OAuth client.** You create the app registration in the provider's
  console; your data flows only between your server and the provider. YodaCode never
  operates a shared OAuth app — for restricted data (like Gmail) a shared app would put
  a third party in your token path and require heavyweight security audits.
- **The catalog is the trust anchor.** `scripts/service-catalog.json` defines each
  provider's endpoints, vault key names, services and scope tiers. The bot can request
  a connection (provider + service names only); it can never inject a scope, an
  endpoint, or a key name.
- **Consent happens on your laptop, exchange on the server.** The wizard prints a
  sign-in link (with a one-time state nonce + PKCE); you approve in your own browser
  and paste the redirect back. The refresh token is written only to `.env` — the
  broker vault. (Providers that rotate refresh tokens get their replacements persisted
  in the broker's private `broker-state/` dir.) The agent container never sees either.
- **One sign-in per provider.** A provider entry holds one refresh token covering all
  its connected services (desktop-app OAuth has no incremental consent). Grant
  metadata — account, services, access tiers — is recorded in
  `workspace/broker/oauth-grants.json` (readable, not writable, by the agent).
- **Renewal is one command.** When a token dies (revocation, password change,
  testing-mode expiry), broker calls fail with an actionable message and
  `yodacode connect <provider> --renew` redoes just the sign-in (~2 minutes).
  `yodacode doctor` live-checks every connected provider.

## Adding a new provider to the catalog

A provider entry needs: `tokenUrl`, the vault key names (`clientSecretKey` only if the
provider issues a secret — public clients omit it and the broker omits `client_secret`
from refresh calls), services with hosts + `scopeTiers`, and (ideally) a cheap
read-only `testPath` per service. The sign-in flow is the catalog's choice:

- `flow: "auth-code"` (default) — needs `authUrl`; the wizard prints a consent link
  (state + PKCE) and the user pastes the dead loopback redirect back. Optional
  `signInNotes` lines show provider-specific guidance during the sign-in, and
  `publishCheck: true` enables the consent-screen-publish interrogation (Google's
  Testing-status footgun).
- `flow: "device-code"` — needs `deviceCodeUrl`; the wizard shows a short code to
  enter at the provider's verification URL and polls until approved. No redirect
  URI, nothing to paste.

Notes:

1. **Rotating refresh tokens are handled — if the old token survives rotation.**
   Providers that replace the refresh token on every refresh but leave the previous
   one valid until its own expiry (Microsoft et al) work: the broker persists each
   replacement in its private state dir (`broker-state/` — a broker-only volume in
   containers, root-only on bare metal; never visible to the agent) and prefers it
   over the `.env` value for as long as it descends from the same sign-in.
   `yodacode connect <provider> --renew` writes a fresh token to `.env`, which always
   wins. Providers that REVOKE the old token the moment it is used (e.g. Strava)
   remain unsupported: one crash or failed write between refresh and persist and the
   chain is unrecoverable.
2. **The sign-in must work from a headless server** — the wizard supports the
   loopback-redirect paste-back flow (`auth-code`, used by Google and Microsoft) and
   the device-code flow. Prefer `auth-code` unless the provider treats device code as
   first-class: Microsoft, for one, is blocking device code by default in managed
   tenants, and device-code sessions there are tainted permanently. Check whether the
   provider is deprecating it before choosing.

PRs welcome — copy the `google` entry's shape.
