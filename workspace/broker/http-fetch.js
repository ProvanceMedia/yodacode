// Shared host-side fetch for the broker: one timeout + JSON/text shaping path used by
// both the per-service tools (services.js) and the generic http_call tool. Plus an SSRF
// guard — these fetches run as root on the host, so a target that resolves to a
// private/link-local/metadata address must be refused (defence-in-depth behind the
// auth-hosts allowlist).
import dns from 'node:dns/promises';

export async function doFetch(url, init, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  init.signal = ctrl.signal;
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep as text */
    }
    return r.ok ? { ok: true, data } : { ok: false, error: `HTTP ${r.status}: ${text.slice(0, 300)}` };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e) };
  } finally {
    clearTimeout(to);
  }
}

function isBlockedIp(ip) {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, RFC1918
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('::ffff:')) return isBlockedIp(low.slice(7)); // v4-mapped v6
  if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true; // link-local + ULA
  return false;
}

/** Returns an error string if the hostname resolves to a blocked (internal) address, else null. */
export async function ssrfCheck(hostname) {
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    return 'dns lookup failed';
  }
  for (const a of addrs) if (isBlockedIp(a.address)) return `target resolves to a blocked address (${a.address})`;
  return null;
}
