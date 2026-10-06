// netlify/lib/ratelimit.js
// Small, best-effort abuse guard shared by the SuppleFacts functions.
//
// Two limits per function:
//   1. per visitor  - N calls per window (default window one hour)
//   2. all visitors - M calls per day (a circuit breaker that caps what a bot or a viral link can cost)
// Visitors are identified by a one-way hash of their IP address; no raw IP is stored.
// Counts live in Netlify Blobs. If Blobs is unavailable the guard "fails open", so a storage
// hiccup can never block a real user. Counting is not atomic, so treat the limits as approximate.

const STORE = 'rate-limits';

async function defaultStore(event) {
  try {
    const mod = await import('@netlify/blobs');
    if (typeof mod.connectLambda === 'function') mod.connectLambda(event);
    return mod.getStore(STORE);
  } catch (e) {
    console.warn('rate-limit store unavailable:', e && e.message);
    return null;
  }
}

function clientIp(event) {
  const h = (event && event.headers) || {};
  return String(h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || h['client-ip'] || 'unknown').trim();
}

async function hashIp(ip) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update('sf-rl-v1|' + ip).digest('hex').slice(0, 24);
}

async function bump(store, key, windowMs, now) {
  let rec = null;
  try { rec = await store.get(key, { type: 'json' }); } catch (e) { rec = null; }
  if (!rec || typeof rec.n !== 'number' || !rec.reset || now >= rec.reset) rec = { n: 0, reset: now + windowMs };
  rec.n += 1;
  try { await store.setJSON(key, rec); } catch (e) { console.warn('rate-limit write failed:', e && e.message); }
  return rec;
}

// opts: { name, perVisitor, windowMs, perDay, getStore?, now? }
// returns { ok: true } or { ok: false, scope: 'visitor' | 'global', retryAfterSec }
async function checkLimit(event, opts) {
  try {
    const now = opts.now || Date.now();
    const store = opts.getStore ? await opts.getStore(event) : await defaultStore(event);
    if (!store) return { ok: true };
    const windowMs = opts.windowMs || 60 * 60 * 1000;
    const id = await hashIp(clientIp(event));
    const v = await bump(store, opts.name + ':v:' + id, windowMs, now);
    if (opts.perVisitor && v.n > opts.perVisitor) {
      return { ok: false, scope: 'visitor', retryAfterSec: Math.max(1, Math.ceil((v.reset - now) / 1000)) };
    }
    if (opts.perDay) {
      const g = await bump(store, opts.name + ':g', 24 * 60 * 60 * 1000, now);
      if (g.n > opts.perDay) {
        return { ok: false, scope: 'global', retryAfterSec: Math.max(1, Math.ceil((g.reset - now) / 1000)) };
      }
    }
    return { ok: true };
  } catch (e) {
    console.warn('rate-limit check failed (allowing):', e && e.message);
    return { ok: true };
  }
}

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

export { checkLimit, clientIp, hashIp, num };
