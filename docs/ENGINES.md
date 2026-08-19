# Choosing which AI runs your assistant

YodaCode runs on **Claude Code** or on **ChatGPT Codex**. Both use a subscription you
may already pay for, so neither adds API billing. You pick one during setup and
can change your mind later:

```bash
yodacode change llm codex     # or: yodacode change llm claude
```

Claude is the default and the better-tested path. Codex exists so that people
who pay for ChatGPT rather than Claude can run the same assistant.

## What you need

| | Claude | Codex |
|---|---|---|
| Subscription | Claude Pro or Max | ChatGPT Plus or Pro |
| Signing in | copy a token into the installer | enter a code at `auth.openai.com/codex/device` |
| Signing in again | about once a year | only if the sign-in chain breaks |

## What's different on Codex

Everything below is a real difference, not a caveat we're obliged to print.

**You share your own ChatGPT quota with the assistant.** Every turn it takes
counts against the same allowance as your own ChatGPT use, and turns are not
cheap — a trivial one costs around 50,000 tokens before it does anything,
because the instructions it carries are large. The assistant also **can't see
how much you have left**, so it can't warn you before you run out.

**The sign-in renews itself, but it can break.** The access token lasts about ten
days and Codex refreshes it automatically — the first turn after it expires does
the renewal inline and carries on. You don't need to do anything.

What *does* need you is the renewal chain breaking. That happens if the sign-in
is revoked, or if two installs share one credential: each refresh invalidates the
previous token, so two agents refreshing the same sign-in kill it for both. Give
each install its own. And **never run `codex logout`** — it revokes the sign-in
at OpenAI's end, turning a self-healing situation into one that needs a new
sign-in.

If it does break, `yodacode doctor` says so, and this fixes it:

```bash
yodacode change llm codex
```

(It has to run as the same user the assistant runs as, which is why it is worth
letting the command do it rather than calling `codex login` yourself.)

**No automatic retry when OpenAI is busy.** On Claude, a turn that hits an
overloaded model quietly retries on a smaller one and you never notice. Codex
doesn't tell us it's overloaded, so a busy period is a failed turn instead.

**Conversation threads survive better.** This one's in Codex's favour: its
threads have stable identifiers, so resuming a conversation is more reliable
than on Claude.

## Switching later

```bash
yodacode change llm codex
```

It checks the target's sign-in first and offers to do it there and then, so you
can switch even when your current subscription has already run out.

**Your conversations start fresh.** A thread belongs to the AI that was running
when it began, so existing threads begin again after a switch. Nothing is
deleted, though — switch back and they pick up exactly where they were.

**Your memory, skills and settings are untouched.** Those are files in your
workspace and have nothing to do with which AI reads them.

**Scheduled tasks may need one edit.** See below.

## Scheduled tasks and models

A task in `cron-tasks/` says what it runs on:

```yaml
model: balanced        # fast | balanced | deep
```

Those three work on either AI — each one decides what "balanced" means for
itself:

| tier | on Claude Code | on ChatGPT Codex |
|---|---|---|
| `fast` | Haiku | GPT-5.6-Luna — fast and affordable |
| `balanced` | Sonnet 5 | GPT-5.6-Terra — everyday work |
| `deep` | Opus 5 | GPT-5.6-Sol — the frontier model |

Use them and your tasks survive a switch untouched.

You can name an exact model instead (`claude-sonnet-5`, `gpt-5.5`), which
pins that task to one AI. That's fine, and sometimes what you want. But if you
switch, `yodacode change llm` lists every task that would break and asks before
going ahead — and any task you leave pinned refuses to run with an explanation
rather than failing quietly overnight.

## If something looks wrong

```bash
yodacode doctor
```

It checks the AI you're actually running: whether the sign-in still works, how
long it has left, and whether your assistant's personality files all loaded.
That last one matters more than it sounds — on Codex the personality is
assembled into a single file, and if part of it goes missing the only symptom is
an assistant that sounds oddly generic.
