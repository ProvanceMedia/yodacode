# Credential isolation (the broker)

## The problem it solves

An LLM-driven agent that holds your API keys is one prompt injection away from leaking them. A
malicious email it reads, a poisoned web page, a confused instruction — any of these can turn
into `cat .env` or `env`. You cannot fix this with prompting, because the rule ("never reveal
secrets") lives in the same place the attacker's text lands. The only durable fix is to make the
secrets **unreachable** — put them in a different security context from the agent.

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
- The **agent** container runs the bot as an unprivileged user. Its environment contains only
  what the supervisor itself needs — the Slack tokens (for Socket Mode) and the model's own
  Claude OAuth token — and **none** of your service API keys. To call a service it asks the
  broker: `broker call http_call '{"host":"api.stripe.com","path":"v1/charges"}'`.
- The wall is the container boundary plus the key split, both enforced by the OS. A compromised
  agent can't read keys it doesn't have and can't reach the file they live in.

Your `bin/` helper scripts (`slack-tools.sh`, etc.) route through the broker automatically, so
most prompts and docs need no change.

> Honest scope: the agent container does hold the **Slack** bot token and the **Claude OAuth**
> token, because the supervisor needs them to run. The high-value service keys (money, CRM,
> cloud, data) are what the broker removes from the agent entirely. Hiding the Slack token too
> is possible with the bare-metal de-root path below (separate uid).

## Configuring services

`workspace/broker/auth-hosts.json` — one line per host, the common case:

```json
{
  "api.github.com": { "scheme": "bearer", "vaultKey": "GITHUB_PAT" },
  "api.acme.com":   { "scheme": "header", "headerName": "X-API-Key", "vaultKey": "ACME_KEY" }
}
```

The secret named by `vaultKey` must exist in `.env`. Schemes: `bearer`, `header`, `basic`,
`query`, `oauth2`. After editing, `docker compose restart broker`. For richer cases (two-secret
Basic auth, fixed paths) use `services.policy.json` — see the `.example` files in
`workspace/broker/`.

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
  hardening, out of scope here).

## Bare-metal alternative (no Docker)

If you run YodaCode as a host systemd install instead of containers, `sudo scripts/setup-broker.sh`
sets up the same isolation without Docker: it creates an unprivileged `yodacode-agent` user, locks
the secret files root-only, installs a `yodacode-brokerd` systemd service, and sets `YODA_DEROOT=1`
so the agent (and crons) spawn as that user with a scrubbed environment. This path additionally
hides the Slack token from the spawned agent (it runs as a separate uid). Roll back with
`YODA_DEROOT=0` and a restart. The mechanism lives in `workspace/lib/deroot.js`.
