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
   host (e.g. `api.notion.com`; include the `:port` if the API uses a non-standard
   one, e.g. `api.example.com:8443` — name that same `host:port` in http_call later),
   the auth style, any always-required static headers
   (version headers!), and the dashboard URL where the user *creates* the key.
   The broker supports exactly these styles:
   - `bearer` — `Authorization: Bearer <key>`
   - `header` — `<headerName>: <key>` (raw value, NO prefix like `Token `)
   - `query` — `?<queryParam>=<key>`
   - `basic` — HTTP basic with the key as USERNAME; `basicPassword` is a fixed literal
     password, usually `""` (only for `scheme: "basic"`).
   If the service is OAuth-only (the user signs in with a browser instead of creating a
   key), see **Connecting an OAuth service** below. If it uses the key as the basic-auth
   *password* or needs a prefixed token, it doesn't fit — say so honestly instead of
   forcing it.

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
   the service's endpoints in `TOOLS.local.md` (see below).

## Connecting an OAuth service (Google, Microsoft 365)

Some services have no pasteable API key — the user signs in with a browser and the
broker holds the resulting tokens. Those are set up with **`yodacode connect`**. Your
job is only to prepare and explain; the sign-in always happens on the server plus the
user's own browser, never in chat.

Supported providers come from the built-in catalog. Currently:

- **google** — services `gmail`, `calendar`, `drive`, `contacts`, `tasks`, `sheets`,
  `docs`, `youtube`, `searchconsole`, `analytics` (GA4)
- **microsoft** — services `outlook-mail`, `ms-calendar`, `onedrive`, `ms-contacts`

For an OAuth service that is NOT in the catalog, say honestly that it isn't supported
yet — do not invent an auth flow or handle tokens in chat.

When the user asks ("connect my gmail", "connect my outlook"):

1. **Write a pending request** to `state/pending-keys/<provider>.json`:

   ```json
   { "kind": "oauth", "provider": "google", "services": ["gmail"], "note": "requested in Slack" }
   ```

   (or `"provider": "microsoft", "services": ["outlook-mail"]` etc.)

   - `provider` and every `services[]` entry must be catalog names (list above).
   - That is the whole schema. You cannot specify scopes, hosts, endpoints, or key
     names — the catalog owns the auth mechanics, and anything else is rejected.
   - Include every service the user plausibly wants: ONE sign-in per provider covers
     many services, and adding one later means redoing the sign-in.

2. **Tell the user** to run `yodacode connect` on the server. Set expectations: the
   first time includes a guided one-time setup in the provider's console (~10 minutes
   for Google Cloud, ~5 for Microsoft Entra — they create their own OAuth client,
   which keeps their data between them and the provider only); after that, changes
   take ~2 minutes.

3. **Hard boundaries**: never ask for or accept a client secret, authorization code,
   sign-in code, or redirect URL in chat — if one is pasted, tell the user to revoke
   the app's access in the provider's console (Google: myaccount.google.com/permissions;
   Microsoft: account.live.com/consent/Manage or their org's My Apps) and redo the
   flow on the server. You never see or relay the consent URL; the wizard mints it
   locally.

4. **When a provider call fails** with *"authorization has expired or been revoked —
   tell the user to run: yodacode connect <provider> --renew"*: relay that verbatim,
   with one line of context (sign-ins die on password changes and revocation; Google's
   also on a consent screen left in "Testing", Microsoft's on 90+ days of disuse or
   org Conditional Access policies). The renewal takes ~2 minutes. `yodacode doctor`
   also diagnoses this.

5. **Check the granted access level first**: `CAPABILITIES.md` lists each connected
   service's tier (e.g. Drive read-only). If you need more access, ask the user to
   re-run `yodacode connect <provider>` and pick the higher tier — don't discover
   scope limits by letting calls 403.

## Document services as you go — in TOOLS.local.md, not here

This file (`TOOLS.md`) is the shipped framework reference: it is **overwritten when
you update**, so do not write your own notes into it. Your notes on connected
services — endpoints, quirks, camera names, SSH details — belong in
**`TOOLS.local.md`**, which is yours and survives updates. It is loaded into your
context alongside this file, so anything you record there is always available.

When a service is connected, append its endpoints and gotchas to `TOOLS.local.md`.
