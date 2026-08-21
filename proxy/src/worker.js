// Orbit Concierge — Cloudflare Worker proxy.
//
// Two jobs:
//
//   POST /concierge      — turns an Orbit profile into real, verifiable things
//                          to do tonight or this weekend (SSE stream of picks).
//   GET/POST /feed       — the shared per-city feed: events + venues ingested
//                          once per city (by the ingestion agent) and served to
//                          every Orbit user there. Profiles never touch the
//                          server; ranking happens on-device.
//
// Provider adapters: OpenAI and xAI share the /v1/responses + web_search
// shape; Anthropic and Gemini get their own `call`/`interpret` pair. Each
// adapter's `interpret` maps one parsed SSE event to {delta|searching|checked|error}.

function responsesProvider(url, keyVar, modelVar, defaultModel, tools) {
  return {
    keyVar,
    modelVar,
    defaultModel,
    async call(env, prompt) {
      return providerFetch(url, {
        Authorization: `Bearer ${env[keyVar]}`,
      }, {
        model: env[modelVar] || defaultModel,
        input: prompt,
        tools,
        stream: true,
      });
    },
    interpret(ev) {
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') return { delta: ev.delta };
      if (ev.type === 'response.web_search_call.searching') return { searching: true };
      if (ev.type === 'response.web_search_call.completed') return { checked: true };
      if (ev.type === 'error' || ev.type === 'response.failed') return { error: ev.message || 'The model stopped early.' };
      return null;
    },
  };
}

const PROVIDERS = {
  openai: responsesProvider(
    'https://api.openai.com/v1/responses',
    'OPENAI_API_KEY', 'OPENAI_MODEL', 'gpt-5.6',
    [{ type: 'web_search' }],
  ),
  xai: responsesProvider(
    'https://api.x.ai/v1/responses',
    'XAI_API_KEY', 'XAI_MODEL', 'grok-4.6',
    [{ type: 'web_search' }, { type: 'x_search' }],
  ),
  anthropic: {
    keyVar: 'ANTHROPIC_API_KEY',
    modelVar: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-sonnet-4-5',
    async call(env, prompt) {
      return providerFetch('https://api.anthropic.com/v1/messages', {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      }, {
        model: env.ANTHROPIC_MODEL || this.defaultModel,
        max_tokens: 8000,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      });
    },
    interpret(ev) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') return { delta: ev.delta.text };
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'server_tool_use') return { searching: true };
      if (ev.type === 'error') return { error: ev.error?.message || 'The model stopped early.' };
      return null;
    },
  },
  gemini: {
    keyVar: 'GEMINI_API_KEY',
    modelVar: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.5-flash',
    async call(env, prompt) {
      const model = env.GEMINI_MODEL || this.defaultModel;
      return providerFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        { 'x-goog-api-key': env.GEMINI_API_KEY },
        {
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
        },
      );
    },
    interpret(ev) {
      const parts = ev.candidates?.[0]?.content?.parts;
      if (parts) {
        const text = parts.map(p => p.text || '').join('');
        if (text) return { delta: text };
      }
      if (ev.error) return { error: ev.error.message || 'The model stopped early.' };
      return null;
    },
  },
};

async function providerFetch(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`provider responded ${res.status}: ${detail.slice(0, 400)}`);
  }
  return res.body;
}

const DEFAULT_ORIGINS = [
  'https://getorbit.pages.dev',
  'https://getorbit.fyi',
  'https://jlin3.github.io',
  'http://localhost:4747',
  'http://127.0.0.1:4747',
];

// A pick has to be actionable: a real place, a real time, and a reason it
// belongs to *this* person. Anything vaguer is noise.
const PICK_SHAPE = `{
  "slot": "short label for when this happens, e.g. \\"Tonight\\", \\"Friday night\\", \\"Saturday afternoon\\"",
  "date": "YYYY-MM-DD",
  "title": "the thing to do, specific and under 60 chars",
  "venue": "venue or place name",
  "neighborhood": "neighborhood or area",
  "startTime": "HH:MM in 24h local time, or null if it runs all day",
  "price": "one of: free, $, $$, $$$",
  "kind": "one of: music, comedy, food, drinks, art, film, outdoors, active, wellness, games, nightlife, home",
  "why": "one sentence, second person, why this fits THEM specifically",
  "tip": "one short insider line — booking, timing, what to order",
  "url": "a real URL for tickets/listing/venue, or null if you are not sure",
  "bring": "first name of the suggested companion from their circle, or null",
  "indoor": true
}`;

