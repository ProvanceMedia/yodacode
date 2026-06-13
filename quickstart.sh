#!/usr/bin/env bash
# YodaCode guided installer — fresh Linux server → running, personalised bot.
#
#   git clone https://github.com/ProvanceMedia/yodacode.git && cd yodacode
#   ./quickstart.sh
set -uo pipefail
cd "$(dirname "$0")"

# Shared palette, spinner, timezone resolver, .env helpers, and the
# persona/Slack setup flows (also used by the `yodacode` CLI).
source scripts/common.sh

step() { echo ""; echo -e "${C}${B}━━━ Step $1/6 · $2 ━━━${X}"; echo ""; }

# ── subcommand: addkey ────────────────────────────────────────────────────────
# Securely register a service API key with the broker. The secret value is read
# here on the server and written only to .env (mounted into the broker container);
# the agent never sees it. The host→key mapping goes into broker/auth-hosts.json.
if [[ "${1:-}" == "addkey" ]]; then
  echo ""
  echo -e "${C}${B}Add an API key${X}"
  echo "  Pick a service (the key stays on this server — the bot never sees it):"
  echo "    1) GitHub      2) Stripe      3) OpenAI"
  echo "    4) Anything else (you provide the host + scheme)"
  echo ""
  pick="$(ask 'Choice' '1')"
  HEADERNAME=""; QUERYPARAM=""; EXTRAHEADERS=""
  case "$pick" in
    1) HOST=api.github.com;  SCHEME=bearer; KEYNAME=GITHUB_PAT;     EXTRAHEADERS='{"Accept":"application/vnd.github+json","User-Agent":"yodacode"}' ;;
    2) HOST=api.stripe.com;  SCHEME=basic;  KEYNAME=STRIPE_API_KEY ;;
    3) HOST=api.openai.com;  SCHEME=bearer; KEYNAME=OPENAI_API_KEY ;;
    *) HOST="$(ask 'API host (e.g. api.example.com)' '')"
       echo "  Auth style:  1) Bearer token   2) custom header   3) ?query= param   4) HTTP basic"
       st="$(ask 'Style' '1')"
       case "$st" in
         2) SCHEME=header; HEADERNAME="$(ask 'Header name (e.g. X-API-Key)' 'X-API-Key')" ;;
         3) SCHEME=query;  QUERYPARAM="$(ask 'Query param name (e.g. api_key)' 'api_key')" ;;
         4) SCHEME=basic ;;
         *) SCHEME=bearer ;;
       esac
       KEYNAME="$(ask 'Name this key (UPPER_SNAKE, e.g. EXAMPLE_API_KEY)' 'EXAMPLE_API_KEY')"
       KEYNAME="$(echo "$KEYNAME" | tr '[:lower:] -' '[:upper:]__' | tr -cd 'A-Z0-9_')" ;;
  esac
  [[ -z "${HOST:-}" || -z "${KEYNAME:-}" ]] && { fail "Need a host and a key name."; exit 1; }
  echo ""
  read -r -s -p "  Paste the secret value for $KEYNAME (hidden): " SECRET; echo ""
  [[ -z "$SECRET" ]] && { fail "No value entered."; exit 1; }

  [[ -f "$ENVF" ]] || cp .env.example "$ENVF"; chmod 600 "$ENVF"
  set_env "$KEYNAME" "$SECRET"
  AH="workspace/broker/auth-hosts.json"
  [[ -f "$AH" ]] || echo '{}' > "$AH"
  # Edit the JSON with python3 (present on the host); the host has no node — that
  # lives in the container. Fall back to running node inside the container if needed.
  json_edit() {
    HOST="$HOST" SCHEME="$SCHEME" KEYNAME="$KEYNAME" HEADERNAME="$HEADERNAME" \
    QUERYPARAM="$QUERYPARAM" EXTRAHEADERS="$EXTRAHEADERS" python3 - "$AH" <<'PY'
import json, os, sys
f = sys.argv[1]
try:
    o = json.load(open(f))
except Exception:
    o = {}
e = {"scheme": os.environ["SCHEME"], "vaultKey": os.environ["KEYNAME"]}
if os.environ.get("HEADERNAME"): e["headerName"] = os.environ["HEADERNAME"]
if os.environ.get("QUERYPARAM"): e["queryParam"] = os.environ["QUERYPARAM"]
if os.environ["SCHEME"] == "basic": e["basicPassword"] = ""
if os.environ.get("EXTRAHEADERS"): e["extraHeaders"] = json.loads(os.environ["EXTRAHEADERS"])
o[os.environ["HOST"]] = e
json.dump(o, open(f, "w"), indent=2); open(f, "a").write("\n")
PY
  }
  if command -v python3 >/dev/null 2>&1; then
    json_edit || { fail "Failed to update auth-hosts.json"; exit 1; }
  else
    fail "python3 not found on this host and node lives only in the container."
    note "Install python3 ($SUDO apt-get install -y python3) and re-run, or add the host to $AH by hand."
    exit 1
  fi
  ok "Stored $KEYNAME and mapped $HOST (scheme: $SCHEME)."
  note "Reloading the broker…"
  docker compose restart broker >/dev/null 2>&1 || docker compose up -d >/dev/null 2>&1 || true
  ok "Done. Ask the bot to use $HOST."
  exit 0
