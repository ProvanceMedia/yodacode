#!/usr/bin/env node
// Yoda browser tool — thin Playwright wrapper.
//
// Usage:
//   node browser-tool.cjs fetch <url>                       — print rendered HTML to stdout
//   node browser-tool.cjs text <url>                        — print rendered text content (innerText of body)
//   node browser-tool.cjs screenshot <url> <out.png>        — full-page screenshot
//   node browser-tool.cjs maps "<address>"                  — Google Maps Place screenshot for an address
//   node browser-tool.cjs street-view "<address>"           — Google Maps Street View screenshot for an address
//   node browser-tool.cjs script <url> "<js-expression>"    — evaluate JS in page context, print result
//
// All commands print a single JSON line to stdout on success:
//   {"ok":true, ...}
// or
//   {"ok":false, "error":"..."}

const fs = require('fs');
const path = require('path');
const os = require('os');

// Resolve the Playwright module from wherever this install put it: the image
// bakes it globally (/usr/local/lib), a workspace `npm install playwright`
// also works, and the legacy host path is kept for old bare-metal installs.
const PW_CANDIDATES = [
  'playwright', // workspace node_modules
  '/usr/local/lib/node_modules/playwright', // global (image default)
  '/usr/lib/node_modules/playwright', // legacy host installs
];
const IN_CONTAINER = fs.existsSync('/.dockerenv');
const INSTALL_HINT = IN_CONTAINER
  ? 'browser not installed — run `yodacode install-browsers` on the server'
  : 'browser not installed — run `npx playwright install chromium` as the agent user';
function resolvePlaywrightPath() {
  for (const c of PW_CANDIDATES) {
    try { return path.dirname(require.resolve(`${c}/package.json`)); } catch (_) { /* next */ }
  }
  return null;
}
function loadPlaywright() {
  for (const c of PW_CANDIDATES) {
    try { return require(c); } catch (_) { /* try next */ }
  }
  return null;
}
const pw = loadPlaywright();
const chromium = pw && pw.chromium;

const NAV_TIMEOUT = 25000;
const VIEWPORT = { width: 1366, height: 900 };

async function withBrowser(fn) {
  if (!chromium) throw new Error(`playwright module not found — ${INSTALL_HINT}`);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    // Playwright's "Executable doesn't exist … playwright install" advice names
    // a command the de-rooted agent can't usefully run — translate it.
    if (/executable doesn't exist|please run.*install/i.test(String(e && e.message))) {
      throw new Error(INSTALL_HINT);
    }
    throw e;
  }
  try {
    const ctx = await browser.newContext({
      viewport: VIEWPORT,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-GB',
    });
    const page = await ctx.newPage();
    return await fn(page, ctx);
  } finally {
    await browser.close();
  }
}

async function navigate(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
}

function ok(extra) {
  console.log(JSON.stringify({ ok: true, ...extra }));
}
function fail(error) {
  console.log(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
  process.exitCode = 1;
}

async function cmdFetch(url) {
  await withBrowser(async (page) => {
    await navigate(page, url);
    const html = await page.content();
    ok({ url, length: html.length, html });
  });
}

async function cmdText(url) {
  await withBrowser(async (page) => {
    await navigate(page, url);
    const text = await page.evaluate(() => document.body.innerText);
    ok({ url, length: text.length, text });
  });
}

async function cmdScreenshot(url, out) {
  await withBrowser(async (page) => {
    await navigate(page, url);
    // Give Google et al a moment for late-render UI
    await page.waitForTimeout(2500);
    await page.screenshot({ path: out, fullPage: false, type: 'jpeg', quality: 85 });
    const stat = fs.statSync(out);
    ok({ url, path: path.resolve(out), bytes: stat.size });
  });
}

async function cmdMaps(address) {
  // Use the official Google Maps Search URL API which auto-geocodes the query.
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  const out = path.join(os.tmpdir(), `yoda-maps-${Date.now()}.jpg`);
  await withBrowser(async (page) => {
    await navigate(page, url);
    // Dismiss EU cookie consent first if it pops up
    try {
      const consent = await page.$('button[aria-label*="Accept"], button[aria-label*="Reject"], button:has-text("Accept all"), button:has-text("Reject all")');
      if (consent) {
        await consent.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      }
    } catch (_) {}
    // Wait for the place panel (h1 with the venue/address) OR a map pin to render.
    // Google injects the sidebar h1 once geocoding finishes — that's our settle signal.
    try {
      await page.waitForSelector('h1.DUwDvf, h1.fontHeadlineLarge, [role="main"] h1', { timeout: 12000 });
    } catch (_) {
      // Even without the panel, give the map tiles time to draw
      await page.waitForTimeout(5000);
    }
    // Extra settle for map tile rendering
    await page.waitForTimeout(2500);
    await page.screenshot({ path: out, fullPage: false, type: 'jpeg', quality: 85 });
    // Try to grab the place name + address from the sidebar (selectors change frequently)
    let placeInfo = '';
    try {
      placeInfo = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        const addrBtn = document.querySelector('button[data-item-id="address"]') ||
                         document.querySelector('[data-item-id="address"]');
        return JSON.stringify({
          name: h1 ? (h1.innerText || h1.textContent || '').trim() : '',
          address: addrBtn ? (addrBtn.innerText || addrBtn.textContent || '').trim() : '',
        });
      });
    } catch (_) {}
    ok({ url, address, screenshot: out, placeInfo });
  });
}

