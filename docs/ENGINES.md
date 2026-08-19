# Claude Code or ChatGPT Codex

Your assistant runs on one of two coding agents. Claude Code, on a Claude Pro or
Max subscription. Or ChatGPT Codex, on a ChatGPT Plus or Pro one. Both use a
subscription you probably already pay for, so neither adds API billing.

The installer asks which. You can change your mind later:

```bash
yodacode change llm codex     # or: yodacode change llm claude
```

Claude Code is the default and has more miles on it. Codex is there so people
who pay for ChatGPT can run the same assistant.

## What you need

| | Claude Code | ChatGPT Codex |
|---|---|---|
| Subscription | Claude Pro or Max | ChatGPT Plus or Pro |
| Signing in | paste a token into the installer | enter a code at `auth.openai.com/codex/device` |
| Signing in again | about once a year | only if the sign-in breaks |

## What's different on Codex

**Your assistant eats into your own ChatGPT allowance.** Same pot as your own
use. And it can't see what's left, so it can't warn you before you run out.

**The sign-in renews itself.** The token lasts about ten days. Codex refreshes
it on the first turn after it expires and carries on. Nothing for you to do.

It only breaks if something revokes it. Two installs sharing one sign-in will do
that, because each refresh kills the previous token, so both agents end up
locked out. Give each install its own. And never run `codex logout`. That
revokes the sign-in at OpenAI's end and turns a self-healing problem into a real
one.

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
