// node --test proxy/test/transform.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform, buildPrompt } from '../src/worker.js';

const enc = new TextEncoder();

// Turns provider SSE frames into a ReadableStream, optionally splitting them at
// arbitrary byte offsets so we exercise partial-chunk handling.
function providerStream(frames, chunkSize) {
  const text = frames.join('');
  const bytes = enc.encode(text);
  const size = chunkSize || bytes.length;
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

const delta = s => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: s })}\n\n`;

async function collect(stream) {
  const text = await new Response(stream).text();
  return text
    .split('\n\n')
    .filter(l => l.startsWith('data:'))
    .map(l => JSON.parse(l.slice(5).trim()));
}

const PICK_A = { slot: 'Tonight', title: 'A show', venue: 'V', price: '$$' };
const PICK_B = { slot: 'Tonight', title: 'Another show', venue: 'W', price: '$' };

test('emits one pick per completed NDJSON line', async () => {
  const events = await collect(transform(providerStream([
    delta(JSON.stringify(PICK_A) + '\n'),
    delta(JSON.stringify(PICK_B) + '\n'),
  ]), 'openai'));

  const picks = events.filter(e => e.type === 'pick');
  assert.equal(picks.length, 2);
  assert.equal(picks[0].pick.title, 'A show');
  assert.equal(picks[1].pick.title, 'Another show');
  assert.deepEqual(events.at(-1), { type: 'done', count: 2 });
});

test('reassembles picks split across many deltas and byte chunks', async () => {
  const json = JSON.stringify(PICK_A);
  const frames = [];
  for (let i = 0; i < json.length; i += 3) frames.push(delta(json.slice(i, i + 3)));
  frames.push(delta('\n'));

  // A 7-byte read size cuts frames mid-`data:` line, which is the real hazard.
  const events = await collect(transform(providerStream(frames, 7), 'openai'));
  const picks = events.filter(e => e.type === 'pick');
  assert.equal(picks.length, 1);
  assert.equal(picks[0].pick.title, 'A show');
});

test('flushes a trailing pick with no closing newline', async () => {
  const events = await collect(transform(providerStream([
    delta(JSON.stringify(PICK_A)),
  ]), 'openai'));
  assert.equal(events.filter(e => e.type === 'pick').length, 1);
});

test('tolerates markdown fences and array punctuation', async () => {
  const events = await collect(transform(providerStream([
    delta('```json\n'),
    delta('[\n'),
    delta(JSON.stringify(PICK_A) + ',\n'),
    delta(JSON.stringify(PICK_B) + '\n'),
    delta(']\n```\n'),
  ]), 'openai'));
  assert.equal(events.filter(e => e.type === 'pick').length, 2);
});

test('drops unparseable lines rather than guessing', async () => {
  const events = await collect(transform(providerStream([
    delta('Here are some ideas for you:\n'),
    delta('{ not json at all\n'),
    delta(JSON.stringify(PICK_A) + '\n'),
  ]), 'openai'));
  const picks = events.filter(e => e.type === 'pick');
  assert.equal(picks.length, 1);
  assert.equal(picks[0].pick.title, 'A show');
});

test('ignores objects with no title', async () => {
  const events = await collect(transform(providerStream([
    delta(JSON.stringify({ slot: 'Tonight', venue: 'V' }) + '\n'),
  ]), 'openai'));
  assert.equal(events.filter(e => e.type === 'pick').length, 0);
  const err = events.find(e => e.type === 'error');
  assert.ok(err, 'a run with zero usable picks should report an error');
});

test('forwards search progress as status events', async () => {
  const events = await collect(transform(providerStream([
    'data: {"type":"response.web_search_call.searching"}\n\n',
    'data: {"type":"response.web_search_call.completed"}\n\n',
    delta(JSON.stringify(PICK_A) + '\n'),
  ]), 'xai'));
  const statuses = events.filter(e => e.type === 'status');
  assert.ok(statuses.length >= 3, 'opening status plus both search updates');
  assert.equal(statuses[0].provider, 'xai');
});

test('surfaces provider errors without dropping earlier picks', async () => {
  const events = await collect(transform(providerStream([
    delta(JSON.stringify(PICK_A) + '\n'),
    'data: {"type":"error","message":"rate limited"}\n\n',
  ]), 'openai'));
  assert.equal(events.filter(e => e.type === 'pick').length, 1);
  assert.equal(events.find(e => e.type === 'error').message, 'rate limited');
});