async function cmdStreetView(address) {
  // Construct a Street View URL — Google's `cbll=lat,lng` requires coords we don't have,
  // so we navigate to the place URL and then click the Street View pegman / use the layer trick.
  const placeUrl = `https://www.google.com/maps/place/${encodeURIComponent(address)}`;
  const out = path.join(os.tmpdir(), `yoda-streetview-${Date.now()}.jpg`);
  await withBrowser(async (page) => {
    await navigate(page, placeUrl);
    await page.waitForTimeout(4000);
    // Dismiss consent
    try {
      const consent = await page.$('button[aria-label*="Accept"], button[aria-label*="Reject"], button:has-text("Accept all"), button:has-text("Reject all")');
      if (consent) {
        await consent.click();
        await page.waitForTimeout(1500);
      }
    } catch (_) {}
    // Try to find a "Street View" thumbnail or button in the sidebar
    let entered = false;
    try {
      const sv = await page.$('button[aria-label*="Street View"], a[aria-label*="Street View"], img[aria-label*="Street View"]');
      if (sv) {
        await sv.click();
        await page.waitForTimeout(4500);
        entered = true;
      }
    } catch (_) {}
    await page.screenshot({ path: out, fullPage: false, type: 'jpeg', quality: 85 });
    ok({ url: placeUrl, address, screenshot: out, streetViewEntered: entered });
  });
}

async function cmdScript(url, expr) {
  await withBrowser(async (page) => {
    await navigate(page, url);
    await page.waitForTimeout(1500);
    const result = await page.evaluate(`(() => { return (${expr}); })()`);
    ok({ url, result });
  });
}

// Cheap readiness check (no browser launch): module resolvable + Chromium
// binary present on disk. Used by refresh-capabilities.py and the
// `yodacode install-browsers` CLI. Exit 0 = ready.
function cmdProbe() {
  if (!pw) return fail(`playwright module not found — ${INSTALL_HINT}`);
  let exe;
  try { exe = chromium.executablePath(); } catch (e) { return fail(e); }
  if (!exe || !fs.existsSync(exe)) return fail(INSTALL_HINT);
  ok({ browser: exe });
}

// Download Chromium via the SAME playwright module the probe and runtime load —
// installing through any other copy (e.g. the global CLI when a workspace copy
// shadows it) can fetch a mismatched browser revision the probe never accepts.
function cmdInstall() {
  const base = resolvePlaywrightPath();
  if (!base) return fail(`playwright module not found — ${INSTALL_HINT}`);
  const cli = path.join(base, 'cli.js');
  if (!fs.existsSync(cli)) return fail(`playwright CLI not found at ${cli}`);
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  process.exit(r.status === 0 ? 0 : 1);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case 'probe':       return cmdProbe();
      case 'install':     return cmdInstall();
      case 'fetch':       return await cmdFetch(rest[0]);
      case 'text':        return await cmdText(rest[0]);
      case 'screenshot':  return await cmdScreenshot(rest[0], rest[1]);
      case 'maps':        return await cmdMaps(rest[0]);
      case 'street-view': return await cmdStreetView(rest[0]);
      case 'script':      return await cmdScript(rest[0], rest[1]);
      default:
        console.error('usage: browser-tool.cjs {probe|fetch|text|screenshot|maps|street-view|script} ...');
        process.exit(2);
    }
  } catch (e) {
    fail(e);
  }
}

main();
