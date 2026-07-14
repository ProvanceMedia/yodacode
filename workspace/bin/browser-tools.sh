#!/usr/bin/env bash
# @yoda-tool
# name: browser-tools.sh
# summary: Headless Chromium via Playwright — JS-rendered pages, screenshots, Google Maps address verification.
# tags: browser, scraping, maps
# requires:
# probe: node bin/browser-tool.cjs probe
# install: run `yodacode install-browsers` on the server (one-time ~300MB download)
# usage:
#   browser-tools.sh fetch <url>                    — render JS, return HTML
#   browser-tools.sh text <url>                     — render JS, return body innerText
#   browser-tools.sh screenshot <url> <out.png>     — full-page screenshot
#   browser-tools.sh maps "<address>"               — Google Maps screenshot (auto temp path)
#   browser-tools.sh street-view "<address>"        — Street View screenshot
#   browser-tools.sh script <url> "<js>"            — evaluate JS in the page, return result
# examples:
#   ./bin/browser-tools.sh maps "1 Roman Rd, London E2 9PB"
#   ./bin/browser-tools.sh text https://example.com
# @end
#
# After running screenshot/maps/street-view, use the `Read` tool on the
# returned `screenshot` path to visually analyse the image.

set -uo pipefail
exec node "$(dirname "$0")/browser-tool.cjs" "$@"
