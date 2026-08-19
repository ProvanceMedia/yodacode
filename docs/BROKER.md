# Credential isolation (the broker)

## The problem it solves

An agent that holds your API keys is one prompt injection away from handing them over. A
malicious email it reads, a poisoned web page, a confused instruction: any of those can end up as
`cat .env`.

You can't fix that with prompting. The rule saying "never reveal secrets" sits in exactly the
same place the attacker's text lands. The only fix that holds is to put the secrets somewhere the
agent cannot reach at all.

YodaCode does that by default.

## The model (container, default)

`docker compose up` brings up two containers:

```
   ┌───────────────────────────┐        ┌──────────────────────────────┐
   │  agent container          │ socket │  broker container            │
   │  - the bot (yoda.js) +    │ ─────► │  - the ONLY place keys live  │
   │    in-container scheduler │ ◄───── │  - reads .env, holds vault   │
   │  - unprivileged user      │ result │  - injects creds, calls API  │
   │  - NO service API keys    │        │  - returns only the response │
   └───────────────────────────┘        └──────────────────────────────┘
```

- The **broker** container mounts `.env` read-only and holds the vault. It performs every
  authenticated call and returns just the response. Your service API keys (Stripe, GitHub,
  HubSpot, …) exist **only** here.
- The **agent** container runs the bot as an unprivileged user. Its environment holds only what
  the supervisor needs to work: the Slack tokens for Socket Mode, and the model's own sign-in
  token. **None** of your service API keys. To call a service it asks the broker:
  `broker call http_call '{"host":"api.stripe.com","path":"v1/charges"}'`.
- The wall is the container boundary plus the key split, both enforced by the OS. A compromised
  agent can't read keys it doesn't have and can't reach the file they live in.

Your `bin/` helper scripts (`slack-tools.sh`, etc.) route through the broker automatically, so
most prompts and docs need no change.

> To be straight about the limits: the agent container does hold the **Slack** bot token and the
> model's own sign-in token, because the supervisor can't run without them. What the broker takes
> away entirely are the keys that matter most, the ones for money, customers, cloud and data. The
> bare-metal de-root path below also hides the Slack token from the agent.

## Configuring services

Normally you use `yodacode addkey`. Ask the bot in chat to set a service up, and it researches
how the API authenticates and writes a pending request. Then run `addkey` on the server and paste
the key at a hidden prompt.

It checks the request before doing anything. It won't let the agent rewrite the auth mechanics of
a service it already knows, and if something tries to point an *existing* vault key at a new
host, it stops and makes you type the hostname yourself. That shape is what credential theft
looks like, so it's worth the extra step.

That guard only works if `auth-hosts.json` is writable by you and not by the agent. In the
container deployment that's enforced: `workspace/broker` is mounted read-only into the agent, so
an injected agent can't add a host-to-key mapping or fake the "already approved" state. Only
`addkey`, running on the host, can write there.

On a bare-metal (`YODA_DEROOT`) install there's no such mount, so make sure the broker's config
directory is owned by the broker user and not writable by the agent user.

Underneath, it keeps `workspace/broker/auth-hosts.json`, one line per host. You can edit it by
hand too:

```json
{
  "api.github.com": { "scheme": "bearer", "vaultKey": "GITHUB_PAT" },
  "api.acme.com":   { "scheme": "header", "headerName": "X-API-Key", "vaultKey": "ACME_KEY" }
}
```

The secret named by `vaultKey` must exist in `.env`. Schemes: `bearer`, `header`, `basic`,
`query`, `oauth2`. An optional `timeoutMs` per host (default 15000, capped at 300000)
gives a slow endpoint, say image generation or a large upload, a longer budget while every other
host stays on the tight 15 second leash. After editing, `docker compose restart broker`. `oauth2` entries
(providers like Google, where a refresh token buys an access token) are normally written by the
guided sign-in wizard, `yodacode connect`. See `docs/providers/`. It also records grant metadata
in `workspace/broker/oauth-grants.json`. For trickier cases, like two-secret Basic auth or fixed
paths, use `services.policy.json`. There are `.example` files in `workspace/broker/`.

## Built-in tools

| tool | use |
|---|---|
| `http_call` | authenticated HTTPS to any configured host |
| `slack_post` / `slack_api` | post / call any Slack method, bot token injected host-side |
| `ssh_exec` | run a command on a host in `workspace/.ssh/config`, key held host-side |

`broker manifest` lists them; `broker status` shows vault/host/service counts.

## What stays exposed (be honest)

- `CLAUDE_CODE_OAUTH_TOKEN` and the Slack tokens are in the agent container (the supervisor needs
  them). The model's OAuth token is short-lived and not a service credential.
- The broker is an authorization choke point, not a firewall: the agent can still call any host
  you've configured. Configure only what it needs.
- Secrets are plaintext in the broker's memory and in `.env` at rest (encrypt-at-rest is a later
  hardening, out of scope here). Same for `broker-state/` (rotated OAuth refresh tokens, for
  providers that replace the token on every refresh). That's a broker-only volume in containers,
  and root-only `0700` on bare metal. To disconnect a provider, remove its keys from `.env`. The
  broker prunes its rotated tokens on the next restart or reload.

## Bare-metal alternative (no Docker)

If you run YodaCode as a host systemd install instead of containers, `sudo scripts/setup-broker.sh`
sets up the same isolation without Docker: it creates an unprivileged `yodacode-agent` user, locks
the secret files root-only, installs a `yodacode-brokerd` systemd service, and sets `YODA_DEROOT=1`
so every agent run, whether a chat reply or a cron, gets a scrubbed environment with no secrets
in it and runs as the `yodacode-agent` user. The root-only file permissions then mean something:
service keys are reachable only through `broker call`, and the Slack token is hidden from the
agent as well. Roll back with `YODA_DEROOT=0` and a restart. The
mechanism lives in `workspace/lib/deroot.js` + `workspace/lib/agent-query.js`.

> Fail-safe: if `YODA_DEROOT=1` is set but the `yodacode-agent` user doesn't exist (e.g. a
> bare-metal `.env` reused inside the container), runs log an error and fall back to the legacy
> env rather than breaking. A non-root supervisor with the flag set gets the curated environment
> without the uid switch, since it is already unprivileged.
