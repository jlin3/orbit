# Orbit

A personal relationship manager built around one principle: **fewer people, deeper bonds.**
Local-first, zero dependencies, all data in one JSON file you own.

## Run it

```sh
node ~/orbit/server.js
# → http://localhost:4747
```

Or enable **Always-on** in the app's Connect tab (installs a LaunchAgent that starts Orbit
at login).

## The system

- **Onboarding wizard** — first launch collects your profile: interests, neighborhoods,
  social budget (hangs/week), preferred nights, dating mode, date styles. Everything
  downstream (event search, idea matching, Today stats) keys off it. Re-open via ✦.
- **Tiers with cadences** — Inner circle (7d), Close (21d), Keep warm (60d). Anyone past
  their cadence shows up on **Today** under "Reach out" with a matched activity idea.
- **Triage** — paste any list, or one-click import Apple Contacts, then sort with keys
  `1`/`2`/`3`/`X`. Cutting archives (history kept).
- **Dating pipeline** — drag cards through New → Talking → Going on dates → Serious;
  5-day cadence, "next step" on every card.
- **Ideas** — NYC activity/date bank tagged by vibe; "Plan it →" schedules it with someone.
- **Plans** — marking done auto-logs contact for everyone on it; feeds a calendar
  subscription (`/api/calendar.ics`).
- **Digest** — daily summary at `/api/digest`, delivered every morning at 8 by a
  scheduled agent that also pulls in NYC events matched to your profile.
- **Connect tab** — one-click contacts import, Apple Calendar subscription, always-on
  LaunchAgent, Gmail delivery guidance, JSON export.

## Design / UI

Vanilla JS + CSS, no build step. Light/dark themes (`☾`), View Transitions between tabs,
⌘K command palette, drag-and-drop pipeline, spring micro-interactions, staggered reveals,
`prefers-reduced-motion` respected.

## API (used by the daily agent)

- `GET  /api/digest` — full digest as JSON + rendered markdown
- `POST /api/events` — `{"events": [...]}` replaces the NYC events on Today / in the digest
- `GET  /api/calendar.ics` — iCal feed of upcoming plans
- `GET  /api/connections` — integration status (launch agent, digest task, platform)
- `POST /api/import/macos-contacts` — reads Contacts via osascript (permission prompt)
- `POST /api/setup/launchagent` — `{"enable": true|false}` installs/removes always-on
- `GET/PUT /api/state` — full app state

Data lives in `data.json` (daily backups in `backups/`). `seed.json` is the fresh-install
template.
