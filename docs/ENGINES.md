# Claude Code or ChatGPT Codex

Your assistant runs on one or the other. Claude Code, on a Claude subscription.
Or ChatGPT Codex, on a ChatGPT one. Pick whichever you already pay for. Neither
adds API billing.

The installer asks. You can change your mind later:

```bash
yodacode change llm codex     # or: yodacode change llm claude
```

## Side by side

| | Claude Code | ChatGPT Codex |
|---|---|---|
| **Subscription** | Claude Pro or Max | ChatGPT Plus or Pro |
| **Signing in** | paste a token into the installer | enter a code at `auth.openai.com/codex/device` |
| **Sign-in lasts** | about a year | about ten days, then renews itself |
| **Can the sign-in break?** | only if you revoke it | yes, if two installs share it or you run `codex logout` |
| **Says when it's rate limited** | yes, in the thread | no, the turn just fails |
| **Provider busy** | retries on a smaller model | the turn fails |
| **Delegating to subagents** | yes | yes |
| **Resuming a thread** | usually, but sessions can vanish | yes, thread ids are stable |
| **Reasoning effort** | `low` to `max` | `low` to `xhigh` |
| **fast / balanced / deep / extraDeep** | Haiku, Sonnet 5, Opus 5.5, Fable 5.1 | GPT-6 Luna, Sol, Astra, Astra at `xhigh` |
| **Your assistant's personality** | loaded from separate files | assembled into one file at startup |
| **Sessions stored in** | `~/.claude` | `~/.codex/sessions` |

Most of that you'll never notice. Four things are worth reading properly.

## Rate limits and retries

Claude Code tells us when it's being limited, so the bot says so in the thread.
It also retries on a smaller model when the provider is overloaded, which is why
you rarely notice a busy period.

Codex reports neither. No warning as you approach a limit, and a busy spell
means a failed turn rather than a slower one. So on Codex the first sign of
trouble is usually a turn that didn't work.

## The Codex sign-in

Normally it looks after itself. The token lasts about ten days and Codex renews
it on the first turn after it expires, so you never notice.

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

## Your assistant's personality

On Claude Code the personality files load individually. On Codex they get
assembled into one file when the container starts, because Codex reads a single
instructions file.

Worth knowing because if part of that assembly fails, nothing errors. Your
assistant just sounds oddly generic. `yodacode doctor` checks it every run.

## Scheduled tasks and models

Every task in `cron-tasks/` says what it runs on:

```yaml
model: balanced        # fast | balanced | deep | extraDeep
```

All four work on either agent, and each picks its own model for them, as in
the table above. Use tiers and your tasks survive a switch untouched.

`extraDeep` is Fable 5.1 on Claude. On Codex it uses GPT-6 Astra
at `xhigh` effort. In Slack, `/fable` asks with it. On some plans Fable
bills to usage credits instead of the allowance that comes with the plan, and a
scheduled task never stops to ask first. To check, open `/model` in Claude Code
on any machine signed in to the same account: if the Fable row says "Requires
usage credits", that's what `extraDeep` runs will spend.

You can name an exact model instead, like `claude-sonnet-5` or `gpt-6-astra`.
That's fine, and sometimes exactly what you want. It does pin the task to one
agent. If you switch, `yodacode change llm` lists every task that would break
and asks before going ahead. Any task you leave pinned refuses to run and says
why, rather than failing quietly at 3am.

## Model update checked on 2026-09-23

The latest Opus model is `claude-opus-5-5`, with a 1M-token context window
and 128K maximum output. Standard API pricing is $4 input / $20 output per
million tokens. See [Anthropic's model catalog](https://platform.claude.com/docs/en/models/overview).

The GPT-6 family has three models, each with a 1.05M-token context window and
128K maximum output. Standard API prices per million input / output tokens are
$0.10 / $0.50 for Luna, $2 / $10 for Sol, and $10 / $50 for Astra.
See the [official OpenAI model catalog](https://developers.openai.com/api/docs/models).
These API prices are a comparison, not the billing rates for YodaCode's
subscription-based CLI sessions; account access and allowances vary.

Codex defaults to `gpt-6-sol` when `YODA_CODEX_MODEL` is empty. Explicit model
settings and literal cron model names remain pinned. The regular tiers leave
effort to the model; Opus 5.5 defaults to `medium`. Codex `extraDeep` keeps
`xhigh`, which this adapter supports, even though the GPT-6 API also offers `max`.

Opus 5.5 requires Claude Code 2.1.280 or newer. YodaCode pins Agent SDK
0.3.281, which bundles Claude Code 2.1.281. Run `yodacode update` to rebuild
the container and refresh its dependency volume; updating a separate global
`claude` executable does not upgrade the SDK runtime.

Opus 5.5 requires adaptive thinking and rejects manual thinking budgets or
disabled thinking. GPT-6 reasoning with tools requires Responses. YodaCode
delegates those request formats to Claude Code and Codex rather than building
API requests itself. See the [Opus migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
and [GPT-6 migration guide](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart).
Local routing tests do not establish account access or end-to-end compatibility
with the installed CLI versions; validate a fresh and resumed turn on each
engine before deploying the update.

## Switching

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

**Scheduled tasks might need one edit**, as above.

## If something looks wrong

```bash
yodacode doctor
```

It checks the agent you're actually running: whether the sign-in works, how long
the current token has, and whether the personality files all loaded.
