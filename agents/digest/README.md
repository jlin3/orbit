# Digest delivery

The last step of the 8am agent. Orbit writes the email and the agent sends
it. The agent never writes digest copy of its own.

## Contract

```bash
curl -s http://localhost:4747/api/digest
```

```json
{
  "date": "2026-09-24",
  "deliveries": [
    { "to": "you@example.com",   "edition": "owner", "subject": "…", "preheader": "…", "html": "<!DOCTYPE html>…", "text": "…" },
    { "to": "friend@example.com", "edition": "guest", "subject": "…", "preheader": "…", "html": "<!DOCTYPE html>…", "text": "…" }
  ],
  "subject": "…", "html": "…", "text": "…"
}
```

For **each** entry in `deliveries`, send **one** email:

- `to`: that entry's `to`, and nobody else. No cc, no bcc, no combining.
- `subject`: the entry's `subject`, verbatim.
- HTML body: the entry's `html`, verbatim (Gmail: `htmlBody`).
- Plain-text alternative: the entry's `text` (Gmail: `body`).

Rules:

- **Never send the `owner` edition to anyone but the owner.** It holds your
  people, dating pipeline, and plans. Friends get the `guest` edition, which
  only carries the city picks.
- Don't add intros, corrections, sign-offs, or "start your own Orbit" footers.
  The guest edition already ends with that invitation.
- `deliveries` can be empty (no owner email set, or nothing worth sending).
  Then send nothing.
- If the numbers look wrong, fix the data or the code and re-run. Don't send
  a hand-written correction.

Slack: post the owner edition's `text` to the webhook, never a guest edition.

## Who gets what

- **Owner:** `settings.email`, set during onboarding.
- **Guests:** `settings.digestGuests`, a list of `{ name, email }` edited
  in Orbit → Digest ("Also send the city edition to"). A guest's optional
  `interests` / `neighborhoods` tune their picks.

## Preview

- In the app: Orbit → Digest (toggle *Your edition* / *Izzy's edition*).
- In a browser: `http://localhost:4747/api/digest.html` or
  `http://localhost:4747/api/digest.html?edition=guest`.

The renderer is [`docs/digest.js`](../../docs/digest.js). The app's
preview and the agent's email both come from it.
