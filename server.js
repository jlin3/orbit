#!/usr/bin/env node
// Orbit — personal relationship manager. Zero-dependency Node server.
// Serves the SPA from ./public, persists state to ./data.json,
// and exposes a digest endpoint for the daily email agent.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 4747;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'docs'); // same files GitHub Pages serves
const DATA_FILE = path.join(ROOT, 'data.json');
const SEED_FILE = path.join(ROOT, 'docs', 'seed.json');
const BACKUP_DIR = path.join(ROOT, 'backups');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function localISO(d = new Date()) {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

function loadState() {
  if (!fs.existsSync(DATA_FILE)) fs.copyFileSync(SEED_FILE, DATA_FILE);
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveState(state) {
  // one backup per day, kept forever (they're tiny)
  const backup = path.join(BACKUP_DIR, `data-${localISO()}.json`);
  if (fs.existsSync(DATA_FILE) && !fs.existsSync(backup)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DATA_FILE, backup);
  }
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function cadenceFor(person, settings) {
  if (person.type === 'dating' && person.stage && person.stage !== 'ended') {
    return settings.datingCadence || 5;
  }
  return settings.tiers[person.tier] || null;
}

function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return localISO(d);
}

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(toIso + 'T12:00:00') - new Date(fromIso + 'T12:00:00')) / 86400000);
}

function nextBirthday(bday) { // "MM-DD" → next occurrence as YYYY-MM-DD
  if (!/^\d{2}-\d{2}$/.test(bday || '')) return null;
  const t = localISO();
  const iso = `${t.slice(0, 4)}-${bday}`;
  return iso >= t ? iso : `${+t.slice(0, 4) + 1}-${bday}`;
}

// ---------- taste engine ----------
// Events are dated and expire; venues persist and accumulate "buzz"
// (independent mentions across sources). Feedback nudges per-tag weights.

const VENUE_STATUS_ORDER = { 'opening-soon': 0, new: 1, hot: 2, classic: 3 };

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function buzz(venue, today) {
  const cutoff = addDays(today, -30);
  const names = new Set((venue.sources || [])
    .filter(s => (s.date || today) >= cutoff)
    .map(s => normKey(s.name)));
  return names.size;
}

function tasteScore(tags, state) {
  const interests = new Set((state.settings.interests || []).map(normKey));
  const weights = state.settings.tasteWeights || {};
  let score = 0;
  for (const t of tags || []) {
    const k = normKey(t);
    score += (interests.has(k) ? 1 : 0.2) * (weights[k] != null ? weights[k] : 1);
  }
  return score;
}

function hoodBonus(hood, state) {
  const mine = ((state.settings.profile || {}).neighborhoods || []).map(normKey);
  const h = normKey(hood);
  return h && mine.some(m => m && (h.includes(m) || m.includes(h))) ? 1 : 0;
}

