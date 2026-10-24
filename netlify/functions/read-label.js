// netlify/functions/read-label.js
// Powers the camera button in the "Add its Supplement Facts" box on the No NIH label and
// Could not identify cards. The page sends ONE photo of a label; this function asks Claude to
// copy the Supplement Facts panel into plain text, which the page puts in the box for the user
// to check and correct before they tap Research with AI.
//
// The prompt is fixed here, on the server, so this endpoint only ever transcribes a label and
// can't be used as a general-purpose image chatbot. The API key never reaches the browser.
//
// Setup: uses the same ANTHROPIC_API_KEY (and optional ALLOWED_ORIGINS) as ai-summary.js.
// Photos are not stored anywhere; nothing is cached because every photo is different.

import { checkLimit, num } from '../lib/ratelimit.js';

const MODEL = 'claude-haiku-5-5'; // Haiku 5.5: built for extraction, and the cheapest current model. To change model, change only this line.
const MAX_BODY_BYTES = 4 * 1024 * 1024; // the page shrinks photos to ~1600 px, well under 1 MB; this is a hard ceiling
const MAX_TEXT = 1500;                   // same limit as the typed box on the page
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DEFAULT_ORIGINS = ['https://supplefacts.brokenpromiseshealthcare.org'];
const NO_LABEL = 'NO_LABEL';

const SYSTEM = 'You copy dietary-supplement labels into plain text for an independent, pharmacist-run supplement education site. ' +
  'You transcribe only what is printed. You never add, guess, correct or explain anything.';

const INSTRUCTIONS = [
  'Copy the Supplement Facts panel in this photo into plain text, exactly as printed.',
  '',
  'Format:',
  'Serving Size: <as printed>',
  'Servings Per Container: <as printed, if shown>',
  'Then one line per ingredient: <name, with any form in parentheses> <amount and unit> (<%DV, if shown>)',
  'Keep proprietary blends as one line with their total amount, then list the blend\'s ingredients on the next line.',
  'Other ingredients: <as printed, if shown>',
  '',
  'Rules:',
  '- Copy names, amounts and units exactly. Do not convert units or fix spelling.',
  '- If a word or number is unreadable, write [unreadable] in its place. Never guess.',
  '- Leave out the column headings, footnotes about Daily Values, and anything that is not on the panel.',
  '- Output only the text above: no title, no notes, no markdown.',
  '- If the photo does not show a readable Supplement Facts panel, output exactly ' + NO_LABEL + ' and nothing else.'
].join('\n');

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});
// The box on the page is plain text, so strip any markdown the model adds anyway
const plain = (t) => String(t || '')
  .replace(/^```[a-z]*\s*|\s*```$/g, '')
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  .replace(/^[ \t]*[-*][ \t]+/gm, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

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
  const mediaType = MEDIA_TYPES.includes(b.media_type) ? b.media_type : '';
  const image = typeof b.image === 'string' ? b.image.replace(/^data:[^,]*,/, '') : '';
  if (!mediaType || image.length < 100 || !/^[A-Za-z0-9+/]+=*$/.test(image)) return json(400, { error: 'bad_image' });

  // Abuse guard: every photo is a paid call. Defaults: 10 photos per visitor per hour, 300 per day across
  // everyone. Override in Netlify with RATE_LABEL_PER_HOUR and RATE_LABEL_PER_DAY.
  const lim = await checkLimit(event, {
    name: 'readlabel',
    perVisitor: num(process.env.RATE_LABEL_PER_HOUR, 10),
    perDay: num(process.env.RATE_LABEL_PER_DAY, 300)
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
        max_tokens: 4000, // Haiku 5.5 thinks first and thinking counts toward this limit; the copied panel itself is only about 400 tokens
        output_config: { effort: 'low' }, // keep thinking short
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: INSTRUCTIONS }
          ]
        }]
      })
    });
    if (r.status === 429) return json(429, { error: 'rate_limited' });
    const data = await r.json();
    if (!r.ok) {
      console.error('Anthropic API error', r.status, JSON.stringify(data).slice(0, 500));
      return json(502, { error: 'upstream_error' });
    }
    if (data.stop_reason === 'refusal') return json(502, { error: 'refused' });
    const text = plain((data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
    if (!text || text === NO_LABEL || text.startsWith(NO_LABEL)) return json(422, { error: 'no_label' });
    return json(200, { text: text.slice(0, MAX_TEXT), cut: text.length > MAX_TEXT });
  } catch (e) {
    console.error('read-label failed', e);
    return json(500, { error: 'server_error' });
  }
};
