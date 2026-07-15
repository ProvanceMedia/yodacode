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
  secrets at 24 months; a public client has no such clock). Its one piece of config is
  a `http://localhost` redirect URI, which is what makes it a public client.
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
4. **Add the redirect URI** — the step people miss: Manage → **Authentication** →
   **Add a platform** → **Mobile and desktop applications** → under *Custom redirect
   URIs* enter `http://localhost` → **Save**.

   > **Get the platform right.** Choosing **Web** registers the app as a *confidential*
   > client, and the sign-in then fails at the very last step — after you've approved
   > and pasted — with `AADSTS7000218: The request body must contain … 'client_secret'`.
   > **Single-page application** fails too (`AADSTS9002327`): a SPA redirect may only be
   > redeemed from a browser, and your server isn't one. It must be *Mobile and desktop
   > applications*. (The port doesn't matter — Microsoft ignores it when matching
   > `localhost`, so registering `http://localhost` covers the `http://localhost:8765`
   > the wizard actually asks for.)
5. **Leave "Allow public client flows" alone** (Authentication → Advanced settings; it
   defaults to **No**). It's only needed for flows that send no redirect URI, and
   leaving it off is a *feature*: it stops this app ever being signed in with the
   device-code flow that Microsoft now blocks by default (see *Why a browser sign-in*).
6. **Work/school tenants only — maybe:** many organizations block user self-consent
   for mail-reading and calendar scopes. If the consent screen says approval is
   required: App registrations → your app → **API permissions** → add the delegated
   Microsoft Graph permissions you'll use → **Grant admin consent**. In your own
   business tenant you *are* the admin — one click. In an employer's tenant, that
   button belongs to IT. Personal accounts self-consent to everything and skip this.

## The sign-in itself

The server has no browser, so the wizard prints a link:

1. **Have the terminal ready first** — see the warning below. Open the link **on your
   laptop**, pick the account, and approve.
2. After approving, the browser tries to load `http://localhost:8765/...` and fails
   with *"This site can't be reached"* — **that is expected** (nothing is listening;
   that address only exists to carry the code back). Copy the **entire URL from the
   address bar** and paste it into the wizard.

   > **You have about 60 seconds.** Microsoft sign-in codes expire roughly a minute
   > after you approve — Google's last ten. The clock starts when you click Accept, not
   > when the link is printed, so the copy-and-paste itself is comfortable (~10
   > seconds) *provided you're already sitting at the prompt*. Don't email the link to
   > yourself, don't open it on your phone, and don't wander off during MFA. If it does
   > expire you lose nothing: the wizard prints a fresh link and you try again.

The wizard exchanges the code on the server, shows you **which account** signed in,
test-calls each service, and only then stores anything.

### Why a browser sign-in and not a device code?

Earlier versions used Microsoft's device-code flow (type a short code at
`microsoft.com/devicelogin`). Microsoft is retiring it for exactly this audience: a
Microsoft-*managed* Conditional Access policy, **"Block device code flow"**, is
auto-created in eligible tenants (including Microsoft 365 Business Premium) in
report-only, then **switched on automatically after ~45 days** unless an admin opts
out. Their reasoning: *"Device code flow is rarely used by customers, but is
frequently used by attackers."*

Worse, device-code sessions are *protocol-tracked*, and that state survives token
refreshes — so when the policy flips, even a long-working connection dies permanently
(`AADSTS530036`) with no fix but a fresh sign-in. Authorization-code + PKCE is not
affected, needs no client secret either, and is what every desktop app uses. Hence the
switch.

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
(e.g. sign-in frequency limits). When that happens:

- The bot's Microsoft calls fail with *"authorization has expired or been revoked"*
  and it will tell you the fix.
- Run **`yodacode connect microsoft --renew`** on the server: no Entra steps, just the
  link-and-paste sign-in again. ~2 minutes.
- `yodacode doctor` live-checks every connected provider.

**Upgrading from a device-code sign-in?** If your connection predates the switch to the
browser flow it still works — until your tenant enables the device-code block, at which
point it dies with `AADSTS530036` and no amount of retrying helps. Two Entra changes fix
it permanently, because the old registration was built for a flow that needs no redirect:

1. **Add the redirect URI** (setup step 4) — without it the browser shows `AADSTS50011`
   and never hands back a code.
2. **Set "Allow public client flows" back to No** (step 5) — the old setup required it
   to be *Yes*. Turning it off is what stops this registration ever being used with the
   blocked flow again.

Then run `yodacode connect microsoft --renew`. The new sign-in isn't protocol-tracked,
so it survives the policy.

A quirk worth knowing (handled automatically): Microsoft **replaces the refresh token
on every refresh**. The broker persists each replacement in its private `broker-state/`
volume — nothing for you to manage, but it's why that volume exists.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `AADSTS7000218` (mentions `client_secret`/`client_assertion`) — fails *after* you approve and paste | Your redirect URI is registered under the **Web** platform, so Entra treats the app as confidential. Delete it and re-add `http://localhost` under **Mobile and desktop applications** (step 4). |
| `AADSTS50011` / *redirect URI mismatch* — fails **in the browser**, nothing to paste | `http://localhost` isn't registered at all. Add the platform per step 4. |
| `AADSTS9002327` (SPA redirect / cross-origin) | The redirect URI is registered under **Single-page application**; a SPA code can only be redeemed from a browser. Re-add it under **Mobile and desktop applications** (step 4). |
| *"the sign-in code expired"* | Microsoft codes last ~**60 seconds** from when you approve. The wizard prints a fresh link — this time have the terminal open beside the browser and paste straight away. |
| `AADSTS530036` (refresh token invalid, auth-flow checks) | An old **device-code** sign-in that your tenant now blocks. Add the redirect URI (step 4), then `yodacode connect microsoft --renew`. |
| `AADSTS53003` (blocked by Conditional Access) | An org policy blocks this sign-in. If it's the device-code block, the browser flow avoids it; otherwise talk to IT. |
| `AADSTS50194` (single-tenant app, `/common` not supported) | The app was registered single-tenant. Easiest: re-register with "any org + personal accounts" (step 2). |
| `AADSTS9002331` (configured for Microsoft Account users only) | The app was registered personal-only; same fix — re-register with the recommended account types. |
| Consent screen says "Need admin approval" | Your org blocks self-consent for these scopes — see step 6 (admin consent), or ask IT. |
| Sign-in works but dies every few days (work account) | A Conditional Access sign-in-frequency policy is forcing re-auth. Renewing works, but the policy wins — talk to IT. |
| Signed in as the wrong account | The wizard asks Microsoft for an account picker, but a browser already signed into another Microsoft account can still catch you out. The wizard shows which account it got and asks before storing — say no and re-run. |
| Bot says it has read-only access but you need more | Re-run `yodacode connect microsoft` and pick the higher tier for that service. |

## Security notes

- There is **no client secret**: the app is a public client, which is Microsoft's
  sanctioned shape for desktop/native apps. Entra infers that from the *Mobile and
  desktop applications* redirect URI, which is why the "Allow public client flows"
  toggle stays off. The security boundary is the **refresh token**, which lives only in
  the broker vault (plus its rotated successors in the broker-only `broker-state/`
  volume; the agent container never sees either).
- The sign-in link carries a one-time `state` nonce and a **PKCE** challenge bound to
  that terminal session, both held only in the wizard's process memory — a pasted
  redirect from anywhere else is rejected, and the code is useless without the verifier.
- The bot can *request* a Microsoft connection (it writes a small pending file naming
  the provider + services), but the catalog in this repo decides every endpoint and
  scope, and only a human at the server terminal can approve and complete a sign-in.
