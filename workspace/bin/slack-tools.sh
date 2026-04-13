#!/usr/bin/env bash
# Yoda Slack helper (multi-channel).
#
# Sub-commands:
#   whoami                       — print bot user id
#   list                         — print conversations (channels + IMs) bot is in (JSON)
#   fetch                        — print new messages across ALL conversations the bot
#                                   is in, since per-channel last-seen.json. Output is a
#                                   JSON object: {"conversations":[{"channel":..,"is_im":..,
#                                   "messages":[...]}, ...]}
#   post <channel> <text>        — post text as a top-level message in <channel>.
#                                   Returns Slack JSON; the new message ts is in `ts` field.
#   update <channel> <ts> <text> — edit an existing message you own (chat.update)
#   react <channel> <ts> <emoji> — add an emoji reaction (no leading colon)
#   unreact <channel> <ts> <emoji> — remove your emoji reaction
#   reply <channel> <thread_ts> <text> — post text as a reply in a thread
#   thread <channel> <thread_ts> — print full thread history (JSON)
#   mark <channel> <ts>          — write ts as last-seen for <channel>
#
# Reads SLACK_BOT_TOKEN from env. State file: ./state/last-seen.json
# (a JSON object mapping channel_id -> ts).

set -euo pipefail

STATE_FILE="${YODA_STATE_FILE:-./state/last-seen.json}"
API="https://slack.com/api"

if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  echo "ERROR: SLACK_BOT_TOKEN must be set" >&2
  exit 2
fi

# Ensure state file exists and is a JSON object
if [[ ! -s "$STATE_FILE" ]]; then
  mkdir -p "$(dirname "$STATE_FILE")"
  echo '{}' > "$STATE_FILE"
fi
# Migrate old single-channel format ({"last_ts": "..."}) to new map format
python3 - "$STATE_FILE" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
if "last_ts" in d and not any(k.startswith(("C","D","G")) for k in d):
    json.dump({}, open(p, "w"))
PY

call_post() {
  local method=$1 payload=$2
  curl -sS -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data "$payload" "$API/$method"
}

call_get() {
  local method=$1; shift
  curl -sS -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -G "$API/$method" "$@"
}

cmd_whoami() {
  call_get auth.test | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("user_id",""))'
}

cmd_list() {
  call_get users.conversations \
    --data-urlencode "types=im,public_channel,private_channel" \
    --data-urlencode "limit=200" \
    --data-urlencode "exclude_archived=true"
}

cmd_fetch() {
  python3 - "$STATE_FILE" "$SLACK_BOT_TOKEN" "$API" <<'PY'
import json, sys, urllib.request, urllib.parse

state_path, token, api = sys.argv[1], sys.argv[2], sys.argv[3]
state = json.load(open(state_path))

def slack_get(method, **params):
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{api}/{method}?{qs}",
                                 headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

convs = slack_get("users.conversations",
                  types="im,public_channel,private_channel",
                  limit=200,
                  exclude_archived="true")
out = {"conversations": []}
if not convs.get("ok"):
    out["error"] = convs.get("error", "unknown")
    print(json.dumps(out)); sys.exit(0)

for c in convs.get("channels", []):
    cid = c["id"]
    last = state.get(cid, "0")
    # Always pull the last 15 messages for conversation context, regardless
    # of last_seen. We then mark which are "new" (ts > last_seen) vs "context".
    hist = slack_get("conversations.history",
                     channel=cid,
                     limit=15)
    if not hist.get("ok"):
        out["conversations"].append({
            "channel": cid,
            "name": c.get("name") or ("im:" + c.get("user","?")),
            "is_im": bool(c.get("is_im")),
            "error": hist.get("error"),
        })
        continue
    msgs_all = list(reversed(hist.get("messages", [])))  # chronological
    has_new = any(m.get("ts","0") > last for m in msgs_all)
    if not has_new:
        continue  # nothing new in this conversation
    # Annotate each message with is_new flag
    for m in msgs_all:
        m["_is_new"] = m.get("ts","0") > last
    out["conversations"].append({
        "channel": cid,
        "name": c.get("name") or ("im:" + c.get("user","?")),
        "is_im": bool(c.get("is_im")),
        "last_seen_ts": last,
        "messages": msgs_all,
    })
print(json.dumps(out))
PY
}

cmd_post() {
  local channel=$1 text=$2
  local payload
  payload=$(python3 -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'text':sys.argv[2]}))" "$channel" "$text")
  call_post chat.postMessage "$payload"
}

cmd_reply() {
  local channel=$1 thread_ts=$2 text=$3
  local payload
  payload=$(python3 -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'thread_ts':sys.argv[2],'text':sys.argv[3]}))" "$channel" "$thread_ts" "$text")
  call_post chat.postMessage "$payload"
}

cmd_thread() {
  local channel=$1 thread_ts=$2
  call_get conversations.replies \
    --data-urlencode "channel=$channel" \
    --data-urlencode "ts=$thread_ts"
}

cmd_update() {
  local channel=$1 ts=$2 text=$3
  local payload
  payload=$(python3 -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'ts':sys.argv[2],'text':sys.argv[3]}))" "$channel" "$ts" "$text")
  call_post chat.update "$payload"
}

cmd_react() {
  local channel=$1 ts=$2 name=$3
  local payload
  payload=$(python3 -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'timestamp':sys.argv[2],'name':sys.argv[3]}))" "$channel" "$ts" "$name")
  call_post reactions.add "$payload"
}

cmd_unreact() {
  local channel=$1 ts=$2 name=$3
  local payload
  payload=$(python3 -c "import json,sys; print(json.dumps({'channel':sys.argv[1],'timestamp':sys.argv[2],'name':sys.argv[3]}))" "$channel" "$ts" "$name")
  call_post reactions.remove "$payload"
}


cmd_mark() {
  local channel=$1 ts=$2
  python3 - "$STATE_FILE" "$channel" "$ts" <<'PY'
import json, sys
p, ch, ts = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(p))
d[ch] = ts
json.dump(d, open(p, "w"))
PY
}

case "${1:-}" in
  whoami)         cmd_whoami ;;
  list)           cmd_list ;;
  fetch)          cmd_fetch ;;
  post)           shift; cmd_post "$1" "$2" ;;
  update)         shift; cmd_update "$1" "$2" "$3" ;;
  react)          shift; cmd_react "$1" "$2" "$3" ;;
  unreact)        shift; cmd_unreact "$1" "$2" "$3" ;;
  reply)          shift; cmd_reply "$1" "$2" "$3" ;;
  thread)         shift; cmd_thread "$1" "$2" ;;
  mark)           shift; cmd_mark "$1" "$2" ;;
  *) echo "usage: $0 {whoami|list|fetch|post|update|react|unreact|reply|thread|mark} ..." >&2; exit 1 ;;
esac
