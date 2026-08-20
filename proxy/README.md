# Orbit Concierge proxy

A single Cloudflare Worker with two jobs:

- **`POST /concierge`** — stands between the Orbit PWA and a search-capable
  LLM. It holds the API keys, so anyone you share Orbit with gets working
  Tonight / Weekend plans without bringing a key of their own.
- **`GET /feed?city=…`** — the shared per-city feed: events and venues that
  an ingestion agent publishes once per city (newsletters, Instagram,
  openings scans), served to every Orbit user there. Profiles never touch
  the server; ranking happens on-device.

## Deploy

```bash
cd proxy
npm install
npx wrangler login

# At least one provider key. All four are supported; the request's
# `provider` field picks one, otherwise the first configured wins
# (openai → xai → anthropic → gemini).
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put XAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY

# Optional: enable the shared city feed.
npx wrangler kv namespace create FEED   # paste the id into wrangler.toml
npx wrangler secret put FEED_ADMIN_KEY  # any long random string

npx wrangler deploy
```

Deploy prints a URL like `https://orbit-concierge.<subdomain>.workers.dev`.
Put that in Orbit under **Connect → Concierge**, or bake it in as
`PROXY_URL` in [`docs/app.js`](../docs/app.js).

Check it came up:

```bash
curl https://orbit-concierge.<subdomain>.workers.dev/health
# {"ok":true,"service":"orbit-concierge","providers":["openai"]}
```

## API

`POST /concierge` with a JSON body:

```json
{
  "mode": "tonight",
  "city": "New York",
  "date": "2026-08-21",
  "dates": ["2026-08-21", "2026-08-22", "2026-08-23"],
  "weather": "72F, clear",
  "vibe": "low key, walkable",
  "budget": "$$",
  "provider": "openai",
  "profile": {
    "firstName": "Jesse",
    "interests": ["live music", "food"],
    "neighborhoods": ["Williamsburg"],
    "dateStyles": ["drinks"],
    "datingMode": "actively"
  },
  "companions": [
    { "name": "Maya", "relationship": "inner circle", "overdueDays": 21, "interests": ["comedy"] }
  ],
  "candidates": [
    { "name": "Bar Test", "hood": "Williamsburg", "tags": ["cocktails"], "availability": "Resy: tables Thu 19:00–21:00", "url": "https://…" }
  ]
}
```

`candidates` (optional, up to 20) are pre-vetted events/venues from the
user's own taste engine. The model is told to prefer them when they fit and
verify with search — grounding, not a straitjacket.

The response is an SSE stream of four event types:

| `type` | Payload | Meaning |
| --- | --- | --- |
| `status` | `text` | Progress while the model searches |
| `pick` | `pick` | One complete suggestion, ready to render |
| `error` | `message` | Something went wrong; stream may continue |
| `done` | `count` | Finished |

Each `pick` carries `slot`, `date`, `title`, `venue`, `neighborhood`,
`startTime`, `price`, `kind`, `why`, `tip`, `url`, `bring`, and `indoor`.

## The feed API

```bash
# read (public, cached ~15 min)
curl 'https://…workers.dev/feed?city=new-york'
# → {"city":"new-york","updatedAt":"…","events":[…],"venues":[…]}

# write (ingestion agent only)
curl -X POST 'https://…workers.dev/feed' \
  -H "Authorization: Bearer $FEED_ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"city":"new-york","events":[…],"venues":[…]}'
```

Each POST replaces the city's feed wholesale (capped at 200 events + 200
venues); the agent owns merge/dedupe logic locally via Orbit's `/api/ingest`
and publishes the already-deduped pool.

## How it streams

OpenAI and xAI expose the same `/v1/responses` endpoint with a hosted
`web_search` tool, so one adapter covers both (xAI also gets `x_search`, which
pulls in X posts). xAI's older Live Search `search_parameters` field is gone —
it returns `410 Gone` — which is why this talks to `/v1/responses` rather than
`/v1/chat/completions`. Anthropic (`/v1/messages` + `web_search_20250305`)
and Gemini (`streamGenerateContent` + `google_search`) get their own small
adapters; each maps its SSE events to the same internal
`{delta|searching|error}` signals.

The model is asked for NDJSON: one complete JSON object per line. The Worker
watches `response.output_text.delta` events, splits on newlines, parses each
finished line, and forwards it as a `pick`. That means cards can render one at
a time as they arrive, without anyone having to parse half-finished JSON.

## Cost and abuse

You are paying for every request, so the Worker:

- only accepts requests from the origins in `ALLOWED_ORIGINS` (plus any
  localhost port, for local development);
- rate limits per IP — uncomment the `RATE_LIMITER` binding in
  [`wrangler.toml`](./wrangler.toml) for a real cross-isolate limit, otherwise
  it falls back to a best-effort in-memory counter capped by `DAILY_LIMIT`.

Nothing is stored. No profile, no request body, no response.
