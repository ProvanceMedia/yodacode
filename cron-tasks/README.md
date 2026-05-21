# Yoda cron tasks

Two ways to define a scheduled task:

1. **Declarative YAML** (`<task-name>.yaml`) — recommended.
   The shared runner (`workspace/bin/cron-runner.js`) reads the YAML and handles
   env loading, claude invocation, model flags, logging, optional Slack delivery,
   and skill/memory reflection. One file = one task.
2. **Shell script** (`<task-name>.sh`) — legacy.
   Each script duplicates ~60 lines of boilerplate. Still works, kept for now
   so existing systemd timers don't break during the migration.

## Adding a task (the YAML way)

```bash
cp _template.yaml my-task.yaml
# edit my-task.yaml: name, prompt, on_calendar, allowed_tools, optional deliver block
./gen-units.sh my-task
# follow the printed sudo commands to install the .service + .timer and enable
```

That's it. The runner does the rest.

## YAML schema

See `_template.yaml` for the full annotated example. Required fields:

- `name` — must match the filename (without `.yaml`)
- `prompt` — multi-line task description (use YAML `|` literal block)

Optional:

- `description` — human one-liner
- `on_calendar` — systemd OnCalendar syntax. Used by `gen-units.sh` to build the .timer.
- `model` — **required.** Every cron yaml must name its model explicitly. No implicit defaults, so you can `head -8 <task>.yaml` and immediately see what it runs on. Common: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`.
- `allowed_tools` — list of Claude tool names. Default sensible.
- `timeout` — seconds, default 600.
- `thinking` — enable extended thinking, default false.
- `deliver` — optional auto-delivery block. If present, the runner posts the output:
  ```yaml
  deliver:
    surface: slack
    channel: C0ALZ3KBN5A
    format: "*{{name}}* — {{today}}\n\n{{output}}"  # optional
  ```
- `reflect` — opt-in skill + memory reflectors. Honours `YODA_SKILL_REFLECTOR_ENABLED` / `YODA_MEMORY_REFLECTOR_ENABLED`. Librarian tasks (`memory-consolidate`, `skill-review`) auto-skip reflection to avoid recursion.

Substitution in prompts and format strings:
- `{{today}}` / `{{date}}` → ISO date
- `{{name}}` → task name
- `{{output}}` → claude's output (deliver.format only)
- `${ENV_VAR}` → env var value

## Migration from .sh to .yaml

Existing `.sh` files still work. To migrate one:

1. Write `<task>.yaml` alongside the existing `<task>.sh`. Extract the heredoc PROMPT into `prompt: |`.
2. `./gen-units.sh <task>` generates the new timer.
3. Switch systemd:
   ```bash
   sudo systemctl disable --now yoda-<task>.timer
   sudo cp systemd/yoda-cron@.service systemd/yoda-cron@<task>.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now yoda-cron@<task>.timer
   ```
4. Watch `logs/<task>.log` for one or two runs to confirm it works.
5. Once confident, delete the old `<task>.sh`.

## Layout

```
cron-tasks/
├── README.md                     ← this file
├── _template.yaml                ← annotated template for new tasks
├── _template.sh                  ← legacy bash template
├── <task>.yaml                   ← declarative task definitions
├── <task>.sh                     ← legacy bash crons (being migrated)
├── lib/
│   └── reflect-after.sh          ← shared helper (still used by legacy .sh crons)
├── systemd/
│   ├── yoda-cron@.service        ← one shared service template
│   └── yoda-cron@<task>.timer    ← generated per task by gen-units.sh
└── gen-units.sh                  ← generate timer files from YAML
```

## Why two formats?

The YAML runner is the standard going forward. The `.sh` files exist only because migrating production crons is non-trivial — every `.sh` is battle-tested against real workflows, and swapping out the systemd timer mid-day is risky. As each `.sh` is migrated and proven, it's deleted.
