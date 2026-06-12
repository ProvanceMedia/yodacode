# Yoda cron tasks

Scheduled tasks are defined as declarative YAML files. A shared runner
([`workspace/bin/cron-runner.js`](../workspace/bin/cron-runner.js)) reads the YAML and handles env
loading, claude invocation, model flag, logging, optional Slack delivery,
and optional skill/memory reflection. One file = one task.

## Adding a task

```bash
cp _template.yaml my-task.yaml
# edit my-task.yaml: name, prompt, model, on_calendar, optional deliver block
docker compose restart       # the in-container scheduler picks it up
```

That's it — the scheduler reads `on_calendar` and runs the task on time; the runner does the
rest. Delete or rename a file to disable it. (You can also just ask the bot to write one for you.)

## Running a task now (out of schedule)

Drop a trigger file and the scheduler fires the task immediately, exactly like a scheduled run:

```bash
touch workspace/state/cron-triggers/<task-name>     # from the install dir on the host
```

Or just ask the bot in Slack ("run the prospecting cron now") — it does the same thing from
inside the container. The scheduler picks triggers up within ~5 seconds and won't double-fire
a task that's already running.

## YAML schema

See [`_template.yaml`](_template.yaml) for the full annotated example. Required fields:

- `name` — must match the filename (without `.yaml`)
- `prompt` — multi-line task description (use YAML `|` literal block)
- `model` — every cron yaml must name its model explicitly. No implicit defaults, so you can `head -8 <task>.yaml` and immediately see what it runs on. Common: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`.

Optional:

- `description` — human one-liner
- `on_calendar` — when to run, in systemd OnCalendar syntax (e.g. `Mon-Fri 09:00`, `*-*-* 03:00`). The in-container scheduler translates it to a cron schedule.
- `allowed_tools` — list of Claude tool names. Default sensible.
- `timeout` — seconds, default 600.
- `thinking` — enable extended thinking, default false.
- `pre_hook` — bash command(s) to run *before* claude (useful for jitter sleeps, queue topups). Default timeout 3600s, override with `pre_hook_timeout: <seconds>`.
- `deliver` — optional auto-delivery block. If present, the runner posts the output:
  ```yaml
  deliver:
    surface: slack
    channel: C0123456789
    format: "*{{name}}* — {{today}}\n\n{{output}}"  # optional
  ```
- `reflect` — opt-in skill + memory reflectors. Honours `YODA_SKILL_REFLECTOR_ENABLED` / `YODA_MEMORY_REFLECTOR_ENABLED`. Librarian tasks (`memory-consolidate`, `skill-review`) auto-skip reflection to avoid recursion.

Substitution in prompts and `deliver.format`:
- `{{today}}` / `{{date}}` → ISO date
- `{{name}}` → task name
- `{{output}}` → claude's output (deliver.format only)
- `${ENV_VAR}` → env var value

## Examples

See [`examples/`](examples/) for two starter tasks:

- [`memory-consolidate.yaml`](examples/memory-consolidate.yaml) — nightly librarian over `MEMORY.md` (merge duplicates, promote large topics, prune stale entries)
- [`skill-review.yaml`](examples/skill-review.yaml) — nightly review of `workspace/skills/` (dedup, promote frequent ones to Core, archive stale)

Copy either into `cron-tasks/<name>.yaml`, tweak, and `docker compose restart`.

## Layout

```
cron-tasks/
├── README.md                          ← this file
├── _template.yaml                     ← annotated template for new tasks
├── <task>.yaml                        ← your task definitions
├── examples/                          ← starter task YAMLs (memory-consolidate, skill-review)
└── lib/
    └── reflect-after.sh               ← reflector helper (called by the runner)
```

The in-container scheduler (`workspace/bin/scheduler.js`) reads every `*.yaml` here on startup,
schedules it from `on_calendar`, and invokes `cron-runner.js` when it fires. No host systemd, no
manual wiring — add a file and restart.

> The `systemd/` templates and `gen-units.sh` are only for the legacy bare-metal host install;
> the container scheduler does not use them.
