# The outbound-action gate

## The problem it solves

The broker stops the agent from *leaking* your keys. It does nothing about the agent *using*
them — that's the whole point of the broker, after all. So the remaining question is: what
stops the agent sending something it shouldn't?

Until now, one sentence in `SOUL.md`: *"When in doubt, ask before acting externally."*

That is a rule written in the same place the attacker's text lands. A poisoned web page, a
crafted email, an instruction buried in a PDF the agent was asked to read — any of them sit in
the same context window as the rule, with equal standing. And even with no attacker involved, a
model 60 tool-calls deep into a task, with its early context compacted away, is a model that has
genuinely forgotten it was ever told to ask.

Prompting cannot fix this, for the same reason it couldn't fix credential leakage. The fix has
to live somewhere the agent cannot reach.

## How it works

The gate is a `PreToolUse` hook (`workspace/lib/hooks.js`) passed to the Agent SDK by the
supervisor. Hooks run **in the supervisor process**, not in the model's context window. That
gives three properties prompting can't:

- It costs zero tokens.
- It survives compaction — there is no "early context" for it to fall out of.
- Nothing the model reads can argue with it. It isn't persuadable, because it isn't a model.

Every `Bash` command the agent runs is classified before it executes. The classifier looks for:

| Pattern | Verdict |
|---|---|
| `broker call slack_post` / `slack_upload` / `ssh_exec` | always external |
| `broker call http_call` with `POST`/`PUT`/`PATCH`/`DELETE` | external (a `GET` is not) |
| `broker call slack_api` | external unless the method is a known read |
| `broker call <named-service>` | external if its verb or its name says so |
| `slack-tools.sh post` / `reply` / `update` / `upload` | external |
| everything else | local — never gated |

The classifier is deliberately **conservative**: when a call's verb can't be determined it counts
as external. A false positive costs one clarifying question. A false negative sends something
that can't be unsent.

## What counts as authorisation

Asking for an outbound action **is** the authorisation. "Email Bob the summary" does not need a
second yes — that would be maddening, and a gate people disable is a gate that protects nobody.

A turn is authorised when the human's message either asks for an outbound action or plainly
assents to one ("yes", "go ahead", "send it"). Cron tasks are always authorised: an operator
wrote the task file and scheduled it, which is a standing instruction with no human in the loop
to ask.

What is left over is exactly the case worth stopping: **an external action nobody asked for.** A
background watch waking up and deciding to message someone. An agent that read a web page and
came back with a new idea about who to email. A subagent doing it on the main thread's behalf —
subagents get no exemption.

When the gate blocks a call, the model receives the denial as a tool result telling it to ask in
chat instead. It adapts and asks. Nothing crashes, and the turn continues normally.

## Modes

Set `YODA_CONFIRM_EXTERNAL` in `.env`:

| Mode | Behaviour |
|---|---|
| `audit` | **(default)** Log every external attempt to `state/external-calls.jsonl`. Block nothing. |
| `confirm` | Block unauthorised external actions. The agent asks instead. |
| `off` | No hooks at all. |

It ships as `audit` on purpose: upgrading YodaCode should never silently change what your bot
will do.

Audit mode is a **dry run**, not just a log. Every entry carries `wouldBlock` — whether `confirm`
mode would have stopped that call — alongside `blocked`, which is what actually happened. So you
can see the effect of turning the gate on before you turn it on.

```bash
# Everything the agent has sent, uploaded or run remotely:
jq -r 'select(.event=="attempt") | "\(.at)  \(.kind)  \(.detail)"' \
  workspace/state/external-calls.jsonl | tail -40

# The preview that matters — what 'confirm' WOULD have stopped:
jq -r 'select(.event=="attempt" and .wouldBlock) | "\(.at)  \(.kind)  \(.detail)"' \
  workspace/state/external-calls.jsonl
```

If that second list is empty after a week of normal use, `confirm` costs you nothing — switch it
on. If it's full of things you did want sent, the classifier or the authorisation heuristic needs
tuning first; open an issue with the lines (they contain no message content, only what was called).

The log records both the attempt and its outcome, so it doubles as an audit trail of everything
your agent has sent — which the reconstructed `state/tool-runs.json` never reliably captured,
since it missed anything that aborted mid-run.

## The other two hooks

The same module installs:

- **`PostToolUse`** — records the outcome of each external call, completing the audit pair.
- **`PreCompact`** — writes a checkpoint to `memory/` just before the context window is
  summarised, capturing the session id and the path to the full pre-summary transcript. This is
  the runtime doing automatically what `AGENTS.md` asks the agent to remember to do by hand.

Together with the *"When summarizing this conversation"* section in `CLAUDE.md` — which tells the
compactor what must survive — these are why `YODA_SESSION_ROTATE_TOKENS` now defaults to `0`.
Long threads compact and carry on, instead of being dropped wholesale at 120k tokens.

## Why this isn't in `.claude/settings.json`

Because it wouldn't survive. `yoda.js` regenerates `workspace/.claude/settings.json` from
`YODA_SANDBOX` on **every boot**. Hooks are passed as a code option in
`workspace/lib/agent-query.js` instead, where nothing rewrites them — and where the agent, which
can edit files in its own workspace, cannot edit them either.
