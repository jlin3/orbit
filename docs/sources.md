# Orbit sources — NYC pack

Orbit's recommendations are only as good as what flows in. This is the NYC
source pack: newsletters, Instagram accounts, and scan targets the ingestion
agent reads every morning. Other cities get their own pack with the same
structure.

## One-time email setup (~15 minutes)

1. Pick an alias on your existing Gmail: `you+orbit@gmail.com`. Every
   newsletter below gets subscribed with that address.
2. In Gmail, create a filter: `to:(you+orbit@gmail.com)` → apply label
   **Orbit/Sources**, skip the inbox. The daily agent reads that label and
   marks threads with **Orbit/Processed** when done.
3. Subscribe using the links below.

## Newsletters

| Newsletter | Covers | Cadence | Subscribe |
| --- | --- | --- | --- |
| The Skint | free/cheap events: comedy, art, screenings, pop-ups | daily | [theskint.com/newsletter-signup](https://www.theskint.com/newsletter-signup/) |
| Nonsense NYC | independent art, weird events, underground parties | weekly (Fri) | [nonsensenyc.com](https://nonsensenyc.com/) |
| coolstuff.nyc | gallery shows, food collabs, pop-ups, openings | weekly (Fri) | [coolstuffnyc.substack.com](https://coolstuffnyc.substack.com/) |
| The Infatuation NYC | restaurants: openings, hit lists, date-night guides | ~2x/week | [theinfatuation.com](https://www.theinfatuation.com/newsletter) |
| Eater NY | restaurant openings/closings, industry intel | daily | [ny.eater.com](https://ny.eater.com/newsletters) |
| Resy "The Hit List" | where to book right now | monthly+ | [resy.com](https://resy.com/) (account settings → emails) |
| Time Out New York | mainstream events, shows, exhibitions | weekly | [timeout.com/newyork](https://www.timeout.com/newyork) |
| The Nudge NYC | curated itineraries and date-worthy plans | 2-3x/week | [thenudge.com](https://www.thenudge.com/) |
| Average Socialite | themed pop-ups, ticketed experiences | weekly | [averagesocialite.com](https://www.averagesocialite.com/) |
| Oh My Rockness | indie/underground show listings | weekly | [ohmyrockness.com](https://www.ohmyrockness.com/) |
| NYC Gallery Openings | gallery openings and receptions | weekly | [nycgalleryopenings.com](https://www.nycgalleryopenings.com/) |
| Hell Gate | NYC news with strong culture coverage | daily | [hellgatenyc.com](https://hellgatenyc.com/) |

Feel free to prune: if a newsletter never produces a pick you act on, the
agent will notice (nothing it extracts gets saved or planned) and it should be
unsubscribed.

## Instagram accounts (read by the Instagram sidecar)

Starter list for `agents/instagram/accounts.txt` — notable NYC accounts whose
reels and posts regularly surface openings, events, and hot spots:

- `@thenewyorkeropenings` style openings trackers; `@eaterny`, `@infatuation`
- food/venue scouts: `@nycfoodgals`, `@heresyourbite`, `@newforkcity`
- events/culture: `@nonsense.nyc`, `@nycforfree`, `@secretnyc_`
- galleries: `@nycgalleryopenings`
- neighborhood-specific: add accounts for your own hoods (e.g. `@williamsburg`)

Curate this by hand — ten good accounts beat a hundred noisy ones.

## Weekly scan targets (openings & hot spots)

Every Monday the agent web-scans these and ingests venues:

- Eater NY — latest openings roundup ("Where to Eat" / openings map)
- The Infatuation — new openings + first looks
- Resy — "New on Resy" for the city
- Grub Street — openings coverage

## What the agent extracts

Every concrete item becomes one of:

- **event** — `{title, date, endDate?, venue, neighborhood, tags[], price?, url, source}`
- **venue** — `{name, hood, kind: restaurant|bar|gallery|venue|shop, tags[], status: opening-soon|new|hot|classic, url?, bookVia?, source}`

Both are POSTed to `POST /api/ingest`, which dedupes and counts independent
mentions ("buzz") — three sources in a month promotes a venue to **hot**.
