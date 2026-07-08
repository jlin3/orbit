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

function suggestIdea(person, ideas) {
  const wantBest = person.type === 'dating' ? ['date', 'either'] : ['friends', 'either'];
  const pool = ideas.filter(i => wantBest.includes(i.best));
  const shared = pool.filter(i => i.tags.some(t => (person.interests || []).includes(t)));
  const list = shared.length ? shared : pool;
  return list.find(i => i.favorite) || list[0] || null;
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
      due.push({
        name: p.name, tier: p.tier, type: p.type, stage: p.stage || null,
        overdueDays: daysBetween(nextDue, today),
        lastContact: p.lastContact || null,
        nextStep: p.nextStep || null,
        interests: p.interests || [],
        idea: idea ? idea.title : null,
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
    .filter(e => !e.date || e.date >= today)
    .slice(0, 12);

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
    lines.push(`- **${d.name}** (${label}) — ${d.overdueDays === 0 ? 'due today' : `${d.overdueDays}d overdue`}${d.lastContact ? `, last contact ${d.lastContact}` : ''}${d.nextStep ? `. Next step: ${d.nextStep}` : d.idea ? `. Idea: ${d.idea}` : ''}`);
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
  lines.push('## Happening in New York');
  if (events.length === 0) lines.push('No events loaded yet — the daily agent fills these in.');
  for (const e of events) {
    lines.push(`- ${e.date ? e.date + ' — ' : ''}**${e.title}**${e.venue ? ` @ ${e.venue}` : ''}${e.url ? ` (${e.url})` : ''}`);
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
