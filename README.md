# Orbit

A personal relationship manager built around one principle: **fewer people, deeper bonds.**
It keeps your closest people close — then tells you exactly what to do with them tonight
or this weekend, using real listings rather than generic advice.

Zero dependencies, no build step. One codebase runs two ways:

- **Local (Mac):** `node server.js` → http://localhost:4747 — full API: contacts import,
  calendar feed, launch agent, daily-agent endpoints. Data in `data.json` (gitignored).
- **Web (PWA):** the same `docs/` folder served statically (GitHub Pages) — data lives in
  the browser, with optional **end-to-end encrypted sync** through a private GitHub gist
  (AES-GCM, key derived from a passphrase via PBKDF2; GitHub only ever stores ciphertext).

A third piece is optional but makes the app what it is: [`proxy/`](./proxy) is a small
Cloudflare Worker that holds a model key so the concierge works for everyone you share
Orbit with, not just people who own an API key.

## The system

### The concierge

**Tonight** and **The weekend** answer the two questions the app exists for. Both search
the live web through the proxy, then filter results through your profile — your city, your
interests, your neighborhoods, your budget — and cross-reference your circle to suggest
*who to bring*, favoring whoever you've been meaning to see. Results stream in one card at
a time, and each one converts to a plan, saves to your library, or shares as a link.

Weather comes from Open-Meteo (keyless), so a rainy Friday quietly pushes the picks indoors.

### Everything else

- **Onboarding** — a full-screen, one-question-per-screen flow ending on your constellation.
  Sets city, interests, neighborhoods, social budget, nights out, cadences, dating mode,
  and goals. Everything downstream keys off this profile; ✦ reopens it to edit.
- **Tiers with cadences** — Inner (7d) / Close (21d) / Keep warm (60d); overdue people
  surface on Today with a matched activity idea. Dating pipeline runs a faster 5d cadence.
- **The constellation** — your circle as a star chart: tier sets the orbit radius, tier
  colour is a star temperature, overdue people pulse. Click a dot to open them.
- **Triage** — paste any list (or import Apple Contacts locally) and sort with `1`/`2`/`3`/`X`.
- **Reach-out channels** — per-person handles power one-tap drafts into **Messages,
  WhatsApp, Instagram, X** (draft copied + right app opened).
- **Plans** — every plan has a one-click **Google Calendar** button; marking done
  auto-logs contact for everyone on it. Local mode also serves an iCal feed.
- **Sharing** — any pick or full itinerary compresses into the URL fragment
  (`#s=…`, deflate-raw + base64url). Recipients get a read-only view of the plan and a way
  to start their own Orbit. Nothing is uploaded and no account exists to create.
- **Digest** — daily 8am agent (Claude scheduled task on the Mac) pulls events for your
  city matched to the profile, loads them into Orbit, and delivers the digest by
  **Slack webhook** and/or email.

## Design

"Deep Field" — dark-first and celestial, with an OKLCH token system, aurora accents, glass
surfaces, and a parallax starfield behind everything. Space Grotesk for UI, Instrument
Serif for editorial moments. Dawn (light) is the secondary theme.

View Transitions between routes, `linear()` spring easings, scroll-driven reveals where
supported, ⌘K palette, bottom tab bar with safe areas on mobile, drag-and-drop dating
pipeline. `prefers-reduced-motion` disables the starfield and all motion. Installable PWA
(manifest + service worker + offline shell).

## API (local mode, used by the daily agent)

- `GET  /api/digest` · `POST /api/events` · `GET /api/calendar.ics`
- `GET  /api/connections` · `POST /api/import/macos-contacts` · `POST /api/setup/launchagent`
- `GET/PUT /api/state`

`docs/seed.json` is the fresh-install template (fictional sample people only —
real data never leaves `data.json` / the browser / the encrypted gist). Seeded ideas carry
a `city`, so they only surface as suggestions to someone in that city.
