// netlify/functions/barcode-lookup.js
// TEST function for the SuppleFacts barcode sandbox (branch: barcode-dev).
//
// Takes a scanned barcode number and asks several product databases what it is, all at the same time,
// so the test page can show which sources recognize which bottles. Nothing here changes the live app.
//
// Setup (Netlify > Project configuration > Environment variables) — all optional:
//   FDC_API_KEY      free key from https://api.data.gov/signup/  (USDA FoodData Central)
//   UPCITEMDB_KEY    paid UPCitemdb developer key; without it the free trial endpoint is used (100 lookups/day)
//   ALLOWED_ORIGINS  comma-separated list; defaults to the live app address plus this project's branch/deploy previews

import { checkLimit, num } from '../lib/ratelimit.js';

const LIVE = 'https://supplefacts.brokenpromiseshealthcare.org';
const PREVIEW_HOST = /^https:\/\/[a-z0-9-]+--supplefacts\.netlify\.app$|^https:\/\/deploy-preview-\d+--supplefacts\.netlify\.app$/;
const DSLD = 'https://api.ods.od.nih.gov/dsld/v9';
const OFF_AGENT = 'SuppleFacts/0.1 (outreach@brokenpromiseshealthcare.org)';
const TIMEOUT_MS = 8000;

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

// ---------- number handling ----------
const digits = (s) => String(s || '').replace(/\D+/g, '');
const stripZeros = (d) => d.replace(/^0+/, '');
const pad = (d, n) => (d.length >= n ? d : '0'.repeat(n - d.length) + d);
// two UPCs match if they agree after removing spaces and leading zeros (and optionally the check digit)
function sameUpc(a, b) {
  const x = stripZeros(digits(a)), y = stripZeros(digits(b));
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length > 6 && y.length > 6 && (x.slice(0, -1) === y || y.slice(0, -1) === x);
}
function spaced12(d12) {
  return d12.length === 12 ? `${d12[0]} ${d12.slice(1, 6)} ${d12.slice(6, 11)} ${d12[11]}` : d12;
}
function variantsOf(raw) {
  const d = digits(raw), core = stripZeros(d), out = [], seen = new Set();
  const add = (v) => { if (v && !seen.has(v)) { seen.add(v); out.push(v); } };
  add(d);
  if (core.length <= 12) add(pad(core, 12));
  if (core.length <= 13) add(pad(core, 13));
  if (core.length <= 14) add(pad(core, 14));
  if (core.length <= 12) add(spaced12(pad(core, 12)));
  return out;
}

// ---------- small helpers ----------
async function getJson(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { ok: res.ok, status: res.status, body, text: body ? '' : text.slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}
async function timed(source, label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { source, label, ms: Date.now() - t0, ...r };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : (e && e.message) || 'error';
    return { source, label, ms: Date.now() - t0, state: 'error', matches: [], note: msg };
  }
}

// ---------- sources ----------
// NIH DSLD: search the number as a keyword, then open the labels and compare their UPC field.
async function lookupDsld(code) {
  const vars = variantsOf(code).slice(0, 4);
  const notes = [];
  const hitIds = new Map();
  await Promise.all(vars.map(async (v) => {
    const r = await getJson(`${DSLD}/browse-products?method=by_keyword&q=${encodeURIComponent(v)}&size=10`);
    if (!r.ok) { notes.push(`"${v}": HTTP ${r.status}`); return; }
    const hits = (r.body && (r.body.hits && r.body.hits.hits ? r.body.hits.hits : r.body.hits)) || [];
    notes.push(`"${v}": ${hits.length} hit(s)`);
    hits.slice(0, 5).forEach((h) => {
      const s = h._source || h;
      const id = s.id || h._id;
      if (id) hitIds.set(String(id), { id, name: s.fullName, brand: s.brandName, upc: s.upcSku });
    });
  }));
  const matches = [];
  await Promise.all([...hitIds.values()].slice(0, 8).map(async (h) => {
    let upc = h.upc, name = h.name, brand = h.brand;
    if (upc === undefined) {
      const r = await getJson(`${DSLD}/label/${encodeURIComponent(h.id)}`);
      if (r.ok && r.body) { upc = r.body.upcSku; name = r.body.fullName; brand = r.body.brandName; }
    }
    if (sameUpc(upc, code)) matches.push({ brand, name, upc, id: h.id, url: `https://dsld.od.nih.gov/label/${h.id}` });
  }));
  return { state: matches.length ? 'found' : 'none', matches, note: notes.join(' · ') };
}

