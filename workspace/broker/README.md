# Broker — optional host-side credential isolation

By default, YodaCode loads your API keys into the agent's environment and the agent calls
services with `curl`. That's simple, but it means the LLM-driven process *holds* every
secret — anything that can influence the agent (a prompt injection, a bad instruction) can
read them.

The **broker** is an opt-in mode that removes that exposure. A small root-owned daemon holds
the secrets and performs the authenticated calls; the agent runs as an unprivileged user with
**no keys in its environment** and no read access to the secret files. It asks the broker to
make calls and gets back only the response.

This is defence the agent can't talk its way around: it's an OS-level boundary (a separate
user + a socket), not a prompt rule. See `../../docs/BROKER.md` for the full setup.

## Pieces

- `brokerd.js` — the daemon. Runs as **root**, reads the vault (the project `.env` + any
  `$YODA_VAULT_FILE`), listens on a Unix socket (`$YODA_BROKER_SOCK`, default
  `/run/yodacode-broker.sock`, mode 0660, group `yodacode`).
- `../bin/broker` — the agent-facing CLI shim. Talks to the daemon over the socket.
- `auth-hosts.json` — one line per API host (`{scheme, vaultKey, …}`). Powers `http_call`.
  Copy `auth-hosts.example.json` to start.
- `services.policy.json` — (optional) richer templated services. Copy the `.example`.
- `vault.js http-call.js http-fetch.js auth-hosts.js oauth.js services.js slack-post.js
  slack-api.js exec-tools.js index.js framing.js` — the core.

## How the agent uses it (instead of `curl -H "Authorization: Bearer $SECRET"`)

```bash
broker call http_call '{"host":"api.github.com","path":"repos/OWNER/REPO/commits","query":"per_page=5"}'
broker call slack_post '{"channel":"C0123","text":"hello"}'
broker manifest        # list callable hosts/tools
broker status          # vault size, #hosts, #services
```

The broker looks the host up in `auth-hosts.json`, injects the matching vault secret
host-side, fetches, and returns only the response body. Adding an API = one line in
`auth-hosts.json` (plus the secret in `.env`).

## Built-in tools

| tool | what it does |
|---|---|
| `http_call` | authenticated HTTPS to any configured host (bearer/header/basic/query/oauth2) |
| `slack_post` | post a message with the bot token, injected host-side |
| `slack_api` | call any Slack Web API method (the token never reaches the agent) |
| `ssh_exec` | run a command on a host from `workspace/.ssh/config`, key held host-side |
| service tools | anything you define in `services.policy.json` |

## Safety properties

- **Fail-closed allowlist:** only hosts in `auth-hosts.json` are callable; everything else is
  refused with no key touched.
- **SSRF guard:** a configured host that resolves to a private/loopback/link-local/metadata
  address is refused.
- **Anthropic blocked:** `api.anthropic.com` is never callable via `http_call`.
- **No leak:** secrets are injected just before the outbound fetch and never logged or
  returned.

## Auth schemes

| scheme | how the secret is sent |
|---|---|
| `bearer` | `Authorization: Bearer <secret>` |
| `header` | `<headerName>: <secret>` |
| `basic`  | `Authorization: Basic base64(<secret>:<password>)` (password literal or `basicPasswordKey`) |
| `query`  | `?<queryParam>=<secret>` |
| `oauth2` | refresh-token → short-lived access token → `Bearer` (Google et al) |

## Local smoke test (no install)

```bash
cd workspace
YODA_BROKER_SOCK=/tmp/yb.sock node broker/brokerd.js &     # start daemon
YODA_BROKER_SOCK=/tmp/yb.sock node bin/broker status
YODA_BROKER_SOCK=/tmp/yb.sock node bin/broker call http_call '{"host":"api.github.com","path":"rate_limit"}'
```
