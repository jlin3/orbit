#!/usr/bin/env node
// Resy availability checker for Orbit — zero-dependency (Node 18+).
//
// Resy has no public API; this speaks the same endpoints the resy.com web
// app uses, with YOUR api key + auth token (see README.md for how to grab
// them). Unofficial means it can break without notice — every command fails
// soft with a JSON error so the daily agent can carry on.
//
// Commands:
//   node resy.js search "Place Name"
//   node resy.js check --venue "Place Name" --day 2026-08-22 --party 2
//   node resy.js scan --names "Place A, Place B" --days 3 --party 2 [--ingest http://localhost:4747]
//
// `scan` is what the daily agent runs: for each name it finds the venue,
// checks the next N evenings, and emits Orbit venue objects with an
// `availability` line and a `bookVia` link — optionally POSTed straight to
// Orbit's /api/ingest.

const API = 'https://api.resy.com';
// Default geo: downtown NYC. Override with RESY_LAT / RESY_LONG.
const LAT = Number(process.env.RESY_LAT || 40.722);
const LONG = Number(process.env.RESY_LONG || -73.987);

function headers() {
  const key = process.env.RESY_API_KEY;
  if (!key) throw new Error('RESY_API_KEY not set — see agents/reservations/README.md');
  const h = {
    Authorization: `ResyAPI api_key="${key}"`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    Origin: 'https://resy.com',
    Referer: 'https://resy.com/',
  };
  if (process.env.RESY_AUTH_TOKEN) h['X-Resy-Auth-Token'] = process.env.RESY_AUTH_TOKEN;
  return h;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function localISO(d = new Date()) {
  return d.toLocaleDateString('en-CA');
}

function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return localISO(d);
}

async function searchVenue(query) {
  const res = await fetch(`${API}/3/venuesearch/search`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      query,
      geo: { latitude: LAT, longitude: LONG },
      per_page: 3,
      types: ['venue'],
    }),
  });
  if (!res.ok) throw new Error(`venuesearch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const hit = data?.search?.hits?.[0];
  if (!hit) return null;
  return {
    id: hit.id?.resy ?? hit.objectID,
    name: hit.name,
    neighborhood: hit.neighborhood || null,
    cuisine: Array.isArray(hit.cuisine) ? hit.cuisine[0] : hit.cuisine || null,
    urlSlug: hit.url_slug || null,
    locationCode: hit.location?.code || 'ny',
  };
}

async function findSlots(venueId, day, party) {
  const qs = new URLSearchParams({
    lat: String(LAT), long: String(LONG),
    day, party_size: String(party), venue_id: String(venueId),
  });
  const res = await fetch(`${API}/4/find?${qs}`, { headers: headers() });
  if (!res.ok) throw new Error(`find ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const slots = data?.results?.venues?.[0]?.slots || [];
  return slots.map(s => ({
    time: (s.date?.start || '').slice(11, 16),
    type: s.config?.type || null,
  })).filter(s => s.time);
}

function bookLink(venue, day, party) {
  if (venue?.urlSlug) {
    return `https://resy.com/cities/${venue.locationCode}/${venue.urlSlug}?date=${day}&seats=${party}`;
  }
  return `https://resy.com/?date=${day}&seats=${party}&query=${encodeURIComponent(venue?.name || '')}`;
}

// Prefer prime evening slots when summarizing.
function summarize(byDay) {
  const prime = [];
  for (const [day, slots] of Object.entries(byDay)) {
    const evening = slots.filter(s => s.time >= '18:00' && s.time <= '21:30');
    if (evening.length) prime.push(`${day} ${evening[0].time}–${evening[evening.length - 1].time}`);
  }
  if (!prime.length) return null;
  return `Resy: tables ${prime.slice(0, 3).join(', ')}`;
}

async function scanOne(name, days, party) {
  const venue = await searchVenue(name);
  if (!venue) return { name, error: 'not found on Resy' };
  const today = localISO();
  const byDay = {};
  for (let i = 0; i < days; i++) {
    const day = addDays(today, i + 1);
    try {
      const slots = await findSlots(venue.id, day, party);
      if (slots.length) byDay[day] = slots;
    } catch (e) {
      return { name, error: String(e.message) };
    }
    await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
  }
  const firstDay = Object.keys(byDay)[0] || addDays(today, 1);
  return {
    name: venue.name,
    hood: venue.neighborhood,
    kind: 'restaurant',
    tags: venue.cuisine ? [venue.cuisine.toLowerCase()] : [],
    source: 'Resy availability',
    availability: summarize(byDay) || `Resy: no tables for ${party} in the next ${days} evenings`,
    bookVia: bookLink(venue, firstDay, party),
  };
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === 'search') {
      const q = process.argv[3];
      if (!q) throw new Error('usage: resy.js search "Place Name"');
      console.log(JSON.stringify(await searchVenue(q), null, 2));
      return;
    }
    if (cmd === 'check') {
      const name = arg('venue');
      const day = arg('day', addDays(localISO(), 1));
      const party = Number(arg('party', '2'));
      if (!name) throw new Error('usage: resy.js check --venue "Name" [--day YYYY-MM-DD] [--party 2]');
      const venue = await searchVenue(name);
      if (!venue) throw new Error(`"${name}" not found on Resy`);
      const slots = await findSlots(venue.id, day, party);
      console.log(JSON.stringify({ venue: venue.name, day, party, slots, bookVia: bookLink(venue, day, party) }, null, 2));
      return;
    }
    if (cmd === 'scan') {
      const names = (arg('names', '')).split(',').map(s => s.trim()).filter(Boolean);
      const days = Number(arg('days', '3'));
      const party = Number(arg('party', '2'));
      if (!names.length) throw new Error('usage: resy.js scan --names "A, B" [--days 3] [--party 2] [--ingest URL]');
      const venues = [];
      for (const n of names) venues.push(await scanOne(n, days, party));
      const ok = venues.filter(v => !v.error);
      const output = { venues: ok, errors: venues.filter(v => v.error) };
      const ingest = arg('ingest');
      if (ingest && ok.length) {
        const res = await fetch(`${ingest.replace(/\/$/, '')}/api/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ venues: ok }),
        });
        output.ingested = await res.json();
      }
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    throw new Error('commands: search | check | scan');
  } catch (e) {
    console.log(JSON.stringify({ error: String(e.message || e) }));
    process.exitCode = 1;
  }
}

main();
