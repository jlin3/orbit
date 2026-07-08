# Orbit

A personal relationship manager built around one principle: **fewer people, deeper bonds.**
Zero dependencies, no build step. One codebase runs two ways:

- **Local (Mac):** `node server.js` → http://localhost:4747 — full API: contacts import,
  calendar feed, launch agent, daily-agent endpoints. Data in `data.json` (gitignored).
- **Web (PWA):** the same `docs/` folder served statically (GitHub Pages) — data lives in
  the browser, with optional **end-to-end encrypted sync** through a private GitHub gist
  (AES-GCM, key derived from a passphrase via PBKDF2; GitHub only ever stores ciphertext).

## The system

- **Onboarding wizard** (✦) — interests, neighborhoods, social budget, nights out, dating
  mode, date styles. Everything downstream keys off this profile.
- **Tiers with cadences** — Inner (7d) / Close (21d) / Keep warm (60d); overdue people
  surface on Today with a matched activity idea. Dating pipeline runs a faster 5d cadence.
- **The constellation** — Today's header draws your circle as dots on orbit rings;
  overdue people pulse. Click a dot to open them.
- **Triage** — paste any list (or import Apple Contacts locally) and sort with `1`/`2`/`3`/`X`.
- **Reach-out channels** — per-person handles power one-tap drafts into **Messages,
  WhatsApp, Instagram, X** (draft copied + right app opened).
- **Plans** — every plan has a one-click **Google Calendar** button; marking done
  auto-logs contact for everyone on it. Local mode also serves an iCal feed.
- **Digest** — daily 8am agent (Claude scheduled task on the Mac) pulls NYC events
  matched to the profile, loads them into Orbit, and delivers the digest by **Slack
  webhook** and/or email.
- **Design** — light/dark, View Transitions, ⌘K palette, bottom tab bar + safe areas on
  mobile, spring micro-interactions, drag-and-drop pipeline, `prefers-reduced-motion`
  respected. Installable PWA (manifest + service worker + offline shell).

## API (local mode, used by the daily agent)

- `GET  /api/digest` · `POST /api/events` · `GET /api/calendar.ics`
- `GET  /api/connections` · `POST /api/import/macos-contacts` · `POST /api/setup/launchagent`
- `GET/PUT /api/state`

`docs/seed.json` is the fresh-install template (fictional sample people only —
real data never leaves `data.json` / the browser / the encrypted gist).
