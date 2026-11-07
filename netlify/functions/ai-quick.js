// netlify/functions/ai-quick.js   (TEST VERSION: used only when the app is switched into NIH + Claude test mode)
// Writes the short "From Claude" part of the NIH + Claude summary in SuppleFacts.
// The NIH part of that summary is built in the browser from the app's own NIH notes, so it needs no AI and appears at once.
//
// This file is separate from ai-summary.js on purpose: ai-summary.js is untouched. To remove the test, delete this file.
// Uses the same ANTHROPIC_API_KEY and ALLOWED_ORIGINS settings as ai-summary.js. Nothing new to set up in Netlify.
//
// The page sends only structured label data. The prompt is built here, so this endpoint can't be used as a general chatbot.

import { checkLimit, num } from '../lib/ratelimit.js';

const MODEL = 'claude-haiku-5-5';
const MAX_BODY_BYTES = 30000;
const MAX_INGREDIENTS = 40;
const DEFAULT_ORIGINS = ['https://supplefacts.brokenpromiseshealthcare.org'];
const CACHE_STORE = 'ai-quick';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, then refresh (this part comes from Claude's memory, so keep it fresh)
const CACHE_VERSION = 'q1'; // bump when the prompt or model changes so old text isn't reused

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
// The page shows plain text, so strip any markdown the model adds
const plain = (t) => String(t || '')
  .replace(/^\s*#{1,6}\s+.*(\r?\n)+/, '')
  .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .replace(/^[ \t]*[-*][ \t]+/gm, '')
  .trim();

const SYSTEM = 'You are a careful assistant for an independent, pharmacist-run dietary-supplement education app. ' +
  'Write short, neutral, plain-language product checks. No marketing tone. Never invent a study, statistic, or citation. ' +
  'Output plain paragraphs only: no title, no headings, no bold, no bullet points.';

async function openCache(event) {
  try {
    const mod = await import('@netlify/blobs');
    if (typeof mod.connectLambda === 'function') mod.connectLambda(event);
    return mod.getStore(CACHE_STORE);
  } catch (e) { console.warn('quick cache unavailable:', e && e.message); return null; }
}
async function cacheKey(text) {
  const { createHash } = await import('node:crypto');
  return CACHE_VERSION + '-' + createHash('sha256').update(text).digest('hex');
}

export function buildPrompt(b, ings) {
  const L = [];
  L.push('PRODUCT LABEL');
  L.push('Brand: ' + clip(b.brand, 120));
  L.push('Product: ' + clip(b.name, 200));
  L.push('Form: ' + clip(b.form, 120) + '; serving size: ' + clip(b.serving, 80));
  L.push('Ingredients per serving:');
  ings.forEach((i) => L.push('- ' + clip(i.name, 160) + (i.amount ? ': ' + clip(i.amount, 60) : '')));
  if (b.other) L.push('Other ingredients: ' + clip(b.other, 300));
  const claims = Array.isArray(b.claims) ? b.claims.slice(0, 8).map((c) => clip(c, 160)).filter(Boolean) : [];
  if (claims.length) L.push('Label claims: ' + claims.join(' | '));

  const withNotes = ings.filter((i) => i.notes && typeof i.notes === 'object');
  const noNotes = ings.filter((i) => !(i.notes && typeof i.notes === 'object'));
  if (withNotes.length) {
    L.push('\nNIH-SOURCED NOTES THE READER ALREADY SEES (do not repeat them):');
    withNotes.slice(0, 12).forEach((i) => {
      L.push(clip(i.name, 120) + ': evidence: ' + clip(i.notes.evidence, 350) + ' Safety: ' + clip(i.notes.safety, 350));
    });
  }
  if (noNotes.length) L.push('\nIngredients with NO NIH notes in this app: ' + noNotes.slice(0, 12).map((i) => clip(i.name, 80)).join(', ') + '.');

  if (withNotes.length) {
    L.push('\nWrite 130 to 190 words as up to four short paragraphs, each starting with its label and a colon:');
    L.push('Dose and form: compare this label’s amount and form with what studies used. If the form differs from what was studied (for example a leaf powder against a root extract), say the results may not carry over. If you are not sure what doses studies used, say so.');
    L.push('Label claims: say whether the evidence supports each claim on the label, and whether it reads as a structure/function claim or a disease claim. Say "evidence not verified" for any label statement you cannot confirm, such as testing or purity claims.');
    L.push('Also worth knowing: include this paragraph only if there is an important safety point or medicine interaction that the NIH notes above do not already cover.');
    if (noNotes.length) L.push('Not covered by NIH notes: one short line for each ingredient listed as having no NIH notes, saying what is known and how strong the evidence is. Mark it (check this).');
  } else {
    // No NIH notes for any ingredient: this answer has to stand on its own, so it covers evidence and safety too.
    L.push('\nThe app has no NIH notes for these ingredients, so write the whole check yourself in 170 to 230 words as short paragraphs, each starting with its label and a colon:');
    L.push('Evidence: for each main ingredient, in one line, what it is used for and how strong the evidence is (strong, moderate, limited, none found, or evidence of harm). Mark anything you are unsure of (check this).');
    L.push('Dose and form: compare this label’s amount and form with what studies used. If the form differs from what was studied (for example a leaf powder against a root extract), say the results may not carry over. If you are not sure what doses studies used, say so.');
    L.push('Safety: the one to three most important safety points and medicine interactions, with (check this) after any specific number or interaction you give from memory.');
    L.push('Label claims: say whether the evidence supports each claim on the label, and whether it reads as a structure/function claim or a disease claim. Say "evidence not verified" for any label statement you cannot confirm, such as testing or purity claims.');
  }
  L.push('\nRules: Take product facts only from the label above. Do not repeat any NIH notes shown. Never invent a study, number or citation, and name a study only if you are certain of it. ' +
    'Whenever you rely on memory for a specific dose, number, date or drug interaction, put (check this) right after it. ' +
    'Where evidence is weak or missing, say so plainly. Give no personal dosing advice. Do not write a disclaimer; one is shown automatically.');
  return L.join('\n');
}

async function callClaude(key, promptText, tryNoThinking) {
  const body = {
    model: MODEL,
    system: SYSTEM,
    messages: [{ role: 'user', content: promptText }]
  };
  if (tryNoThinking) {
    // Fastest path: no thinking step. Needs only a small token budget.
    body.max_tokens = 900;
    body.thinking = { type: 'disabled' };
  } else {
    // Fallback if the API rejects the setting above: same call style as ai-summary.js
    body.max_tokens = 4000; // thinking counts toward this limit
    body.output_config = { effort: 'low' };
  }
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(503, { error: 'not_configured' });

  const allowed = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) : DEFAULT_ORIGINS;
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (!allowed.includes(origin)) return json(403, { error: 'forbidden_origin' });

  if ((event.body || '').length > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_json' }); }
  const ings = Array.isArray(b.ingredients) ? b.ingredients.slice(0, MAX_INGREDIENTS) : [];
  if (!ings.length) return json(400, { error: 'no_ingredients' });

  const promptText = buildPrompt(b, ings);
  const store = await openCache(event);
  let ckey = null;
  if (store) {
    try {
      ckey = await cacheKey(promptText);
      const hit = await store.get(ckey, { type: 'json' });
      if (hit && hit.text && Date.now() - (hit.savedAt || 0) < CACHE_TTL_MS) return json(200, { text: hit.text, cached: true });
    } catch (e) { console.warn('quick cache read failed:', e && e.message); }
  }

  // Abuse guard: only new (uncached) requests count. Same defaults as summaries; override with RATE_QUICK_PER_HOUR / RATE_QUICK_PER_DAY.
  const lim = await checkLimit(event, { name: 'quick', perVisitor: num(process.env.RATE_QUICK_PER_HOUR, 20), perDay: num(process.env.RATE_QUICK_PER_DAY, 600) });
  if (!lim.ok) return { ...json(429, { error: 'rate_limited' }), headers: { 'Content-Type': 'application/json', 'Retry-After': String(lim.retryAfterSec) } };

  try {
    let r = await callClaude(key, promptText, true);
    if (r.status === 400) { // the no-thinking setting was refused: retry the way ai-summary.js calls it
      console.warn('ai-quick: retrying without thinking=disabled');
      r = await callClaude(key, promptText, false);
    }
    if (r.status === 429) return json(429, { error: 'rate_limited' });
    const data = await r.json();
    if (!r.ok) { console.error('Anthropic API error', r.status, JSON.stringify(data).slice(0, 500)); return json(502, { error: 'upstream_error' }); }
    const text = plain((data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
    if (!text) { console.error('ai-quick empty response, stop_reason:', data.stop_reason); return json(502, { error: 'empty_response' }); }
    if (store && ckey) { try { await store.setJSON(ckey, { text, savedAt: Date.now() }); } catch (e) { console.warn('quick cache write failed:', e && e.message); } }
    return json(200, { text, cached: false });
  } catch (e) {
    console.error('ai-quick failed', e);
    return json(500, { error: 'server_error' });
  }
};