function nightBonus(dateIso, state) {
  if (!dateIso) return 0;
  const nights = (state.settings.profile || {}).nights || [];
  const day = new Date(dateIso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
  return nights.includes(day) ? 0.5 : 0;
}

function scoreEvent(e, state) {
  return tasteScore(e.tags, state)
    + hoodBonus(e.neighborhood || e.venue, state)
    + nightBonus(e.date, state)
    + Math.min((e.sources || []).length, 3) * 0.3
    + (e.status === 'saved' ? 2 : 0);
}

function scoreVenue(v, state, today) {
  const novelty = { 'opening-soon': 0.75, new: 0.75, hot: 0.5 }[v.status] || 0;
  return tasteScore(v.tags, state)
    + hoodBonus(v.hood, state)
    + Math.min(buzz(v, today), 4) * 0.5
    + novelty
    + (v.flag === 'saved' ? 2 : 0);
}

// Merge new candidates instead of overwriting. A re-mention of something we
// already know about is signal (buzz), not a duplicate row.
function ingestCandidates(state, body) {
  const today = localISO();
  const out = { eventsAdded: 0, eventsMerged: 0, venuesAdded: 0, venuesMerged: 0 };
  state.events = state.events || [];
  state.venues = state.venues || [];

  for (const raw of body.events || []) {
    if (!raw || !raw.title) continue;
    const key = normKey(raw.title) + '|' + (raw.date || '');
    const mention = { name: raw.source || 'web', date: today };
    const existing = state.events.find(e => normKey(e.title) + '|' + (e.date || '') === key);
    if (existing) {
      existing.tags = [...new Set([...(existing.tags || []), ...(raw.tags || [])])];
      for (const f of ['venue', 'url', 'neighborhood', 'category', 'price', 'endDate']) {
        if (raw[f] && !existing[f]) existing[f] = raw[f];
      }
      existing.sources = existing.sources || [];
      if (!existing.sources.some(s => normKey(s.name) === normKey(mention.name))) {
        existing.sources.push(mention);
      }
      out.eventsMerged++;
    } else {
      state.events.push({ id: uid('e'), status: 'new', firstSeen: today, ...raw, sources: [mention] });
      out.eventsAdded++;
    }
  }

  for (const raw of body.venues || []) {
    if (!raw || !raw.name) continue;
    const mention = { name: raw.source || 'web', date: raw.sourceDate || today };
    const existing = state.venues.find(v => normKey(v.name) === normKey(raw.name));
    if (existing) {
      existing.tags = [...new Set([...(existing.tags || []), ...(raw.tags || [])])];
      for (const f of ['hood', 'kind', 'url', 'bookVia', 'notes']) {
        if (raw[f] && !existing[f]) existing[f] = raw[f];
      }
      if (raw.availability) existing.availability = raw.availability; // always refresh
      if (raw.status && (VENUE_STATUS_ORDER[raw.status] ?? -1) > (VENUE_STATUS_ORDER[existing.status] ?? -1)) {
        existing.status = raw.status;
      }
      if (raw.visited) existing.visited = [...new Set([...(existing.visited || []), ...raw.visited])].sort();
      if (!(existing.sources || []).some(s => normKey(s.name) === normKey(mention.name) && s.date === mention.date)) {
        (existing.sources = existing.sources || []).push(mention);
      }
      out.venuesMerged++;
    } else {
      state.venues.push({
        id: uid('v'), status: 'new', firstSeen: today, visited: [], ...raw, sources: [mention],
      });
      out.venuesAdded++;
    }
  }

  // Buzz promotion: three independent mentions in 30 days makes a spot "hot".
  for (const v of state.venues) {
    if ((v.status === 'new' || v.status === 'opening-soon') && buzz(v, today) >= 3) v.status = 'hot';
  }
  // Expire events that ended more than a week ago.
  state.events = state.events.filter(e => {
    const end = e.endDate || e.date;
    return !end || end >= addDays(today, -7);
  });
  return out;
}

function applyFeedback(state, fb) {
  const list = fb.kind === 'venue' ? state.venues : state.events;
  const item = (list || []).find(x => x.id === fb.id);
  if (!item) return null;
  if (fb.kind === 'venue') {
    if (fb.action === 'save') item.flag = 'saved';
    if (fb.action === 'dismiss') item.flag = 'dismissed';
    if (fb.action === 'visited') item.visited = [...new Set([...(item.visited || []), fb.date || localISO()])].sort();
  } else {
    if (fb.action === 'save' || fb.action === 'planned') item.status = 'saved';
    if (fb.action === 'dismiss') item.status = 'dismissed';
  }
  const delta = { save: 0.15, planned: 0.15, visited: 0.15, dismiss: -0.1 }[fb.action] || 0;
  if (delta) {
    const w = state.settings.tasteWeights = state.settings.tasteWeights || {};
    for (const t of item.tags || []) {
      const k = normKey(t);
      w[k] = Math.round(Math.max(0.2, Math.min(3, (w[k] != null ? w[k] : 1) + delta)) * 100) / 100;
    }
  }
  return item;
}

// Auto-add confirmed reservations (parsed from confirmation emails) as plans.
function ingestPlans(state, plans) {
  const out = { added: 0, skipped: [] };
  state.plans = state.plans || [];
  for (const raw of plans || []) {
    if (!raw || !raw.title || !raw.date) continue;
    if (state.plans.some(pl => normKey(pl.title) === normKey(raw.title) && pl.date === raw.date)) {
      out.skipped.push(raw.title);
      continue;
    }
    const names = raw.people || (raw.personName ? [raw.personName] : []);
    const personIds = names
      .map(n => (state.people.find(p => normKey(p.name) === normKey(n) || normKey(p.name).startsWith(normKey(n))) || {}).id)
      .filter(Boolean);
    state.plans.push({
      id: uid('pl'),
      title: raw.title,
      date: raw.date,
      time: raw.time || null,
      place: raw.place || null,
      notes: raw.notes || (raw.source ? `Auto-added from ${raw.source}` : null),
      personIds,
      status: 'upcoming',
      source: raw.source || null,
    });
    out.added++;
  }
  return out;
}

function suggestIdea(person, ideas) {
  const wantBest = person.type === 'dating' ? ['date', 'either'] : ['friends', 'either'];
  const pool = ideas.filter(i => wantBest.includes(i.best));
  const shared = pool.filter(i => i.tags.some(t => (person.interests || []).includes(t)));
  const list = shared.length ? shared : pool;
  return list.find(i => i.favorite) || list[0] || null;
}

function weekSuggestions(state) {
  const prof = (state.settings.profile || {});
  const nights = prof.nights && prof.nights.length ? prof.nights : ['Thu', 'Fri', 'Sat'];
  const dayName = iso => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
  const planned = new Set((state.plans || []).filter(pl => pl.status !== 'done').map(pl => pl.date));
  const tierW = p => p.type === 'dating' ? 3 : ({ inner: 3, close: 2, warm: 1 }[p.tier] || 1);
  const today = localISO();
  const cands = state.people
    .filter(p => p.tier !== 'archived' && p.tier !== 'unsorted')
    .map(p => {
      const cad = cadenceFor(p, state.settings);
      if (!cad) return null;
      const overdue = daysBetween(addDays(p.lastContact || p.createdAt || today, cad), today);
      return { p, overdue };
    })
    .filter(x => x && !(x.p.snoozedUntil && x.p.snoozedUntil > today))
    .sort((a, b) => (b.overdue * tierW(b.p)) - (a.overdue * tierW(a.p)));
  const used = new Set();
  const out = [];
  for (let i = 1; i <= 14 && out.length < 3; i++) {
    const d = addDays(today, i);
    if (!nights.includes(dayName(d)) || planned.has(d)) continue;
    const c = cands.find(x => !used.has(x.p.id));
    if (!c) break;
    used.add(c.p.id);
    const idea = suggestIdea(c.p, state.ideas || []);
    out.push({ date: d, name: c.p.name, idea: idea ? `${idea.title} (${idea.hood || 'NYC'})` : null });
  }
  return out;
}

function computeDigest(state) {
  const today = localISO();
  const horizon = addDays(today, 7);

  const due = [];
  for (const p of state.people) {
    if (p.tier === 'archived' || p.tier === 'unsorted') continue;
    if (p.snoozedUntil && p.snoozedUntil > today) continue;
    const cadence = cadenceFor(p, state.settings);
    if (!cadence) continue;
    const last = p.lastContact || p.createdAt || today;
    const nextDue = addDays(last, cadence);
    if (nextDue <= today) {
      const idea = suggestIdea(p, state.ideas || []);
      const thread = (p.threads || []).find(t => !t.done) || null;
      due.push({
        name: p.name, tier: p.tier, type: p.type, stage: p.stage || null,
        overdueDays: daysBetween(nextDue, today),
        lastContact: p.lastContact || null,
        nextStep: p.nextStep || null,
        interests: p.interests || [],
        idea: idea ? idea.title : null,
        thread: thread ? thread.text : null,
      });
    }
  }
  due.sort((a, b) => b.overdueDays - a.overdueDays);

  const birthdays = state.people
    .filter(p => p.tier !== 'archived' && p.tier !== 'unsorted')
    .map(p => ({ name: p.name, date: nextBirthday(p.birthday) }))
    .filter(b => b.date && daysBetween(today, b.date) <= 7)
    .sort((a, b) => a.date.localeCompare(b.date));

  const plans = (state.plans || [])
    .filter(pl => pl.status !== 'done' && pl.date >= today && pl.date <= horizon)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
    .map(pl => ({
      title: pl.title, date: pl.date, time: pl.time || null, place: pl.place || null,
      people: pl.personIds.map(id => (state.people.find(p => p.id === id) || {}).name).filter(Boolean),
    }));

  const events = (state.events || [])
    .filter(e => e.status !== 'dismissed' && (!e.date || e.date >= today))
    .sort((a, b) => scoreEvent(b, state) - scoreEvent(a, state))
    .slice(0, 12);

  const buzzing = (state.venues || [])
    .filter(v => v.flag !== 'dismissed' && ['opening-soon', 'new', 'hot'].includes(v.status))
    .sort((a, b) => scoreVenue(b, state, today) - scoreVenue(a, state, today))
    .slice(0, 6)
    .map(v => ({ ...v, buzz: buzz(v, today) }));

  const toBook = (state.venues || [])
    .filter(v => v.flag !== 'dismissed'
      && ['restaurant', 'bar'].includes(v.kind)
      && !(v.visited || []).some(d => d >= addDays(today, -60)))
    .sort((a, b) => scoreVenue(b, state, today) - scoreVenue(a, state, today))
    .slice(0, 5);

  const datingNudges = state.people
    .filter(p => p.type === 'dating' && p.stage && p.stage !== 'ended' && p.tier !== 'archived' && p.nextStep)
    .map(p => ({ name: p.name, stage: p.stage, nextStep: p.nextStep }));

  const lines = [];
  lines.push(`# Orbit digest — ${today}`);
  lines.push('');
  lines.push('## Reach out today');
  if (due.length === 0) lines.push('All caught up — nobody is overdue.');
  for (const d of due) {
    const label = d.type === 'dating' ? `dating · ${d.stage}` : d.tier;
    lines.push(`- **${d.name}** (${label}) — ${d.overdueDays === 0 ? 'due today' : `${d.overdueDays}d overdue`}${d.lastContact ? `, last contact ${d.lastContact}` : ''}${d.thread ? `. 💭 ${d.thread}` : d.nextStep ? `. Next step: ${d.nextStep}` : d.idea ? `. Idea: ${d.idea}` : ''}`);
  }
  const sugs = weekSuggestions(state);
  if (sugs.length) {
    lines.push('');
    lines.push('## Line up your week');
    for (const s of sugs) lines.push(`- ${s.date} — **${s.name}**${s.idea ? ` · ${s.idea}` : ''}`);
  }
  if (birthdays.length) {
    lines.push('');
    lines.push('## Birthdays this week');
    for (const b of birthdays) {
      const inDays = daysBetween(today, b.date);
      lines.push(`- 🎂 **${b.name}** — ${inDays === 0 ? 'TODAY' : `${b.date} (in ${inDays}d)`}`);
    }
  }
  lines.push('');
  lines.push('## Plans this week');
  if (plans.length === 0) lines.push('Nothing on the calendar — pick someone above and plan something.');
  for (const pl of plans) {
    lines.push(`- ${pl.date}${pl.time ? ' ' + pl.time : ''} — **${pl.title}** with ${pl.people.join(', ') || '?'}${pl.place ? ` @ ${pl.place}` : ''}`);
  }
  if (datingNudges.length) {
    lines.push('');
    lines.push('## Dating next steps');
    for (const n of datingNudges) lines.push(`- **${n.name}** (${n.stage}): ${n.nextStep}`);
  }
  lines.push('');
  lines.push(`## Happening in ${state.settings.city || 'New York'}`);
  if (events.length === 0) lines.push('No events loaded yet — the daily agent fills these in.');
  for (const e of events) {
    lines.push(`- ${e.date ? e.date + ' — ' : ''}**${e.title}**${e.venue ? ` @ ${e.venue}` : ''}${e.url ? ` (${e.url})` : ''}`);
  }
  if (buzzing.length) {
    lines.push('');
    lines.push('## New & buzzing');
    for (const v of buzzing) {
      const label = v.status === 'opening-soon' ? 'opening soon' : v.status;
      lines.push(`- **${v.name}**${v.hood ? ` (${v.hood})` : ''} — ${label}${v.buzz > 1 ? ` · ${v.buzz} sources this month` : ''}${v.notes ? `. ${v.notes}` : ''}${v.url ? ` (${v.url})` : ''}`);
    }
  }
  if (toBook.length) {
    lines.push('');
    lines.push('## Restaurants to book');
    for (const v of toBook) {
      lines.push(`- **${v.name}**${v.hood ? ` (${v.hood})` : ''}${v.availability ? ` — ${v.availability}` : ''}${v.bookVia ? ` — book: ${v.bookVia}` : ''}`);
    }
  }

  return {
    date: today,
    email: state.settings.email || null,
    interests: state.settings.interests || [],
    reachOut: due,
    birthdays,
    plans,
    datingNudges,
    events,
    buzzing,
    toBook,
    markdown: lines.join('\n'),
  };
}

function escapeIcs(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function buildCalendar(state) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Orbit//EN',
    'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Orbit',
  ];
  for (const pl of (state.plans || []).filter(x => x.status !== 'done')) {
    const names = pl.personIds
      .map(id => (state.people.find(p => p.id === id) || {}).name)
      .filter(Boolean).join(', ');
    const dt = pl.time
      ? `DTSTART:${pl.date.replace(/-/g, '')}T${pl.time.replace(':', '')}00`
      : `DTSTART;VALUE=DATE:${pl.date.replace(/-/g, '')}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${pl.id}@orbit.local`,
      dt,
      `SUMMARY:${escapeIcs(pl.title + (names ? ` with ${names}` : ''))}`,
      pl.place ? `LOCATION:${escapeIcs(pl.place)}` : null,
      pl.notes ? `DESCRIPTION:${escapeIcs(pl.notes)}` : null,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).join('\r\n');
}