const PICK_SHAPE_PLANNER = `{
  "slot": "one of: morning, afternoon, happyhour, dinner, night",
  "date": "YYYY-MM-DD",
  "title": "the thing to do, specific and under 60 chars",
  "venue": "venue or place name",
  "neighborhood": "neighborhood or area",
  "startTime": "HH:MM in 24h local time, or null if it runs all day",
  "price": "one of: free, $, $$, $$$",
  "kind": "one of: music, comedy, food, drinks, art, film, outdoors, active, wellness, games, nightlife, home",
  "why": "one sentence, second person, why this fits THEM specifically",
  "tip": "one short insider line — booking, timing, what to order",
  "url": "a real URL for tickets/listing/venue, or null if you are not sure",
  "bring": "first name of the suggested companion from their circle, or null",
  "indoor": true
}`;

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) },
  });
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS || '').trim()
    ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;
  if (list.includes('*') || list.includes(origin)) return origin;
  // Allow any localhost port so `node server.js` works on a custom PORT.
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return false;
}

// Best-effort limiter. Uses the native rate-limiting binding when it's
// configured; otherwise falls back to an in-isolate counter, which is weaker
// (Workers spin up many isolates) but still blunts a runaway client.
const memHits = new Map();

async function overLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.RATE_LIMITER?.limit) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      return !success;
    } catch {
      /* fall through to the in-memory counter */
    }
  }
  const max = Number(env.DAILY_LIMIT || 200);
  const day = new Date().toISOString().slice(0, 10);
  const key = `${ip}|${day}`;
  const n = (memHits.get(key) || 0) + 1;
  memHits.set(key, n);
  if (memHits.size > 5000) memHits.clear();
  return n > max;
}

function pickProvider(env, requested) {
  const available = Object.keys(PROVIDERS).filter(k => env[PROVIDERS[k].keyVar]);
  if (!available.length) return null;
  if (requested && available.includes(requested)) return requested;
  return available[0];
}

const PLANNER_SLOTS = [
  { id: 'morning', n: 1 },
  { id: 'afternoon', n: 1 },
  { id: 'happyhour', n: 2 },
  { id: 'dinner', n: 2 },
  { id: 'night', n: 2 },
];

function plannerWanted(dates, locked) {
  const skip = new Set(locked || []);
  const wanted = [];
  for (const date of dates) {
    for (const { id, n } of PLANNER_SLOTS) {
      if (skip.has(`${date}|${id}`)) continue;
      wanted.push({ date, slot: id, n });
    }
  }
  return wanted;
}

