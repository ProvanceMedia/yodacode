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

The secret itself is always entered on the **server** (never in chat) — but YOU do the
research and preparation, so the user only has to run one command and paste the key.

When the user wants a service connected ("connect my Notion", "can you check Stripe?"):

1. **Research how its API authenticates** — official docs only. You need: the bare API
   host (e.g. `api.notion.com`), the auth style, any always-required static headers
   (version headers!), and the dashboard URL where the user *creates* the key.
   The broker supports exactly these styles:
   - `bearer` — `Authorization: Bearer <key>`
   - `header` — `<headerName>: <key>` (raw value, NO prefix like `Token `)
   - `query` — `?<queryParam>=<key>`
   - `basic` — HTTP basic with the key as USERNAME; `basicPassword` is a fixed literal
     password, usually `""` (only for `scheme: "basic"`).
   If the service is OAuth-only, uses the key as the basic-auth *password*, or needs a
   prefixed token, it doesn't fit — say so honestly instead of forcing it.

2. **Write a pending key request** to `state/pending-keys/<service>.json` — relative to
   your workspace root (your working directory), i.e. the same tree as `bin/` and `TOOLS.md`.
   Create the directory if needed:

   ```json
   {
     "service": "Notion",
     "host": "api.notion.com",
     "scheme": "bearer",
     "headerName": "",
     "queryParam": "",
     "basicPassword": "",
     "extraHeaders": { "Notion-Version": "2022-06-28" },
     "keyName": "NOTION_API_KEY",
     "docsUrl": "https://www.notion.so/my-integrations",
     "keyHint": "New integration → copy the Internal Integration Secret",
     "testPath": "v1/users/me",
     "note": "Notion API"
   }
   ```

   - `testPath`: a cheap, read-only GET on that host that succeeds with a valid key
     (a `/me`, account, or list-models endpoint). Omit if none exists.
   - `keyName`: UPPER_SNAKE, **must start with a letter**, only `A–Z 0–9 _`, ≤64 chars
     (e.g. `NOTION_API_KEY`). A request that violates this is rejected silently, so get it right.
     It must be a NEW name unless the user *explicitly* asked to reuse an existing key. Never
     point an existing key name at a new host on your own initiative — the CLI treats that
     shape as a possible exfiltration attempt and challenges the user.
   - `headerName`/`queryParam`/`basicPassword`: include only the one your `scheme` needs;
     leave the others out or empty.
   - Never guess the host. If you couldn't verify it in the docs, say so.

3. **Tell the user what to do** — where to create the key (the `docsUrl`), then on the
   server: `yodacode addkey`, which shows what you prepared and asks them to paste the
   key at a hidden prompt. It validates everything, stores the key in the broker vault,
   reloads, and (when the service has a known test endpoint) test-calls it.

4. **Never ask for or accept the secret in chat.** If the user pastes a key into Slack,
   tell them to revoke it and create a fresh one — chat history keeps it forever.

5. **When they say it's done**: check `broker manifest`, make a real call, then document
   the service's endpoints below.

## Document services as you go

When a service is connected, jot its endpoints and gotchas here so future-you knows them:

```
## ServiceName  (host: api.example.com)
- Endpoints: /users, /items, /orders
- Notes: rate-limited 100 req/min; use ?page= for pagination.
```