// ---------- connections ----------
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.jesse.orbit.plist');
const DIGEST_TASK = path.join(os.homedir(), '.claude', 'scheduled-tasks', 'orbit-daily-digest', 'SKILL.md');

function connectionStatus() {
  return {
    platform: process.platform,
    port: PORT,
    launchAgent: fs.existsSync(PLIST_PATH),
    digestTask: fs.existsSync(DIGEST_TASK),
    contactsImport: process.platform === 'darwin',
  };
}

function importMacContacts() {
  return new Promise((resolve, reject) => {
    const script = 'JSON.stringify(Application("Contacts").people.name())';
    execFile('osascript', ['-l', 'JavaScript', '-e', script],
      { timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(
          /not allowed|authoriz/i.test(String(err))
            ? 'macOS blocked access to Contacts. Grant permission in System Settings → Privacy & Security → Contacts, then retry.'
            : 'Could not read Contacts: ' + err.message));
        try {
          const names = [...new Set(JSON.parse(stdout.trim())
            .map(n => String(n || '').trim()).filter(n => n.length > 1))];
          resolve(names);
        } catch (e) { reject(new Error('Unexpected Contacts output')); }
      });
  });
}

function setLaunchAgent(enable) {
  return new Promise((resolve, reject) => {
    if (!enable) {
      execFile('launchctl', ['unload', '-w', PLIST_PATH], () => {
        try { fs.unlinkSync(PLIST_PATH); } catch {}
        resolve(false);
      });
      return;
    }
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jesse.orbit</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${path.join(ROOT, 'server.js')}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/orbit.log</string>
  <key>StandardErrorPath</key><string>/tmp/orbit.err</string>
</dict></plist>`;
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.writeFileSync(PLIST_PATH, plist);
    execFile('launchctl', ['load', '-w', PLIST_PATH], () => resolve(true));
  });
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/api/state' && req.method === 'GET') {
      return sendJSON(res, 200, loadState());
    }
    if (p === '/api/state' && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      if (!body || !Array.isArray(body.people) || !body.settings) {
        return sendJSON(res, 400, { error: 'invalid state shape' });
      }
      // Older clients don't know about agent-owned collections — never let a
      // client save wipe them.
      const prev = loadState();
      if (body.venues === undefined) body.venues = prev.venues || [];
      if (body.events === undefined) body.events = prev.events || [];
      saveState(body);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/events' && req.method === 'POST') {
      // used by the daily agent to load NYC events into the app
      const body = JSON.parse(await readBody(req));
      if (!Array.isArray(body.events)) return sendJSON(res, 400, { error: 'expected {events: [...]}' });
      const state = loadState();
      state.events = body.events;
      saveState(state);
      return sendJSON(res, 200, { ok: true, count: body.events.length });
    }
    if (p === '/api/ingest' && req.method === 'POST') {
      // daily agent: merge extracted events + venues, dedupe, track buzz
      const body = JSON.parse(await readBody(req));
      if (!Array.isArray(body.events) && !Array.isArray(body.venues)) {
        return sendJSON(res, 400, { error: 'expected {events: [...]} and/or {venues: [...]}' });
      }
      const state = loadState();
      const result = ingestCandidates(state, body);
      saveState(state);
      return sendJSON(res, 200, { ok: true, ...result });
    }
    if (p === '/api/feedback' && req.method === 'POST') {
      // {kind: 'event'|'venue', id, action: 'save'|'dismiss'|'planned'|'visited', date?}
      const body = JSON.parse(await readBody(req));
      const state = loadState();
      const item = applyFeedback(state, body || {});
      if (!item) return sendJSON(res, 404, { error: 'no such item' });
      saveState(state);
      return sendJSON(res, 200, { ok: true, id: item.id, tasteWeights: state.settings.tasteWeights || {} });
    }
    if (p === '/api/plans/ingest' && req.method === 'POST') {
      // daily agent: auto-add confirmed reservations as plans
      const body = JSON.parse(await readBody(req));
      if (!Array.isArray(body.plans)) return sendJSON(res, 400, { error: 'expected {plans: [...]}' });
      const state = loadState();
      const result = ingestPlans(state, body.plans);
      saveState(state);
      return sendJSON(res, 200, { ok: true, ...result });
    }
    if (p === '/api/digest' && req.method === 'GET') {
      return sendJSON(res, 200, computeDigest(loadState()));
    }
    if (p === '/api/calendar.ics' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
      return res.end(buildCalendar(loadState()));
    }
    if (p === '/api/connections' && req.method === 'GET') {
      return sendJSON(res, 200, connectionStatus());
    }
    if (p === '/api/import/macos-contacts' && req.method === 'POST') {
      try {
        const names = await importMacContacts();
        return sendJSON(res, 200, { ok: true, names });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }
    if (p === '/api/setup/launchagent' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const enabled = await setLaunchAgent(body.enable !== false);
      return sendJSON(res, 200, { ok: true, enabled });
    }

    // static files
    let file = p === '/' ? '/index.html' : p;
    const resolved = path.join(PUBLIC_DIR, path.normalize(file));
    if (!resolved.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream' });
    fs.createReadStream(resolved).pipe(res);
  } catch (err) {
    sendJSON(res, 500, { error: String(err.message || err) });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Orbit already running on port ${PORT} — exiting.`);
    process.exit(0); // clean exit so launchd (SuccessfulExit=false) doesn't thrash
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Orbit running at http://localhost:${PORT}`);
});
