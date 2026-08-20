#!/usr/bin/env python3
"""Instagram source collector for Orbit.

Reads recent posts/reels from the curated accounts in accounts.txt using YOUR
Instagram session (instagrapi), and prints candidate posts as JSON for the
daily agent to extract venues/events from.

This logs in as a real account, so it is deliberately timid:

- one persisted session (session.json) + fixed device fingerprint — never a
  fresh login per run;
- a hard budget of API calls per run, with randomized human-ish delays;
- accounts are visited in rotation across runs (cursor in state.json), so a
  long list stays under budget;
- any challenge/checkpoint stops the run immediately (alert via
  SLACK_ALERTS_WEBHOOK when set) — no retries, ever.

First run:  IG_USERNAME=you IG_PASSWORD=... python3 fetch.py --login
Daily run:  python3 fetch.py            (uses session.json)
"""

import json
import os
import random
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
SESSION_FILE = HERE / "session.json"
STATE_FILE = HERE / "state.json"
ACCOUNTS_FILE = HERE / "accounts.txt"

MAX_CALLS = 12          # hard API-call budget per run
ACCOUNTS_PER_RUN = 5    # visited in rotation
POSTS_PER_ACCOUNT = 6
RECENT_DAYS = 7
calls_made = 0


def sleep_a_bit():
    time.sleep(random.uniform(3, 8))


def budget():
    global calls_made
    calls_made += 1
    if calls_made > MAX_CALLS:
        raise RuntimeError(f"call budget ({MAX_CALLS}) exhausted — stopping cleanly")
    if calls_made > 1:
        sleep_a_bit()


def alert(message: str):
    webhook = os.environ.get("SLACK_ALERTS_WEBHOOK")
    print(f"ALERT: {message}", file=sys.stderr)
    if not webhook:
        return
    try:
        req = urllib.request.Request(
            webhook,
            data=json.dumps({"text": f"Orbit instagram sidecar: {message}"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"cursor": 0, "user_ids": {}}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def get_client(do_login: bool):
    from instagrapi import Client

    cl = Client()
    cl.delay_range = [3, 8]  # instagrapi's own inter-request jitter
    if SESSION_FILE.exists():
        cl.load_settings(SESSION_FILE)  # session + fixed device fingerprint
    if do_login:
        username = os.environ.get("IG_USERNAME")
        password = os.environ.get("IG_PASSWORD")
        if not (username and password):
            sys.exit("set IG_USERNAME and IG_PASSWORD for --login")
        cl.login(username, password)
        cl.dump_settings(SESSION_FILE)
        print(json.dumps({"ok": True, "note": f"session saved to {SESSION_FILE.name}"}))
        sys.exit(0)
    if not SESSION_FILE.exists():
        sys.exit("no session.json — run once with --login first")
    # Reuse the session without a fresh login; get_timeline etc. will raise
    # LoginRequired if the session died, which we treat as a hard stop.
    return cl


def main():
    do_login = "--login" in sys.argv
    cl = get_client(do_login)

    accounts = [
        line.strip().lstrip("@")
        for line in ACCOUNTS_FILE.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if not accounts:
        sys.exit("accounts.txt is empty")

    state = load_state()
    start = state.get("cursor", 0) % len(accounts)
    batch = [accounts[(start + i) % len(accounts)] for i in range(min(ACCOUNTS_PER_RUN, len(accounts)))]

    cutoff = datetime.now(timezone.utc) - timedelta(days=RECENT_DAYS)
    posts, errors = [], []

    try:
        for username in batch:
            try:
                user_id = state["user_ids"].get(username)
                if not user_id:
                    budget()
                    user_id = str(cl.user_id_from_username(username))
                    state["user_ids"][username] = user_id
                budget()
                medias = cl.user_medias(int(user_id), amount=POSTS_PER_ACCOUNT)
            except Exception as e:  # instagrapi raises many specific types
                name = type(e).__name__
                if name in ("LoginRequired", "ChallengeRequired", "TwoFactorRequired"):
                    alert(f"session challenged ({name}) — stopped immediately, re-login needed")
                    raise SystemExit(1)
                if name in ("PleaseWaitFewMinutes", "RateLimitError"):
                    alert(f"rate limited ({name}) — stopped for today")
                    break
                errors.append({"account": username, "error": f"{name}: {e}"})
                continue

            for m in medias:
                taken = m.taken_at if m.taken_at.tzinfo else m.taken_at.replace(tzinfo=timezone.utc)
                if taken < cutoff:
                    continue
                posts.append({
                    "account": username,
                    "taken_at": taken.strftime("%Y-%m-%d"),
                    "media_type": {1: "photo", 2: "reel", 8: "album"}.get(m.media_type, str(m.media_type)),
                    "caption": (m.caption_text or "")[:1000],
                    "location": m.location.name if m.location else None,
                    "url": f"https://www.instagram.com/p/{m.code}/",
                })
    finally:
        state["cursor"] = (start + len(batch)) % len(accounts)
        save_state(state)

    print(json.dumps({"posts": posts, "errors": errors, "accounts_visited": batch, "calls_made": calls_made}, indent=2))


if __name__ == "__main__":
    main()
