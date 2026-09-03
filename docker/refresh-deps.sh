#!/usr/bin/env bash
# Bring the workspace dependency volume up to date with the image.
#
# /app/workspace/node_modules is a named volume so that packages the agent
# installs for itself survive container recreation. Docker fills a NEW volume
# from the image, but an existing one keeps whatever it already had — so a
# dependency bump in package.json (a newer Agent SDK, say) was built into the
# image and then never reached a running install. Nothing said so; the agent
# just kept running the old tree.
#
# The image keeps a pristine copy of its own install at /opt/yodacode/node_modules
# with a stamp of the package.json it was built from. When the volume's stamp
# differs, the image's tree is copied OVER the volume's: framework packages come
# up to date, anything the agent added itself is left alone.
#
# Runs as root from the entrypoint, before privileges drop. Safe to run again:
# the stamp is written last, so an interrupted pass simply repeats next boot.
set -euo pipefail

STAGE=/opt/yodacode/node_modules
STAMP_SRC=/opt/yodacode/deps.stamp
NM="${YODA_NODE_MODULES:-/app/workspace/node_modules}"
OWNER="${YODA_DEPS_OWNER:-yoda:yodacode}"

# An image built before staging existed has nothing to refresh from.
[[ -d "$STAGE" && -s "$STAMP_SRC" ]] || exit 0

want="$(cat "$STAMP_SRC")"
have="$(cat "$NM/.yodacode-deps.stamp" 2>/dev/null || true)"
[[ "$want" == "$have" ]] && exit 0

echo "[entrypoint] workspace dependencies are older than the image — refreshing (packages the agent installed itself are kept)…"
mkdir -p "$NM"
cp -a "$STAGE"/. "$NM"/
# The copy arrives root-owned; the agent must be able to npm install on top of it.
chown -R "$OWNER" "$NM"/. 2>/dev/null || true
printf '%s\n' "$want" > "$NM/.yodacode-deps.stamp"
chown "$OWNER" "$NM/.yodacode-deps.stamp" 2>/dev/null || true
echo "[entrypoint] dependencies refreshed."
