#!/usr/bin/env node
// Publish the local Orbit candidate pool as the shared per-city feed.
// Reads ORBIT_FEED_URL + ORBIT_FEED_KEY from the environment (or ~/orbit/.env).
//
//   node agents/publish-feed.js                # city from settings, else new-york
//   node agents/publish-feed.js --city new-york
//   node agents/publish-feed.js --file feed.json

const fs = require('fs');
const os = require('os');
const path = require('path');

function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

loadDotenv(path.join(os.homedir(), 'orbit', '.env'));
loadDotenv(path.join(__dirname, '..', '.env'));

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function publicEvent(e) {
  if (!e || !e.title) return null;
  if (e.status === 'dismissed') return null;
  return {
    title: e.title,
    date: e.date || null,
    endDate: e.endDate || null,
    venue: e.venue || null,
    neighborhood: e.neighborhood || null,
    tags: e.tags || [],
    price: e.price || null,
    url: e.url || null,
    source: e.source || (e.sources && e.sources[0] && e.sources[0].name) || null,
    sources: e.sources || undefined,
  };
}

function publicVenue(v) {
  if (!v || !v.name) return null;
  if (v.flag === 'dismissed') return null;
  return {
    name: v.name,
    hood: v.hood || null,
    kind: v.kind || null,
    tags: v.tags || [],
    status: v.status || 'new',
    url: v.url || null,
    bookVia: v.bookVia || null,
    availability: v.availability || null,
    notes: v.notes || null,
    source: v.source || (v.sources && v.sources[0] && v.sources[0].name) || null,
    sources: v.sources || undefined,
  };
}

async function main() {
  const url = (process.env.ORBIT_FEED_URL || '').replace(/\/+$/, '');
  const key = process.env.ORBIT_FEED_KEY;
  if (!url || !key) {
    console.log(JSON.stringify({ error: 'ORBIT_FEED_URL and ORBIT_FEED_KEY must be set (see ~/orbit/.env)' }));
    process.exit(1);
  }

  let events = [];
  let venues = [];
  let city = arg('city');

  const file = arg('file');
  if (file) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    events = doc.events || [];
    venues = doc.venues || [];
    city = city || doc.city;
  } else {
    const origin = process.env.ORBIT_API || 'http://localhost:4747';
    const res = await fetch(origin + '/api/state');
    if (!res.ok) throw new Error(`could not read ${origin}/api/state (${res.status})`);
    const state = await res.json();
    city = city || state.settings.city || 'new-york';
    events = (state.events || []).map(publicEvent).filter(Boolean);
    venues = (state.venues || []).map(publicVenue).filter(Boolean);
  }

  city = slug(city || 'new-york');
  const res = await fetch(url + '/feed', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ city, events, venues }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(JSON.stringify({ error: body.error || res.status, status: res.status }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, city, events: body.events, venues: body.venues, url: url + '/feed?city=' + city }));
}

main().catch(err => {
  console.log(JSON.stringify({ error: String(err.message || err) }));
  process.exit(1);
});