function buildPrompt(body) {
  const {
    mode = 'tonight',
    city = '',
    date = '',
    dates = [],
    weather = null,
    vibe = '',
    budget = '',
    profile = {},
    companions = [],
    candidates = [],
    locked = [],
  } = body;

  const {
    firstName = '',
    interests = [],
    neighborhoods = [],
    dateStyles = [],
    datingMode = '',
  } = profile;

  if (mode === 'planner') {
    const windowDates = (dates.length ? dates : [date]).filter(Boolean);
    const wanted = plannerWanted(windowDates, locked);
    const count = wanted.reduce((n, w) => n + w.n, 0);
    const quota = wanted.map(w => `${w.n} × ${w.slot} on ${w.date}`).join('\n');
    const lockedLine = (locked || []).length
      ? `Do not emit anything for these already-chosen cells: ${locked.join(', ')}.`
      : '';

    const grounded = (candidates || []).slice(0, 20).map(c => {
      const bits = [c.title || c.name];
      if (c.venue) bits.push(`@ ${c.venue}`);
      if (c.hood || c.neighborhood) bits.push(`(${c.hood || c.neighborhood})`);
      if (c.date) bits.push(c.date);
      if (c.availability) bits.push(c.availability);
      if (c.tags?.length) bits.push(`[${c.tags.slice(0, 4).join(', ')}]`);
      if (c.url) bits.push(c.url);
      return `- ${bits.join(' ')}`;
    });

    const people = companions.length
      ? companions.map(c => {
          const bits = [c.relationship || 'friend'];
          if (c.overdueDays > 0) bits.push(`${c.overdueDays} days since you last connected`);
          if (c.interests?.length) bits.push(`into ${c.interests.join(', ')}`);
          return `- ${c.name} (${bits.join('; ')})`;
        }).join('\n')
      : '- (nobody in their circle yet — leave "bring" null)';

    return [
      `You are Orbit's planner. ${firstName ? firstName + ' lives' : 'The user lives'} in ${city}.`,
      '',
      `Fill a calendar for ${windowDates.join(', ') || date}. Each day is split into morning, afternoon, happyhour, dinner, and night.`,
      `Return exactly ${count} competing options, allocated as:`,
      quota,
      lockedLine,
      '',
      'THEIR PROFILE',
      `- Into: ${interests.join(', ') || 'not specified'}`,
      `- Usually hangs around: ${neighborhoods.join(', ') || 'anywhere in ' + city}`,
      dateStyles.length ? `- Enjoys these kinds of dates: ${dateStyles.join(', ')}` : null,
      datingMode ? `- Dating mode: ${datingMode}` : null,
      budget ? `- Budget: ${budget}` : null,
      vibe ? `- What they asked for: "${vibe}"` : null,
      weather ? `- Forecast: ${weather}` : null,
      '',
      'THEIR CIRCLE (suggest who to bring, favoring people they have not seen in a while)',
      people,
      '',
      ...(grounded.length ? [
        'VETTED CANDIDATES (from their own sources — newsletters, local accounts, availability checks). Prefer these when they fit the request; verify dates and hours with search before using one:',
        ...grounded,
        '',
      ] : []),
      'RULES',
      `1. Search the web first. Only suggest things that are actually happening in ${city} on the given dates, or venues you have confirmed are open.`,
      '2. Prefer primary sources: venue sites, ticketing pages, event listings, local press. Check dates carefully — never surface a past event.',
      '3. No generic filler ("go to a nice restaurant"). Name the place. Options in the same cell must be different places.',
      '4. Bias toward their interests and neighborhoods, but include one thing that pleasantly surprises them.',
      '5. If the forecast is bad, favor indoor picks and set "indoor" accordingly.',
      '6. Slot meanings: morning = brunch, gym, wellness, a walk; afternoon = museums, outdoors, matinees; happyhour = drinks; dinner = a real table; night = shows, comedy, music, late entertainment.',
      '7. "slot" must be exactly one of: morning, afternoon, happyhour, dinner, night.',
      '',
      'OUTPUT FORMAT — this matters',
      `Emit one JSON object per line (NDJSON). No markdown fences, no wrapper array, no commentary before or after. Each line must be a complete, parseable JSON object of exactly this shape:`,
      PICK_SHAPE_PLANNER,
      '',
      `Emit ${count} lines and then stop.`,
    ].filter(l => l !== null).join('\n');
  }

  const count = mode === 'weekend' ? 5 : 4;
  const window = mode === 'weekend'
    ? `the upcoming weekend (${dates.join(', ') || date})`
    : `${date}`;

  // Grounded candidates come from the user's taste engine (newsletters, IG,
  // openings scans, availability checks) — already matched to their profile.
  const grounded = (candidates || []).slice(0, 20).map(c => {
    const bits = [c.title || c.name];
    if (c.venue) bits.push(`@ ${c.venue}`);
    if (c.hood || c.neighborhood) bits.push(`(${c.hood || c.neighborhood})`);
    if (c.date) bits.push(c.date);
    if (c.availability) bits.push(c.availability);
    if (c.tags?.length) bits.push(`[${c.tags.slice(0, 4).join(', ')}]`);
    if (c.url) bits.push(c.url);
    return `- ${bits.join(' ')}`;
  });

  const people = companions.length
    ? companions.map(c => {
        const bits = [c.relationship || 'friend'];
        if (c.overdueDays > 0) bits.push(`${c.overdueDays} days since you last connected`);
        if (c.interests?.length) bits.push(`into ${c.interests.join(', ')}`);
        return `- ${c.name} (${bits.join('; ')})`;
      }).join('\n')
    : '- (nobody in their circle yet — leave "bring" null)';

  const lines = [
    `You are Orbit's concierge. ${firstName ? firstName + ' lives' : 'The user lives'} in ${city}.`,
    '',
    `Plan ${window}. Return exactly ${count} ${mode === 'weekend' ? 'itinerary blocks that flow together across the weekend' : 'options for the evening'}.`,
    '',
    'THEIR PROFILE',
    `- Into: ${interests.join(', ') || 'not specified'}`,
    `- Usually hangs around: ${neighborhoods.join(', ') || 'anywhere in ' + city}`,
    dateStyles.length ? `- Enjoys these kinds of dates: ${dateStyles.join(', ')}` : null,
    datingMode ? `- Dating mode: ${datingMode}` : null,
    budget ? `- Budget tonight: ${budget}` : null,
    vibe ? `- What they asked for: "${vibe}"` : null,
    weather ? `- Forecast: ${weather}` : null,
    '',
    'THEIR CIRCLE (suggest who to bring, favoring people they have not seen in a while)',
    people,
    '',
    ...(grounded.length ? [
      'VETTED CANDIDATES (from their own sources — newsletters, local accounts, availability checks). Prefer these when they fit the request; verify dates and hours with search before using one:',
      ...grounded,
      '',
    ] : []),
    'RULES',
    `1. Search the web first. Only suggest things that are actually happening in ${city} on the given dates, or venues you have confirmed are open.`,
    '2. Prefer primary sources: venue sites, ticketing pages, event listings, local press. Check dates carefully — never surface a past event.',
    '3. No generic filler ("go to a nice restaurant"). Name the place.',
    '4. Bias toward their interests and neighborhoods, but include one thing that pleasantly surprises them.',
    '5. If the forecast is bad, favor indoor picks and set "indoor" accordingly.',
    mode === 'weekend'
      ? '6. Blocks should span the weekend and vary in energy: something social, something calm, something worth telling people about. Pace them so the weekend feels designed, not stacked.'
      : '6. Vary price and energy across the options so there is a real choice to make.',
    '',
    'OUTPUT FORMAT — this matters',
    `Emit one JSON object per line (NDJSON). No markdown fences, no wrapper array, no commentary before or after. Each line must be a complete, parseable JSON object of exactly this shape:`,
    PICK_SHAPE,
    '',
    `Emit ${count} lines and then stop.`,
  ];

  return lines.filter(l => l !== null).join('\n');
}

