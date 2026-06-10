# Credential isolation (the broker)

## The problem it solves

By default, YodaCode loads your API keys into the agent's environment and the agent calls
services with `curl -H "Authorization: Bearer $KEY"`. That's simple and fine for a hobby bot —
but it means the LLM-driven process **holds every secret you've given it**. Anything that can
steer the agent (a prompt injection in an email it reads, a malicious web page, a confused
instruction) is one `cat .env` or `env` away from your keys.

You cannot fix this with prompting. A rule like "never reveal secrets" lives in the same place
the attacker's text lands. The only durable fix is to make the secrets **unreachable** — put
them in a different security context from the agent.

## The model

```
  ┌─────────────────────────┐         ┌──────────────────────────────┐
  │  agent  (yodacode-agent) │  socket │  broker  (root)              │
  │  - no API keys in env    │ ──────► │  - holds the vault (.env)    │
  │  - can't read .env/.ssh  │ ◄────── │  - injects creds, calls API  │
  │  - unprivileged user     │  result │  - returns only the response │
  └─────────────────────────┘         └──────────────────────────────┘
```

- The **agent** runs as an unprivileged user (`yodacode-agent`). Its environment is scrubbed to
  a non-secret allowlist; the secret files are `root:root 0600`, so it cannot read them. This is
  an OS boundary, not a prompt rule.
- The **broker** (`workspace/broker/brokerd.js`) runs as root, holds the secrets in memory, and
  exposes a few tools over a Unix socket. It performs the authenticated call and hands back just
  the response. The key never crosses the socket.
- The agent calls services with `broker call http_call '{"host":"…","path":"…"}'` instead of
  curl. Your existing helper scripts (`slack-tools.sh`, etc.) route through the broker
  automatically when no token is present, so most prompts/docs need no change.

This is the same pattern used by container-isolating agents (a host vault + an injecting proxy),
implemented for a plain host process: a separate user instead of a container.

## Enabling it

```bash
sudo scripts/setup-broker.sh      # creates the user, locks secrets, starts the broker
# add your hosts:
cp workspace/broker/auth-hosts.example.json workspace/broker/auth-hosts.json
$EDITOR workspace/broker/auth-hosts.json
sudo systemctl restart yodacode-brokerd   # reload after editing hosts
sudo systemctl restart yodacode           # agent now spawns de-rooted
```

`setup-broker.sh` sets `YODA_DEROOT=1` in `.env`. To roll back, set it to `0` and restart — the
agent runs exactly as it did before, with keys in its env. Nothing is destroyed.

## Configuring services

`workspace/broker/auth-hosts.json` — one line per host, the common case:

```json
{
  "api.github.com": { "scheme": "bearer", "vaultKey": "GITHUB_PAT" },
  "api.acme.com":   { "scheme": "header", "headerName": "X-API-Key", "vaultKey": "ACME_KEY" }
}
```

The secret named by `vaultKey` must exist in `.env` (or `$YODA_VAULT_FILE`). Schemes:
`bearer`, `header`, `basic`, `query`, `oauth2`. For anything more involved (two-secret Basic
auth, fixed paths) use `services.policy.json` — see the `.example` files in `workspace/broker/`.

## Built-in tools

| tool | use |
|---|---|
| `http_call` | authenticated HTTPS to any configured host |
| `slack_post` / `slack_api` | post / call any Slack method, bot token injected host-side |
| `ssh_exec` | run a command on a host in `workspace/.ssh/config`, key held host-side |

`broker manifest` lists them; `broker status` shows vault/host/service counts.

## What stays exposed (be honest)

- `CLAUDE_CODE_OAUTH_TOKEN` is in the agent's env — it's the model's own auth and must travel
  with the agent. It's short-lived and not a service credential.
- The broker is an authorization choke point, not a firewall: the agent can still call any host
  you've configured. Configure only what it needs.
- Secrets are plaintext in the broker's memory and in `.env` at `0600` (encrypt-at-rest is a
  later hardening, out of scope here).

## Cron jobs

Set `deroot: true` in a cron's YAML to run that job de-rooted too. Anything in the job's prompt
that used `curl -H "...$KEY"` should become a `broker call`. Jobs that need a host-side CLI with
its own credential store (e.g. a vendor CLI with a keyring) can keep a small root-side `pre_hook`
that prepares data for the de-rooted agent to consume.
