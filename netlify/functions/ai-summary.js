// netlify/functions/ai-summary.js
// Powers the "Generate summary" button in SuppleFacts on the live site.
//
// The page sends ONLY structured label data (brand, product, ingredients and their
// NIH monograph notes). The prompt is built here, on the server, so this endpoint
// can't be used as a general-purpose chatbot. The API key never reaches the browser.
//
// Setup (Netlify > Site configuration > Environment variables):
//   ANTHROPIC_API_KEY = your key from console.anthropic.com
// Optional: ALLOWED_ORIGINS = comma-separated list (defaults to the SuppleFacts address)
//
// Caching: finished summaries are saved in Netlify Blobs, keyed by a fingerprint of the
// structured label input. The same product is summarized by Claude once; after that every
// visitor gets the saved copy instantly and for free. If Blobs is unavailable for any reason
// the cache is skipped and the function works exactly as before (it never blocks a summary).

import { checkLimit, num } from '../lib/ratelimit.js';

const MODEL = 'claude-haiku-4-5';
const MAX_BODY_BYTES = 30000; // a real label request is a few KB; anything bigger is not from the app
const MAX_INGREDIENTS = 40;
const DEFAULT_ORIGINS = ['https://supplefacts.brokenpromiseshealthcare.org'];
const CACHE_STORE = 'ai-summaries';
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, then refresh
// Bump this whenever the prompt/model above changes so old cached text isn't reused.
const CACHE_VERSION = 'v3';