fi

# Per-run log dir — fixed /tmp names collide with (and replay) a previous
# user's stale logs, and root-owned leftovers would break the redirects.
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/yodacode.XXXXXX")"

banner
echo "  This sets up your assistant from scratch — about 5 minutes. You'll need:"
echo "    • a Claude subscription (Max recommended) + a browser on your laptop/phone"
echo "    • the ability to add an app to your Slack workspace"
echo ""
read -r -p "  Press Enter to begin (Ctrl-C to quit) " _

# ── already configured? ───────────────────────────────────────────────────────
if [[ -f "$ENVF" ]] && grep -q '^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-' "$ENVF" 2>/dev/null \
   && grep -q '^SLACK_BOT_TOKEN=xoxb-' "$ENVF" 2>/dev/null && ! grep -q 'xoxb-your-bot-token' "$ENVF" 2>/dev/null; then
  ok "Found an existing setup ($(grep -m1 '^BOT_NAME=' "$ENVF" | cut -d= -f2-) for $(grep -m1 '^USER_NAME=' "$ENVF" | cut -d= -f2-))."
  a=$(ask "(S)tart it, or (R)econfigure from scratch?" "S")
  if [[ ! "${a,,}" =~ ^r ]]; then
    # Refresh the framework persona doc from the (possibly updated) template, keeping
    # the operator's name/context. TOOLS.md is static and CAPABILITIES.md regenerates
    # on boot, so this keeps a `git pull && start` fully up to date.
    bn="$(grep -m1 '^BOT_NAME=' "$ENVF" | cut -d= -f2-)"; un="$(grep -m1 '^USER_NAME=' "$ENVF" | cut -d= -f2-)"
    tz="$(grep -m1 '^TZ=' "$ENVF" | cut -d= -f2-)"
    [[ -f templates/CLAUDE.md.template ]] && sed -e "s/{{BOT_NAME}}/${bn:-Yoda}/g" -e "s/{{USER_NAME}}/${un:-friend}/g" -e "s|{{TIMEZONE}}|${tz:-UTC}|g" templates/CLAUDE.md.template > workspace/CLAUDE.md
    docker compose up -d --build && ok "Starting — watch with: docker compose logs -f agent"; exit $?
  fi
fi

