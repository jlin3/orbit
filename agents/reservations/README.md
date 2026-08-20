# Reservation adapters

Orbit's reservation layer does three things:

1. **Availability discovery** — check whether recommended restaurants actually
   have a table before suggesting them ("table for 2, Thu 8pm").
2. **Booking hand-off** — every restaurant rec carries a `bookVia` deep link.
3. **Auto-scheduling** — the daily agent parses confirmation emails in Gmail
   and POSTs them to Orbit's `/api/plans/ingest`, so confirmed reservations
   land on your calendar (and mark the venue visited) automatically.

## Resy (`resy.js`) — working adapter

Resy has no public API; this speaks the endpoints the resy.com web app uses,
with your own credentials. Grab them once:

1. Log in at resy.com, open DevTools → Network, click any restaurant.
2. On any `api.resy.com` request, copy the `Authorization: ResyAPI api_key="…"`
   value → `RESY_API_KEY`, and the `X-Resy-Auth-Token` header →
   `RESY_AUTH_TOKEN`.
3. Export both (e.g. in the shell profile the daily agent uses). Optional:
   `RESY_LAT` / `RESY_LONG` (defaults to downtown NYC).

Usage:

```bash
node resy.js search "Bernie's"
node resy.js check --venue "Bernie's" --day 2026-08-22 --party 2
# what the daily agent runs — checks Orbit's top unbooked restaurant picks
node resy.js scan --names "Bernie's, Place des Fêtes" --days 3 --party 2 --ingest http://localhost:4747
```

`scan` emits Orbit venue objects with an `availability` summary and `bookVia`
link, and (with `--ingest`) POSTs them straight into Orbit. Unofficial API:
expect it to break occasionally; every command fails soft with `{error}` JSON.

## Artemis, Resx — deep links for now

No adapter yet: both need their app traffic captured (a logged-in session)
before we can speak their APIs. Until then:

- Recs link out (`bookVia`) and you book in-app.
- Their **confirmation emails still work**: the daily agent parses whatever
  lands in Gmail regardless of platform, so bookings made through Artemis or
  Resx still auto-create Orbit plans and visit history.

To build an adapter later: proxy the app through Charles/mitmproxy, capture
the search + availability endpoints and auth headers, and follow the shape of
`resy.js`.