// Reads the provider's SSE stream, pulls out text deltas, and re-emits our own
// much simpler event stream: status pings while it searches, one `pick` per
// completed NDJSON line, then `done`.
function transform(providerStream, providerKey) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      const send = obj => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let sseBuffer = '';
      let lineBuffer = '';
      let picks = 0;

      const flushLine = raw => {
        const line = raw.trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
        if (!line || line === '[' || line === ']' || line === ',') return;
        const cleaned = line.replace(/,$/, '');
        if (!cleaned.startsWith('{')) return;
        try {
          const pick = JSON.parse(cleaned);
          if (pick && pick.title) {
            picks++;
            send({ type: 'pick', pick });
          }
        } catch {
          /* an incomplete or non-JSON line — drop it rather than guess */
        }
      };

      try {
        send({ type: 'status', text: `Searching for what's actually on…`, provider: providerKey });
        const reader = providerStream.getReader();

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          const frames = sseBuffer.split('\n\n');
          sseBuffer = frames.pop() ?? '';

          for (const frame of frames) {
            for (const rawLine of frame.split('\n')) {
              if (!rawLine.startsWith('data:')) continue;
              const payload = rawLine.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;

              let ev;
              try { ev = JSON.parse(payload); } catch { continue; }

              const sig = PROVIDERS[providerKey].interpret(ev);
              if (!sig) continue;
              if (sig.delta) {
                lineBuffer += sig.delta;
                let nl;
                while ((nl = lineBuffer.indexOf('\n')) !== -1) {
                  flushLine(lineBuffer.slice(0, nl));
                  lineBuffer = lineBuffer.slice(nl + 1);
                }
              } else if (sig.searching) {
                send({ type: 'status', text: 'Reading listings and venue pages…' });
              } else if (sig.checked) {
                send({ type: 'status', text: 'Cross-checking dates…' });
              } else if (sig.error) {
                send({ type: 'error', message: sig.error });
              }
            }
          }
        }

        if (lineBuffer.trim()) flushLine(lineBuffer);
        if (!picks) send({ type: 'error', message: 'No plans came back — try again in a moment.' });
        send({ type: 'done', count: picks });
      } catch (err) {
        send({ type: 'error', message: String(err?.message || err) });
      } finally {
        controller.close();
      }
    },
  });
}

