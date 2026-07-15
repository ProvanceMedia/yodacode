# Connecting Microsoft 365 (Outlook Mail, Calendar, OneDrive, Contacts)

`yodacode connect microsoft` signs your bot into your Microsoft account through an
**app registration that you create yourself**. That "bring your own app" model is the
ecosystem standard for self-hosted tools and it keeps the deal clean: your mail flows
only between your server and Microsoft — no third party, no shared app, nothing for
anyone else to verify or audit.

The wizard walks you through everything; this page is the same walkthrough with more
detail, plus troubleshooting.

## What you'll end up with

- An **Entra ID app registration** (free) configured as a *public client* — there is
  **no client secret at all**, so nothing expires behind your back (Microsoft caps
  secrets at 24 months; a public client has no such clock).
- The Application (client) ID and one **refresh token** stored in the broker vault.
  The bot itself never sees them; it calls Microsoft Graph through the broker.
- One sign-in covering every Microsoft service you selected (Mail, Calendar,
  OneDrive, Contacts) — they all live on one API host, `graph.microsoft.com`.

## The one-time Entra setup (~5 minutes)

Do these in a browser on your laptop, signed in as the Microsoft account you're
connecting:

0. **Personal account (outlook.com / hotmail / live) only:** you need a tenant before
   you can register apps — signing straight into the Entra portal with a bare personal
   account lands in a shared context where app registration is blocked. Create a
   **free Azure account** at <https://azure.microsoft.com/free> (identity verification,
   but app registration itself is free forever); that provisions your own "Default
   Directory". Work/school accounts usually already have a tenant and skip this.
1. **Register the app**: <https://entra.microsoft.com> → Entra ID → App registrations
   → **New registration**. Name it anything (e.g. `yodacode`).
2. **Supported account types**: pick **"Accounts in any organizational directory and
   personal Microsoft accounts"** — the safest default; it works for both personal and
   work sign-ins. (If you pick single-tenant instead, see Troubleshooting before your
   first sign-in.)
3. **Copy the Application (client) ID** from the app's Overview page — a GUID; the
   wizard asks for it. **Do not create a client secret** — this flow doesn't use one.
4. **Allow public client flows** — the step people miss: Manage → **Authentication** →
   Advanced settings → set **"Allow public client flows"** to **Yes** → Save.

   > **Why this matters:** without it the sign-in fails with the deeply unhelpful
   > `AADSTS7000218: The request body must contain … 'client_secret'`. The wizard
   > maps that error to this toggle, but save yourself the round-trip.
5. **Work/school tenants only — maybe:** many organizations block user self-consent
   for mail-reading and calendar scopes. If the consent screen says approval is
   required: App registrations → your app → **API permissions** → add the delegated
   Microsoft Graph permissions you'll use → **Grant admin consent**. In your own
   business tenant you *are* the admin — one click. In an employer's tenant, that
   button belongs to IT. Personal accounts self-consent to everything and skip this.

## The sign-in itself

No links to copy and no redirect to paste — Microsoft's device-code flow was built for
headless machines:

1. The wizard prints a **verification URL** (`microsoft.com/devicelogin`) and a
   **short code**.
2. Open the URL on your laptop or phone, type the code, sign in, and approve the
   requested access. Personal accounts are asked to **sign in a second time** ("to
   transfer authentication state") — that's documented Microsoft behaviour, not a bug.
3. The wizard is polling in the background; the moment you approve, it exchanges the
   grant, shows you **which account** signed in, test-calls each service, and only
   then stores anything. Codes last ~15 minutes; the wizard mints a fresh one if
   needed.

## Choosing services and access levels

- One Microsoft sign-in covers all selected services with **one** token — tick
  everything you might want; adding a service later means redoing the (2-minute)
  sign-in.
- Each service has plain-English access tiers (e.g. Mail: *read-only* vs *read, send +
  organise*). The bot can see which tier it has (in its `CAPABILITIES.md`), so it
  won't try to send mail with a read-only grant.
- To **reduce** access or disconnect: revoke the app at
  <https://account.live.com/consent/Manage> (personal) or via My Apps / your admin
  (work), then re-run `yodacode connect microsoft` for a narrower grant.

## When the sign-in dies

Microsoft refresh tokens die on: **90+ days without use** (any bot activity resets the
clock — a scheduled `yodacode doctor` run is enough), a **password change or admin
reset**, **revocation**, and — on work/school tenants — **Conditional Access policies**
(sign-in frequency limits, or org rules that block the device-code flow outright).
When that happens:

- The bot's Microsoft calls fail with *"authorization has expired or been revoked"*
  and it will tell you the fix.
- Run **`yodacode connect microsoft --renew`** on the server: no Entra steps, just the
  code-entry sign-in again. ~2 minutes.
- `yodacode doctor` live-checks every connected provider.

A quirk worth knowing (handled automatically): Microsoft **replaces the refresh token
on every refresh**. The broker persists each replacement in its private `broker-state/`
volume — nothing for you to manage, but it's why that volume exists.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `AADSTS7000218` (mentions `client_secret`/`client_assertion`) | "Allow public client flows" is still **No** — Authentication → Advanced settings → Yes → Save, then re-run. |
| `AADSTS50194` (single-tenant app, `/common` not supported) | The app was registered single-tenant. Easiest: re-register with "any org + personal accounts" (step 2). |
| `AADSTS9002331` (configured for Microsoft Account users only) | The app was registered personal-only; same fix — re-register with the recommended account types. |
| Consent screen says "Need admin approval" | Your org blocks self-consent for these scopes — see step 5 (admin consent), or ask IT. |
| Sign-in works but dies every few days (work account) | A Conditional Access sign-in-frequency policy is forcing re-auth. Renewing works, but the policy wins — talk to IT. |
| *"the code expired"* | Device codes last ~15 minutes and the wizard was left waiting. It offers a fresh code — approve faster this time. |
| Bot says it has read-only access but you need more | Re-run `yodacode connect microsoft` and pick the higher tier for that service. |

## Security notes

- There is **no client secret**: the app is a public client, which is Microsoft's
  sanctioned shape for device-code apps. The security boundary is the **refresh
  token**, which lives only in the broker vault (plus its rotated successors in the
  broker-only `broker-state/` volume; the agent container never sees either).
- The device code binding the sign-in session is held only in the wizard's process
  memory and is never shown, logged, or written anywhere.
- The bot can *request* a Microsoft connection (it writes a small pending file naming
  the provider + services), but the catalog in this repo decides every endpoint and
  scope, and only a human at the server terminal can approve and complete a sign-in.
