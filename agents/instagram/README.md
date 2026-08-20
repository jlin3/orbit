# Instagram sidecar

Collects recent posts/reels from the curated NYC accounts in `accounts.txt`
using your Instagram session, and prints candidate posts as JSON. The daily
agent then LLM-extracts venues/events from the captions and POSTs them to
Orbit's `/api/ingest`.

This is the one Python component in Orbit (instagrapi has no Node
equivalent). It lives in its own venv and is never imported by the server.

## Setup (once)

```bash
cd agents/instagram
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
IG_USERNAME=you IG_PASSWORD=... .venv/bin/python fetch.py --login   # saves session.json
```

## Daily run (what the agent does)

```bash
.venv/bin/python fetch.py   # JSON on stdout: {posts, errors, accounts_visited}
```

## Why it won't get your account flagged (probably)

Using an unofficial client is against Instagram's ToS and carries real risk.
The sidecar minimizes it:

- one persisted session + fixed device fingerprint (`session.json`) — looks
  like the same phone every day, never a fresh login;
- hard budget of 12 API calls per run, 3–8s randomized delays, once daily;
- accounts visited in rotation (cursor in `state.json`), so a long list stays
  under budget;
- any challenge/checkpoint = immediate stop + Slack alert
  (`SLACK_ALERTS_WEBHOOK`), never a retry.

If you get a challenge: open the Instagram app, approve the "was this you?"
prompt, then re-run `--login` to refresh the session.

## Tuning

Constants at the top of `fetch.py`: `MAX_CALLS`, `ACCOUNTS_PER_RUN`,
`POSTS_PER_ACCOUNT`, `RECENT_DAYS`. Edit `accounts.txt` freely — one handle
per line, `#` comments.
