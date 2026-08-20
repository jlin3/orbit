// Orbit Concierge — Cloudflare Worker proxy.
//
// One endpoint, POST /concierge, that turns an Orbit profile into a set of
// real, verifiable things to do tonight or this weekend. The provider key
// lives here so shared users never need one of their own.
//
// OpenAI and xAI both expose the same /v1/responses + web_search tool shape,
// so a single adapter drives both (xAI additionally gets x_search).

const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/responses',
    keyVar: 'OPENAI_API_KEY',
    modelVar: 'OPENAI_MODEL',
    defaultModel: 'gpt-5.6',
    tools: () => [{ type: 'web_search' }],
  },
  xai: {
    url: 'https://api.x.ai/v1/responses',
    keyVar: 'XAI_API_KEY',
    modelVar: 'XAI_MODEL',
    defaultModel: 'grok-4.6',
    tools: () => [{ type: 'web_search' }, { type: 'x_search' }],
  },
};

const DEFAULT_ORIGINS = [
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

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) },
  });
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
  const max = Number(env.DAILY_LIMIT || 40);
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
  } = body;

  const {
    firstName = '',
    interests = [],
    neighborhoods = [],
    dateStyles = [],
    datingMode = '',
  } = profile;

  const count = mode === 'weekend' ? 5 : 4;
  const window = mode === 'weekend'
    ? `the upcoming weekend (${dates.join(', ') || date})`
    : `${date}`;

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

async function callProvider(providerKey, env, prompt) {
  const p = PROVIDERS[providerKey];
  const res = await fetch(p.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env[p.keyVar]}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env[p.modelVar] || p.defaultModel,
      input: prompt,
      tools: p.tools(),
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${providerKey} responded ${res.status}: ${detail.slice(0, 400)}`);
  }
  return res.body;
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

              if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
                lineBuffer += ev.delta;
                let nl;
                while ((nl = lineBuffer.indexOf('\n')) !== -1) {
                  flushLine(lineBuffer.slice(0, nl));
                  lineBuffer = lineBuffer.slice(nl + 1);
                }
              } else if (ev.type === 'response.web_search_call.searching') {
                send({ type: 'status', text: 'Reading listings and venue pages…' });
              } else if (ev.type === 'response.web_search_call.completed') {
                send({ type: 'status', text: 'Cross-checking dates…' });
              } else if (ev.type === 'error' || ev.type === 'response.failed') {
                send({ type: 'error', message: ev.message || 'The model stopped early.' });
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
      }, 200, origin);
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
      return json({ error: 'No provider key configured on this proxy (set OPENAI_API_KEY or XAI_API_KEY).' }, 503, origin);
    }

    let providerStream;
    try {
      providerStream = await callProvider(providerKey, env, buildPrompt(body));
    } catch (err) {
      return json({ error: String(err?.message || err) }, 502, origin);
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