test('ignores [DONE] sentinels and malformed frames', async () => {
  const events = await collect(transform(providerStream([
    'data: [DONE]\n\n',
    'data: not-json\n\n',
    ': a comment line\n\n',
    delta(JSON.stringify(PICK_A) + '\n'),
  ]), 'openai'));
  assert.equal(events.filter(e => e.type === 'pick').length, 1);
});

test('prompt carries the profile, companions, and NDJSON contract', () => {
  const p = buildPrompt({
    mode: 'weekend',
    city: 'Berlin',
    dates: ['2026-08-21', '2026-08-22'],
    weather: 'rain',
    vibe: 'low key',
    budget: '$$',
    profile: { firstName: 'Jesse', interests: ['techno'], neighborhoods: ['Kreuzberg'] },
    companions: [{ name: 'Maya', relationship: 'inner circle', overdueDays: 21, interests: ['art'] }],
  });
  assert.match(p, /Berlin/);
  assert.match(p, /techno/);
  assert.match(p, /Kreuzberg/);
  assert.match(p, /Maya/);
  assert.match(p, /21 days since you last connected/);
  assert.match(p, /low key/);
  assert.match(p, /Forecast: rain/);
  assert.match(p, /NDJSON/);
  assert.match(p, /Emit 5 lines/); // weekend asks for five blocks
  assert.match(p, /2026-08-21, 2026-08-22/);
});

test('tonight mode asks for four options and leaves bring null with no circle', () => {
  const p = buildPrompt({ mode: 'tonight', city: 'Austin', date: '2026-08-20', companions: [] });
  assert.match(p, /Emit 4 lines/);
  assert.match(p, /leave "bring" null/);
});

test('grounded candidates appear in the prompt, capped at 20', () => {
  const candidates = Array.from({ length: 25 }, (_, i) => ({
    name: `Spot ${i}`, hood: 'Williamsburg', tags: ['food'], availability: 'Resy: tables Thu 19:00',
  }));
  const p = buildPrompt({ mode: 'tonight', city: 'New York', date: '2026-08-20', candidates });
  assert.match(p, /VETTED CANDIDATES/);
  assert.match(p, /Spot 0 \(Williamsburg\) Resy: tables Thu 19:00/);
  assert.match(p, /Spot 19/);
  assert.doesNotMatch(p, /Spot 20/);
});

test('no candidates means no vetted section', () => {
  const p = buildPrompt({ mode: 'tonight', city: 'New York', date: '2026-08-20' });
  assert.doesNotMatch(p, /VETTED CANDIDATES/);
});

test('planner mode asks for slot-enum options weighted to the evening', () => {
  const p = buildPrompt({
    mode: 'planner',
    city: 'New York',
    dates: ['2026-08-21', '2026-08-22', '2026-08-23'],
    vibe: 'impress Chen',
    locked: ['2026-08-21|dinner'],
    profile: { firstName: 'Jesse', interests: ['comedy'] },
    companions: [{ name: 'Chen', relationship: 'dating · new', overdueDays: 5 }],
  });
  assert.match(p, /one of: morning, afternoon, happyhour, dinner, night/);
  assert.match(p, /impress Chen/);
  assert.match(p, /comedy/);
  assert.match(p, /Chen/);
  assert.match(p, /2 × happyhour on 2026-08-21/);
  assert.match(p, /2 × night on 2026-08-21/);
  assert.doesNotMatch(p, /dinner on 2026-08-21/);
  assert.match(p, /already-chosen cells: 2026-08-21\|dinner/);
  // 3 days × 8 slots, minus the locked Friday dinner (2) = 22
  assert.match(p, /Emit 22 lines/);
});

test('anthropic stream shape produces picks and search status', async () => {
  const events = await collect(transform(providerStream([
    'data: {"type":"content_block_start","content_block":{"type":"server_tool_use"}}\n\n',
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify(PICK_A) + '\n' } })}\n\n`,
  ]), 'anthropic'));
  assert.equal(events.filter(e => e.type === 'pick').length, 1);
  assert.ok(events.filter(e => e.type === 'status').length >= 2);
});

test('gemini stream shape produces picks', async () => {
  const events = await collect(transform(providerStream([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(PICK_A) + '\n' }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(PICK_B) + '\n' }] } }] })}\n\n`,
  ]), 'gemini'));
  assert.equal(events.filter(e => e.type === 'pick').length, 2);
});
