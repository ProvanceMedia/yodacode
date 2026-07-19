# Commitments — nothing falls through the cracks

Once a day, your bot reads your recent Slack, email, and Google Meet transcripts,
pulls out what you **promised people** (and what people promised **you**), preps the
follow-up emails as **drafts in your Gmail**, and DMs you one tidy digest.

It's built to draft, never send: follow-ups wait in your Gmail/Outlook drafts
for you to hit send, and Slack replies arrive as ready-to-paste suggestions.
You stay the sender. (See the honest note on enforcement under Privacy below.)

## Turn it on

```
yodacode commitments
```

Two questions (when the digest arrives, where to DM it) and it's live. For the
full sweep — email, meetings, and Gmail drafts — connect Google first:

```
yodacode connect google      # pick Gmail, Calendar, Drive, Docs
```

No Google connection? It still works, Slack-only.

## What a digest looks like

> ☀️ Commitments — 2026-07-19
> **You promised:**
> 1. Quote for Dave (email, due Friday) — draft's in your Gmail, just hit send
> 2. Intro Sarah → Tom (Slack) — suggested reply below
> **Waiting on others:**
> 3. Invoice from the printer (email, promised Tuesday) — chase draft in Gmail
>
> Reply "done 1", "dismiss 2", or "chase 3" and I'll keep the ledger straight.

Reply in that DM in plain words — "done 1", "dismiss 2", "what's still open?" —
and the bot updates the ledger.

## Where it looks

| Source | What it reads | Needs |
|---|---|---|
| Slack | Last 24h of channels + DMs the bot is in | nothing extra |
| Gmail | Last ~2 days of mail (in + out) | `yodacode connect google` (Gmail) |
| Outlook | Last ~2 days of mail (in + out) | `yodacode connect microsoft` (Outlook Mail) |
| Meetings | Google Meet transcript / Gemini-notes docs in your Drive | transcription turned on in the meeting, + Drive/Docs connected |

Drafts are created in whichever mailbox the conversation lives — Gmail replies
in Gmail's drafts, Outlook replies in Outlook's.

Meeting caveats: a transcript only exists if transcription (or Gemini's "take
notes for me") was on during the meeting, and it lands in the **organizer's**
Drive — so your own meetings are covered; other people's may not be. Teams
meeting transcripts aren't swept yet (they need a Graph permission the
Microsoft connection doesn't request today).

## The drafts sound like you — that's the point

The sweep reads how *you* write (your sent mail, your Slack messages) and drafts
in your voice: your greeting, your sign-off, your level of formality. Every
draft has to pass a simple test before it's saved — *would a human actually say
this, out loud, to this person?* No "I hope this email finds you well". No
"circling back". If a draft needs information you haven't given it, it asks the
natural question instead of inventing an answer.

## Tuning

The live task is your file — edit `cron-tasks/commitments.yaml`:

- **Schedule** — the `schedule:` line (standard cron syntax).
- **Model** — `claude-opus-4-8` by default for the best judgement and voice;
  switch to `claude-sonnet-4-6` to run cheaper.
- **Off** — delete the file, or set `disabled: true` in it.

Updates to yodacode never touch your live copy — the shipped template lives in
`cron-tasks/examples/` and only `yodacode commitments` copies it over (it asks
before overwriting).

## Privacy & cost

- Everything runs on your box, through your own connections. Conversation
  content isn't sent anywhere except to Claude for the sweep itself.
- One bounded run a day (default weekdays). On Opus with a busy inbox expect a
  few minutes of runtime per sweep; Sonnet is the cheaper option.
- **The honest note on enforcement:** "draft, never send" is how the sweep is
  built and instructed — but today it's enforced by those instructions, not by a
  hard technical wall. The Google/Microsoft grants that allow creating drafts
  can also send, and the sweep reads content other people wrote (email, shared
  channels), which is exactly where prompt-injection tricks live. The task's
  rules name the send endpoints as forbidden and the model is good at honouring
  that, but treat it as a strong default, not a guarantee. A broker-level
  policy that hard-blocks send endpoints for cron runs is on the roadmap; until
  then, if that risk doesn't sit right, connect Gmail with the read-only tier
  and take suggested text in the digest instead of drafts.
