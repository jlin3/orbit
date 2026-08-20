# Orbit Concierge proxy

A single Cloudflare Worker that stands between the Orbit PWA and a
search-capable LLM. It holds the API key, so anyone you share Orbit with gets
working Tonight / Weekend plans without bringing a key of their own.

## Deploy

```bash
cd proxy
npm install
npx wrangler login

# At least one of these. OpenAI and xAI are both supported; if both keys are
# set, OpenAI is used unless the request asks for xai.
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put XAI_API_KEY

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
  ]
}
```

The response is an SSE stream of four event types:

| `type` | Payload | Meaning |
| --- | --- | --- |
| `status` | `text` | Progress while the model searches |
| `pick` | `pick` | One complete suggestion, ready to render |
| `error` | `message` | Something went wrong; stream may continue |
| `done` | `count` | Finished |

Each `pick` carries `slot`, `date`, `title`, `venue`, `neighborhood`,
`startTime`, `price`, `kind`, `why`, `tip`, `url`, `bring`, and `indoor`.

## How it streams

Both OpenAI and xAI expose the same `/v1/responses` endpoint with a hosted
`web_search` tool, so one adapter covers both (xAI also gets `x_search`, which
pulls in X posts). xAI's older Live Search `search_parameters` field is gone —
it returns `410 Gone` — which is why this talks to `/v1/responses` rather than
`/v1/chat/completions`.

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
