# OAuth providers

`yodacode connect` signs the bot into services that use browser-based OAuth instead of
pasteable API keys. Guides per provider:

- **[Google](google.md)** — Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs, YouTube.

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
  broker vault. The agent container never sees it.
- **One sign-in per provider.** A provider entry holds one refresh token covering all
  its connected services (desktop-app OAuth has no incremental consent). Grant
  metadata — account, services, access tiers — is recorded in
  `workspace/broker/oauth-grants.json` (readable, not writable, by the agent).
- **Renewal is one command.** When a token dies (revocation, password change,
  testing-mode expiry), broker calls fail with an actionable message and
  `yodacode connect <provider> --renew` redoes just the sign-in (~2 minutes).
  `yodacode doctor` live-checks every connected provider.

## Adding a new provider to the catalog

A provider entry needs: `authUrl`, `tokenUrl`, three vault key names, services with
hosts + `scopeTiers`, and (ideally) a cheap read-only `testPath` per service. Two hard
requirements:

1. **Refresh tokens must not rotate on use.** The broker mounts `.env` read-only and
   cannot persist a replacement token — providers that rotate (e.g. Strava) will break
   after the first refresh and are deliberately unsupported.
2. **The auth-code flow must work with a loopback redirect URI** (or an equivalent
   paste-back flow), since the server is headless.

PRs welcome — copy the `google` entry's shape.