async function lookupOff(host, code) {
  const vars = [pad(stripZeros(digits(code)), 13), stripZeros(digits(code)).length <= 12 ? pad(stripZeros(digits(code)), 12) : ''].filter(Boolean);
  const tried = [];
  for (const v of [...new Set(vars)]) {
    const r = await getJson(`https://${host}/api/v2/product/${v}.json?fields=code,product_name,brands,quantity,categories`, { headers: { 'User-Agent': OFF_AGENT } });
    tried.push(`${v}: ${r.ok ? (r.body && r.body.status === 1 ? 'found' : 'not found') : 'HTTP ' + r.status}`);
    if (r.ok && r.body && r.body.status === 1 && r.body.product) {
      const p = r.body.product;
      return { state: 'found', matches: [{ brand: p.brands || '', name: [p.product_name, p.quantity].filter(Boolean).join(' · '), upc: p.code || v, url: `https://${host}/product/${p.code || v}` }], note: tried.join(' · ') };
    }
    if (!r.ok && r.status === 429) return { state: 'error', matches: [], note: 'rate limited (15 reads/min/IP)' };
  }
  return { state: 'none', matches: [], note: tried.join(' · ') };
}

async function lookupFdc(code) {
  const key = process.env.FDC_API_KEY;
  if (!key) return { state: 'skipped', matches: [], note: 'No FDC_API_KEY set in Netlify yet.' };
  const r = await getJson(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: stripZeros(digits(code)), dataType: ['Branded'], pageSize: 25 })
  });
  if (!r.ok) return { state: 'error', matches: [], note: `HTTP ${r.status}` };
  const foods = (r.body && r.body.foods) || [];
  const matches = foods.filter((f) => sameUpc(f.gtinUpc, code)).slice(0, 5).map((f) => ({
    brand: f.brandOwner || f.brandName || '', name: f.description || '', upc: f.gtinUpc, url: `https://fdc.nal.usda.gov/food-details/${f.fdcId}/branded`
  }));
  return { state: matches.length ? 'found' : 'none', matches, note: `${foods.length} text hit(s); ${matches.length} with a matching UPC` };
}

async function lookupUpcItemDb(code) {
  const key = process.env.UPCITEMDB_KEY;
  const base = key ? 'https://api.upcitemdb.com/prod/v1/lookup' : 'https://api.upcitemdb.com/prod/trial/lookup';
  const headers = key ? { user_key: key, key_type: '3scale', Accept: 'application/json' } : { Accept: 'application/json' };
  const v = pad(stripZeros(digits(code)), 12);
  const r = await getJson(`${base}?upc=${encodeURIComponent(v)}`, { headers });
  if (r.status === 429) return { state: 'error', matches: [], note: 'daily or per-minute limit reached' };
  if (!r.ok) return { state: 'error', matches: [], note: `HTTP ${r.status}` };
  const items = (r.body && r.body.items) || [];
  const matches = items.slice(0, 3).map((i) => ({ brand: i.brand || '', name: i.title || '', upc: i.upc || i.ean || v, url: '' }));
  return { state: matches.length ? 'found' : 'none', matches, note: key ? 'paid key' : 'free trial endpoint (100/day)' };
}

// ---------- handler ----------
export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!(origin === LIVE || PREVIEW_HOST.test(origin) || extra.includes(origin))) return json(403, { error: 'forbidden_origin' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_json' }); }
  const code = digits(body.code);
  if (code.length < 8 || code.length > 14) return json(400, { error: 'need 8 to 14 digits' });

  // Abuse guard (protects the free UPCitemdb / Open Food Facts limits). Defaults: 60 lookups per visitor per hour,
  // 1500 per day across everyone. Override in Netlify with RATE_BARCODE_PER_HOUR and RATE_BARCODE_PER_DAY.
  const lim = await checkLimit(event, {
    name: 'barcode',
    perVisitor: num(process.env.RATE_BARCODE_PER_HOUR, 60),
    perDay: num(process.env.RATE_BARCODE_PER_DAY, 1500)
  });
  if (!lim.ok) {
    return { ...json(429, { error: 'rate_limited' }), headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(lim.retryAfterSec) } };
  }

  const results = await Promise.all([
    timed('dsld', 'NIH DSLD (by UPC)', () => lookupDsld(code)),
    timed('off', 'Open Food Facts', () => lookupOff('world.openfoodfacts.org', code)),
    timed('opf', 'Open Products Facts', () => lookupOff('world.openproductsfacts.org', code)),
    timed('fdc', 'USDA FoodData Central', () => lookupFdc(code)),
    timed('upcitemdb', 'UPCitemdb', () => lookupUpcItemDb(code))
  ]);
  return json(200, { code, variants: variantsOf(code), results });
};

export { sameUpc, variantsOf };
