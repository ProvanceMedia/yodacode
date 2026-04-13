#!/usr/bin/env bash
# Yoda browser helper — thin shell wrapper around browser-tool.js (Playwright).
#
# Sub-commands (all output a single JSON line):
#   fetch <url>                       — render JS, return HTML
#   text <url>                        — render JS, return body innerText
#   screenshot <url> <out.png>        — full-page screenshot
#   maps "<address>"                  — Google Maps screenshot for an address (auto temp path)
#   street-view "<address>"           — Google Maps Street View screenshot for an address
#   script <url> "<js-expression>"    — evaluate JS in the page, return result
#
# After running screenshot/maps/street-view, use the `Read` tool on the
# returned `screenshot` path to visually analyse the image.

set -uo pipefail
exec node "$(dirname "$0")/browser-tool.js" "$@"