# ── 1 · Docker ────────────────────────────────────────────────────────────────
step 1 "Docker"
wait_for_apt() {
  command -v fuser >/dev/null 2>&1 || return 0
  local locks="/var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock" waited=0
  while $SUDO fuser $locks >/dev/null 2>&1; do
    (( waited == 0 )) && warn "Server is finishing first-boot updates — waiting (normal on a new machine)…"
    sleep 5; waited=$((waited+5)); (( waited >= 600 )) && { fail "Still locked after 10 min — try again shortly."; return 1; }
  done; (( waited > 0 )) && ok "Updates finished."; return 0
}
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) already installed."
else
  [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1 && { fail "Needs root: sudo ./quickstart.sh"; exit 1; }
  wait_for_apt || exit 1; installed=0
  for a in 1 2; do
    # pipefail must be re-set inside bash -c (options don't inherit) — without
    # it a failed curl leaves sh reading EOF and "succeeding".
    spin "Installing Docker (runs the bot in an isolated container)…" "$LOGDIR/docker.log" \
      bash -c "set -o pipefail; curl -fsSL https://get.docker.com | $SUDO sh" && { installed=1; break; }
    (( a < 2 )) && { warn "Retry…"; sleep 10; wait_for_apt || break; }
  done
  [[ "$installed" == 1 ]] || { fail "Docker install failed — last lines:"; tail -5 "$LOGDIR/docker.log" 2>/dev/null | sed 's/^/    /'; note "Try manually: curl -fsSL https://get.docker.com | sh"; exit 1; }
  $SUDO systemctl enable --now docker 2>/dev/null || true; ok "Docker installed."
fi

# ── 2 · Build ─────────────────────────────────────────────────────────────────
step 2 "Building"
if spin "Building the image — may take a few minutes — grab a brew…" "$LOGDIR/build.log" docker compose build; then ok "Image built."; else
  fail "Build failed — last lines:"; tail -8 "$LOGDIR/build.log" | sed 's/^/    /'
  note "Low memory? add swap: fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"; exit 1
fi

# ── 3 · Claude sign-in ────────────────────────────────────────────────────────
step 3 "Sign in to Claude"
echo "  Runs on your Claude subscription — no API key, no extra billing."
echo -e "  A helper starts now and prints a ${B}URL${X}:"
echo -e "    1. open it in the browser on your ${B}laptop or phone${X}"
echo "    2. sign in to Claude and approve"
echo "    3. copy the code it gives you, paste it back here"
echo ""
read -r -p "  Press Enter to start sign-in… " _
docker compose run --rm --no-deps --entrypoint claude agent setup-token || true
echo ""
echo -e "  It printed a token starting ${B}sk-ant-oat01-${X}."
CLAUDE_TOKEN=""
for t in 1 2 3; do
  read -r -p "  Paste it here: " CLAUDE_TOKEN; CLAUDE_TOKEN="$(echo "$CLAUDE_TOKEN" | tr -d '[:space:]')"
  [[ "$CLAUDE_TOKEN" == sk-ant-oat01-* ]] && break
  fail "Should start with sk-ant-oat01- ($((3-t)) left)"; CLAUDE_TOKEN=""
done
[[ -n "$CLAUDE_TOKEN" ]] || { fail "No valid token. Re-run ./quickstart.sh."; exit 1; }
if spin "Checking your sign-in works…" "$LOGDIR/auth.log" docker compose run --rm --no-deps \
     -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN" -e ANTHROPIC_API_KEY= \
     --entrypoint claude agent -p "say OK" --output-format json \
   && grep -qE '"is_error"[ ]*:[ ]*false' "$LOGDIR/auth.log"; then
  ok "Signed in to Claude."; else warn "Couldn't verify just now — continuing (may still work)."; fi

# ── 4 · Personalise ───────────────────────────────────────────────────────────
step 4 "Personalise your assistant"
echo "  Let's give it a name and tell it who you are."
echo ""
configure_persona   # bot name, your name, context, timezone → renders persona docs

# ── 5 · Slack app ─────────────────────────────────────────────────────────────
step 5 "Create the Slack app"
configure_slack || { fail "Slack setup didn't complete. Re-run ./quickstart.sh."; exit 1; }   # member ID, manifest, tokens

# ── write config ──────────────────────────────────────────────────────────────
set_env CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_TOKEN"
ok "Configuration saved."

# ── 6 · Launch + smoke test ───────────────────────────────────────────────────
step 6 "Launch"
spin "Starting the containers…" "$LOGDIR/up.log" docker compose up -d || {
  fail "Start failed — last lines:"; tail -8 "$LOGDIR/up.log" 2>/dev/null | sed 's/^/    /'
  note "Full log: $LOGDIR/up.log — if containers started, also try: docker compose logs"; exit 1; }
if spin "Waiting for ${BOT_NAME} to connect to Slack…" "$LOGDIR/ready.log" bash -c \
  'for i in $(seq 1 30); do docker compose logs agent 2>/dev/null | grep -q "\"msg\":\"slack: ready\"" && exit 0; sleep 2; done; exit 1'; then
  ok "Connected to Slack."
else warn "No 'slack: ready' yet — check: docker compose logs -f agent"; fi

echo ""
note "Quick test — asking ${BOT_NAME} to say hello (proves Claude + the agent work):"
echo ""
reply=""
if spin "${BOT_NAME} is thinking…" "$LOGDIR/hello.log" bash -c 'docker compose exec -T agent claude -p "$1" 2>/dev/null' _ \
     "You are ${BOT_NAME}. In one short, friendly sentence, introduce yourself to ${USER_NAME} and say you're ready."; then
  reply="$(head -c 400 "$LOGDIR/hello.log" 2>/dev/null)"
fi
if [[ -n "$reply" ]]; then echo -e "  ${C}${B}${BOT_NAME}:${X} ${reply}"; ok "${BOT_NAME} is responding."; else warn "No reply from the test — check: docker compose logs agent"; fi

# Install the `yodacode` CLI so management commands work from anywhere.
install_cli_wrapper

echo ""
echo -e "  ${G}${B}🎉 ${BOT_NAME} is live.${X}  Open Slack and DM ${BOT_NAME} — say hello."
echo ""
echo "  Manage it with the ${B}yodacode${X} command (run ${B}yodacode help${X} for the full list):"
echo "    yodacode logs       # watch it think"
echo "    yodacode doctor     # check everything's healthy"
echo "    yodacode update     # pull the latest version and rebuild"
echo "    yodacode restart    # after changing settings"
echo ""
if [[ "${YC_WRAPPER_PATH_ADDED:-0}" == 1 ]]; then
  note "New command added to your PATH — run 'source ~/.bashrc' (or open a new shell) to use 'yodacode'."
  note "Until then: ./yodacode help"
fi
echo -e "  ${B}Add API keys any time:${X} run ${B}yodacode addkey${X}, or DM ${BOT_NAME} \`/yodacode\` in Slack."
echo "  Keys live in a separate broker container; ${BOT_NAME} itself never sees them."
