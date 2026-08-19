# Claude Code or ChatGPT Codex

Your assistant runs on one or the other. Claude Code, on a Claude subscription.
Or ChatGPT Codex, on a ChatGPT one. Pick whichever you already pay for. Neither
adds API billing.

The installer asks which. You can change your mind later:

```bash
yodacode change llm codex     # or: yodacode change llm claude
```

## What you need

| | Claude Code | ChatGPT Codex |
|---|---|---|
| Subscription | Claude Pro or Max | ChatGPT Plus or Pro |
| Signing in | paste a token into the installer | enter a code at `auth.openai.com/codex/device` |
| Signing in again | about once a year | only if the sign-in breaks |

## What's different on Codex

**It can't tell you when you're running low.** Claude Code warns you when it hits
a limit, so the bot says so in the thread. Codex sends nothing of the sort, so
the first sign of trouble is a turn that fails.

**The sign-in can be broken, and there are two ways to do it.** Normally it looks
after itself: the token lasts about ten days and Codex renews it on the first
turn after it expires, so you never notice.

It only survives while one install is using it, though. Each refresh kills the
previous token, so two installs sharing one sign-in lock each other out. Give
each install its own. And never run `codex logout`, which revokes the sign-in at
OpenAI's end and turns a problem that fixes itself into one that doesn't.

If it does break, `yodacode doctor` tells you, and this fixes it:

```bash
yodacode change llm codex
```

Let the command do it rather than running `codex login` yourself. It has to run
as the same user your assistant runs as, and that's easy to get wrong by hand.

**No automatic retry when OpenAI is busy.** On Claude Code, a turn that hits an
overloaded model quietly retries on a smaller one and you never notice. Codex
doesn't tell us when it's overloaded, so a busy spell means a failed turn.

**Threads pick up better.** One in Codex's favour. Its conversation threads have
stable ids, so resuming one is more reliable than on Claude Code.

## Switching later

```bash
yodacode change llm codex
```

It checks the sign-in for the one you're moving to first, and offers to do it
there and then. So you can switch even when the subscription you're leaving has
already run dry.

**Conversations start fresh.** A thread belongs to whichever agent started it,
so open threads begin again after a switch. Nothing is deleted. Switch back and
they carry on where they left off.

**Memory, skills and settings stay put.** They're files in your workspace. They
don't care which agent reads them.

**Scheduled tasks might need one edit.** See below.

## Scheduled tasks and models

Every task in `cron-tasks/` says what it runs on:

```yaml
model: balanced        # fast | balanced | deep
```

Those three work on either agent. Each one decides what "balanced" means for
itself:

| tier | Claude Code | ChatGPT Codex |
|---|---|---|
| `fast` | Haiku | GPT-5.6-Luna, fast and cheap |
| `balanced` | Sonnet 5 | GPT-5.6-Terra, everyday work |
| `deep` | Opus 5 | GPT-5.6-Sol, the frontier model |

Use tiers and your tasks survive a switch untouched.

You can name an exact model instead, like `claude-sonnet-5` or `gpt-5.6-sol`.
That's fine, and sometimes exactly what you want. It does pin the task to one
agent. If you switch, `yodacode change llm` lists every task that would break
and asks before going ahead. Any task you leave pinned refuses to run and says
why, rather than failing quietly at 3am.

## If something looks wrong

```bash
yodacode doctor
```

It checks the agent you're actually running: whether the sign-in still works,
how long the current token has, and whether your assistant's personality files
all loaded.

That last one matters more than it sounds. On Codex the personality gets
assembled into a single file, and if part of it goes missing the only symptom is
an assistant that sounds oddly generic.
