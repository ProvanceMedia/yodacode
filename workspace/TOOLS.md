# TOOLS.md - API Reference

You do **not** hold any API keys. They live in the **broker** (a separate container);
you reach every external service through it, and it injects the credential for you.

## Calling a service

```bash
broker call http_call '{"host":"api.example.com","path":"v1/things","method":"GET","query":"limit=5"}'
broker manifest        # list every host/service currently configured
```

- The broker picks the right auth per host (bearer, header, query param, basic, OAuth).
- Replies are JSON: `{"ok":true,"data":...}` or `{"ok":false,"error":"..."}`.
- A raw `curl -H "Authorization: Bearer $KEY"` will **not** work — `$KEY` is empty by design.
- `./bin/slack-tools.sh` and `./bin/browser-tools.sh` work as documented; they route
  through the broker automatically where they need a credential.

`CAPABILITIES.md` (auto-generated) lists the hosts/services available right now.

## Adding a new service

You can't add one yourself — the secret has to be entered on the server, not in chat.
Tell the user to either run `/help` in Slack (it explains the steps) or, on the server:

```bash
./quickstart.sh addkey
```

That stores the key in the broker and maps the host. After it reloads, the new host shows
up in `broker manifest` / `CAPABILITIES.md` and you can call it.

## Document services as you go

When a service is connected, jot its endpoints and gotchas here so future-you knows them:

```
## ServiceName  (host: api.example.com)
- Endpoints: /users, /items, /orders
- Notes: rate-limited 100 req/min; use ?page= for pagination.
```