// Added to the end of a summary when any ingredient had no NIH guide behind it. It is added by the
// server (not left to the model) so the wording is always friendly and always present.
const MISSING_POINTER = 'Some ingredients on this label fall outside the NIH sources used for this summary. ' +
  'That doesn\u2019t mean nothing is known about them. Tap Investigate the Evidence below to search the research ' +
  'for every ingredient on this label.';

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});
// The page shows plain text, so strip any markdown the model adds (headings, bold, bullets)
const plain = (t) => String(t || '')
  .replace(/^\s*#{1,6}\s+.*(\r?\n)+/, '')      // drop a leading "# Title" line
  .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')               // any other heading markers
  .replace(/\*\*(.+?)\*\*/g, '$1')              // **bold**
  .replace(/^[ \t]*[-*][ \t]+/gm, '')                  // bullet markers
  .trim();
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

// ---- cache helpers (all failures are swallowed: caching is a bonus, never a requirement) ----
async function openCache(event) {
  try {
    const mod = await import('@netlify/blobs');
    if (typeof mod.connectLambda === 'function') mod.connectLambda(event);
    return mod.getStore(CACHE_STORE);
  } catch (e) {
    console.warn('summary cache unavailable:', e && e.message);
    return null;
  }
}
async function cacheKey(lines) {
  const { createHash } = await import('node:crypto');
  return CACHE_VERSION + '-' + createHash('sha256').update(lines).digest('hex');
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(503, { error: 'not_configured' });

  // Basic origin check: only our own site may call this
  const allowed = (process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
    : DEFAULT_ORIGINS);
  const origin = event.headers.origin || event.headers.Origin || '';
  if (!allowed.includes(origin)) return json(403, { error: 'forbidden_origin' });

  if ((event.body || '').length > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_json' }); }
  const ings = Array.isArray(b.ingredients) ? b.ingredients.slice(0, MAX_INGREDIENTS) : [];
  if (!ings.length) return json(400, { error: 'no_ingredients' });

  const lines = [];
  lines.push('Product label: ' + clip(b.brand, 120) + ' — ' + clip(b.name, 200) +
    ' (' + clip(b.form, 120) + ', serving size ' + clip(b.serving, 80) + ').');
  lines.push('Use ONLY the NIH-sourced material given for each ingredient below. Do not add outside claims or invented statistics.');
  const hasNotes = (i) => !!(i.notes && typeof i.notes === 'object');
  const missing = ings.filter((i) => !hasNotes(i));
  ings.forEach((i) => {
    lines.push('\n' + clip(i.name, 160) + (i.amount ? ' (' + clip(i.amount, 60) + ' per serving)' : '') + ':');
    if (hasNotes(i)) {
      lines.push('What it is: ' + clip(i.notes.what, 600));
      lines.push('What the evidence shows: ' + clip(i.notes.evidence, 600));
      lines.push('Safety & interactions: ' + clip(i.notes.safety, 600));
    } else {
      lines.push('(The NIH source material used by this app has no guide for this ingredient. Do not describe its benefits, risks or doses from your own knowledge.)');
    }
  });
  if (missing.length) {
    lines.push('\nIngredients with no NIH guide in this app: ' +
      missing.slice(0, 12).map((i) => clip(i.name, 80)).join(', ') + '.');
    lines.push('For those ingredients, say plainly and calmly that the NIH sources used for this summary do not cover them. ' +
      'Make clear this is a limit of these sources: it is not evidence that nothing is known, and it is not a sign that the ingredient ' +
      'is ineffective or unsafe. Never say the information is "unavailable" or "not found", and never suggest the reader is out of options. ' +
      'Do not write any pointer to an "Investigate the Evidence" search yourself; one is added automatically after your summary.');
  }
  if (missing.length && missing.length === ings.length) {
    // Nothing from the NIH to summarize: stay with what the label itself says, keep it short and kind
    lines.push('\nWrite one short, friendly summary of 70–110 words. State what the label lists (ingredient names and amounts exactly as given), ' +
      'explain the limit described above, and end with one short sentence noting this is general information, not medical advice.');
  } else {
    lines.push('\nWrite one consumer-friendly summary, ' + (ings.length > 3 ? '180–260' : '120–180') +
      ' words, covering what this product’s active ingredient(s) are for and what the evidence actually supports. ' +
      'Stay neutral; do not overstate benefit. End with one short sentence noting this is general information ' +
      'drawn from NIH source material, not medical advice.');
  }

  const promptText = lines.join('\n');
  const store = await openCache(event);
  let ckey = null;
  if (store) {
    try {
      ckey = await cacheKey(promptText);
      const hit = await store.get(ckey, { type: 'json' });
      if (hit && hit.text && Date.now() - (hit.savedAt || 0) < CACHE_TTL_MS) {
        return json(200, { text: hit.text, cached: true });
      }
    } catch (e) { console.warn('cache read failed:', e && e.message); }
  }

  // Abuse guard: only brand-new summaries (cache misses) count, because those are the ones that cost money.
  // Defaults: 20 new summaries per visitor per hour, 600 per day across everyone. Override in Netlify with
  // RATE_SUMMARY_PER_HOUR and RATE_SUMMARY_PER_DAY.
  const lim = await checkLimit(event, {
    name: 'summary',
    perVisitor: num(process.env.RATE_SUMMARY_PER_HOUR, 20),
    perDay: num(process.env.RATE_SUMMARY_PER_DAY, 600)
  });
  if (!lim.ok) {
    return { ...json(429, { error: 'rate_limited' }), headers: { 'Content-Type': 'application/json', 'Retry-After': String(lim.retryAfterSec) } };
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: 'You write short, neutral, evidence-based ingredient summaries for an independent, pharmacist-run dietary-supplement education site. Plain language, no marketing tone, no claims beyond what the source material actually supports. Output only the summary as plain paragraphs: no title, no headings, no bold, no bullet points.',
        messages: [{ role: 'user', content: promptText }]
      })
    });
    if (r.status === 429) return json(429, { error: 'rate_limited' });
    const data = await r.json();
    if (!r.ok) {
      console.error('Anthropic API error', r.status, JSON.stringify(data).slice(0, 500));
      return json(502, { error: 'upstream_error' });
    }
    let text = plain((data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
    if (!text) return json(502, { error: 'empty_response' });
    if (missing.length) text = text + '\n\n' + MISSING_POINTER;
    if (store && ckey) {
      try { await store.setJSON(ckey, { text, savedAt: Date.now() }); }
      catch (e) { console.warn('cache write failed:', e && e.message); }
    }
    return json(200, { text, cached: false });
  } catch (e) {
    console.error('ai-summary failed', e);
    return json(500, { error: 'server_error' });
  }
};