// Exported for tests — the NDJSON-over-SSE parsing is the part most worth
// pinning down, and it can't be exercised without a provider key otherwise.
export { transform, buildPrompt };

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (origin === false) return new Response('Origin not allowed', { status: 403 });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({
        ok: true,
        service: 'orbit-concierge',
        providers: Object.keys(PROVIDERS).filter(k => env[PROVIDERS[k].keyVar]),
        feed: Boolean(env.FEED),
      }, 200, origin);
    }

    // The shared per-city feed. Public read (cached), admin-key write.
    if (url.pathname === '/feed') {
      if (!env.FEED) return json({ error: 'feed not configured on this proxy (bind a FEED KV namespace)' }, 503, origin);
      const city = (url.searchParams.get('city') || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      if (request.method === 'GET') {
        if (!city) return json({ error: 'city is required, e.g. /feed?city=new-york' }, 400, origin);
        const raw = await env.FEED.get(`feed:${city}`);
        return new Response(raw || JSON.stringify({ city, updatedAt: null, events: [], venues: [] }), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=900',
            ...cors(origin),
          },
        });
      }

      if (request.method === 'POST') {
        const auth = request.headers.get('Authorization') || '';
        if (!env.FEED_ADMIN_KEY || auth !== `Bearer ${env.FEED_ADMIN_KEY}`) {
          return json({ error: 'unauthorized' }, 401, origin);
        }
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Expected a JSON body' }, 400, origin); }
        const postCity = (body.city || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!postCity) return json({ error: 'city is required' }, 400, origin);
        const doc = {
          city: postCity,
          updatedAt: new Date().toISOString(),
          events: Array.isArray(body.events) ? body.events.slice(0, 200) : [],
          venues: Array.isArray(body.venues) ? body.venues.slice(0, 200) : [],
        };
        await env.FEED.put(`feed:${postCity}`, JSON.stringify(doc));
        return json({ ok: true, city: postCity, events: doc.events.length, venues: doc.venues.length }, 200, origin);
      }

      return json({ error: 'GET or POST /feed' }, 405, origin);
    }

    if (url.pathname !== '/concierge' || request.method !== 'POST') {
      return json({ error: 'POST /concierge' }, 404, origin);
    }

    if (await overLimit(request, env)) {
      return json({ error: 'Daily limit reached on this proxy. Try again tomorrow.' }, 429, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Expected a JSON body' }, 400, origin);
    }
    if (!body.city) return json({ error: 'city is required' }, 400, origin);

    const providerKey = pickProvider(env, body.provider);
    if (!providerKey) {
      return json({ error: 'No provider key configured on this proxy (set OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or XAI_API_KEY).' }, 503, origin);
    }

    let providerStream;
    try {
      providerStream = await PROVIDERS[providerKey].call(env, buildPrompt(body));
    } catch (err) {
      return json({ error: `${providerKey}: ${String(err?.message || err)}` }, 502, origin);
    }

    return new Response(transform(providerStream, providerKey), {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        ...cors(origin),
      },
    });
  },
};
