'use strict';

// ---------- environment ----------
const LOCAL = location.port === '4747'; // served by the Mac server (has /api); otherwise static web/PWA
const WEB_URL = 'https://getorbit.pages.dev/';

// The concierge proxy holds the model key, so people you share Orbit with get
// real plans without bringing an API key of their own. Override in Connect.
const DEFAULT_PROXY_URL = 'https://orbit-concierge.jlin3.workers.dev';
const proxyUrl = () => (S?.settings?.integrations?.proxyUrl || DEFAULT_PROXY_URL).replace(/\/+$/, '');

// ---------- state ----------
let S = null;
let route = location.hash.slice(1) || 'today';
let lastRoute = null;
let peopleFilter = 'active';
let peopleSearch = '';
let ideaFilter = null;
let sharedPayload = null; // set when the URL carries a shared itinerary

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const uid = () => 'x' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const hashN = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const pad = n => String(n).padStart(2, '0');

// ---------- dates ----------
const todayIso = () => new Date().toLocaleDateString('en-CA');
function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}
const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
const fmtDate = iso => iso
  ? new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  : '—';
const fmtDay = iso =>
  new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

function nextBirthdayIso(bday) {
  if (!/^\d{2}-\d{2}$/.test(bday || '')) return null;
  const t = todayIso();
  const iso = `${t.slice(0, 4)}-${bday}`;
  return iso >= t ? iso : `${+t.slice(0, 4) + 1}-${bday}`;
}

function startOfWeek() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toLocaleDateString('en-CA');
}

const dayShort = iso =>
  new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });

// Friday through Sunday of the weekend we're heading into. On a Saturday that
// means today and tomorrow, not six days from now.
function weekendDates() {
  const today = todayIso();
  const dow = new Date(today + 'T12:00:00').getDay(); // 0 Sun … 6 Sat
  if (dow === 0) return [today];
  if (dow === 6) return [today, addDays(today, 1)];
  const fri = addDays(today, (5 - dow + 7) % 7);
  return [fri, addDays(fri, 1), addDays(fri, 2)];
}

// ---------- persistence (local server ⇄ browser storage) ----------
const LS_STATE = 'orbit-state';

function normalizeState() {
  S.settings.profile = S.settings.profile || {};
  S.settings.connections = S.settings.connections || {};
  S.settings.integrations = S.settings.integrations || {};
  S.meta = S.meta || { updatedAt: 0 };
  S.events = S.events || [];
  S.venues = S.venues || [];
  S.plans = S.plans || [];
  S.ideas = S.ideas || [];
  S.settings.tasteWeights = S.settings.tasteWeights || {};
  for (const e of S.events) if (!e.id) e.id = uid();
  for (const v of S.venues) if (!v.id) v.id = uid();
  S.streaks = S.streaks || { focusDays: 0, bestFocus: 0, lastFocusDate: null, lastReviewDate: null };
  S.history = S.history || [];
  S.focus = S.focus || null;
  S.settings.goals = S.settings.goals || {};
  S.settings.city = S.settings.city || '';
  S.concierge = S.concierge || {};
  S.concierge.runs = S.concierge.runs || {};
  delete S.concierge.mode; // the route decides this now
  S.planner = S.planner || {};
  S.planner.range = ['tonight', 'weekend', 'week'].includes(S.planner.range) ? S.planner.range : 'weekend';
  S.planner.prompt = typeof S.planner.prompt === 'string' ? S.planner.prompt : '';
  S.planner.boards = S.planner.boards || {};
  S.planner.pickedDate = S.planner.pickedDate || S.concierge.pickedDate || '';
  // sample/demo data is retired — real people only
  if (S.people.some(p => p.sample) || (S.plans || []).some(pl => pl.sample)) {
    S.people = S.people.filter(p => !p.sample);
    S.plans = (S.plans || []).filter(pl => !pl.sample);
    S.focus = null;
  }
  for (const p of S.people) {
    p.threads = p.threads || [];
    p.handles = p.handles || {};
  }
}

async function loadState() {
  if (LOCAL) {
    S = await (await fetch('api/state')).json();
  } else {
    const raw = localStorage.getItem(LS_STATE);
    S = raw ? JSON.parse(raw) : await (await fetch('./seed.json')).json();
  }
  normalizeState();
}

let saveTimer = null;
function persist() {
  S.meta.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (LOCAL) {
      fetch('api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(S),
      }).catch(() => toast('⚠️ Save failed — is the server running?'));
    } else {
      try { localStorage.setItem(LS_STATE, JSON.stringify(S)); }
      catch { toast('⚠️ Could not save locally'); }
    }
    schedulePush();
  }, 300);
}
function save() { persist(); render(); }

// ---------- taste engine (client) ----------
// Mirrors the scoring/feedback logic in server.js so web-mode users get the
// same ranking without a local server. Feedback nudges per-tag weights.
const normTag = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function tasteScoreTags(tags) {
  const interests = new Set((S.settings.interests || []).map(normTag));
  const weights = S.settings.tasteWeights || {};
  let score = 0;
  for (const t of tags || []) {
    const k = normTag(t);
    score += (interests.has(k) ? 1 : 0.2) * (weights[k] != null ? weights[k] : 1);
  }
  return score;
}

function hoodBonusClient(hood) {
  const mine = ((S.settings.profile || {}).neighborhoods || []).map(normTag);
  const h = normTag(hood);
  return h && mine.some(m => m && (h.includes(m) || m.includes(h))) ? 1 : 0;
}

function venueBuzz(v) {
  const cutoff = addDays(todayIso(), -30);
  return new Set((v.sources || []).filter(s => (s.date || cutoff) >= cutoff).map(s => normTag(s.name))).size;
}

function scoreEventClient(e) {
  const nights = (S.settings.profile || {}).nights || [];
  const nightHit = e.date && nights.includes(dayShort(e.date)) ? 0.5 : 0;
  return tasteScoreTags(e.tags) + hoodBonusClient(e.neighborhood || e.venue) + nightHit
    + Math.min((e.sources || []).length, 3) * 0.3 + (e.status === 'saved' ? 2 : 0);
}

function scoreVenueClient(v) {
  const novelty = { 'opening-soon': 0.75, new: 0.75, hot: 0.5 }[v.status] || 0;
  return tasteScoreTags(v.tags) + hoodBonusClient(v.hood) + Math.min(venueBuzz(v), 4) * 0.5
    + novelty + (v.flag === 'saved' ? 2 : 0);
}

function applyTasteFeedback(kind, id, action) {
  const item = (kind === 'venue' ? S.venues : S.events).find(x => x.id === id);
  if (!item) return;
  if (kind === 'venue') {
    if (action === 'save') item.flag = 'saved';
    if (action === 'dismiss') item.flag = 'dismissed';
  } else {
    if (action === 'save' || action === 'planned') item.status = 'saved';
    if (action === 'dismiss') item.status = 'dismissed';
  }
  const delta = { save: 0.15, planned: 0.15, dismiss: -0.1 }[action] || 0;
  if (delta) {
    const w = S.settings.tasteWeights;
    for (const t of item.tags || []) {
      const k = normTag(t);
      w[k] = Math.round(Math.max(0.2, Math.min(3, (w[k] != null ? w[k] : 1) + delta)) * 100) / 100;
    }
  }
}

// The shared per-city feed: sources ingested once per city, served by the
// concierge proxy, ranked here against the local profile. Personal signals
// (saves, dismissals, visits) never leave the device.
function mergeFeedIntoState(feed) {
  const today = todayIso();
  let changed = false;
  for (const raw of feed.events || []) {
    if (!raw || !raw.title) continue;
    const key = normTag(raw.title) + '|' + (raw.date || '');
    const ex = S.events.find(e => normTag(e.title) + '|' + (e.date || '') === key);
    if (ex) {
      ex.tags = [...new Set([...(ex.tags || []), ...(raw.tags || [])])];
      for (const f of ['venue', 'url', 'neighborhood', 'price', 'endDate']) if (raw[f] && !ex[f]) ex[f] = raw[f];
      if (raw.sources) ex.sources = raw.sources;
    } else {
      S.events.push({ ...raw, id: uid(), status: 'new' });
      changed = true;
    }
  }
  for (const raw of feed.venues || []) {
    if (!raw || !raw.name) continue;
    const ex = S.venues.find(v => normTag(v.name) === normTag(raw.name));
    if (ex) {
      ex.tags = [...new Set([...(ex.tags || []), ...(raw.tags || [])])];
      for (const f of ['hood', 'kind', 'url', 'bookVia', 'notes', 'status'] ) if (raw[f] && !ex[f]) ex[f] = raw[f];
      if (raw.availability) ex.availability = raw.availability;
      if (raw.sources) ex.sources = raw.sources;
    } else {
      const { flag, visited, ...rest } = raw;
      S.venues.push({ ...rest, id: uid(), visited: [] });
      changed = true;
    }
  }
  S.events = S.events.filter(e => {
    const end = e.endDate || e.date;
    return !end || end >= addDays(today, -7);
  });
  return changed;
}

async function refreshCityFeed() {
  if (!S?.settings?.city) return false;
  if (Date.now() - (S.meta.feedAt || 0) < 6 * 3600e3) return false;
  const city = S.settings.city.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    const res = await fetch(`${proxyUrl()}/feed?city=${city}`);
    if (!res.ok) return false;
    const feed = await res.json();
    if (!feed.updatedAt) return false;
    const changed = mergeFeedIntoState(feed);
    S.meta.feedAt = Date.now();
    persist();
    return changed;
  } catch {
    return false;
  }
}

// ---------- encrypted cross-device sync (private gist, E2E) ----------
const LS_SYNC = 'orbit-sync';
const SYNC_FILE = 'orbit.enc.json';
let syncCfg = JSON.parse(localStorage.getItem(LS_SYNC) || 'null');
let pushTimer = null;
let lastSyncAt = null;

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(pass, saltU8) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltU8, iterations: 150000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function keyFromCfg() {
  return crypto.subtle.importKey('raw', unb64(syncCfg.keyB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encryptState() {
  const key = await keyFromCfg();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(S)));
  return JSON.stringify({ v: 1, updatedAt: S.meta.updatedAt, salt: syncCfg.salt, iv: b64(iv), ct: b64(ct) });
}
async function decryptPayload(payload, key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(payload.iv) }, key, unb64(payload.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

function ghHeaders() {
  return { 'Authorization': 'Bearer ' + syncCfg.token, 'Accept': 'application/vnd.github+json' };
}
function setSyncDot(state) { // 'on' | 'busy' | 'off'
  const d = $('#syncDot');
  d.hidden = state === 'off';
  d.classList.toggle('busy', state === 'busy');
}

async function pushSync() {
  if (!syncCfg?.gistId) return;
  setSyncDot('busy');
  try {
    const content = await encryptState();
    const r = await fetch(`https://api.github.com/gists/${syncCfg.gistId}`, {
      method: 'PATCH', headers: ghHeaders(),
      body: JSON.stringify({ files: { [SYNC_FILE]: { content } } }),
    });
    if (!r.ok) throw new Error('gist write failed');
    lastSyncAt = Date.now();
    setSyncDot('on');
  } catch { setSyncDot('on'); toast('⚠️ Sync push failed'); }
}
function schedulePush() {
  if (!syncCfg?.gistId) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushSync, 2500);
}

async function pullSync({ silent } = { silent: true }) {
  if (!syncCfg?.gistId) return false;
  setSyncDot('busy');
  try {
    const r = await fetch(`https://api.github.com/gists/${syncCfg.gistId}`, { headers: ghHeaders() });
    if (!r.ok) throw new Error('gist read failed');
    const g = await r.json();
    const payload = JSON.parse(g.files[SYNC_FILE].content);
    if (payload.updatedAt > (S?.meta?.updatedAt || 0)) {
      const key = await keyFromCfg();
      S = await decryptPayload(payload, key);
      normalizeState();
      if (LOCAL) fetch('api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S) });
      else localStorage.setItem(LS_STATE, JSON.stringify(S));
      lastSyncAt = Date.now();
      setSyncDot('on');
      if (!silent) toast('Pulled latest from sync ✓');
      return true;
    }
    lastSyncAt = Date.now();
    setSyncDot('on');
    return false;
  } catch {
    setSyncDot(syncCfg ? 'on' : 'off');
    if (!silent) toast('⚠️ Sync pull failed');
    return false;
  }
}

async function syncCreate(passphrase, token) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  syncCfg = { token, salt: b64(salt), keyB64: b64(await crypto.subtle.exportKey('raw', key)), gistId: null };
  const content = await encryptState();
  const r = await fetch('https://api.github.com/gists', {
    method: 'POST', headers: ghHeaders(),
    body: JSON.stringify({ description: 'Orbit — encrypted sync (E2E, safe to ignore)', public: false, files: { [SYNC_FILE]: { content } } }),
  });
  if (!r.ok) throw new Error('Could not create gist — check the token has the "gist" scope');
  syncCfg.gistId = (await r.json()).id;
  localStorage.setItem(LS_SYNC, JSON.stringify(syncCfg));
  lastSyncAt = Date.now();
  setSyncDot('on');
}

async function syncConnect(passphrase, token) {
  syncCfg = { token };
  const r = await fetch('https://api.github.com/gists?per_page=100', { headers: ghHeaders() });
  if (!r.ok) throw new Error('Could not list gists — check the token');
  const g = (await r.json()).find(x => x.files && x.files[SYNC_FILE]);
  if (!g) throw new Error('No Orbit sync found on this account — create one on your first device');
  const full = await (await fetch(`https://api.github.com/gists/${g.id}`, { headers: ghHeaders() })).json();
  const payload = JSON.parse(full.files[SYNC_FILE].content);
  const key = await deriveKey(passphrase, unb64(payload.salt));
  let remote;
  try { remote = await decryptPayload(payload, key); }
  catch { throw new Error('Wrong passphrase'); }
  syncCfg = { token, salt: payload.salt, keyB64: b64(await crypto.subtle.exportKey('raw', key)), gistId: g.id };
  localStorage.setItem(LS_SYNC, JSON.stringify(syncCfg));
  if (payload.updatedAt > (S.meta.updatedAt || 0)) { S = remote; normalizeState(); }
  persist();
  lastSyncAt = Date.now();
  setSyncDot('on');
}

// ---------- domain ----------
const TIER_LABEL = { inner: 'Inner circle', close: 'Close', warm: 'Keep warm', unsorted: 'Unsorted', archived: 'Archived' };
const STAGES = ['new', 'talking', 'dating', 'serious'];
const STAGE_LABEL = { new: 'New / matched', talking: 'Talking', dating: 'Going on dates', serious: 'Serious' };
const KIND_LABEL = { catchup: '💬', hangout: '🍻', date: '💐', note: '📝' };
const INTEREST_BANK = ['live music', 'jazz', 'comedy', 'food', 'cocktails', 'wine', 'coffee', 'art', 'museums', 'film', 'theater', 'books', 'outdoors', 'running', 'climbing', 'cycling', 'wellness', 'dancing', 'games', 'tech', 'basketball', 'poker'];
const DATE_STYLES = ['drinks', 'dinner', 'coffee walk', 'activity date', 'live show', 'adventurous', 'cozy'];
const NIGHTS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const CHANNELS = {
  messages: { label: 'iM', name: 'Messages', needs: 'phone',
    url: (h, m) => `sms:${(h.phone || '').replace(/[^+\d]/g, '')}${m ? '&body=' + encodeURIComponent(m) : ''}` },
  whatsapp: { label: 'WA', name: 'WhatsApp', needs: 'phone',
    url: (h, m) => `https://wa.me/${(h.phone || '').replace(/[^\d]/g, '')}${m ? '?text=' + encodeURIComponent(m) : ''}` },
  instagram: { label: 'IG', name: 'Instagram', needs: 'instagram',
    url: h => `https://ig.me/m/${(h.instagram || '').replace(/^@/, '')}` },
  x: { label: '𝕏', name: 'X', needs: 'x',
    url: h => `https://x.com/${(h.x || '').replace(/^@/, '')}` },
};

function person(id) { return S.people.find(p => p.id === id); }
function activePeople() { return S.people.filter(p => p.tier !== 'archived' && p.tier !== 'unsorted'); }

function dueInfo(p) {
  if (p.tier === 'archived' || p.tier === 'unsorted') return null;
  const cadence = (p.type === 'dating' && p.stage)
    ? (S.settings.datingCadence || 5)
    : S.settings.tiers[p.tier];
  if (!cadence) return null;
  const last = p.lastContact || p.createdAt || todayIso();
  const nextDue = addDays(last, cadence);
  const overdue = daysBetween(nextDue, todayIso());
  const snoozed = !!(p.snoozedUntil && p.snoozedUntil > todayIso());
  return { cadence, nextDue, overdue, snoozed };
}

function duePeople() {
  return S.people
    .map(p => ({ p, d: dueInfo(p) }))
    .filter(x => x.d && !x.d.snoozed && x.d.overdue >= 0)
    .sort((a, b) => b.d.overdue - a.d.overdue);
}

// Seeded ideas are tied to a specific city. Suggesting a Greenwich Village
// comedy club to someone in Berlin is worse than suggesting nothing.
function ideaFitsCity(i) {
  return !i.city || !S.settings.city || i.city === S.settings.city;
}

function suggestIdea(p) {
  const wantBest = p.type === 'dating' ? ['date', 'either'] : ['friends', 'either'];
  const pool = S.ideas.filter(i => wantBest.includes(i.best) && ideaFitsCity(i));
  const shared = pool.filter(i => i.tags.some(t => (p.interests || []).includes(t)));
  const list = shared.length ? shared : pool;
  const favs = list.filter(i => i.favorite);
  return (favs[0] || list[0]) || null;
}

function logContact(p, kind, note, date) {
  const d = date || todayIso();
  p.log = p.log || [];
  p.log.unshift({ date: d, kind, note: note || '' });
  if (!p.lastContact || d > p.lastContact) p.lastContact = d;
  p.snoozedUntil = null;
}

// ---------- intelligence: threads, focus, score, suggestions ----------
function tierWeight(p) {
  return p.type === 'dating' ? 3 : ({ inner: 3, close: 2, warm: 1 }[p.tier] || 1);
}
function openThread(p) {
  return (p.threads || []).find(t => !t.done) || null;
}

function nextFreeNights(count = 3) {
  const prof = S.settings.profile || {};
  const nights = prof.nights?.length ? prof.nights : ['Thu', 'Fri', 'Sat'];
  const dayName = iso => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
  const planned = new Set((S.plans || []).filter(pl => pl.status !== 'done').map(pl => pl.date));
  const out = [];
  for (let i = 1; i <= 14 && out.length < count; i++) {
    const d = addDays(todayIso(), i);
    if (nights.includes(dayName(d)) && !planned.has(d)) out.push(d);
  }
  return out;
}

function planSuggestions(n = 3) {
  const nights = nextFreeNights(n);
  const cands = activePeople().map(p => ({ p, d: dueInfo(p) }))
    .filter(x => x.d && !x.d.snoozed)
    .sort((a, b) => (b.d.overdue * tierWeight(b.p)) - (a.d.overdue * tierWeight(a.p)));
  const used = new Set();
  return nights.map(date => {
    const c = cands.find(x => !used.has(x.p.id));
    if (!c) return null;
    used.add(c.p.id);
    return { person: c.p, idea: suggestIdea(c.p), date };
  }).filter(Boolean);
}

function plansThisWeek() {
  const ws = startOfWeek();
  return (S.plans || []).filter(pl => pl.date >= ws && pl.date <= addDays(ws, 6));
}

function datesThisMonth() {
  const month = todayIso().slice(0, 7);
  const seen = new Set();
  for (const p of S.people) {
    if (p.type !== 'dating') continue;
    for (const l of (p.log || [])) {
      if (l.kind === 'date' && l.date.startsWith(month)) seen.add(l.date + '|' + p.id);
    }
  }
  return seen.size;
}

function orbitScore() {
  const act = activePeople();
  if (!act.length) return 100;
  let wSum = 0, wOk = 0;
  for (const p of act) {
    const w = tierWeight(p);
    const d = dueInfo(p);
    wSum += w;
    if (!d || d.snoozed || d.overdue < 0) wOk += w;
  }
  const onTrack = wSum ? wOk / wSum : 1;
  const prof = S.settings.profile || {};
  const hangs = plansThisWeek().length;
  const budget = prof.socialBudget ? Math.min(1, hangs / prof.socialBudget) : (hangs > 0 ? 1 : 0.6);
  return Math.round(100 * (0.65 * onTrack + 0.35 * budget));
}

function snapshotHistory() {
  const today = todayIso();
  const last = S.history[S.history.length - 1];
  if (last?.date === today) { last.score = orbitScore(); return; }
  S.history.push({ date: today, score: orbitScore() });
  if (S.history.length > 90) S.history = S.history.slice(-90);
}

function sparklineSvg() {
  const vals = S.history.slice(-30).map(h => h.score);
  // Two points is a line segment, not a trend — it just reads as a stray stroke.
  if (vals.length < 4) return '';
  const w = 72, h = 22;
  const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
  const pts = vals.map((v, i) =>
    `${(i / (vals.length - 1) * w).toFixed(1)},${(h - 2 - (v - min) / span * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}"/></svg>`;
}

let focusPending = null; // focus item awaiting a plan-dialog save

function generateFocus() {
  const today = todayIso();
  if (S.focus?.date === today && S.focus.items?.length) return S.focus;
  const ranked = duePeople()
    .sort((a, b) => (b.d.overdue * tierWeight(b.p)) - (a.d.overdue * tierWeight(a.p)));
  const items = [];
  const used = new Set();
  const takeDue = (pred, kind) => {
    const c = ranked.find(x => !used.has(x.p.id) && pred(x));
    if (c) { used.add(c.p.id); items.push({ id: uid(), personId: c.p.id, kind, done: false, skipped: false }); }
  };
  takeDue(() => true, 'reachout');
  takeDue(x => x.p.type === 'dating' && x.p.nextStep, 'nextstep');
  const sug = planSuggestions(3).find(s => !used.has(s.person.id));
  if (sug && items.length) {
    used.add(sug.person.id);
    items.push({ id: uid(), personId: sug.person.id, kind: 'plan', ideaId: sug.idea?.id || null, date: sug.date, done: false, skipped: false });
  }
  while (items.length < 3) {
    const c = ranked.find(x => !used.has(x.p.id));
    if (!c) break;
    used.add(c.p.id);
    items.push({ id: uid(), personId: c.p.id, kind: 'reachout', done: false, skipped: false });
  }
  S.focus = { date: today, items: items.slice(0, 3), celebrated: false };
  persist();
  return S.focus;
}

function checkFocusComplete() {
  const f = S.focus;
  if (!f || f.celebrated) return;
  const open = f.items.filter(i => !i.done && !i.skipped);
  if (open.length || !f.items.some(i => i.done)) return;
  f.celebrated = true;
  const y = addDays(todayIso(), -1);
  S.streaks.focusDays = S.streaks.lastFocusDate === y ? S.streaks.focusDays + 1 : 1;
  S.streaks.lastFocusDate = todayIso();
  S.streaks.bestFocus = Math.max(S.streaks.bestFocus || 0, S.streaks.focusDays);
  persist();
  confetti(40);
  toast(`Today's three — done. 🔥 ${S.streaks.focusDays}-day streak`);
}

function maybeCompleteFocus(personId) {
  const item = S.focus?.date === todayIso()
    && S.focus.items.find(i => i.personId === personId && !i.done && !i.skipped && i.kind !== 'plan');
  if (item) { item.done = true; checkFocusComplete(); }
}

function channelsFor(p) {
  const h = p.handles || {};
  return Object.entries(CHANNELS).filter(([, c]) => (h[c.needs] || '').trim());
}
function chStrip(p) {
  return channelsFor(p).map(([k, c]) =>
    `<button class="ch-btn" data-act="sayHi" data-id="${p.id}" data-ch="${k}" title="Say hi on ${c.name} (draft copied)">${c.label}</button>`).join('');
}
function draftFor(p) {
  const first = p.name.split(' ')[0];
  const th = openThread(p);
  if (th) {
    return /\?$/.test(th.text.trim())
      ? `Hey ${first} — ${th.text.trim().charAt(0).toLowerCase() + th.text.trim().slice(1)}`
      : `Hey ${first} — been meaning to ask: ${th.text.trim()}?`;
  }
  const idea = suggestIdea(p);
  if (p.type === 'dating') return `Hey ${first} — ${idea ? idea.title.toLowerCase() : 'drinks'} this week?`;
  return `Yo ${first} — been too long! ${idea ? idea.title + '?' : 'Free this week?'}`;
}

function gcalUrl(pl) {
  const names = pl.personIds.map(id => person(id)?.name.split(' ')[0]).filter(Boolean).join(' & ');
  const title = pl.title + (names ? ` with ${names}` : '');
  let dates;
  if (pl.time) {
    const [H, M] = pl.time.split(':').map(Number);
    const endMin = H * 60 + M + 90;
    const endDate = endMin >= 1440 ? addDays(pl.date, 1) : pl.date;
    dates = `${pl.date.replace(/-/g, '')}T${pad(H)}${pad(M)}00/${endDate.replace(/-/g, '')}T${pad(Math.floor(endMin / 60) % 24)}${pad(endMin % 60)}00`;
  } else {
    dates = `${pl.date.replace(/-/g, '')}/${addDays(pl.date, 1).replace(/-/g, '')}`;
  }
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${dates}${pl.place ? `&location=${encodeURIComponent(pl.place)}` : ''}&details=${encodeURIComponent('Planned in Orbit')}`;
}

// ---------- toast + confetti ----------
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function confetti(n = 48) {
  if (reduceMotion) return;
  const colors = ['#e06a3f', '#c2502f', '#cfa93e', '#8ba1cc', '#bd82b5', '#75a888'];
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'confetti';
    d.style.background = colors[i % colors.length];
    d.style.left = 50 + (Math.random() - 0.5) * 36 + 'vw';
    d.style.top = '-14px';
    if (Math.random() > 0.5) d.style.borderRadius = '50%';
    document.body.appendChild(d);
    d.animate([
      { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${(Math.random() - 0.5) * 260}px, ${62 + Math.random() * 40}vh) rotate(${Math.random() * 720 - 360}deg)`, opacity: 0 },
    ], { duration: 1500 + Math.random() * 1300, easing: 'cubic-bezier(.2,.55,.45,1)' }).onfinish = () => d.remove();
  }
}

// ---------- theme ----------
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('orbit-theme', next);
  $('#themeBtn').textContent = next === 'dark' ? '☀' : '☾';
  drawStarfield();
}

// ---------- starfield ----------
// Ambient depth behind the whole app. Three parallax layers that drift with
// scroll and breathe on their own. Skipped entirely under reduced motion.
let stars = [];
let starCanvas = null;
let starCtx = null;

function seedStars() {
  const w = innerWidth, h = innerHeight;
  const count = Math.min(190, Math.round((w * h) / 11000));
  stars = Array.from({ length: count }, (_, i) => ({
    x: Math.random() * w,
    y: Math.random() * (h * 1.6),
    r: 0.4 + Math.random() * 1.5,
    depth: 0.25 + Math.random() * 0.75,
    phase: Math.random() * Math.PI * 2,
    speed: 0.4 + Math.random() * 1.1,
    hue: i % 11 === 0 ? 'warm' : i % 7 === 0 ? 'cool' : 'plain',
  }));
}

function drawStarfield(t = 0) {
  if (!starCtx || reduceMotion) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = innerWidth, h = innerHeight;
  if (starCanvas.width !== w * dpr || starCanvas.height !== h * dpr) {
    starCanvas.width = w * dpr;
    starCanvas.height = h * dpr;
  }
  starCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  starCtx.clearRect(0, 0, w, h);
  const light = document.documentElement.dataset.theme === 'light';
  const scroll = scrollY;
  for (const s of stars) {
    const y = (s.y - scroll * s.depth * 0.35) % (h * 1.6);
    if (y < -4 || y > h + 4) continue;
    const twinkle = 0.45 + 0.55 * Math.abs(Math.sin(t / 2400 * s.speed + s.phase));
    const alpha = (light ? 0.3 : 0.85) * s.depth * twinkle;
    starCtx.beginPath();
    starCtx.arc(s.x, y, s.r * (light ? 0.9 : 1), 0, Math.PI * 2);
    starCtx.fillStyle = s.hue === 'warm'
      ? `rgba(252, 211, 141, ${alpha})`
      : s.hue === 'cool'
        ? `rgba(160, 205, 255, ${alpha})`
        : light ? `rgba(90, 80, 130, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
    starCtx.fill();
  }
}

function initStarfield() {
  starCanvas = $('#starfield');
  if (!starCanvas || reduceMotion) return;
  starCtx = starCanvas.getContext('2d');
  seedStars();
  addEventListener('resize', () => { seedStars(); drawStarfield(performance.now()); }, { passive: true });
  const loop = t => { drawStarfield(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

// ---------- router ----------
const VIEWS = {};
// Routes that borrow another tab's highlight in the nav.
const ROUTE_ALIAS = { triage: 'people', weekend: 'plan', tonight: 'plan', build: 'people' };

function render() {
  // A shared itinerary owns the whole screen — it's the one view a stranger
  // ever sees, so nothing else should compete with it.
  if (sharedPayload) {
    $$('#nav a, #tabbar a').forEach(a => a.classList.remove('active'));
    document.documentElement.dataset.route = 'shared';
    return VIEWS.shared();
  }

  const doRender = () => {
    // Onboarding and shared plans get the whole screen — CSS hides the chrome.
    document.documentElement.dataset.route = route;
    if (route !== 'plan' && route !== 'tonight' && route !== 'weekend') {
      document.documentElement.classList.remove('has-itin');
    }
    const highlight = ROUTE_ALIAS[route] || route;
    $$('#nav a, #tabbar a').forEach(a => {
      const on = a.dataset.view === highlight;
      a.classList.toggle('active', on);
      if (a.closest('#nav')) a.style.viewTransitionName = on ? 'nav-pill' : '';
    });
    const n = duePeople().length;
    for (const [sel] of [['#dueCount'], ['#tabDue']]) {
      const b = $(sel);
      if (b) { b.hidden = n === 0; b.textContent = n; }
    }
    return (VIEWS[route] || VIEWS.today)();
  };
  if (document.startViewTransition && !reduceMotion && lastRoute !== null && lastRoute !== route) {
    lastRoute = route;
    document.startViewTransition(doRender);
  } else {
    lastRoute = route;
    doRender();
  }
}

// Opening a share link while Orbit is already loaded is a fragment-only
// navigation, so this has to handle the token too — not just the cold boot.
async function applyShareToken(token) {
  try {
    const payload = await decodeShare(token);
    if (!Array.isArray(payload?.picks) || !payload.picks.length) throw new Error('empty');
    sharedPayload = payload;
    render();
    return true;
  } catch {
    sharedPayload = null;
    toast('That share link looks broken');
    return false;
  }
}

window.addEventListener('hashchange', () => {
  const hash = location.hash.slice(1);
  cgAbort?.abort();
  cgRun = null;
  plRun = null;

  if (hash.startsWith('s=')) {
    applyShareToken(hash.slice(2)).then(ok => {
      if (!ok) { route = 'today'; render(); }
    });
    return;
  }

  sharedPayload = null;
  route = hash || 'today';
  if (route !== 'welcome') ob = null;
  render();
});

// ---------- avatars ----------
function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function tierColor(p) {
  if (p.type === 'dating') return 'var(--dating)';
  return { inner: 'var(--inner)', close: 'var(--close)', warm: 'var(--warm)' }[p.tier] || 'var(--line)';
}
function avatarStyle(p) {
  const h = hashN(p.name) % 360;
  return `background:linear-gradient(135deg, hsl(${h} 46% 50%), hsl(${(h + 46) % 360} 52% 36%));--tierc:${tierColor(p)}`;
}

// ---------- constellation ----------
// Your circle drawn as a star chart: tier sets the orbit radius, tier colour is
// a star temperature, and anyone overdue pulses. Hairlines connect the inner
// ring back to you so it reads as a system rather than scattered dots.
function constellationSvg({ interactive = true } = {}) {
  const act = activePeople();
  const RADII = { inner: 62, close: 98, warm: 134 };
  const cx = 160, cy = 160;

  const rings = Object.values(RADII).map(r =>
    `<circle class="ring-line" cx="${cx}" cy="${cy}" r="${r}"/>`).join('');

  const specks = Array.from({ length: 26 }, (_, i) => {
    const a = (hashN('speck' + i) % 3600) / 10 * Math.PI / 180;
    const r = 26 + (hashN('r' + i) % 132);
    return `<circle class="speck" cx="${(cx + r * Math.cos(a)).toFixed(1)}" cy="${(cy + r * Math.sin(a)).toFixed(1)}" r="${(0.7 + (i % 3) * 0.5).toFixed(1)}"/>`;
  }).join('');

  const placed = act.map(p => {
    const r = RADII[p.tier] || RADII.warm;
    const a = (hashN(p.id) % 360) * Math.PI / 180;
    return {
      p,
      d: dueInfo(p),
      x: +(cx + r * Math.cos(a)).toFixed(1),
      y: +(cy + r * Math.sin(a)).toFixed(1),
    };
  });

  const links = placed
    .filter(s => s.p.tier === 'inner')
    .map(s => `<line class="link" x1="${cx}" y1="${cy}" x2="${s.x}" y2="${s.y}"/>`)
    .join('');

  const dots = placed.map(({ p, d, x, y }) => {
    const over = d && !d.snoozed && d.overdue >= 0;
    const color = p.type === 'dating' ? 'var(--dating)' : tierColor(p);
    const act = interactive ? `data-act="openPerson" data-id="${p.id}"` : '';
    return `<circle class="p-dot ${over ? 'overdue-dot' : ''}" ${act}
      cx="${x}" cy="${y}" r="${over ? 8 : 6}" fill="${color}" color="${color}">
      <title>${esc(p.name)}${over ? ` — ${d.overdue}d overdue` : ''}</title></circle>`;
  }).join('');

  const first = (S.settings.profile.firstName || 'You')[0].toUpperCase();
  return `<svg class="constellation" viewBox="0 0 320 320" aria-label="Your circle">
    <defs>
      <radialGradient id="youGrad" cx="35%" cy="30%" r="80%">
        <stop offset="0" stop-color="var(--aurora-3)"/>
        <stop offset="0.55" stop-color="var(--aurora-1)"/>
        <stop offset="1" stop-color="var(--aurora-2)"/>
      </radialGradient>
    </defs>
    ${rings}${specks}
    <g class="links">${links}</g>
    <g class="orbits">${dots}</g>
    <circle class="you-dot" cx="${cx}" cy="${cy}" r="16"/>
    <text class="you-label" x="${cx}" y="${cy + 3.5}" text-anchor="middle">${esc(first)}</text>
  </svg>`;
}

// ============================================================
//  THE CONCIERGE — "what should I do tonight / this weekend"
// ============================================================

const KIND_ICON = {
  music: '♪', comedy: '☺', food: '◍', drinks: '❋', art: '◈', film: '▤',
  outdoors: '⛰', active: '⚡', wellness: '❁', games: '◆', nightlife: '☾', home: '⌂',
};

const SLOTS = [
  { id: 'morning',   label: 'Morning',     time: '09:00', kinds: ['active', 'wellness', 'outdoors', 'food'] },
  { id: 'afternoon', label: 'Afternoon',   time: '14:00', kinds: ['art', 'outdoors', 'film', 'games', 'active'] },
  { id: 'happyhour', label: 'Happy hour',  time: '18:00', kinds: ['drinks', 'food'] },
  { id: 'dinner',    label: 'Dinner',      time: '20:00', kinds: ['food', 'drinks'] },
  { id: 'night',     label: 'Night',       time: '21:30', kinds: ['music', 'comedy', 'nightlife', 'film', 'games'] },
];
const SLOT_IDS = new Set(SLOTS.map(s => s.id));
const KIND_SLOT = {
  active: 'morning', wellness: 'morning',
  outdoors: 'afternoon', art: 'afternoon', film: 'afternoon', games: 'afternoon',
  drinks: 'happyhour', food: 'dinner',
  music: 'night', comedy: 'night', nightlife: 'night', home: 'night',
};
const TAG_KIND = {
  music: 'music', 'live music': 'music', jazz: 'music', concert: 'music', show: 'music',
  comedy: 'comedy',
  food: 'food', dinner: 'food', brunch: 'food', coffee: 'food', restaurant: 'food',
  drinks: 'drinks', cocktails: 'drinks', wine: 'drinks', bar: 'drinks', 'happy hour': 'drinks',
  art: 'art', museums: 'art', theater: 'art',
  film: 'film',
  outdoors: 'outdoors',
  active: 'active', running: 'active', climbing: 'active', cycling: 'active',
  basketball: 'active', gym: 'active', workout: 'active', fitness: 'active',
  wellness: 'wellness', yoga: 'wellness',
  games: 'games', poker: 'games',
  nightlife: 'nightlife', night: 'nightlife', dancing: 'nightlife', club: 'nightlife',
};

const PROMPT_HINTS = [
  'rainy, low-key, walkable',
  'impress a date — dinner then a show',
  'want to move my body, then eat well',
  'comedy and a late dinner',
  'happy hour with someone I miss',
  'outdoors Saturday, cozy Sunday',
];

const CITY_SUGGESTIONS = [
  'New York', 'Los Angeles', 'San Francisco', 'Chicago', 'Austin', 'Seattle',
  'Boston', 'Miami', 'Denver', 'London', 'Berlin', 'Paris', 'Toronto', 'Sydney',
];

function fmtTime(hhmm) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm || '')) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${pad(m)} ${ampm}`;
}

// Live run being streamed right now. Kept out of S so a half-finished run
// never gets persisted or synced.
let cgRun = null;
let cgAbort = null;
let plRun = null;
let plOpen = new Set();
let plAutoKey = '';

function conciergeKey(mode, date, vibe) {
  return [mode, S.settings.city || '?', date, (vibe || '').trim().toLowerCase()].join('|');
}

function conciergeDate(mode) {
  if (mode === 'weekend') return weekendDates()[0];
  const picked = S.concierge.pickedDate || S.planner.pickedDate;
  return picked && picked >= todayIso() ? picked : todayIso();
}

function inferKind(tags) {
  for (const t of tags || []) {
    const k = TAG_KIND[normTag(t)];
    if (k) return k;
  }
  return 'home';
}

function slotFromTime(hhmm) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm || '')) return 'dinner';
  const [h, m] = hhmm.split(':').map(Number);
  const mins = h * 60 + m;
  let best = SLOTS[3], dist = Infinity;
  for (const s of SLOTS) {
    const [sh, sm] = s.time.split(':').map(Number);
    const d = Math.abs(mins - (sh * 60 + sm));
    if (d < dist) { dist = d; best = s; }
  }
  return best.id;
}

function slotForItem(tags, startTime) {
  if (startTime) return slotFromTime(startTime);
  return KIND_SLOT[inferKind(tags)] || 'night';
}

function slotLabel(slot) {
  return SLOTS.find(s => s.id === slot)?.label || slot;
}

function slotTime(slot) {
  return SLOTS.find(s => s.id === slot)?.time || '19:00';
}

function plannerDates() {
  const range = S.planner.range;
  if (range === 'week') return Array.from({ length: 7 }, (_, i) => addDays(todayIso(), i));
  if (range === 'tonight') {
    const picked = S.planner.pickedDate;
    return [picked && picked >= todayIso() ? picked : todayIso()];
  }
  return weekendDates();
}

function plannerKey() {
  const dates = plannerDates();
  return [S.planner.range, S.settings.city || '?', dates[0], (S.planner.prompt || '').trim().toLowerCase()].join('|');
}

function cellKey(date, slot) { return `${date}|${slot}`; }

function scoreIdeaClient(i) {
  return tasteScoreTags(i.tags) + hoodBonusClient(i.hood) + (i.favorite ? 1.5 : 0);
}

function optionDedupeKey(o) {
  return normTag(o.title) + '|' + normTag(o.venue || '');
}

function syncRangeFromRoute() {
  if (route === 'tonight') S.planner.range = 'tonight';
  else if (route === 'weekend') S.planner.range = 'weekend';
}

// The URL is the source of truth for which mode you're in, so back/forward and
// shared links all behave.
const conciergeMode = () => (route === 'weekend' ? 'weekend' : 'tonight');

// ---------- weather (Open-Meteo, keyless) ----------
async function geocodeCity(city) {
  const cached = S.settings.profile.geo;
  if (cached?.city === city) return cached;
  const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name='
    + encodeURIComponent(city));
  const j = await r.json();
  const hit = j.results?.[0];
  if (!hit) throw new Error('city not found');
  const geo = { city, lat: hit.latitude, lon: hit.longitude, label: hit.name };
  S.settings.profile.geo = geo;
  persist();
  return geo;
}

const WEATHER_CODE = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'foggy', 51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'snow', 73: 'snow',
  75: 'heavy snow', 80: 'showers', 81: 'showers', 82: 'heavy showers',
  95: 'thunderstorms', 96: 'thunderstorms', 99: 'thunderstorms',
};

async function fetchWeather(dates) {
  const city = S.settings.city;
  if (!city || !dates.length) return null;
  try {
    const geo = await geocodeCity(city);
    const r = await fetch('https://api.open-meteo.com/v1/forecast'
      + `?latitude=${geo.lat}&longitude=${geo.lon}`
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min'
      + '&temperature_unit=fahrenheit&timezone=auto&forecast_days=10');
    const j = await r.json();
    const out = [];
    for (const date of dates) {
      const i = j.daily?.time?.indexOf(date);
      if (i === undefined || i < 0) continue;
      out.push({
        date,
        summary: WEATHER_CODE[j.daily.weather_code[i]] || 'mixed',
        high: Math.round(j.daily.temperature_2m_max[i]),
        low: Math.round(j.daily.temperature_2m_min[i]),
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function weatherLine(weather) {
  if (!weather?.length) return '';
  return weather.map(w => `${fmtDate(w.date)}: ${w.summary}, ${w.high}°/${w.low}°F`).join('; ');
}

// ---------- who to bring ----------
// The people most worth seeing right now: overdue, weighted by tier. This is
// what turns generic city listings into something only Orbit could suggest.
function companionsPayload(limit = 8) {
  return activePeople()
    .map(p => ({ p, d: dueInfo(p) }))
    .filter(x => x.d && !x.d.snoozed)
    .sort((a, b) => (b.d.overdue * tierWeight(b.p)) - (a.d.overdue * tierWeight(a.p)))
    .slice(0, limit)
    .map(({ p, d }) => ({
      name: p.name.split(' ')[0],
      relationship: p.type === 'dating' ? `dating · ${p.stage || 'new'}` : TIER_LABEL[p.tier].toLowerCase(),
      overdueDays: Math.max(0, d.overdue),
      interests: (p.interests || []).slice(0, 4),
    }));
}

function personByFirstName(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  return activePeople().find(p => p.name.split(' ')[0].toLowerCase() === n)
    || activePeople().find(p => p.name.toLowerCase().startsWith(n)) || null;
}

// ---------- the run ----------
// Top-scored events/venues from the taste engine, sent along so the model
// grounds its picks in things the user's own sources already vetted.
function conciergeCandidates(dates) {
  const evs = (S.events || [])
    .filter(e => e.status !== 'dismissed' && e.date && dates.includes(e.date))
    .sort((a, b) => scoreEventClient(b) - scoreEventClient(a))
    .slice(0, 12)
    .map(e => ({ title: e.title, venue: e.venue, neighborhood: e.neighborhood, date: e.date, tags: e.tags, url: e.url }));
  const vns = (S.venues || [])
    .filter(v => v.flag !== 'dismissed')
    .sort((a, b) => scoreVenueClient(b) - scoreVenueClient(a))
    .slice(0, 8)
    .map(v => ({ name: v.name, hood: v.hood, tags: v.tags, availability: v.availability, url: v.url || v.bookVia }));
  return [...evs, ...vns].slice(0, 20);
}

async function runConcierge({ mode, vibe = '', budget = '', force = false } = {}) {
  const city = S.settings.city;
  if (!city) { toast('Add your city first ✦'); location.hash = '#welcome'; return; }

  const dates = mode === 'weekend' ? weekendDates() : [conciergeDate(mode)];
  const key = conciergeKey(mode, dates[0], vibe);

  if (!force && S.concierge.runs[key]?.picks?.length) {
    cgRun = null;
    renderConciergeBody();
    return;
  }

  cgAbort?.abort();
  cgAbort = new AbortController();
  cgRun = { mode, key, dates, vibe, budget, status: 'Reading the room…', picks: [], error: null, done: false };
  renderConciergeBody();

  const weather = await fetchWeather(dates);
  if (weather) {
    S.concierge.weather = { city, at: Date.now(), days: weather };
    persist();
  }
  if (cgRun) renderConciergeBody();

  const prof = S.settings.profile || {};
  const body = {
    mode,
    city,
    date: dates[0],
    dates,
    vibe,
    budget,
    weather: weatherLine(weather),
    profile: {
      firstName: prof.firstName || '',
      interests: S.settings.interests || [],
      neighborhoods: prof.neighborhoods || [],
      dateStyles: prof.dateStyles || [],
      datingMode: prof.datingMode || '',
    },
    companions: companionsPayload(),
    candidates: conciergeCandidates(dates),
  };
  if (S.settings.integrations?.provider) body.provider = S.settings.integrations.provider;

  try {
    const res = await fetch(proxyUrl() + '/concierge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: cgAbort.signal,
    });

    if (!res.ok || !res.body) {
      let msg = `The concierge is unreachable (${res.status}).`;
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch { /* keep the status-code message */ }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (!cgRun) return;
          if (ev.type === 'status') cgRun.status = ev.text;
          else if (ev.type === 'pick') cgRun.picks.push(normalizePick(ev.pick, cgRun));
          else if (ev.type === 'error') cgRun.error = ev.message;
          else if (ev.type === 'done') cgRun.done = true;
          renderConciergeBody();
        }
      }
    }

    if (!cgRun) return;
    if (cgRun.picks.length) {
      S.concierge.runs[key] = {
        mode, city, dates, vibe,
        at: Date.now(),
        picks: cgRun.picks,
      };
      // Only the last handful of runs are worth keeping around.
      const keys = Object.keys(S.concierge.runs);
      if (keys.length > 8) {
        keys
          .sort((a, b) => (S.concierge.runs[a].at || 0) - (S.concierge.runs[b].at || 0))
          .slice(0, keys.length - 8)
          .forEach(k => delete S.concierge.runs[k]);
      }
      persist();
      cgRun = null;
      renderConciergeBody();
      if (!reduceMotion) confetti(18);
    } else {
      cgRun.error = cgRun.error || 'Nothing came back. Try again, or loosen the vibe.';
      cgRun.done = true;
      renderConciergeBody();
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (!cgRun) return;
    cgRun.error = String(err.message || err);
    cgRun.done = true;
    renderConciergeBody();
  }
}

function normalizePick(raw, run) {
  const dates = run?.dates || [todayIso()];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') && dates.includes(raw.date)
    ? raw.date
    : dates[0];
  const planner = run?.mode === 'planner' || SLOT_IDS.has(raw.slot);
  let slot;
  if (SLOT_IDS.has(raw.slot)) slot = raw.slot;
  else if (planner) slot = slotFromTime(raw.startTime);
  else slot = String(raw.slot || (run?.mode === 'weekend' ? fmtDay(date) : 'Tonight')).slice(0, 40);
  return {
    id: raw.id || uid(),
    slot,
    date,
    title: String(raw.title || '').slice(0, 140),
    venue: String(raw.venue || '').slice(0, 90),
    neighborhood: String(raw.neighborhood || '').slice(0, 60),
    startTime: /^\d{1,2}:\d{2}$/.test(raw.startTime || '') ? raw.startTime : slotTime(slot),
    price: ['free', '$', '$$', '$$$'].includes(raw.price) ? raw.price : '',
    kind: KIND_ICON[raw.kind] ? raw.kind : inferKind([raw.kind]),
    why: String(raw.why || '').slice(0, 260),
    tip: String(raw.tip || '').slice(0, 220),
    url: /^https?:\/\//.test(raw.url || '') ? raw.url : null,
    bring: raw.bring ? String(raw.bring).slice(0, 40) : null,
    indoor: raw.indoor !== false,
    source: raw.source === 'yours' ? 'yours' : (run?.mode === 'planner' ? 'live' : (raw.source || '')),
    refKind: raw.refKind || null,
    refId: raw.refId || null,
  };
}

function localOptions(dates) {
  const cells = {};
  for (const date of dates) for (const s of SLOTS) cells[cellKey(date, s.id)] = [];

  const push = (date, slot, opt) => {
    const k = cellKey(date, slot);
    if (!cells[k]) return;
    if (cells[k].some(x => optionDedupeKey(x) === optionDedupeKey(opt))) return;
    cells[k].push(opt);
  };

  for (const e of (S.events || [])) {
    if (e.status === 'dismissed' || !e.date || !dates.includes(e.date)) continue;
    const kind = inferKind(e.tags);
    const slot = slotForItem(e.tags, e.startTime || e.time);
    push(e.date, slot, {
      id: uid(), slot, date: e.date, title: e.title, venue: e.venue || '',
      neighborhood: e.neighborhood || '', startTime: e.startTime || e.time || slotTime(slot),
      price: e.price || '', kind, why: '', tip: e.notes || '', url: e.url || null,
      bring: null, indoor: e.indoor !== false, source: 'yours', refKind: 'event', refId: e.id,
    });
  }

  const standing = [
    ...(S.venues || []).filter(v => v.flag !== 'dismissed').map(v => {
      const kind = inferKind(v.tags);
      return {
        score: scoreVenueClient(v),
        slot: KIND_SLOT[kind] || 'dinner',
        opt: date => ({
          id: uid(), slot: KIND_SLOT[kind] || 'dinner', date, title: v.name, venue: v.name,
          neighborhood: v.hood || '', startTime: slotTime(KIND_SLOT[kind] || 'dinner'),
          price: v.price || '', kind, why: '', tip: v.availability || '', url: v.url || v.bookVia || null,
          bring: null, indoor: true, source: 'yours', refKind: 'venue', refId: v.id,
        }),
      };
    }),
    ...(S.ideas || []).filter(ideaFitsCity).map(i => {
      const kind = inferKind(i.tags);
      return {
        score: scoreIdeaClient(i),
        slot: KIND_SLOT[kind] || slotForItem(i.tags),
        opt: date => ({
          id: uid(), slot: KIND_SLOT[kind] || slotForItem(i.tags), date, title: i.title,
          venue: i.hood || '', neighborhood: i.hood || '', startTime: slotTime(KIND_SLOT[kind] || 'night'),
          price: i.cost || '', kind, why: '', tip: i.notes || '', url: i.url || null,
          bring: null, indoor: true, source: 'yours', refKind: 'idea', refId: i.id,
        }),
      };
    }),
  ].sort((a, b) => b.score - a.score);

  for (const [di, date] of dates.entries()) {
    const used = new Set(Object.entries(cells)
      .filter(([k]) => k.startsWith(date + '|'))
      .flatMap(([, list]) => list.map(optionDedupeKey)));
    const rotated = standing.slice(di).concat(standing.slice(0, di));
    for (const item of rotated) {
      const k = cellKey(date, item.slot);
      if ((cells[k] || []).length >= 3) continue;
      const opt = item.opt(date);
      if (used.has(optionDedupeKey(opt))) continue;
      push(date, item.slot, opt);
      used.add(optionDedupeKey(opt));
    }
  }

  for (const k of Object.keys(cells)) cells[k] = cells[k].slice(0, 3);
  return cells;
}

function currentBoard() {
  return S.planner.boards[plannerKey()] || { dates: plannerDates(), at: 0, options: {}, chosen: {}, dismissed: [] };
}

function ensureBoard() {
  const key = plannerKey();
  const dates = plannerDates();
  let board = S.planner.boards[key];
  if (!board) board = S.planner.boards[key] = { dates, at: 0, options: {}, chosen: {}, dismissed: [] };
  board.dismissed = board.dismissed || [];
  const blocked = new Set(board.dismissed);
  const local = localOptions(dates);
  for (const [cell, opts] of Object.entries(local)) {
    const have = board.options[cell] || [];
    const seen = new Set(have.map(optionDedupeKey));
    board.options[cell] = have.concat(opts.filter(o => !seen.has(optionDedupeKey(o)) && !blocked.has(optionDedupeKey(o))));
  }
  return board;
}

function pruneBoards() {
  const keys = Object.keys(S.planner.boards);
  if (keys.length <= 6) return;
  keys.sort((a, b) => (S.planner.boards[a].at || 0) - (S.planner.boards[b].at || 0))
    .slice(0, keys.length - 6)
    .forEach(k => delete S.planner.boards[k]);
}

function findOption(id) {
  const board = currentBoard();
  for (const list of Object.values(board.options || {})) {
    const hit = list.find(o => o.id === id);
    if (hit) return hit;
  }
  return null;
}

function lockedCells(board) {
  return Object.entries(board.chosen || {}).filter(([, id]) => id).map(([cell]) => cell);
}

function chosenOptions(board) {
  const out = [];
  for (const [cell, id] of Object.entries(board.chosen || {})) {
    const opt = (board.options[cell] || []).find(o => o.id === id);
    if (opt) out.push(opt);
  }
  return out.sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
}

function boardHasLive(board) {
  return Object.values(board.options || {}).some(list => list.some(o => o.source === 'live'));
}

function mergeLiveOption(board, pick) {
  if (!SLOT_IDS.has(pick.slot)) pick.slot = slotFromTime(pick.startTime);
  if (!board.dates.includes(pick.date)) pick.date = board.dates[0];
  const cell = cellKey(pick.date, pick.slot);
  if (board.chosen[cell]) return; // locked — don't overwrite
  const key = optionDedupeKey(pick);
  if ((board.dismissed || []).includes(key)) return;
  const have = board.options[cell] || [];
  if (have.some(o => optionDedupeKey(o) === key)) return;
  board.options[cell] = have.concat(pick);
}

async function runPlanner({ force = false } = {}) {
  const city = S.settings.city;
  if (!city) { toast('Add your city first ✦'); location.hash = '#welcome'; return; }

  const dates = plannerDates();
  const key = plannerKey();
  const board = ensureBoard();

  if (!force && boardHasLive(board)) {
    plRun = null;
    renderPlannerBody();
    return;
  }

  if (force) {
    const locked = new Set(lockedCells(board));
    if (locked.size === dates.length * SLOTS.length) {
      toast('Everything is locked — unlock a slot to reshape');
      return;
    }
    for (const cell of Object.keys(board.options)) {
      if (locked.has(cell)) continue;
      board.options[cell] = (board.options[cell] || []).filter(o => o.source === 'yours');
    }
    const local = localOptions(dates);
    const blocked = new Set(board.dismissed || []);
    for (const [cell, opts] of Object.entries(local)) {
      if (locked.has(cell)) continue;
      const have = board.options[cell] || [];
      const seen = new Set(have.map(optionDedupeKey));
      board.options[cell] = have.concat(opts.filter(o => !seen.has(optionDedupeKey(o)) && !blocked.has(optionDedupeKey(o))));
    }
  }

  cgAbort?.abort();
  cgAbort = new AbortController();
  plRun = { key, dates, status: 'Reading the room…', error: null, done: false };
  renderPlannerBody();

  const weather = await fetchWeather(dates);
  if (weather) {
    S.concierge.weather = { city, at: Date.now(), days: weather };
    persist();
  }
  if (plRun) renderPlannerBody();

  const prof = S.settings.profile || {};
  const body = {
    mode: 'planner',
    city,
    date: dates[0],
    dates,
    vibe: S.planner.prompt || '',
    weather: weatherLine(weather),
    locked: lockedCells(board),
    profile: {
      firstName: prof.firstName || '',
      interests: S.settings.interests || [],
      neighborhoods: prof.neighborhoods || [],
      dateStyles: prof.dateStyles || [],
      datingMode: prof.datingMode || '',
    },
    companions: companionsPayload(),
    candidates: conciergeCandidates(dates),
  };
  if (S.settings.integrations?.provider) body.provider = S.settings.integrations.provider;

  try {
    const res = await fetch(proxyUrl() + '/concierge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: cgAbort.signal,
    });

    if (!res.ok || !res.body) {
      let msg = `The concierge is unreachable (${res.status}).`;
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch { /* keep the status-code message */ }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (!plRun) return;
          if (ev.type === 'status') plRun.status = ev.text;
          else if (ev.type === 'pick') {
            mergeLiveOption(board, normalizePick(ev.pick, { mode: 'planner', dates }));
            board.at = Date.now();
          } else if (ev.type === 'error') plRun.error = ev.message;
          else if (ev.type === 'done') plRun.done = true;
          renderPlannerBody();
        }
      }
    }

    if (!plRun) return;
    if (boardHasLive(board) || Object.values(board.options).some(l => l.length)) {
      board.at = Date.now();
      pruneBoards();
      persist();
      plRun = null;
      renderPlannerBody();
      if (!reduceMotion && boardHasLive(board)) confetti(12);
    } else {
      plRun.error = plRun.error || 'Nothing came back. Try a looser prompt.';
      plRun.done = true;
      renderPlannerBody();
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (!plRun) return;
    plRun.error = String(err.message || err);
    plRun.done = true;
    renderPlannerBody();
  }
}

function maybeAutoPlan() {
  if (!S.settings.city) return;
  const key = plannerKey();
  if (plAutoKey === key) return;
  if (plRun && !plRun.done) return;
  if (boardHasLive(ensureBoard())) { plAutoKey = key; return; }
  plAutoKey = key;
  runPlanner({ force: false });
}

// ---------- rendering ----------
function pickCard(pick, i, { readOnly = false } = {}) {
  const buddy = readOnly ? null : personByFirstName(pick.bring);
  const meta = [
    pick.venue,
    pick.neighborhood,
    pick.price === 'free' ? 'free' : pick.price,
  ].filter(Boolean).map(esc).join(' · ');

  const title = pick.url
    ? `<a href="${esc(pick.url)}" target="_blank" rel="noopener">${esc(pick.title)} ↗</a>`
    : esc(pick.title);

  return `<article class="pick-card spot" style="--i:${i};animation-delay:${i * 70}ms">
    <div class="pick-when">
      <span class="slot">${esc(slotLabel(pick.slot))}</span>
      ${pick.startTime ? `<span class="time">${esc(fmtTime(pick.startTime))}</span>` : ''}
      ${!readOnly && pick.date !== todayIso() ? `<span class="time">${esc(fmtDate(pick.date))}</span>` : ''}
    </div>
    <div class="pick-kind" title="${esc(pick.kind)}">${KIND_ICON[pick.kind] || '◍'}</div>
    <div class="pick-body">
      <h3 class="pick-title">${title}</h3>
      ${meta ? `<div class="pick-meta">${meta}${pick.indoor === false ? ' · outdoors' : ''}</div>` : ''}
      ${pick.why ? `<p class="pick-why">${esc(pick.why)}</p>` : ''}
      ${pick.tip ? `<div class="pick-tip">${esc(pick.tip)}</div>` : ''}
      ${buddy ? `<div><span class="pick-bring">
        <span class="avatar" style="${avatarStyle(buddy)}">${initials(buddy.name)}</span>
        bring ${esc(buddy.name.split(' ')[0])}${dueInfo(buddy)?.overdue > 0 ? ` · ${dueInfo(buddy).overdue}d overdue` : ''}
      </span></div>` : pick.bring && !readOnly ? `<div class="small faint">bring ${esc(pick.bring)}</div>` : ''}
      ${readOnly ? '' : `<div class="pick-actions">
        <button class="btn tiny accent" data-act="pickPlan" data-id="${pick.id}">Make it a plan</button>
        <button class="btn tiny" data-act="pickSave" data-id="${pick.id}">Save</button>
        <button class="btn tiny ghost" data-act="pickShare" data-id="${pick.id}">Share</button>
      </div>`}
    </div>
  </article>`;
}

function currentPicks() {
  if (cgRun) return cgRun.picks;
  const mode = conciergeMode();
  const run = S.concierge.runs[conciergeKey(mode, conciergeDate(mode), S.concierge.vibe || '')];
  return run?.picks || [];
}

function findPick(id) {
  return findOption(id) || currentPicks().find(p => p.id === id) || null;
}

function weatherChip() {
  const w = S.concierge.weather;
  if (!w || w.city !== S.settings.city) return '';
  const day = w.days.find(d => d.date === conciergeDate(conciergeMode())) || w.days[0];
  if (!day) return '';
  return `<span class="weather-chip">${esc(day.summary)} · ${day.high}°/${day.low}°F</span>`;
}

// Only the stream area re-renders while results arrive, so the vibe input keeps
// focus and the caret doesn't jump mid-typing.
function renderConciergeBody() {
  const status = $('#cgStatus');
  const stream = $('#cgStream');
  if (!status || !stream) return;

  const go = $('#cgGo');
  if (go) {
    const running = cgRun && !cgRun.done;
    go.disabled = !!running;
    go.innerHTML = running
      ? '<span class="spin">◌</span> Searching…'
      : `${currentPicks().length ? 'Find more' : 'Find something'} →`;
  }

  if (cgRun && !cgRun.done) {
    status.innerHTML = `<span class="orb"></span><span>${esc(cgRun.status)}</span>
      <button class="btn tiny ghost" data-act="cgStop">Stop</button>`;
    status.hidden = false;
  } else {
    const picks = currentPicks();
    const run = cgRun || S.concierge.runs[conciergeKey(conciergeMode(), conciergeDate(conciergeMode()), S.concierge.vibe || '')];
    if (picks.length && run?.at) {
      status.innerHTML = `<span>${picks.length} ${picks.length === 1 ? 'idea' : 'ideas'} · found ${new Date(run.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        <button class="btn tiny ghost" data-act="cgRefresh">↻ Again</button>
        <button class="btn tiny ghost" data-act="cgShareAll">Share all</button>`;
      status.hidden = false;
    } else {
      status.hidden = true;
    }
  }

  const picks = currentPicks();
  const err = cgRun?.error;
  const loading = cgRun && !cgRun.done;

  stream.innerHTML = [
    picks.map((p, i) => pickCard(p, i)).join(''),
    loading ? `<div class="skeleton" style="animation-delay:${picks.length * 70}ms"></div>` : '',
    err ? `<div class="empty">
        <span class="big">◌</span>${esc(err)}
        <div class="small faint" style="margin-top:10px">
          The concierge runs through a proxy you control — check it in <a href="#connect">Connect</a>.
        </div>
      </div>` : '',
    !picks.length && !loading && !err ? `<div class="empty">
        <span class="big">✦</span>
        Hit <b>Find something</b> and Orbit will go read the listings, cross-check the dates,
        and come back with real places${activePeople().length ? ' — plus who to bring' : ''}.
      </div>` : '',
  ].join('');
}

function dayWeather(date) {
  const w = S.concierge.weather;
  if (!w || w.city !== S.settings.city) return null;
  return w.days.find(d => d.date === date) || null;
}

function optionCard(opt, cell, lockedId) {
  const locked = lockedId === opt.id;
  const buddy = personByFirstName(opt.bring);
  const meta = [opt.venue && opt.venue !== opt.title ? opt.venue : '', opt.neighborhood, opt.price === 'free' ? 'free' : opt.price]
    .filter(Boolean).map(esc).join(' · ');
  const title = opt.url
    ? `<a href="${esc(opt.url)}" target="_blank" rel="noopener">${esc(opt.title)} ↗</a>`
    : esc(opt.title);
  return `<article class="pl-opt spot ${locked ? 'locked' : ''} ${opt.source === 'live' ? 'live' : 'yours'}" data-opt="${opt.id}">
    <div class="pl-opt-kind" title="${esc(opt.kind)}">${KIND_ICON[opt.kind] || '◍'}</div>
    <div class="pl-opt-body">
      <h3 class="pl-opt-title">${title}</h3>
      ${meta ? `<div class="pl-opt-meta">${meta}${opt.indoor === false ? ' · outdoors' : ''}${opt.startTime ? ` · ${esc(fmtTime(opt.startTime))}` : ''}</div>` : ''}
      ${opt.why ? `<p class="pl-opt-why">${esc(opt.why)}</p>` : ''}
      ${opt.tip ? `<div class="pl-opt-tip">${esc(opt.tip)}</div>` : ''}
      ${buddy ? `<div class="pick-bring"><span class="avatar" style="${avatarStyle(buddy)}">${initials(buddy.name)}</span>bring ${esc(buddy.name.split(' ')[0])}</div>` : ''}
      <div class="pl-opt-actions">
        <button class="btn tiny ${locked ? 'accent' : ''}" data-act="plLock" data-id="${opt.id}">${locked ? 'Locked' : 'Choose'}</button>
        <button class="btn tiny ghost" data-act="plSave" data-id="${opt.id}">Save</button>
        <button class="btn tiny ghost danger" data-act="plDismiss" data-id="${opt.id}" title="Not for me">✕</button>
      </div>
    </div>
  </article>`;
}

function renderPlannerBody() {
  const status = $('#plStatus');
  const grid = $('#plGrid');
  const itin = $('#plItin');
  const go = $('#plGo');
  if (!grid) return;

  const board = currentBoard();
  const dates = board.dates.length ? board.dates : plannerDates();
  const running = plRun && !plRun.done;

  if (go) {
    go.disabled = !!running;
    go.innerHTML = running
      ? '<span class="spin">◌</span> Searching…'
      : boardHasLive(board) ? 'Reshape →' : 'Fill the weekend →';
  }

  if (status) {
    if (running) {
      status.innerHTML = `<span class="orb"></span><span>${esc(plRun.status)}</span>
        <button class="btn tiny ghost" data-act="plStop">Stop</button>`;
      status.hidden = false;
    } else if (plRun?.error) {
      status.innerHTML = `<span>${esc(plRun.error)}</span>
        <button class="btn tiny ghost" data-act="plRefresh">↻ Try again</button>`;
      status.hidden = false;
    } else if (boardHasLive(board) && board.at) {
      status.innerHTML = `<span>Live options · ${new Date(board.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        <button class="btn tiny ghost" data-act="plRefresh">↻ Again</button>`;
      status.hidden = false;
    } else {
      status.hidden = true;
    }
  }

  const nDays = dates.length;
  const heads = dates.map(date => {
    const w = dayWeather(date);
    const isToday = date === todayIso();
    return `<header class="pl-day-head ${isToday ? 'today' : ''}">
      <b>${esc(new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }))}</b>
      <span>${esc(fmtDate(date))}</span>
      ${w ? `<span class="weather-chip">${esc(w.summary)} · ${w.high}°</span>` : ''}
    </header>`;
  }).join('');

  const cellHtml = (date, s) => {
    const cell = cellKey(date, s.id);
    const all = board.options[cell] || [];
    const lockedId = board.chosen[cell];
    const open = plOpen.has(cell);
    const shown = open ? all : all.slice(0, 2);
    const more = all.length - shown.length;
    return `<div class="pl-cell" data-cell="${esc(cell)}">
      <div class="pl-cell-label">${esc(s.label)}</div>
      <div class="pl-opts">${shown.map(o => optionCard(o, cell, lockedId)).join('')}</div>
      ${all.length > 2 ? `<button class="pl-more" data-act="plMore" data-id="${esc(cell)}">${open ? 'Show less' : `+${more} more`}</button>` : ''}
      ${!all.length ? `<div class="pl-empty">${running ? '<div class="skeleton pl-skel"></div>' : '—'}</div>` : ''}
    </div>`;
  };

  grid.style.setProperty('--days', String(nDays));
  grid.innerHTML = `
    <div class="pl-cal-grid">
      <div class="pl-corner"></div>
      ${heads}
      ${SLOTS.map(s => `
        <div class="pl-rail-slot">${esc(s.label)}</div>
        ${dates.map(date => cellHtml(date, s)).join('')}
      `).join('')}
    </div>
    <div class="pl-stack">
      ${dates.map((date, i) => {
        const w = dayWeather(date);
        return `<section class="pl-day rise" style="--i:${i}">
          <header class="pl-day-head ${date === todayIso() ? 'today' : ''}">
            <b>${esc(new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }))}</b>
            <span>${esc(fmtDate(date))}</span>
            ${w ? `<span class="weather-chip">${esc(w.summary)} · ${w.high}°</span>` : ''}
          </header>
          ${SLOTS.map(s => cellHtml(date, s)).join('')}
        </section>`;
      }).join('')}
    </div>
  `;

  const locked = chosenOptions(board);
  if (itin) {
    if (!locked.length) { itin.hidden = true; document.documentElement.classList.remove('has-itin'); }
    else {
      itin.hidden = false;
      document.documentElement.classList.add('has-itin');
      const span = `${fmtDay(locked[0].date)}${locked.length > 1 ? '–' + fmtDay(locked[locked.length - 1].date) : ''}`;
      itin.innerHTML = `
        <div class="pl-itin-copy"><b>${locked.length} locked</b> · ${esc(span)}</div>
        <div class="pl-itin-actions">
          <button class="btn tiny accent" data-act="plAddAll">Add all to Plans</button>
          <button class="btn tiny ghost" data-act="plShareAll">Share</button>
        </div>`;
    }
  }
}

VIEWS.plan = function renderPlanner() {
  syncRangeFromRoute();
  const city = S.settings.city;
  const range = S.planner.range;
  const dates = plannerDates();
  const hint = PROMPT_HINTS[Math.floor(Date.now() / 60000) % PROMPT_HINTS.length];
  const headings = {
    tonight: `What should I do <span class="aurora-text">${dates[0] === todayIso() ? 'tonight' : fmtDay(dates[0])}</span>?`,
    weekend: `Plan <span class="aurora-text">this weekend</span>`,
    week: `Plan <span class="aurora-text">the week</span>`,
  };
  const lede = city
    ? `Real options in ${esc(city)} — dinner, happy hour, shows, a workout — so you actually go out. Type what you feel; Orbit fills the calendar.`
    : `Add your city and Orbit can start finding real things to do.`;

  ensureBoard();

  $('#view').innerHTML = `
    <section class="cg-hero pl-hero rise">
      <h1>${headings[range] || headings.weekend}</h1>
      <p class="cg-lede">${lede}</p>

      <div class="pl-ranges">
        <button class="pl-range ${range === 'tonight' ? 'on' : ''}" data-act="plRange" data-id="tonight">Tonight</button>
        <button class="pl-range ${range === 'weekend' ? 'on' : ''}" data-act="plRange" data-id="weekend">This weekend</button>
        <button class="pl-range ${range === 'week' ? 'on' : ''}" data-act="plRange" data-id="week">Next 7 days</button>
      </div>

      <form class="pl-prompt" id="plForm">
        ${range === 'tonight' ? `<input type="date" id="plDate" value="${esc(dates[0])}" min="${todayIso()}" max="${addDays(todayIso(), 21)}">` : ''}
        <input id="plPrompt" placeholder="${esc(hint)}" value="${esc(S.planner.prompt || '')}" autocomplete="off">
        <button class="btn accent" id="plGo" type="submit">${boardHasLive(currentBoard()) ? 'Reshape →' : 'Fill the weekend →'}</button>
      </form>
      <div class="cg-status" id="plStatus" hidden></div>
    </section>

    <div class="pl-cal" id="plGrid" style="--days:${dates.length}"></div>
    <div class="pl-itin" id="plItin" hidden></div>

    ${city ? '' : `<div class="empty rise" style="margin-top:18px">
      Orbit needs to know where you are. <a href="#" data-act="goWelcome"><b>Set your city →</b></a>
    </div>`}
  `;

  renderPlannerBody();
  maybeAutoPlan();
  if (city) {
    fetchWeather(dates).then(weather => {
      if (!weather) return;
      S.concierge.weather = { city, at: Date.now(), days: weather };
      persist();
      renderPlannerBody();
    });
  }

  $('#plForm')?.addEventListener('submit', e => {
    e.preventDefault();
    ACTIONS.plGo();
  });
  $('#plDate')?.addEventListener('change', e => {
    S.planner.pickedDate = e.target.value;
    S.concierge.pickedDate = e.target.value;
    persist();
    VIEWS.plan();
  });
};

VIEWS.tonight = VIEWS.plan;
VIEWS.weekend = VIEWS.plan;

// ---------- TODAY ----------
function dueRow({ p, d }, i) {
  const idea = suggestIdea(p);
  const label = p.type === 'dating'
    ? `<span class="chip type-dating">dating · ${esc(STAGE_LABEL[p.stage] || p.stage)}</span>`
    : `<span class="chip tier-${p.tier}">${TIER_LABEL[p.tier]}</span>`;
  const overdueTxt = d.overdue === 0 ? 'due today' : `${d.overdue}d overdue`;
  const lastTxt = p.lastContact ? `last: ${fmtDate(p.lastContact)}` : 'never logged';
  const ideaTxt = idea ? ` · idea: ${esc(idea.title)}` : '';
  return `<div class="due-row rise" style="--i:${i}">
    <div class="avatar" style="${avatarStyle(p)}">${initials(p.name)}</div>
    <div class="who">
      <div class="name">${esc(p.name)} ${label} <span class="chip overdue">${overdueTxt}</span></div>
      <div class="meta">${lastTxt}${ideaTxt}</div>
      ${openThread(p) ? `<div class="next-step">💭 ${esc(openThread(p).text)}</div>` : ''}
      ${p.nextStep ? `<div class="next-step">→ ${esc(p.nextStep)}</div>` : ''}
    </div>
    <div class="actions">
      <span class="ch-strip">${chStrip(p)}</span>
      <button class="btn tiny" data-act="log" data-id="${p.id}">✓ Caught up</button>
      <button class="btn tiny accent" data-act="plan" data-id="${p.id}">Plan</button>
      <button class="btn tiny ghost" data-act="snooze" data-id="${p.id}">Snooze</button>
    </div>
  </div>`;
}

function planRow(pl, i = 0, withActions = true) {
  const names = pl.personIds.map(id => person(id)?.name).filter(Boolean).join(', ');
  const meta = [names || null, pl.place || null].filter(Boolean).join(' · ');
  return `<div class="plan-row rise ${pl.status === 'done' ? 'done' : ''}" style="--i:${i}">
    <div class="when">${fmtDay(pl.date)}<span class="t">${esc(pl.time || '')}</span></div>
    <div class="what">
      <div class="title">${esc(pl.title)}</div>
      <div class="meta">${esc(meta)}</div>
    </div>
    ${withActions && pl.status !== 'done' ? `<div class="actions">
      <a class="btn tiny ghost" href="${gcalUrl(pl)}" target="_blank" rel="noopener" title="Add to Google Calendar">GCal ↗</a>
      <button class="btn tiny" data-act="planDone" data-id="${pl.id}">✓ Done</button>
      <button class="btn tiny ghost" data-act="planEdit" data-id="${pl.id}">Edit</button>
    </div>` : ''}
  </div>`;
}

// The strip that makes the concierge the front door of the app.
function conciergeStrip() {
  const hour = new Date().getHours();
  const dow = new Date().getDay();
  const weekendish = dow === 5 || dow === 6 || dow === 4;
  const lead = weekendish
    ? { mode: 'weekend', label: 'Plan my weekend', sub: 'Friday to Sunday, pick from real options' }
    : { mode: 'tonight', label: hour >= 16 ? 'What should I do tonight?' : 'What should I do this evening?', sub: `Live in ${esc(S.settings.city || 'your city')}, matched to you` };
  const other = lead.mode === 'weekend'
    ? { mode: 'tonight', label: 'Just tonight', sub: 'one evening, several ways to spend it' }
    : { mode: 'weekend', label: 'The whole weekend', sub: 'Friday to Sunday' };

  return `<div class="cg-modes" style="margin-top:24px">
    <button class="cg-mode rise" style="--i:1" data-act="cgJump" data-id="${lead.mode}">
      <span class="cg-ico">${lead.mode === 'weekend' ? '✦' : '☾'}</span>
      <span><b>${lead.label}</b><span>${lead.sub}</span></span>
    </button>
    <button class="cg-mode rise" style="--i:2" data-act="cgJump" data-id="${other.mode}">
      <span class="cg-ico">${other.mode === 'weekend' ? '✦' : '☾'}</span>
      <span><b>${other.label}</b><span>${other.sub}</span></span>
    </button>
  </div>`;
}

VIEWS.today = function renderToday() {
  if (!S.settings.profile.completed) return renderLanding();

  const due = duePeople();
  const today = todayIso();
  const upcoming = (S.plans || [])
    .filter(pl => pl.status !== 'done' && pl.date >= today && pl.date <= addDays(today, 14))
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const events = (S.events || [])
    .filter(e => e.status !== 'dismissed' && (!e.date || e.date >= today))
    .sort((a, b) => scoreEventClient(b) - scoreEventClient(a))
    .slice(0, 12);
  const hotVenues = (S.venues || [])
    .filter(v => v.flag !== 'dismissed' && ['opening-soon', 'new', 'hot'].includes(v.status))
    .sort((a, b) => scoreVenueClient(b) - scoreVenueClient(a))
    .slice(0, 6);
  const act = activePeople();
  const prof = S.settings.profile || {};

  const onTrack = act.length
    ? Math.round(100 * act.filter(p => {
        const d = dueInfo(p);
        return !d || d.snoozed || d.overdue < 0;
      }).length / act.length)
    : 100;

  const weekStart = startOfWeek();
  const hangsThisWeek = (S.plans || []).filter(pl =>
    pl.date >= weekStart && pl.date <= addDays(weekStart, 6)).length;

  const goals = S.settings.goals || {};
  const innerCount = act.filter(p => p.tier === 'inner' && p.type !== 'dating').length;
  const datingCount = act.filter(p => p.type === 'dating').length;
  const trackDates = goals.datesPerMonth && prof.datingMode !== 'paused';
  const stats = [
    [goals.innerTarget ? `${innerCount}/${goals.innerTarget}` : innerCount, 'inner circle'],
    [act.filter(p => p.tier === 'close').length, 'close'],
    trackDates ? [`${datesThisMonth()}/${goals.datesPerMonth}`, 'dates this month'] : [datingCount, 'dating'],
    prof.socialBudget ? [`${hangsThisWeek}/${prof.socialBudget}`, 'hangs this week'] : [act.filter(p => p.tier === 'warm').length, 'keep warm'],
  ];

  const bdays = act
    .map(p => ({ p, b: nextBirthdayIso(p.birthday) }))
    .filter(x => x.b && daysBetween(today, x.b) <= 14)
    .sort((a, b) => a.b.localeCompare(b.b));

  const hello = prof.firstName ? `, ${esc(prof.firstName)}` : '';
  const hour = new Date().getHours();

  if (!act.length) {
    $('#view').innerHTML = `
      <div class="hero">
        <div>
          <div class="today-head rise">
            <h1>${hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening'}${hello}</h1>
            <div class="date">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          </div>
          <div class="card build-cta rise" style="--i:1">
            <div style="font-family:var(--display);font-size:21px;font-weight:600;letter-spacing:-0.6px">Your sky is empty — let's fix that.</div>
            <p class="muted" style="margin:8px 0 16px">Five minutes: your inner circle, close friends, anyone you're dating. Then the whole system — today's three, drafts, weekend plans — runs on your real life.</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn accent big" data-act="goBuild">Add my people →</button>
              ${LOCAL ? `<a class="btn" href="#connect">Import Apple Contacts</a>` : ''}
              <a class="btn ghost" href="#triage">Paste a list</a>
            </div>
          </div>
          ${conciergeStrip()}
        </div>
        <div class="rise" style="--i:2">${constellationSvg()}</div>
      </div>
    `;
    return;
  }

  const focus = generateFocus();
  const focusItems = focus.items.filter(i => !i.skipped);
  const focusDone = focusItems.filter(i => i.done).length;
  const score = orbitScore();
  const streak = S.streaks.focusDays || 0;

  const dow = new Date().getDay(); // 0 Sun, 1 Mon
  const reviewedThisWeek = S.streaks.lastReviewDate && S.streaks.lastReviewDate >= startOfWeek();
  const showReviewBanner = (dow === 0 || dow === 1) && !reviewedThisWeek && act.length > 0;

  const sugs = prof.socialBudget && hangsThisWeek < prof.socialBudget
    ? planSuggestions(Math.min(3, prof.socialBudget - hangsThisWeek))
    : [];

  const focusCard = (item, i) => {
    const p = person(item.personId);
    if (!p) return '';
    const th = openThread(p);
    const idea = item.ideaId ? S.ideas.find(x => x.id === item.ideaId) : suggestIdea(p);
    const heads = {
      reachout: `Reach out to <b>${esc(p.name)}</b>`,
      nextstep: `Next step with <b>${esc(p.name)}</b>`,
      plan: `Lock in ${fmtDay(item.date || todayIso())} night`,
    };
    const subs = {
      reachout: th ? `💭 ${esc(th.text)}` : `It's been a while — draft's ready, one tap.`,
      nextstep: `→ ${esc(p.nextStep || '')}`,
      plan: `<b>${esc(p.name)}</b>${idea ? ` · ${esc(idea.title)}` : ''} — your night's free.`,
    };
    const acts = item.kind === 'plan'
      ? `<button class="btn tiny accent" data-act="focusPlan" data-id="${item.id}">Plan it →</button>`
      : `<span class="ch-strip">${chStrip(p)}</span>
         <button class="btn tiny accent" data-act="focusLog" data-id="${item.id}">✓ Did it</button>`;
    return `<div class="focus-card spot rise ${item.done ? 'done' : ''}" style="--i:${i}">
      <div class="focus-num">${item.done ? '✓' : i + 1}</div>
      <div class="avatar" style="${avatarStyle(p)}" data-act="openPerson" data-id="${p.id}">${initials(p.name)}</div>
      <div class="who">
        <div class="name">${heads[item.kind]}</div>
        <div class="meta">${subs[item.kind]}</div>
      </div>
      <div class="actions">
        ${item.done ? '<span class="chip ok">done</span>' : acts + `<button class="btn tiny ghost" data-act="focusSkip" data-id="${item.id}">Skip</button>`}
      </div>
    </div>`;
  };

  $('#view').innerHTML = `
    <div class="hero">
      <div>
        <div class="today-head rise">
          <h1>${hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening'}${hello}</h1>
          <div class="date">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · ${act.length} people in your orbit</div>
          <div class="hero-chips rise" style="--i:1">
            <span class="hero-chip"><b>${score}</b> orbit score ${sparklineSvg()}</span>
            ${streak > 0 ? `<span class="hero-chip">✦ <b>${streak}</b>-day streak</span>` : ''}
            <button class="hero-chip as-btn" data-act="goReview">◈ weekly review</button>
          </div>
          ${conciergeStrip()}
        </div>
        <div class="stats">
          ${stats.map(([n, l], i) => `<div class="stat spot rise" style="--i:${i + 1}"><div class="n" data-count="${n}">${n}</div><div class="l">${l}</div></div>`).join('')}
          <div class="stat ring-stat spot rise" style="--i:${stats.length + 1}">
            <svg class="ring" width="46" height="46" viewBox="0 0 46 46">
              <circle class="track" cx="23" cy="23" r="18"/>
              <circle class="fg" id="onTrackRing" cx="23" cy="23" r="18"/>
            </svg>
            <div><div class="n" data-count="${onTrack}%">${onTrack}%</div><div class="l">on track</div></div>
          </div>
        </div>
      </div>
      <div class="rise" style="--i:2">${constellationSvg()}</div>
    </div>

    ${showReviewBanner ? `
    <div class="review-banner rise" data-act="goReview">
      <span>◈ <b>${dow === 0 ? "It's Sunday" : 'New week'}</b> — two minutes to review your week and line up the next one.</span>
      <span class="btn tiny primary">Start review →</span>
    </div>` : ''}

    ${focusItems.length ? `
    <h2>Today's three <span class="sub">${focusDone}/${focusItems.length} done — this is the whole job</span></h2>
    <div class="due-list">${focusItems.map(focusCard).join('')}</div>` : ''}

    ${sugs.length ? `
    <h2>Free nights this week <span class="sub">${hangsThisWeek}/${prof.socialBudget} hangs booked — one tap fills a night</span></h2>
    <div class="due-list">${sugs.map((s, i) => `
      <div class="due-row rise" style="--i:${i}">
        <div class="avatar" style="${avatarStyle(s.person)}">${initials(s.person.name)}</div>
        <div class="who">
          <div class="name">${esc(fmtDay(s.date))} — ${esc(s.person.name)}</div>
          <div class="meta">${s.idea ? `${esc(s.idea.title)} · ${esc(s.idea.hood || '')}` : 'Pick something together'}</div>
        </div>
        <div class="actions">
          <button class="btn tiny accent" data-act="suggestPlan" data-id="${s.person.id}" data-idea="${s.idea?.id || ''}" data-date="${s.date}">Plan it →</button>
        </div>
      </div>`).join('')}</div>` : ''}

    ${bdays.length ? `
    <h2>Birthdays <span class="sub">next 14 days</span></h2>
    <div class="due-list">${bdays.map(({ p, b }, i) => {
      const inDays = daysBetween(today, b);
      return `<div class="due-row rise" style="--i:${i}">
        <div class="avatar" style="${avatarStyle(p)}">🎂</div>
        <div class="who"><div class="name">${esc(p.name)} <span class="chip due-today">${inDays === 0 ? 'today!' : `${fmtDate(b)} · in ${inDays}d`}</span></div></div>
        <div class="actions"><span class="ch-strip">${chStrip(p)}</span><button class="btn tiny accent" data-act="plan" data-id="${p.id}">Plan something</button></div>
      </div>`;
    }).join('')}</div>` : ''}

    <h2>Reach out <span class="sub">${due.length ? `${due.length} due · tap a channel to open a draft` : ''}</span></h2>
    ${due.length
      ? `<div class="due-list">${due.map(dueRow).join('')}</div>`
      : `<div class="empty rise"><span class="big">◍</span>All caught up — nobody is overdue.</div>`}

    <h2>Coming up <span class="sub">next 14 days</span></h2>
    ${upcoming.length
      ? `<div class="plan-list">${upcoming.map((pl, i) => planRow(pl, i)).join('')}</div>`
      : `<div class="empty rise">Nothing planned. Pick someone above and hit <b>Plan</b>, or browse <a href="#ideas">Ideas</a>.</div>`}

    <h2>Happening in ${esc(S.settings.city || 'your city')} <span class="sub">ranked for your taste — ✦ trains it</span></h2>
    ${events.length
      ? `<div class="event-list">${events.map((e, i) => `
          <div class="event-row rise" style="--i:${i}">
            <span class="date">${e.date ? fmtDate(e.date) : ''}</span>
            <span>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}${e.venue ? ` <span class="faint">@ ${esc(e.venue)}</span>` : ''}</span>
            <span class="actions" style="margin-left:auto;display:inline-flex;gap:4px;flex-shrink:0">
              ${e.status === 'saved'
                ? '<span class="chip ok">saved</span>'
                : `<button class="btn tiny ghost" data-act="evSave" data-id="${e.id}" title="More like this">✦</button>`}
              <button class="btn tiny ghost" data-act="evDismiss" data-id="${e.id}" title="Not for me">✕</button>
            </span>
          </div>`).join('')}</div>`
      : `<div class="empty rise">Your daily agent fills this in each morning — events matched to your interests land here and in your inbox.</div>`}

    ${hotVenues.length ? `
    <h2>New & buzzing <span class="sub">openings and hot spots from your sources</span></h2>
    <div class="event-list">${hotVenues.map((v, i) => {
      const b = venueBuzz(v);
      return `
        <div class="event-row rise" style="--i:${i}">
          <span class="date">${v.status === 'opening-soon' ? 'soon' : esc(v.status)}</span>
          <span>${v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.name)}</a>` : esc(v.name)}${v.hood ? ` <span class="faint">· ${esc(v.hood)}</span>` : ''}${b > 1 ? ` <span class="chip">${b} sources</span>` : ''}${v.availability ? ` <span class="faint">· ${esc(v.availability)}</span>` : ''}</span>
          <span class="actions" style="margin-left:auto;display:inline-flex;gap:4px;flex-shrink:0">
            ${v.bookVia ? `<a class="btn tiny accent" href="${esc(v.bookVia)}" target="_blank" rel="noopener">Book</a>` : ''}
            ${v.flag === 'saved'
              ? '<span class="chip ok">saved</span>'
              : `<button class="btn tiny ghost" data-act="vnSave" data-id="${v.id}" title="More like this">✦</button>`}
            <button class="btn tiny ghost" data-act="vnDismiss" data-id="${v.id}" title="Not for me">✕</button>
          </span>
        </div>`;
    }).join('')}</div>` : ''}
  `;

  animateStats(onTrack);
};

function animateStats(onTrack) {
  if (reduceMotion) return;
  requestAnimationFrame(() => {
    const ring = $('#onTrackRing');
    if (ring) ring.style.setProperty('--p', onTrack);
  });
  $$('.stat .n[data-count]').forEach(el => {
    const raw = el.dataset.count;
    const m = String(raw).match(/^(\d+)([^\d].*)?$/);
    if (!m || m[2]?.includes('/')) return;
    const target = +m[1], suffix = m[2] || '';
    const t0 = performance.now(), dur = 750;
    const tick = now => {
      const k = Math.min(1, (now - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))) + suffix;
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ============================================================
//  SHARING — an itinerary packed into the URL, no server involved
// ============================================================

const b64urlEncode = bytes => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = s => Uint8Array.from(
  atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function encodeShare(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (typeof CompressionStream === 'function') {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const packed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    return 'z' + b64urlEncode(packed);
  }
  return 'r' + b64urlEncode(bytes);
}

async function decodeShare(token) {
  const flag = token[0];
  const bytes = b64urlDecode(token.slice(1));
  if (flag === 'z') {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const raw = await new Response(ds.readable).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(raw));
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Strip the fields a stranger has no business seeing — this is a plan, not a
// window into someone's address book.
function sharePick(pick) {
  return {
    slot: pick.slot, date: pick.date, title: pick.title, venue: pick.venue,
    neighborhood: pick.neighborhood, startTime: pick.startTime, price: pick.price,
    kind: pick.kind, why: pick.why, tip: pick.tip, url: pick.url, indoor: pick.indoor,
  };
}

async function shareItinerary(picks, label) {
  if (!picks.length) { toast('Nothing to share yet'); return; }
  const payload = {
    v: 1,
    from: S.settings.profile.firstName || '',
    city: S.settings.city || '',
    label: label || (picks.length > 1 ? 'A weekend in the making' : picks[0].title),
    picks: picks.map(sharePick),
  };
  const token = await encodeShare(payload);
  const url = `${WEB_URL}#s=${token}`;

  if (url.length > 7500) { toast('That itinerary is too big to share as a link'); return; }

  if (navigator.share) {
    try {
      await navigator.share({ title: 'Orbit', text: payload.label, url });
      return;
    } catch { /* user dismissed the sheet — fall back to the clipboard */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied — anyone can open it ✦');
  } catch {
    prompt('Copy this link:', url);
  }
}

VIEWS.shared = function renderShared() {
  const p = sharedPayload;
  if (!p) { location.hash = '#today'; return; }
  const who = p.from ? `${esc(p.from)} sent you this` : 'Someone sent you this';

  $('#view').innerHTML = `
    <div class="share-view">
      <div class="share-brand rise">
        <svg width="18" height="18" viewBox="0 0 100 100"><circle cx="50" cy="50" r="36" fill="none" stroke="var(--accent)" stroke-width="10"/><circle cx="50" cy="11" r="11" fill="var(--aurora-3)"/></svg>
        Orbit
      </div>
      <div class="share-head rise" style="--i:1">
        <h1>${esc(p.label || 'A plan')}</h1>
        <div class="share-from">${who}${p.city ? ` · ${esc(p.city)}` : ''}</div>
      </div>
      <div class="cg-stream">
        ${p.picks.map((pick, i) => pickCard(normalizePick(pick, { dates: [pick.date || todayIso()] }), i, { readOnly: true })).join('')}
      </div>
      <div class="share-cta rise" style="--i:2">
        <h2>Want your own?</h2>
        <p>Orbit keeps your closest people close, then tells you exactly what to do with them — tonight, or this weekend.</p>
        <button class="btn accent big" data-act="sharedStart">Start my orbit ✦</button>
      </div>
    </div>
  `;
};

// ---------- PEOPLE ----------
function dueBadge(p) {
  const d = dueInfo(p);
  if (!d) return '';
  if (d.snoozed) return `<span class="chip tier-unsorted">snoozed</span>`;
  if (d.overdue > 0) return `<span class="chip overdue">${d.overdue}d overdue</span>`;
  if (d.overdue === 0) return `<span class="chip due-today">due today</span>`;
  return `<span class="chip ok">due ${fmtDate(d.nextDue)}</span>`;
}

VIEWS.people = function renderPeople() {
  const filters = [
    ['active', 'All active'], ['inner', 'Inner'], ['close', 'Close'], ['warm', 'Keep warm'],
    ['dating', 'Dating'], ['unsorted', 'Unsorted'], ['archived', 'Archived'],
  ];
  let list = S.people.filter(p => {
    if (peopleFilter === 'active') return p.tier !== 'archived' && p.tier !== 'unsorted';
    if (peopleFilter === 'dating') return p.type === 'dating' && p.tier !== 'archived';
    return p.tier === peopleFilter;
  });
  if (peopleSearch) {
    const q = peopleSearch.toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(q) ||
      (p.notes || '').toLowerCase().includes(q) ||
      (p.interests || []).some(t => t.includes(q)));
  }
  const tierRank = { inner: 0, close: 1, warm: 2, unsorted: 3, archived: 4 };
  list.sort((a, b) => (tierRank[a.tier] - tierRank[b.tier]) || a.name.localeCompare(b.name));

  const unsortedCount = S.people.filter(p => p.tier === 'unsorted').length;
  const hasSamples = S.people.some(p => p.sample);

  $('#view').innerHTML = `
    <h1 style="margin-top:16px" class="rise">People</h1>
    <div class="toolbar rise" style="--i:1">
      ${filters.map(([k, lbl]) => `<button class="filter-chip ${peopleFilter === k ? 'active' : ''}" data-act="pfilter" data-id="${k}">${lbl}${k === 'unsorted' && unsortedCount ? ` (${unsortedCount})` : ''}</button>`).join('')}
      <span class="spacer"></span>
      <input type="search" id="peopleSearch" placeholder="Search…" value="${esc(peopleSearch)}">
      <button class="btn" data-act="triageStart">⚡ Triage</button>
      <button class="btn primary" data-act="addPerson">+ Add person</button>
    </div>
    ${hasSamples ? `<p class="small muted rise" style="--i:2;margin-bottom:12px">Showing sample people so you can see how it works — <a href="#" data-act="removeSamples">remove them</a> when you're ready.</p>` : ''}
    ${list.length ? `<div class="people-list">${list.map((p, i) => `
      <div class="person-row rise" style="--i:${Math.min(i, 14)}" data-act="openPerson" data-id="${p.id}">
        <div class="avatar" style="${avatarStyle(p)}">${initials(p.name)}</div>
        <div class="name">${esc(p.name)}</div>
        <div class="chips">
          <span class="chip tier-${p.tier}">${TIER_LABEL[p.tier]}</span>
          ${p.type === 'dating' ? `<span class="chip type-dating">${esc(STAGE_LABEL[p.stage] || 'dating')}</span>` : ''}
          ${(p.interests || []).slice(0, 3).map(t => `<span class="chip tag">${esc(t)}</span>`).join('')}
        </div>
        <div class="small faint" style="width:110px;flex-shrink:0">last: ${fmtDate(p.lastContact)}</div>
        <div class="due">${dueBadge(p)}</div>
      </div>`).join('')}</div>`
      : `<div class="empty rise"><span class="big">🌱</span>No one here yet. <a href="#" data-act="goBuild"><b>Build your orbit</b></a> in five minutes, hit <b>⚡ Triage</b> to paste a list${LOCAL ? ', or <a href="#connect">import your contacts</a>' : ''}.</div>`}
  `;
  $('#peopleSearch').addEventListener('input', e => {
    peopleSearch = e.target.value;
    VIEWS.people();
    const inp = $('#peopleSearch');
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  });
};

// ---------- TRIAGE ----------
let triageTotal = 0;
VIEWS.triage = function renderTriage() {
  const queue = S.people.filter(p => p.tier === 'unsorted');
  const cur = queue[0];
  if (queue.length > triageTotal) triageTotal = queue.length;
  const done = triageTotal - queue.length;

  $('#view').innerHTML = `
    <div class="triage-wrap">
      <h1 class="rise">Triage</h1>
      <p class="muted rise" style="--i:1;margin:8px 0 24px">Be ruthless. Your time goes to the people you keep.<br>
      <kbd>1</kbd> inner &nbsp; <kbd>2</kbd> close &nbsp; <kbd>3</kbd> keep warm &nbsp; <kbd>X</kbd> cut</p>
      ${cur ? `
        <div class="triage-card">
          <div class="tname">${esc(cur.name)}</div>
          <div class="tnotes">${esc(cur.notes || '')}</div>
          <div class="triage-btns">
            <button class="btn tb-inner" data-act="triageAssign" data-id="inner">1 · Inner circle</button>
            <button class="btn tb-close" data-act="triageAssign" data-id="close">2 · Close</button>
            <button class="btn tb-warm" data-act="triageAssign" data-id="warm">3 · Keep warm</button>
            <button class="btn tb-cut" data-act="triageAssign" data-id="archived">X · Cut</button>
          </div>
          <div class="triage-progress">${queue.length} left${triageTotal > 1 ? ` · ${done} sorted` : ''}</div>
          ${triageTotal > 1 ? `<div class="triage-bar"><div class="fill" style="width:${Math.round(100 * done / triageTotal)}%"></div></div>` : ''}
        </div>
      ` : `
        <div class="triage-paste card rise" style="text-align:left">
          <h2 style="margin-top:0">Paste your contacts</h2>
          <p class="muted small" style="margin-bottom:10px">One name per line — from your phone, Instagram follows, wherever.${LOCAL ? ' Or <a href="#connect">import your Apple Contacts</a> in one click.' : ''} You'll sort everyone into tiers (or cut them).</p>
          <textarea id="triageNames" placeholder="Maya Chen&#10;Dev Patel&#10;…"></textarea>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="btn primary" data-act="triageAdd">Add to triage</button>
            <button class="btn ghost" data-act="backToPeople">Back to people</button>
          </div>
        </div>
      `}
    </div>
  `;
};

document.addEventListener('keydown', e => {
  if (route !== 'triage') return;
  if (e.target.matches('input, textarea, select')) return;
  const map = { 1: 'inner', 2: 'close', 3: 'warm', x: 'archived', X: 'archived' };
  const tier = map[e.key];
  if (tier) { e.preventDefault(); triageAssign(tier); }
});

function triageAssign(tier) {
  const cur = S.people.find(p => p.tier === 'unsorted');
  if (!cur) return;
  cur.tier = tier;
  if (tier !== 'archived' && !cur.lastContact) cur.lastContact = todayIso();
  toast(tier === 'archived' ? `Cut ${cur.name}` : `${cur.name} → ${TIER_LABEL[tier]}`);
  const remaining = S.people.filter(p => p.tier === 'unsorted').length;
  persist();
  if (remaining === 0) {
    triageTotal = 0;
    location.hash = '#people';
    confetti();
    toast('Triage complete 🎉');
  } else render();
}

// ---------- DATING ----------
VIEWS.dating = function renderDating() {
  const prospects = S.people.filter(p => p.type === 'dating' && p.tier !== 'archived');
  $('#view').innerHTML = `
    <div class="toolbar" style="margin-top:16px">
      <h1 style="flex:1" class="rise">Dating</h1>
      <button class="btn primary rise" data-act="addProspect">+ Add prospect</button>
    </div>
    <div class="board">
      ${STAGES.map((st, ci) => `
        <div class="board-col rise" style="--i:${ci}" data-stage="${st}">
          <h3>${STAGE_LABEL[st]}</h3>
          ${prospects.filter(p => (p.stage || 'new') === st).map(p => {
            const d = dueInfo(p);
            const idx = STAGES.indexOf(st);
            return `<div class="board-card" draggable="true" data-act="openPerson" data-id="${p.id}">
              <div class="name">${esc(p.name)}</div>
              <div class="meta">last contact ${fmtDate(p.lastContact)}${d && d.overdue > 0 ? ` · <b style="color:var(--danger)">${d.overdue}d quiet</b>` : ''}</div>
              ${p.nextStep ? `<div class="next">→ ${esc(p.nextStep)}</div>` : ''}
              <div class="movers">
                ${idx > 0 ? `<button class="btn tiny ghost" data-act="stageMove" data-id="${p.id}" data-dir="-1">◀</button>` : ''}
                ${idx < STAGES.length - 1 ? `<button class="btn tiny ghost" data-act="stageMove" data-id="${p.id}" data-dir="1">▶</button>` : ''}
                <span style="flex:1"></span>
                <span class="ch-strip">${chStrip(p)}</span>
                <button class="btn tiny accent" data-act="plan" data-id="${p.id}">Plan</button>
              </div>
            </div>`;
          }).join('') || `<div class="small faint" style="padding:6px">—</div>`}
        </div>`).join('')}
    </div>
    <p class="drag-hint">Drag cards between columns as things progress · dating cadence is ${S.settings.datingCadence || 5} days · when something ends, open the card and archive it.</p>
  `;
  bindBoardDnD();
};

function bindBoardDnD() {
  $$('.board-card').forEach(c => {
    c.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', c.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => c.classList.add('dragging'));
    });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
  });
  $$('.board-col').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drop-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop-over'));
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drop-over');
      const p = person(e.dataTransfer.getData('text/plain'));
      if (p && p.stage !== col.dataset.stage) {
        p.stage = col.dataset.stage;
        save();
        toast(`${p.name} → ${STAGE_LABEL[p.stage]}`);
      }
    });
  });
}

// ---------- IDEAS ----------
VIEWS.ideas = function renderIdeas() {
  const allTags = [...new Set(S.ideas.flatMap(i => i.tags))].sort();
  let list = S.ideas;
  if (ideaFilter === '_fav') list = list.filter(i => i.favorite);
  else if (ideaFilter) list = list.filter(i => i.tags.includes(ideaFilter));

  $('#view').innerHTML = `
    <div class="toolbar" style="margin-top:16px">
      <h1 style="flex:1" class="rise">Ideas</h1>
      <button class="btn primary rise" data-act="addIdea">+ Add idea</button>
    </div>
    <div class="toolbar rise" style="--i:1;margin-top:4px">
      <button class="filter-chip ${!ideaFilter ? 'active' : ''}" data-act="ifilter" data-id="">All</button>
      <button class="filter-chip ${ideaFilter === '_fav' ? 'active' : ''}" data-act="ifilter" data-id="_fav">★ Favorites</button>
      ${allTags.map(t => `<button class="filter-chip ${ideaFilter === t ? 'active' : ''}" data-act="ifilter" data-id="${esc(t)}">${esc(t)}</button>`).join('')}
    </div>
    <div class="idea-grid">
      ${list.map((i, idx) => `
        <div class="idea-card spot rise" style="--i:${Math.min(idx, 14)}">
          <div class="top">
            <div class="title">${esc(i.title)}</div>
            <button class="fav" data-act="fav" data-id="${i.id}" title="Favorite">${i.favorite ? '★' : '☆'}</button>
          </div>
          <div class="meta">${esc(i.hood || '')}${i.cost ? ` · ${esc(i.cost)}` : ''} · ${i.best === 'date' ? 'date' : i.best === 'friends' ? 'friends' : 'date or friends'}</div>
          <div class="tags">${i.tags.map(t => `<span class="chip tag">${esc(t)}</span>`).join('')}</div>
          ${i.notes ? `<div class="notes">${esc(i.notes)}</div>` : ''}
          <div class="foot">
            <button class="btn tiny ghost" data-act="editIdea" data-id="${i.id}">Edit</button>
            <button class="btn tiny accent" data-act="planIdea" data-id="${i.id}">Plan it →</button>
          </div>
        </div>`).join('')}
    </div>
  `;
};

// ---------- PLANS ----------
VIEWS.plans = function renderPlans() {
  const upcoming = (S.plans || []).filter(pl => pl.status !== 'done')
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const past = (S.plans || []).filter(pl => pl.status === 'done')
    .sort((a, b) => b.date.localeCompare(a.date));

  $('#view').innerHTML = `
    <div class="toolbar" style="margin-top:16px">
      <h1 style="flex:1" class="rise">Plans</h1>
      <button class="btn primary rise" data-act="newPlan">+ New plan</button>
    </div>
    ${upcoming.length
      ? `<div class="plan-list">${upcoming.map((pl, i) => `
          <div class="plan-row rise" style="--i:${i}">
            <div class="when">${fmtDay(pl.date)}<span class="t">${esc(pl.time || '')}</span></div>
            <div class="what">
              <div class="title">${esc(pl.title)}</div>
              <div class="meta">${esc([pl.personIds.map(id => person(id)?.name).filter(Boolean).join(', '), pl.place].filter(Boolean).join(' · '))}</div>
            </div>
            <div class="actions">
              <a class="btn tiny ghost" href="${gcalUrl(pl)}" target="_blank" rel="noopener" title="Add to Google Calendar">GCal ↗</a>
              <button class="btn tiny" data-act="planDone" data-id="${pl.id}">✓ Done</button>
              <button class="btn tiny ghost" data-act="planEdit" data-id="${pl.id}">Edit</button>
              <button class="btn tiny ghost danger" data-act="planDelete" data-id="${pl.id}">✕</button>
            </div>
          </div>`).join('')}</div>`
      : `<div class="empty rise"><span class="big">🗓️</span>No upcoming plans. Grab an <a href="#ideas">idea</a> and put someone on the calendar.</div>`}
    ${past.length ? `
      <details style="margin-top:24px" class="rise">
        <summary class="muted" style="cursor:pointer">Past plans (${past.length})</summary>
        <div class="plan-list" style="margin-top:10px">${past.map((pl, i) => planRow(pl, i, false)).join('')}</div>
      </details>` : ''}
    <p class="small faint rise" style="margin-top:20px">Each plan has a <b>GCal ↗</b> button — one click adds it to Google Calendar.${LOCAL ? ' You can also subscribe to the whole feed in <a href="#connect">Connect</a>.' : ''}</p>
  `;
};

function markPlanDone(id) {
  const pl = S.plans.find(x => x.id === id);
  if (!pl) return;
  pl.status = 'done';
  const d = pl.date > todayIso() ? todayIso() : pl.date;
  for (const pid of pl.personIds) {
    const p = person(pid);
    if (p) logContact(p, p.type === 'dating' ? 'date' : 'hangout', pl.title, d);
  }
  toast(`Done — logged for ${pl.personIds.length} ${pl.personIds.length === 1 ? 'person' : 'people'}`);
  save();
}

// ---------- DIGEST ----------
function buildDigestMarkdown() {
  const today = todayIso();
  const lines = [`# Orbit digest — ${today}`, '', '## Reach out today'];
  const due = duePeople();
  if (!due.length) lines.push('All caught up — nobody is overdue.');
  for (const { p, d } of due) {
    const label = p.type === 'dating' ? `dating · ${p.stage}` : p.tier;
    const idea = suggestIdea(p);
    const th = openThread(p);
    lines.push(`- **${p.name}** (${label}) — ${d.overdue === 0 ? 'due today' : `${d.overdue}d overdue`}${p.lastContact ? `, last contact ${p.lastContact}` : ''}${th ? `. 💭 ${th.text}` : p.nextStep ? `. Next step: ${p.nextStep}` : idea ? `. Idea: ${idea.title}` : ''}`);
  }
  const sugs = planSuggestions(3);
  if (sugs.length) {
    lines.push('', '## Line up your week');
    for (const s of sugs) lines.push(`- ${fmtDay(s.date)} — **${s.person.name}**${s.idea ? ` · ${s.idea.title} (${s.idea.hood || 'NYC'})` : ''}`);
  }
  const bdays = activePeople()
    .map(p => ({ name: p.name, date: nextBirthdayIso(p.birthday) }))
    .filter(b => b.date && daysBetween(today, b.date) <= 7)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (bdays.length) {
    lines.push('', '## Birthdays this week');
    for (const b of bdays) lines.push(`- 🎂 **${b.name}** — ${daysBetween(today, b.date) === 0 ? 'TODAY' : `${b.date} (in ${daysBetween(today, b.date)}d)`}`);
  }
  lines.push('', '## Plans this week');
  const plans = (S.plans || []).filter(pl => pl.status !== 'done' && pl.date >= today && pl.date <= addDays(today, 7))
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  if (!plans.length) lines.push('Nothing on the calendar — pick someone above and plan something.');
  for (const pl of plans) lines.push(`- ${pl.date}${pl.time ? ' ' + pl.time : ''} — **${pl.title}** with ${pl.personIds.map(id => person(id)?.name).filter(Boolean).join(', ') || '?'}${pl.place ? ` @ ${pl.place}` : ''}`);
  const nudges = S.people.filter(p => p.type === 'dating' && p.stage && p.tier !== 'archived' && p.nextStep);
  if (nudges.length) {
    lines.push('', '## Dating next steps');
    for (const n of nudges) lines.push(`- **${n.name}** (${n.stage}): ${n.nextStep}`);
  }
  lines.push('', `## Happening in ${S.settings.city || 'your city'}`);
  const events = (S.events || [])
    .filter(e => e.status !== 'dismissed' && (!e.date || e.date >= today))
    .sort((a, b) => scoreEventClient(b) - scoreEventClient(a))
    .slice(0, 12);
  if (!events.length) lines.push('No events loaded yet — the daily agent fills these in.');
  for (const e of events) lines.push(`- ${e.date ? e.date + ' — ' : ''}**${e.title}**${e.venue ? ` @ ${e.venue}` : ''}${e.url ? ` (${e.url})` : ''}`);
  const buzzing = (S.venues || [])
    .filter(v => v.flag !== 'dismissed' && ['opening-soon', 'new', 'hot'].includes(v.status))
    .sort((a, b) => scoreVenueClient(b) - scoreVenueClient(a))
    .slice(0, 6);
  if (buzzing.length) {
    lines.push('', '## New & buzzing');
    for (const v of buzzing) {
      const b = venueBuzz(v);
      lines.push(`- **${v.name}**${v.hood ? ` (${v.hood})` : ''} — ${v.status === 'opening-soon' ? 'opening soon' : v.status}${b > 1 ? ` · ${b} sources this month` : ''}${v.bookVia ? ` — book: ${v.bookVia}` : ''}`);
    }
  }
  return lines.join('\n');
}

VIEWS.digest = async function renderDigest() {
  let md, email = S.settings.email, interests = S.settings.interests || [];
  if (LOCAL) {
    try {
      const dg = await (await fetch('api/digest')).json();
      md = dg.markdown; email = dg.email; interests = dg.interests;
    } catch { md = buildDigestMarkdown(); }
  } else {
    md = buildDigestMarkdown();
  }
  const html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/^# (.*)$/gm, '<strong style="font-size:19px;font-family:var(--serif)">$1</strong>')
    .replace(/^## (.*)$/gm, '<strong style="font-size:15.5px">$1</strong>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^- /gm, '&nbsp;&nbsp;•&nbsp; ');
  $('#view').innerHTML = `
    <div class="toolbar" style="margin-top:16px">
      <h1 style="flex:1" class="rise">Daily digest</h1>
      <button class="btn rise" data-act="copyDigest">Copy as text</button>
    </div>
    <p class="muted small rise" style="--i:1;margin-bottom:14px">This is what lands in your inbox each morning (${esc(email || 'no email set')}). Generated live from your people, plans, and the NYC events your agent pulls in.</p>
    <div class="digest-pre rise" style="--i:2">${html}</div>
    <div class="card digest-note small muted rise" style="--i:3">
      <b style="color:var(--ink)">How it works:</b> a scheduled agent on your Mac runs every morning at 8 — it searches NYC events matching your profile (${interests.map(esc).join(', ')}), loads them into Orbit, then delivers this digest by email or Slack. Manage delivery in <a href="#connect">Connect</a>.
    </div>
  `;
  $('#view').dataset.digestMd = md;
};

// ---------- CONNECT ----------
function connectCard(icon, title, sub, status, body, foot, i) {
  return `
    <div class="connect-card spot rise" style="--i:${i}">
      <div class="head">
        <div class="icon">${icon}</div>
        <div style="flex:1;min-width:0"><div class="t">${title}</div><div class="s">${sub}</div></div>
        ${status !== null ? `<span class="status-pill ${status ? 'on' : 'off'}">${status ? 'Connected' : 'Not set up'}</span>` : ''}
      </div>
      <div class="body">${body}</div>
      <div class="foot">${foot}</div>
    </div>`;
}

VIEWS.connect = async function renderConnect() {
  $('#view').innerHTML = `<h1 style="margin-top:16px">Connect</h1><p class="muted">Checking status…</p>`;
  let c = { launchAgent: false, digestTask: false, contactsImport: false, port: 4747 };
  if (LOCAL) { try { c = await (await fetch('api/connections')).json(); } catch {} }
  const gmail = !!S.settings.connections.gmail;
  const slackHook = S.settings.integrations.slackWebhook || '';
  const synced = !!syncCfg?.gistId;

  const syncCard = connectCard('⟳', 'Sync across devices', 'Mac ⇄ phone ⇄ web, end-to-end encrypted', synced,
    synced
      ? `Your data syncs through a private GitHub gist, encrypted on-device with your passphrase — GitHub only ever sees ciphertext.${lastSyncAt ? ` Last synced ${new Date(lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}`
      : `Use Orbit on your phone and Mac with the same data. Encrypted with a passphrase <b>before</b> it leaves the device — GitHub only stores ciphertext.
        <input id="sync-pass" type="password" placeholder="Choose a sync passphrase" autocomplete="new-password">
        <input id="sync-token" type="password" placeholder="GitHub token with gist scope" autocomplete="off">
        <div style="margin-top:6px"><a href="https://github.com/settings/tokens/new?scopes=gist&description=Orbit%20sync" target="_blank" rel="noopener">Create a token ↗</a> <span class="faint">(classic, “gist” scope only — stays on this device)</span></div>`,
    synced
      ? `<button class="btn" data-act="syncNow">Sync now</button><button class="btn ghost danger" data-act="syncOff">Disconnect</button>`
      : `<button class="btn primary" data-act="syncCreate">Create sync</button><button class="btn ghost" data-act="syncConnect">I already have one</button>`, 2);

  const slackCard = connectCard('◗', 'Slack', 'Digest in your DMs', !!slackHook,
    `Paste an <a href="https://api.slack.com/messaging/webhooks" target="_blank" rel="noopener">incoming webhook URL ↗</a> and the 8am agent posts your digest to Slack too.
     <input id="slack-hook" type="password" placeholder="https://hooks.slack.com/services/…" value="${esc(slackHook)}">`,
    `<button class="btn ${slackHook ? 'ghost' : 'primary'}" data-act="saveSlack">${slackHook ? 'Update' : 'Save'}</button>
     ${slackHook ? '<button class="btn ghost danger" data-act="clearSlack">Remove</button>' : ''}`, 3);

  const gcalCard = connectCard('◫', 'Google Calendar', 'Plans → your calendar', null,
    `Every plan has a <b>GCal ↗</b> button — one click adds it with people, time, and place prefilled. No account linking needed.${LOCAL ? `<br><span class="faint">On this Mac you can also subscribe to the live feed:</span>` : ''}`,
    LOCAL
      ? `<a class="btn" href="webcal://localhost:${c.port}/api/calendar.ics">Subscribe in Apple Calendar</a><a class="btn ghost" href="#plans">See plans</a>`
      : `<a class="btn" href="#plans">See plans</a>`, 4);

  const channelsCard = connectCard('✉', 'Messages · WhatsApp · IG · X', 'One-tap outreach', null,
    `Add a phone number or handle to anyone and channel buttons appear on their cards. Tap one → a ready-to-send draft is copied and the right app opens: <b>iM</b> Messages, <b>WA</b> WhatsApp, <b>IG</b> Instagram DM, <b>𝕏</b> X.`,
    `<a class="btn" href="#people">Add handles to people</a>`, 5);

  const customProxy = S.settings.integrations.proxyUrl || '';
  const conciergeCard = connectCard('✦', 'The planner', 'A calendar of real things to do', null,
    `<b>Plan</b> lays out tonight, the weekend, or the next seven days — dinner, happy hour, shows,
     a workout — then lets you type what you feel and reshape the board. Requests go through a
     small proxy that holds the model key, so nothing sensitive touches this device.
     <div style="margin-top:10px" class="faint small">Proxy: <code>${esc(customProxy || DEFAULT_PROXY_URL)}</code></div>
     <input id="cg-proxy" placeholder="Your own worker URL (optional)" value="${esc(customProxy)}">`,
    `<a class="btn accent" href="#plan">Open the planner →</a>
     <button class="btn" data-act="cgTestProxy">Test connection</button>
     <button class="btn ghost" data-act="cgSaveProxy">${customProxy ? 'Update' : 'Use my own'}</button>
     ${customProxy ? '<button class="btn ghost danger" data-act="cgClearProxy">Reset</button>' : ''}`, 1);

  let cards;
  if (LOCAL) {
    cards = [
      conciergeCard,
      syncCard,
      connectCard('◉', 'Apple Contacts', 'Import your people in one click', null,
        `Pulls every name from your macOS Contacts straight into Triage so you can sort your real circle. macOS will ask for permission once.`,
        `<button class="btn primary" data-act="importContacts">Import contacts</button>
         <a class="btn ghost" href="#triage">Or paste a list</a>`, 3),
      connectCard('◈', 'Daily digest agent', 'Runs every morning at 8:00', c.digestTask,
        `Searches ${esc(S.settings.city || 'your city')} events matching your profile, loads them into Orbit, and delivers your digest. <span class="faint">To change the time, just ask Claude.</span>`,
        `<a class="btn ghost" href="#digest">Preview today's digest</a>`, 4),
      connectCard('▤', 'Email delivery', 'Digest → your inbox', gmail,
        `The agent delivers as a notification until Gmail is connected in Claude:
         <ol><li>Claude desktop → <b>Settings → Connectors</b></li><li>Add <b>Gmail</b> and sign in</li><li>Done — the 8am agent finds it automatically</li></ol>`,
        `<button class="btn ${gmail ? 'ghost' : 'primary'}" data-act="toggleGmail">${gmail ? 'Mark as not connected' : "I've connected Gmail ✓"}</button>`, 5),
      slackCard.replace('--i:3', '--i:6'),
      gcalCard.replace('--i:4', '--i:7'),
      channelsCard.replace('--i:5', '--i:8'),
      connectCard('◍', 'Orbit on the web', 'Use it anywhere', null,
        `Your app is live at <code>${WEB_URL}</code> — open it on your phone, add it to your home screen, and turn on Sync (above) to share data with this Mac.`,
        `<a class="btn primary" href="${WEB_URL}" target="_blank" rel="noopener">Open web app ↗</a>`, 9),
      connectCard('⚡', 'Always-on', 'Orbit runs itself', c.launchAgent,
        `Starts Orbit at login and keeps it running in the background, so the morning agent and calendar feed always work — no terminal needed.`,
        `<button class="btn ${c.launchAgent ? 'ghost' : 'primary'}" data-act="alwaysOn" data-id="${c.launchAgent ? 'off' : 'on'}">${c.launchAgent ? 'Disable' : 'Enable'}</button>`, 10),
      connectCard('⌂', 'Your data', 'One JSON file, yours', null,
        `Everything lives in <code>~/orbit/data.json</code> with automatic daily backups. Export any time.`,
        `<button class="btn ghost" data-act="exportJson">Export JSON</button>
         ${S.people.some(p => p.sample) ? `<button class="btn ghost danger" data-act="removeSamples">Remove samples</button>` : ''}`, 11),
    ];
  } else {
    cards = [
      conciergeCard,
      syncCard,
      connectCard('▢', 'Install as an app', 'Home-screen Orbit', null,
        `On iPhone: open this page in Safari → <b>Share</b> → <b>Add to Home Screen</b>. Full-screen, offline-capable, feels native.`,
        `<span class="faint small">Already installed? You're looking at it.</span>`, 3),
      slackCard.replace('--i:3', '--i:4'),
      gcalCard.replace('--i:4', '--i:5'),
      channelsCard.replace('--i:5', '--i:6'),
      connectCard('◈', 'Daily digest agent', 'Runs on your Mac at 8:00', null,
        `The agent lives on your Mac: it finds events in ${esc(S.settings.city || 'your city')} for your profile and delivers your digest by email/Slack. With Sync on, events and updates flow here automatically.`,
        `<a class="btn ghost" href="#digest">Preview the digest</a>`, 7),
      connectCard('⌂', 'Your data', 'Stored on this device', null,
        `Data lives in this browser (and in your encrypted sync, if enabled). Export a backup any time.`,
        `<button class="btn ghost" data-act="exportJson">Export JSON</button>
         ${S.people.some(p => p.sample) ? `<button class="btn ghost danger" data-act="removeSamples">Remove samples</button>` : ''}`, 8),
    ];
  }

  $('#view').innerHTML = `
    <h1 style="margin-top:16px" class="rise">Connect</h1>
    <p class="muted rise" style="--i:1;margin-top:6px;max-width:640px">Everything Orbit plugs into. A few minutes here and the whole system runs itself — contacts in, digest out, plans on your calendar, drafts into your chats.</p>
    <div class="connect-grid">${cards.join('')}</div>
  `;
};

// ---------- WEEKLY REVIEW ----------
VIEWS.review = function renderReview() {
  const ws = startOfWeek();
  const we = addDays(ws, 6);
  const prof = S.settings.profile || {};
  const inWeek = d => d >= ws && d <= we;

  const touched = activePeople().filter(p => (p.log || []).some(l => inWeek(l.date)));
  const hangs = activePeople().flatMap(p => (p.log || []).filter(l => inWeek(l.date) && (l.kind === 'hangout' || l.kind === 'date')));
  const plansUpcoming = plansThisWeek().filter(pl => pl.status !== 'done');
  const budget = prof.socialBudget || null;
  const budgetTotal = hangs.length + plansUpcoming.length;
  const budgetMet = budget ? budgetTotal >= budget : budgetTotal > 0;

  const slipping = activePeople()
    .map(p => ({ p, d: dueInfo(p) }))
    .filter(x => x.d && !x.d.snoozed && x.d.overdue >= x.d.cadence)
    .sort((a, b) => (b.d.overdue * tierWeight(b.p)) - (a.d.overdue * tierWeight(a.p)))
    .slice(0, 5);

  const sugs = planSuggestions(3);
  const score = orbitScore();

  const statCard = (n, l, i) => `<div class="stat spot rise" style="--i:${i}"><div class="n">${n}</div><div class="l">${l}</div></div>`;

  $('#view').innerHTML = `
    <h1 style="margin-top:16px" class="rise">Weekly review</h1>
    <p class="muted rise" style="--i:1">Week of ${fmtDate(ws)}–${fmtDate(we)} · the two-minute ritual that keeps the whole system honest.</p>
    <div class="stats" style="margin-top:16px">
      ${statCard(touched.length, 'people touched', 1)}
      ${statCard(hangs.length, 'hangs & dates', 2)}
      ${statCard(budget ? `${budgetTotal}/${budget}` : budgetTotal, budget ? 'weekly budget' : 'planned + done', 3)}
      ${statCard(score, 'orbit score', 4)}
      ${S.streaks.focusDays ? statCard(`🔥 ${S.streaks.focusDays}`, 'day streak', 5) : ''}
    </div>
    ${budgetMet ? `<div class="card rise" style="--i:2;border-color:color-mix(in srgb, var(--ok) 40%, transparent)">✨ <b>Budget met.</b> ${hangs.length ? `You showed up for ${touched.slice(0, 3).map(p => esc(p.name.split(' ')[0])).join(', ')}${touched.length > 3 ? ` and ${touched.length - 3} more` : ''} this week.` : 'Plans are locked in.'} That's the whole point of this app.</div>` : ''}

    ${(() => {
      const goals = S.settings.goals || {};
      const bars = [];
      const bar = (label, n, target) => bars.push(`
        <div class="goal-row">
          <span class="goal-label">${label}</span>
          <div class="triage-bar" style="flex:1;margin:0"><div class="fill" style="width:${Math.min(100, Math.round(100 * n / target))}%"></div></div>
          <span class="goal-val ${n >= target ? 'met' : ''}">${n}/${target}</span>
        </div>`);
      const inner = activePeople().filter(p => p.tier === 'inner' && p.type !== 'dating').length;
      if (goals.innerTarget) bar('Inner circle', inner, goals.innerTarget);
      if (prof.socialBudget) bar('Hangs this week', budgetTotal, prof.socialBudget);
      if (goals.datesPerMonth && prof.datingMode !== 'paused') bar('Dates this month', datesThisMonth(), goals.datesPerMonth);
      const custom = (goals.custom || []).map(g => `<div class="thread-item">🎯 <span style="flex:1">${esc(g.text)}</span></div>`).join('');
      if (!bars.length && !custom) return '';
      return `<h2>Goals <span class="sub">set them in ✦ profile</span></h2>
        <div class="card rise" style="display:flex;flex-direction:column;gap:12px">${bars.join('')}${custom ? `<div class="thread-list">${custom}</div>` : ''}</div>`;
    })()}

    <h2>Slipping away <span class="sub">a full cadence overdue — worth a real reach-out</span></h2>
    ${slipping.length
      ? `<div class="due-list">${slipping.map((x, i) => dueRow(x, i)).join('')}</div>`
      : `<div class="empty rise">Nobody's slipping. Genuinely impressive.</div>`}

    <h2>Line up next week <span class="sub">your free nights, matched to your people</span></h2>
    ${sugs.length
      ? `<div class="due-list">${sugs.map((s, i) => `
        <div class="due-row rise" style="--i:${i}">
          <div class="avatar" style="${avatarStyle(s.person)}">${initials(s.person.name)}</div>
          <div class="who">
            <div class="name">${esc(fmtDay(s.date))} — ${esc(s.person.name)}</div>
            <div class="meta">${s.idea ? `${esc(s.idea.title)} · ${esc(s.idea.hood || '')}` : 'Pick something together'}</div>
          </div>
          <div class="actions">
            <button class="btn tiny accent" data-act="suggestPlan" data-id="${s.person.id}" data-idea="${s.idea?.id || ''}" data-date="${s.date}">Plan it →</button>
          </div>
        </div>`).join('')}</div>`
      : `<div class="empty rise">Every preferred night already has a plan. Look at you.</div>`}

    <div style="margin-top:28px;display:flex;justify-content:center">
      <button class="btn accent big rise" data-act="reviewDone">Done — see you next week ✦</button>
    </div>
  `;
};

// ---------- CIRCLE BUILDER ----------
const BUILD_STEPS = [
  { key: 'inner', type: 'friend', tier: 'inner', title: 'Your inner circle',
    sub: 'The handful you\'d call at 2am. Weekly-ish energy.', target: s => s.goals?.innerTarget || 5 },
  { key: 'close', type: 'friend', tier: 'close', title: 'Close friends',
    sub: 'Great hangs, every few weeks. The people you\'re always glad you saw.', target: () => null },
  { key: 'warm', type: 'friend', tier: 'warm', title: 'Keep warm',
    sub: 'People you genuinely like but see a few times a year. Skip if you\'d rather triage a pasted list later.', target: () => null },
  { key: 'dating', type: 'dating', tier: 'inner', title: 'Dating',
    sub: 'Anyone currently in the picture — Orbit keeps the momentum.', target: () => null },
];
let buildStep = 0;

VIEWS.build = function renderBuild() {
  const step = BUILD_STEPS[buildStep];
  const last = buildStep === BUILD_STEPS.length - 1;
  const added = S.people.filter(p =>
    step.type === 'dating' ? p.type === 'dating' && p.tier !== 'archived'
      : p.type !== 'dating' && p.tier === step.tier);
  const target = step.target(S.settings);
  const quickTags = [...new Set([...(S.settings.interests || []), 'food', 'drinks', 'active', 'art', 'music'])].slice(0, 12);

  $('#view').innerHTML = `
    <div class="triage-wrap" style="max-width:680px">
      <div class="wiz-dots" style="margin-top:20px">${BUILD_STEPS.map((_, i) => `<span class="dot ${i <= buildStep ? 'on' : ''}"></span>`).join('')}</div>
      <h1 class="rise">${step.title}</h1>
      <p class="muted rise" style="--i:1;margin:8px 0 20px">${step.sub}${target ? ` <b>Goal: ${target}.</b>` : ''}</p>

      <div class="card build-card rise" style="--i:2;text-align:left">
        <input id="bd-name" placeholder="${step.type === 'dating' ? 'Their name' : 'Name'}" autocomplete="off"
          style="font-size:17px;padding:12px 14px;width:100%;font-family:var(--serif)">
        ${step.type === 'dating' ? `
          <div class="chip-select" style="margin-top:10px">
            ${STAGES.map((s, i) => `<button class="pick bd-stage ${i === 0 ? 'on' : ''}" data-val="${s}">${STAGE_LABEL[s]}</button>`).join('')}
          </div>
          <input id="bd-nextstep" placeholder="Next step — e.g. “Suggest Thursday drinks”" style="width:100%;margin-top:10px">` : `
          <div class="chip-select" style="margin-top:10px">
            ${quickTags.map(t => `<button class="pick bd-tag" data-val="${esc(t)}">${esc(t)}</button>`).join('')}
          </div>`}
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <input id="bd-phone" placeholder="Phone (for Messages/WhatsApp)" style="flex:2;min-width:180px">
          <input id="bd-bday" placeholder="Birthday MM-DD" style="flex:1;min-width:110px">
        </div>
        <input id="bd-thread" placeholder="💭 Something to ask them about next time (optional)" style="width:100%;margin-top:10px">
        <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
          <button class="btn accent" data-act="buildAdd">Add ⏎</button>
          <span class="small faint">Enter works too — rapid fire, details later</span>
        </div>
      </div>

      ${added.length ? `
      <div class="build-added rise" style="--i:3">
        ${added.map(p => `<span class="build-pill" data-act="openPerson" data-id="${p.id}">
          <span class="avatar" style="${avatarStyle(p)};width:22px;height:22px;font-size:9px">${initials(p.name)}</span>${esc(p.name.split(' ')[0])}</span>`).join('')}
        <span class="small faint" style="align-self:center">${added.length}${target ? `/${target}` : ''} added</span>
      </div>` : ''}

      <div style="display:flex;gap:8px;justify-content:center;margin-top:24px">
        ${buildStep > 0 ? `<button class="btn ghost" data-act="buildBack">← Back</button>` : ''}
        <button class="btn ${last ? 'accent big' : 'primary'}" data-act="buildNext">${last ? 'Finish — see my orbit ✦' : added.length ? 'Next →' : 'Skip →'}</button>
      </div>
    </div>
  `;
  $('#bd-name').focus();
  $$('.bd-tag').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')));
  $$('.bd-stage').forEach(b => b.addEventListener('click', () =>
    $$('.bd-stage').forEach(x => x.classList.toggle('on', x === b))));
  $('#view').querySelectorAll('#bd-name, #bd-phone, #bd-bday, #bd-thread, #bd-nextstep').forEach(inp =>
    inp?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ACTIONS.buildAdd(); } }));
};

function buildAddPerson() {
  const step = BUILD_STEPS[buildStep];
  const name = $('#bd-name').value.trim();
  if (!name) { toast('Name first'); return; }
  if (S.people.some(p => p.name.toLowerCase() === name.toLowerCase())) { toast(`${name} is already in your orbit`); return; }
  const phone = $('#bd-phone').value.trim();
  const bday = $('#bd-bday').value.trim();
  const threadText = $('#bd-thread').value.trim();
  const p = {
    id: uid(), name, type: step.type, tier: step.tier,
    stage: step.type === 'dating' ? ($('.bd-stage.on')?.dataset.val || 'new') : null,
    interests: step.type === 'dating' ? [] : $$('.bd-tag.on').map(b => b.dataset.val),
    notes: '', nextStep: step.type === 'dating' ? ($('#bd-nextstep').value.trim() || '') : '',
    handles: phone ? { phone } : {}, preferredChannel: null,
    birthday: /^\d{2}-\d{2}$/.test(bday) ? bday : null,
    lastContact: todayIso(), snoozedUntil: null, createdAt: todayIso(),
    threads: threadText ? [{ id: uid(), text: threadText, createdAt: todayIso(), done: false }] : [],
    log: [],
  };
  S.people.push(p);
  persist();
  toast(`${name} → ${step.type === 'dating' ? STAGE_LABEL[p.stage] : TIER_LABEL[step.tier]} ✓`);
  VIEWS.build();
}

// ---------- PERSON DIALOG ----------
function openPersonDialog(id, presets = {}) {
  const isNew = !id;
  const p = isNew
    ? { id: uid(), name: '', type: presets.type || 'friend', tier: presets.tier || 'close', stage: presets.type === 'dating' ? 'new' : null,
        interests: [], notes: '', nextStep: '', handles: {}, preferredChannel: null, birthday: null, lastContact: null, snoozedUntil: null, createdAt: todayIso(), log: [] }
    : person(id);
  p.handles = p.handles || {};
  const dlg = $('#personDialog');
  dlg.innerHTML = `
    <h2>${isNew ? 'Add person' : esc(p.name)}</h2>
    <div class="form-grid">
      <label class="field full">Name<input id="pf-name" value="${esc(p.name)}" placeholder="Full name"></label>
      <label class="field">Type<select id="pf-type">
        ${['friend', 'dating', 'family', 'work'].map(t => `<option value="${t}" ${p.type === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select></label>
      <label class="field">Tier<select id="pf-tier">
        ${['inner', 'close', 'warm', 'unsorted', 'archived'].map(t => `<option value="${t}" ${p.tier === t ? 'selected' : ''}>${TIER_LABEL[t]}</option>`).join('')}
      </select></label>
      <label class="field" id="pf-stage-wrap" ${p.type === 'dating' ? '' : 'hidden'}>Stage<select id="pf-stage">
        ${STAGES.map(s => `<option value="${s}" ${p.stage === s ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}
      </select></label>
      <label class="field">Last contact<input type="date" id="pf-last" value="${esc(p.lastContact || '')}"></label>
      <label class="field">Birthday (MM-DD)<input id="pf-bday" value="${esc(p.birthday || '')}" placeholder="07-15"></label>
      <label class="field full">Interests <span style="font-weight:400;text-transform:none">(comma-separated — matches ideas & events)</span><input id="pf-interests" value="${esc((p.interests || []).join(', '))}" placeholder="food, comedy, outdoors"></label>
      <label class="field full">Next step<input id="pf-next" value="${esc(p.nextStep || '')}" placeholder="e.g. Text about Thursday"></label>
      <label class="field">Phone <span style="font-weight:400;text-transform:none">(Messages + WhatsApp)</span><input id="pf-phone" value="${esc(p.handles.phone || '')}" placeholder="+1 917 555 0100"></label>
      <label class="field">Instagram<input id="pf-ig" value="${esc(p.handles.instagram || '')}" placeholder="@handle"></label>
      <label class="field">X<input id="pf-x" value="${esc(p.handles.x || '')}" placeholder="@handle"></label>
      <label class="field">Slack<input id="pf-slack" value="${esc(p.handles.slack || '')}" placeholder="@name / workspace"></label>
      <label class="field full">Notes<textarea id="pf-notes" placeholder="How you met, what they care about, gift ideas…">${esc(p.notes || '')}</textarea></label>
    </div>
    ${!isNew ? `
      <h2 style="font-size:15px;margin-top:18px">Threads <span class="sub">things to bring up next time — they power your drafts</span></h2>
      <div class="thread-list">${(p.threads || []).filter(t => !t.done).map(t => `
        <div class="thread-item">💭 <span style="flex:1">${esc(t.text)}</span>
          <button class="btn tiny ghost" data-thread-done="${t.id}" title="Resolved">✓</button></div>`).join('') || '<div class="small faint">Nothing open. Add one below — e.g. “How was the Berlin trip?”</div>'}
      </div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <input id="pf-thread" placeholder="Remember for next time…" style="flex:1">
        <button class="btn" id="pf-thread-add">Add</button>
      </div>` : ''}
    ${!isNew && (p.log || []).length ? `
      <h2 style="font-size:15px;margin-top:18px">History</h2>
      <div class="log-list">${p.log.slice(0, 12).map(l => `
        <div class="log-item"><span class="d">${fmtDate(l.date)}</span><span>${KIND_LABEL[l.kind] || '📝'}</span><span>${esc(l.note || l.kind)}</span></div>`).join('')}
      </div>` : ''}
    ${!isNew ? `
      <div style="display:flex;gap:6px;margin-top:14px">
        <input id="pf-lognote" placeholder="Quick log: what happened?" style="flex:1">
        <select id="pf-logkind">
          <option value="catchup">💬 catch-up</option><option value="hangout">🍻 hangout</option><option value="date">💐 date</option><option value="note">📝 note</option>
        </select>
        <button class="btn" id="pf-logadd">Log</button>
      </div>` : ''}
    <div class="dialog-actions">
      <button class="btn primary" id="pf-save">Save</button>
      <button class="btn ghost" id="pf-cancel">Cancel</button>
      <span class="spacer"></span>
      ${!isNew ? `<button class="btn ghost danger" id="pf-delete">Delete</button>` : ''}
    </div>
  `;
  dlg.showModal();

  $('#pf-type').addEventListener('change', e => {
    $('#pf-stage-wrap').hidden = e.target.value !== 'dating';
  });
  const collect = () => {
    p.name = $('#pf-name').value.trim();
    p.type = $('#pf-type').value;
    p.tier = $('#pf-tier').value;
    p.stage = p.type === 'dating' ? $('#pf-stage').value : null;
    p.lastContact = $('#pf-last').value || null;
    p.birthday = $('#pf-bday').value.trim() || null;
    p.interests = $('#pf-interests').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    p.nextStep = $('#pf-next').value.trim();
    p.handles = {
      phone: $('#pf-phone').value.trim() || undefined,
      instagram: $('#pf-ig').value.trim().replace(/^@/, '') || undefined,
      x: $('#pf-x').value.trim().replace(/^@/, '') || undefined,
      slack: $('#pf-slack').value.trim() || undefined,
    };
    p.notes = $('#pf-notes').value.trim();
    delete p.sample;
  };
  $('#pf-save').addEventListener('click', () => {
    collect();
    if (!p.name) { toast('Name is required'); return; }
    if (isNew) S.people.push(p);
    dlg.close(); save(); toast(isNew ? `Added ${p.name}` : 'Saved');
  });
  $('#pf-cancel').addEventListener('click', () => dlg.close());
  if (!isNew) {
    $('#pf-delete')?.addEventListener('click', () => {
      if (!confirm(`Delete ${p.name} entirely? (Archiving keeps their history.)`)) return;
      S.people = S.people.filter(x => x.id !== p.id);
      S.plans.forEach(pl => pl.personIds = pl.personIds.filter(x => x !== p.id));
      dlg.close(); save(); toast('Deleted');
    });
    $('#pf-logadd')?.addEventListener('click', () => {
      const note = $('#pf-lognote').value.trim();
      logContact(p, $('#pf-logkind').value, note);
      maybeCompleteFocus(p.id);
      dlg.close(); save(); toast(`Logged for ${p.name}`);
    });
    const addThread = () => {
      const text = $('#pf-thread').value.trim();
      if (!text) return;
      p.threads.push({ id: uid(), text, createdAt: todayIso(), done: false });
      persist();
      openPersonDialog(p.id); // re-render dialog with the new thread
      toast('Thread saved 💭');
    };
    $('#pf-thread-add')?.addEventListener('click', addThread);
    $('#pf-thread')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addThread(); } });
    dlg.querySelectorAll('[data-thread-done]').forEach(b => b.addEventListener('click', () => {
      const t = p.threads.find(x => x.id === b.dataset.threadDone);
      if (t) { t.done = true; persist(); openPersonDialog(p.id); toast('Thread resolved ✓'); }
    }));
  }
}

// ---------- PLAN DIALOG ----------
function openPlanDialog({ planId, personId, ideaId, date, title, place, time, notes } = {}) {
  const existing = planId ? S.plans.find(x => x.id === planId) : null;
  const idea = ideaId ? S.ideas.find(i => i.id === ideaId) : null;
  const pl = existing || {
    id: uid(),
    title: title || (idea ? idea.title : ''),
    personIds: personId ? [personId] : [],
    date: date || addDays(todayIso(), 2),
    time: time || '19:00',
    place: place || (idea ? (idea.hood || '') : ''),
    notes: notes || '',
    status: 'upcoming',
  };
  const candidates = activePeople().sort((a, b) => a.name.localeCompare(b.name));
  const dlg = $('#planDialog');
  dlg.innerHTML = `
    <h2>${existing ? 'Edit plan' : 'New plan'}</h2>
    <div class="form-grid">
      <label class="field full">What<input id="plf-title" value="${esc(pl.title)}" placeholder="Dinner, show, walk…" list="ideaList">
        <datalist id="ideaList">${S.ideas.map(i => `<option value="${esc(i.title)}">`).join('')}</datalist></label>
      <label class="field">Date<input type="date" id="plf-date" value="${esc(pl.date)}"></label>
      <label class="field">Time<input type="time" id="plf-time" value="${esc(pl.time || '')}"></label>
      <label class="field full">Where<input id="plf-place" value="${esc(pl.place || '')}" placeholder="Neighborhood or venue"></label>
      <label class="field full">Who
        <div class="checkbox-list">
          ${candidates.map(p => `<label><input type="checkbox" class="plf-person" value="${p.id}" ${pl.personIds.includes(p.id) ? 'checked' : ''}> ${esc(p.name)} <span class="faint small">${TIER_LABEL[p.tier]}${p.type === 'dating' ? ' · dating' : ''}</span></label>`).join('')}
        </div>
      </label>
      <label class="field full">Notes<textarea id="plf-notes">${esc(pl.notes || '')}</textarea></label>
    </div>
    <div class="dialog-actions">
      <button class="btn primary" id="plf-save">${existing ? 'Save' : 'Add plan'}</button>
      <button class="btn ghost" id="plf-cancel">Cancel</button>
    </div>
  `;
  dlg.showModal();
  $('#plf-save').addEventListener('click', () => {
    pl.title = $('#plf-title').value.trim();
    pl.date = $('#plf-date').value;
    pl.time = $('#plf-time').value;
    pl.place = $('#plf-place').value.trim();
    pl.notes = $('#plf-notes').value.trim();
    pl.personIds = $$('.plf-person:checked').map(c => c.value);
    if (!pl.title || !pl.date) { toast('Needs a title and date'); return; }
    if (!existing) S.plans.push(pl);
    delete pl.sample;
    if (focusPending) {
      const item = S.focus?.items.find(i => i.id === focusPending);
      if (item) { item.done = true; checkFocusComplete(); }
      focusPending = null;
    }
    dlg.close(); save(); toast('Plan saved 🗓️');
  });
  $('#plf-cancel').addEventListener('click', () => { focusPending = null; dlg.close(); });
}

// ---------- IDEA DIALOG ----------
function openIdeaDialog(id) {
  const existing = id ? S.ideas.find(i => i.id === id) : null;
  const idea = existing || { id: uid(), title: '', tags: [], hood: '', cost: '$$', best: 'either', notes: '', favorite: false };
  const dlg = $('#ideaDialog');
  dlg.innerHTML = `
    <h2>${existing ? 'Edit idea' : 'Add idea'}</h2>
    <div class="form-grid">
      <label class="field full">Title<input id="if-title" value="${esc(idea.title)}"></label>
      <label class="field">Neighborhood<input id="if-hood" value="${esc(idea.hood || '')}"></label>
      <label class="field">Cost<select id="if-cost">${['free', '$', '$$', '$$$'].map(c => `<option ${idea.cost === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field">Best for<select id="if-best">${[['either', 'date or friends'], ['date', 'dates'], ['friends', 'friends']].map(([v, l]) => `<option value="${v}" ${idea.best === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Tags<input id="if-tags" value="${esc(idea.tags.join(', '))}" placeholder="food, outdoors"></label>
      <label class="field full">Notes<textarea id="if-notes">${esc(idea.notes || '')}</textarea></label>
    </div>
    <div class="dialog-actions">
      <button class="btn primary" id="if-save">Save</button>
      <button class="btn ghost" id="if-cancel">Cancel</button>
      <span class="spacer"></span>
      ${existing ? `<button class="btn ghost danger" id="if-delete">Delete</button>` : ''}
    </div>
  `;
  dlg.showModal();
  $('#if-save').addEventListener('click', () => {
    idea.title = $('#if-title').value.trim();
    idea.hood = $('#if-hood').value.trim();
    idea.cost = $('#if-cost').value;
    idea.best = $('#if-best').value;
    idea.tags = $('#if-tags').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    idea.notes = $('#if-notes').value.trim();
    if (!idea.title) { toast('Needs a title'); return; }
    if (!existing) S.ideas.push(idea);
    dlg.close(); save(); toast('Idea saved');
  });
  $('#if-cancel').addEventListener('click', () => dlg.close());
  $('#if-delete')?.addEventListener('click', () => {
    S.ideas = S.ideas.filter(i => i.id !== idea.id);
    dlg.close(); save(); toast('Idea deleted');
  });
}

// ============================================================
//  ONBOARDING — one question per screen, full bleed
// ============================================================

let ob = null;

// Also the settings surface: the ✦ button reopens this pre-filled, so there's
// only ever one place profile lives.
function openWizard() {
  location.hash = '#welcome';
}

function obInit() {
  const st = S.settings, prof = st.profile || {};
  ob = {
    step: 0, dir: 1, editing: !!prof.completed,
    data: {
      firstName: prof.firstName || '',
      email: st.email || '',
      city: st.city || '',
      neighborhoods: (prof.neighborhoods || []).join(', '),
      interests: [...(st.interests || [])],
      socialBudget: prof.socialBudget || 3,
      nights: [...(prof.nights || ['Thu', 'Fri', 'Sat'])],
      inner: st.tiers.inner, close: st.tiers.close, warm: st.tiers.warm,
      datingCadence: st.datingCadence || 5,
      datingMode: prof.datingMode || 'actively',
      dateStyles: [...(prof.dateStyles || [])],
      innerTarget: st.goals?.innerTarget || 5,
      datesPerMonth: st.goals?.datesPerMonth ?? 4,
      customGoals: [...(st.goals?.custom || [])],
    },
  };
}

const OB_STEPS = [
  {
    eyebrow: 'Welcome to Orbit',
    title: d => d.firstName ? `Good to see you, ${esc(d.firstName)}.` : 'First — what should we call you?',
    sub: 'Orbit is built on one idea: fewer people, deeper bonds. It keeps your closest people close, then tells you exactly what to do with them.',
    body: d => `
      <input id="ob-name" value="${esc(d.firstName)}" placeholder="Your first name" autocomplete="given-name" autofocus>`,
    collect: d => { d.firstName = $('#ob-name').value.trim(); },
    valid: d => !!d.firstName || 'A name makes everything else feel less like a database.',
  },
  {
    eyebrow: 'Step 2',
    title: () => 'Where are you these days?',
    sub: 'This is the big one. Your city is how Orbit finds real shows, real openings, real tables — not generic advice.',
    body: d => `
      <input id="ob-city" value="${esc(d.city)}" placeholder="City" autocomplete="address-level2" autofocus>
      <div class="city-suggest">
        ${CITY_SUGGESTIONS.map(c => `<button data-ob-city="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      <div style="margin-top:18px">
        <div class="ob-label">Neighborhoods you actually hang in <span style="text-transform:none;letter-spacing:0">— optional</span></div>
        <input id="ob-hoods" value="${esc(d.neighborhoods)}" placeholder="Williamsburg, East Village…" style="margin-top:8px">
      </div>`,
    collect: d => {
      d.city = $('#ob-city').value.trim();
      d.neighborhoods = $('#ob-hoods').value;
    },
    valid: d => !!d.city || 'Orbit needs a city before it can find anything.',
  },
  {
    eyebrow: 'Step 3',
    title: () => 'What are you into?',
    sub: 'Pick as many as ring true. Every suggestion — tonight, this weekend, for any person — gets filtered through these.',
    body: d => `
      <div class="chip-select">
        ${[...new Set([...INTEREST_BANK, ...d.interests])].map(t =>
          `<button class="pick ${d.interests.includes(t) ? 'on' : ''}" data-pick="interests" data-val="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>
      <div class="wiz-row">
        <input id="ob-custom" class="grow" placeholder="Something else…">
        <button class="btn" id="ob-custom-add">Add</button>
      </div>`,
    collect: () => {},
    valid: d => d.interests.length >= 2 || 'Pick at least two so there\'s something to work with.',
  },
  {
    eyebrow: 'Step 4',
    title: () => 'What\'s your rhythm?',
    sub: 'Orbit paces everything to this. It will never nag you past the life you actually want.',
    body: d => `
      <div class="ob-label">Hangs and dates per week</div>
      <div class="wiz-row">
        <input type="range" id="ob-budget" class="grow" min="1" max="7" value="${d.socialBudget}">
        <div class="slider-val" id="ob-budget-val">${d.socialBudget}</div>
      </div>
      <div class="ob-label" style="margin-top:10px">Nights you like going out</div>
      <div class="chip-select" style="margin-top:8px">
        ${NIGHTS.map(n => `<button class="pick ${d.nights.includes(n) ? 'on' : ''}" data-pick="nights" data-val="${n}">${n}</button>`).join('')}
      </div>
      <div class="ob-label" style="margin-top:22px">How many days before someone counts as overdue?</div>
      <div class="field-row" style="margin-top:8px">
        <label class="field">Inner circle<input type="number" id="ob-inner" value="${d.inner}" min="1" max="365"></label>
        <label class="field">Close<input type="number" id="ob-close" value="${d.close}" min="1" max="365"></label>
        <label class="field">Keep warm<input type="number" id="ob-warm" value="${d.warm}" min="1" max="365"></label>
        <label class="field">Dating<input type="number" id="ob-dating" value="${d.datingCadence}" min="1" max="365"></label>
      </div>`,
    collect: d => {
      d.socialBudget = +$('#ob-budget').value;
      d.inner = +$('#ob-inner').value || 7;
      d.close = +$('#ob-close').value || 21;
      d.warm = +$('#ob-warm').value || 60;
      d.datingCadence = +$('#ob-dating').value || 5;
    },
    after: () => {
      $('#ob-budget')?.addEventListener('input', e => { $('#ob-budget-val').textContent = e.target.value; });
    },
  },
  {
    eyebrow: 'Step 5',
    title: () => 'How\'s dating going?',
    sub: 'So the pipeline pushes exactly as hard as you want it to — and no harder.',
    body: d => `
      <div class="radio-cards">
        ${[['actively', '✦', 'Actively looking', 'dates get priority'],
           ['casually', '◐', 'Casually dating', 'open, not chasing'],
           ['paused', '◯', 'Paused', 'friends only for now']].map(([v, e, b, s]) =>
          `<div class="rc ${d.datingMode === v ? 'on' : ''}" data-pick-one="datingMode" data-val="${v}"><span class="e">${e}</span><b>${b}</b>${s}</div>`).join('')}
      </div>
      <div class="ob-label" style="margin-top:22px">Date styles you actually enjoy</div>
      <div class="chip-select" style="margin-top:8px">
        ${DATE_STYLES.map(t => `<button class="pick ${d.dateStyles.includes(t) ? 'on' : ''}" data-pick="dateStyles" data-val="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>`,
    collect: () => {},
  },
  {
    eyebrow: 'Last one',
    title: () => 'What does winning look like?',
    sub: 'Goals turn this from a list into a scoreboard. Your weekly review measures against them.',
    body: d => `
      <div class="ob-label">People who get weekly-ish energy</div>
      <div class="wiz-row">
        <input type="range" id="ob-innertarget" class="grow" min="2" max="10" value="${d.innerTarget}">
        <div class="slider-val" id="ob-innertarget-val">${d.innerTarget}</div>
      </div>
      <div class="ob-label" style="margin-top:8px">Dates per month <span style="text-transform:none;letter-spacing:0">— 0 to not track</span></div>
      <div class="wiz-row">
        <input type="range" id="ob-datesgoal" class="grow" min="0" max="10" value="${d.datesPerMonth}">
        <div class="slider-val" id="ob-datesgoal-val">${d.datesPerMonth}</div>
      </div>
      <div class="ob-label" style="margin-top:14px">Anything of your own</div>
      <div class="thread-list" style="margin-top:8px">
        ${d.customGoals.map((g, i) => `<div class="thread-item">◎ <span style="flex:1">${esc(g.text)}</span><button class="btn tiny ghost" data-goal-rm="${i}">✕</button></div>`).join('')
          || '<div class="small faint">e.g. “Host a dinner every month” · “One new friend a quarter”</div>'}
      </div>
      <div class="wiz-row">
        <input id="ob-goal-custom" class="grow" placeholder="Add a goal…">
        <button class="btn" id="ob-goal-add">Add</button>
      </div>
      <div style="margin-top:14px">
        <div class="ob-label">Digest email <span style="text-transform:none;letter-spacing:0">— optional</span></div>
        <input id="ob-email" value="${esc(d.email)}" placeholder="you@email.com" style="margin-top:8px" autocomplete="email">
      </div>`,
    collect: d => {
      d.innerTarget = +$('#ob-innertarget').value || 5;
      d.datesPerMonth = +$('#ob-datesgoal').value;
      d.email = $('#ob-email').value.trim();
    },
    after: () => {
      $('#ob-innertarget')?.addEventListener('input', e => { $('#ob-innertarget-val').textContent = e.target.value; });
      $('#ob-datesgoal')?.addEventListener('input', e => { $('#ob-datesgoal-val').textContent = e.target.value; });
    },
  },
];

VIEWS.welcome = function renderOnboarding() {
  if (!ob) obInit();

  // The finale sits one past the last question — the payoff screen.
  if (ob.step >= OB_STEPS.length) return renderObFinale();

  const step = OB_STEPS[ob.step];
  const d = ob.data;
  const pct = Math.round((ob.step / (OB_STEPS.length + 1)) * 100);
  const last = ob.step === OB_STEPS.length - 1;

  $('#view').innerHTML = `
    <div class="ob">
      <div class="ob-progress"><div class="ob-bar" style="width:${pct}%"></div></div>
      <div class="ob-stage ${ob.dir < 0 ? 'back' : ''}">
        <div class="ob-eyebrow">${esc(step.eyebrow)}</div>
        <h1 class="ob-title">${typeof step.title === 'function' ? step.title(d) : esc(step.title)}</h1>
        <p class="ob-sub">${step.sub}</p>
        <div class="ob-body">${step.body(d)}</div>
      </div>
      <div class="ob-nav">
        ${ob.step > 0
          ? `<button class="btn ghost" data-act="obBack">← Back</button>`
          : ob.editing ? `<button class="btn ghost" data-act="obExit">Cancel</button>` : ''}
        <span class="spacer"></span>
        <span class="ob-hint">↵ enter</span>
        <button class="btn accent big" data-act="obNext">${last ? 'See my orbit ✦' : 'Continue'}</button>
      </div>
    </div>
  `;

  bindPickers($('#view'), d, () => VIEWS.welcome());
  step.after?.();

  $('#ob-custom-add')?.addEventListener('click', () => {
    const v = $('#ob-custom').value.trim().toLowerCase();
    if (v && !d.interests.includes(v)) { d.interests.push(v); VIEWS.welcome(); }
  });
  $('#ob-goal-add')?.addEventListener('click', () => {
    const v = $('#ob-goal-custom').value.trim();
    if (v) { step.collect(d); d.customGoals.push({ id: uid(), text: v }); VIEWS.welcome(); }
  });
  $('#view').querySelectorAll('[data-goal-rm]').forEach(b => b.addEventListener('click', () => {
    step.collect(d);
    d.customGoals.splice(+b.dataset.goalRm, 1);
    VIEWS.welcome();
  }));
  $('#view').querySelectorAll('[data-ob-city]').forEach(b => b.addEventListener('click', () => {
    $('#ob-city').value = b.dataset.obCity;
    ACTIONS.obNext();
  }));

  // Enter advances, except in the small "add another" inputs.
  $('#view').querySelectorAll('input:not([type=range])').forEach(inp =>
    inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (inp.id === 'ob-custom') { $('#ob-custom-add').click(); return; }
      if (inp.id === 'ob-goal-custom') { $('#ob-goal-add').click(); return; }
      ACTIONS.obNext();
    }));

  $('#view').querySelector('[autofocus]')?.focus();
};

// Shared chip / radio-card wiring — onboarding and the circle builder both use it.
function bindPickers(root, data, rerender) {
  root.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    const arr = data[b.dataset.pick];
    const i = arr.indexOf(b.dataset.val);
    i >= 0 ? arr.splice(i, 1) : arr.push(b.dataset.val);
    b.classList.toggle('on');
  }));
  root.querySelectorAll('[data-pick-one]').forEach(b => b.addEventListener('click', () => {
    data[b.dataset.pickOne] = b.dataset.val;
    root.querySelectorAll(`[data-pick-one="${b.dataset.pickOne}"]`)
      .forEach(x => x.classList.toggle('on', x === b));
  }));
  void rerender;
}

function renderObFinale() {
  const d = ob.data;
  const act = activePeople();
  const hasPeople = act.length > 0;

  $('#view').innerHTML = `
    <div class="ob">
      <div class="ob-progress"><div class="ob-bar" style="width:100%"></div></div>
      <div class="ob-stage ob-finale">
        ${constellationSvg({ interactive: false })}
        <div class="ob-eyebrow">Your orbit</div>
        <h1 class="ob-title">${hasPeople
          ? `${act.length} ${act.length === 1 ? 'person' : 'people'} in orbit around you.`
          : 'This is your sky. Time to put people in it.'}</h1>
        <p class="ob-sub" style="margin-inline:auto">${hasPeople
          ? `Orbit will keep them close and tell you what to do with them. Here's what's next.`
          : `Add your inner circle — the handful you'd call at 2am — and everything else switches on.`}</p>
        <div class="ob-finale-stats">
          <span class="proof-item"><span class="pi">◍</span>${esc(d.city || 'your city')}</span>
          <span class="proof-item"><span class="pi">✦</span>${d.interests.length} interests</span>
          <span class="proof-item"><span class="pi">◆</span>${d.socialBudget}/week</span>
        </div>
      </div>
      <div class="ob-nav" style="justify-content:center">
        ${hasPeople
          ? `<button class="btn accent big" data-act="obFinish" data-id="tonight">What should I do tonight? →</button>
             <button class="btn ghost" data-act="obFinish" data-id="today">Just show me Today</button>`
          : `<button class="btn accent big" data-act="obFinish" data-id="build">Add my people →</button>
             <button class="btn ghost" data-act="obFinish" data-id="today">Later</button>`}
      </div>
    </div>
  `;
}

function obSave() {
  const d = ob.data;
  S.settings.email = d.email;
  S.settings.city = d.city;
  S.settings.interests = [...d.interests];
  S.settings.tiers = { inner: d.inner, close: d.close, warm: d.warm };
  S.settings.datingCadence = d.datingCadence;
  S.settings.profile = {
    ...S.settings.profile,
    firstName: d.firstName,
    neighborhoods: d.neighborhoods.split(',').map(s => s.trim()).filter(Boolean),
    socialBudget: d.socialBudget,
    nights: [...d.nights],
    datingMode: d.datingMode,
    dateStyles: [...d.dateStyles],
    completed: true,
    completedAt: S.settings.profile.completedAt || todayIso(),
  };
  // A different city invalidates the cached geocode and every stale run.
  if (S.settings.profile.geo && S.settings.profile.geo.city !== d.city) {
    S.settings.profile.geo = null;
    S.concierge.runs = {};
    S.concierge.weather = null;
  }
  S.settings.goals = {
    ...S.settings.goals,
    innerTarget: d.innerTarget,
    datesPerMonth: d.datesPerMonth || null,
    custom: [...d.customGoals],
  };
  persist();
}

// ---------- landing (first ever visit) ----------
function renderLanding() {
  // Nothing behind the nav is worth seeing yet, so the hero gets the screen.
  document.documentElement.dataset.route = 'landing';
  $('#view').innerHTML = `
    <div class="landing">
      <div class="landing-inner">
        <svg class="landing-mark rise" width="60" height="60" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="36" fill="none" stroke="var(--accent)" stroke-width="6" opacity="0.9"/>
          <circle cx="50" cy="50" r="20" fill="none" stroke="var(--aurora-2)" stroke-width="3" opacity="0.5"/>
          <circle cx="50" cy="50" r="7" fill="var(--aurora-1)"/>
          <circle cx="50" cy="11" r="10" fill="var(--aurora-3)"/>
        </svg>
        <h1 class="landing-title rise" style="--i:1">
          Fewer people,<br><span class="landing-serif aurora-text">deeper bonds.</span>
        </h1>
        <p class="landing-sub rise" style="--i:2">
          Orbit keeps your closest people close — then tells you exactly what to do with them
          tonight, or this weekend. Real places, real dates, chosen for you.
        </p>
        <div class="landing-actions rise" style="--i:3">
          <button class="btn accent big" data-act="goWelcome">Begin ✦</button>
          <a class="btn ghost big" href="#connect">How it works</a>
        </div>
        <div class="landing-proof rise" style="--i:4">
          <span class="proof-item"><span class="pi">◍</span>Two minutes to set up</span>
          <span class="proof-item"><span class="pi">✦</span>Live listings, not generic advice</span>
          <span class="proof-item"><span class="pi">⌂</span>Your data stays yours</span>
        </div>
      </div>
    </div>
  `;
}

// ---------- COMMAND PALETTE ----------
let palSel = 0;
function paletteItems(q) {
  const items = [];
  const add = (icon, label, hint, fn) => items.push({ icon, label, hint, fn });
  add('☾', 'What should I do tonight?', 'Planner', () => ACTIONS.cgJump('tonight'));
  add('✦', 'Plan my weekend', 'Planner', () => ACTIONS.cgJump('weekend'));
  add('▦', 'Plan the week', 'Planner', () => ACTIONS.cgJump('week'));
  if (!q) {
    duePeople().slice(0, 3).forEach(({ p, d }) =>
      add(initials(p.name), `Reach out: ${p.name}`, `${d.overdue}d overdue`, () => openPersonDialog(p.id)));
  }
  add('＋', 'Add person', 'People', () => openPersonDialog(null));
  add('♥', 'Add dating prospect', 'Dating', () => openPersonDialog(null, { type: 'dating', tier: 'inner' }));
  add('◫', 'New plan', 'Plans', () => openPlanDialog({}));
  add('✧', 'Add idea', 'Ideas', () => openIdeaDialog(null));
  add('⚡', 'Triage contacts', 'People', () => location.hash = '#triage');
  add('◉', 'Add people', 'Setup', () => { buildStep = 0; location.hash = '#build'; });
  add('◈', 'Weekly review', 'Ritual', () => location.hash = '#review');
  add('◐', 'Toggle dark mode', 'Theme', toggleTheme);
  add('✦', 'Profile & settings', 'Setup', () => { ob = null; openWizard(); });
  if (syncCfg?.gistId) add('⟳', 'Sync now', 'Sync', () => { pushSync(); toast('Syncing…'); });
  ['today', 'plan', 'tonight', 'people', 'dating', 'ideas', 'plans', 'digest', 'connect'].forEach(v =>
    add('▸', `Go to ${v[0].toUpperCase() + v.slice(1)}`, 'Navigate', () => location.hash = '#' + v));
  activePeople().forEach(p =>
    add(initials(p.name), p.name, TIER_LABEL[p.tier], () => openPersonDialog(p.id)));
  S.ideas.forEach(i =>
    add('✧', `Plan: ${i.title}`, i.hood || 'Idea', () => openPlanDialog({ ideaId: i.id })));

  if (!q) return items.slice(0, 9);
  const ql = q.toLowerCase();
  return items
    .map(it => ({ it, score: it.label.toLowerCase().startsWith(ql) ? 2 : it.label.toLowerCase().includes(ql) ? 1 : 0 }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.it)
    .slice(0, 9);
}

function openPalette() {
  const dlg = $('#paletteDialog');
  palSel = 0;
  dlg.innerHTML = `
    <input id="pal-q" placeholder="Search people, ideas, actions…" autocomplete="off">
    <div class="palette-list" id="pal-list"></div>
  `;
  const listEl = dlg.querySelector('#pal-list');
  const qEl = dlg.querySelector('#pal-q');
  let current = [];

  const draw = () => {
    current = paletteItems(qEl.value.trim());
    palSel = Math.min(palSel, Math.max(0, current.length - 1));
    listEl.innerHTML = current.length
      ? current.map((it, i) => `
        <div class="palette-item ${i === palSel ? 'sel' : ''}" data-i="${i}">
          <span class="pi-icon">${esc(it.icon)}</span>
          <span>${esc(it.label)}</span>
          <span class="pi-hint">${esc(it.hint)}</span>
        </div>`).join('')
      : `<div class="palette-empty">No matches</div>`;
    listEl.querySelectorAll('.palette-item').forEach(el => {
      el.addEventListener('click', () => { dlg.close(); current[+el.dataset.i].fn(); });
      el.addEventListener('mousemove', () => {
        if (palSel !== +el.dataset.i) { palSel = +el.dataset.i; draw(); }
      });
    });
  };
  qEl.addEventListener('input', () => { palSel = 0; draw(); });
  qEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palSel + 1, current.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(palSel - 1, 0); draw(); }
    else if (e.key === 'Enter' && current[palSel]) { dlg.close(); current[palSel].fn(); }
  });
  draw();
  dlg.showModal();
  qEl.focus();
}

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const dlg = $('#paletteDialog');
    dlg.open ? dlg.close() : openPalette();
  }
});

// ---------- more sheet (mobile) ----------
function openMoreSheet() {
  const sheet = $('#moreSheet');
  sheet.innerHTML = `
    <div class="sheet-list">
      <a href="#plan" data-close><span class="si">✦</span>Plan</a>
      <a href="#plans" data-close><span class="si">◫</span>Plans</a>
      <a href="#ideas" data-close><span class="si">✧</span>Saved ideas</a>
      <a href="#review" data-close><span class="si">◈</span>Weekly review</a>
      <a href="#build" data-close><span class="si">◉</span>Add people</a>
      <a href="#digest" data-close><span class="si">▤</span>Digest</a>
      <a href="#connect" data-close><span class="si">⚯</span>Connect</a>
      <button data-run="wizard"><span class="si">✦</span>Profile &amp; settings</button>
      <button data-run="theme"><span class="si">◐</span>Toggle theme</button>
      ${syncCfg?.gistId ? '<button data-run="sync"><span class="si">⟳</span>Sync now</button>' : ''}
    </div>
  `;
  sheet.querySelectorAll('[data-close]').forEach(a => a.addEventListener('click', () => sheet.close()));
  sheet.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => {
    sheet.close();
    const r = b.dataset.run;
    if (r === 'wizard') openWizard();
    if (r === 'theme') toggleTheme();
    if (r === 'sync') { pushSync(); toast('Syncing…'); }
  }));
  sheet.showModal();
}

// ---------- spotlight (cursor-tracked glow) ----------
document.addEventListener('mousemove', e => {
  const el = e.target.closest?.('.spot');
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${e.clientX - r.left}px`);
  el.style.setProperty('--my', `${e.clientY - r.top}px`);
});

// ---------- actions ----------
function removeSamples() {
  S.people = S.people.filter(p => !p.sample);
  S.plans = S.plans.filter(pl => !pl.sample);
  save(); toast('Sample data removed');
}

function addToTriage(names) {
  const existing = new Set(S.people.map(p => p.name.toLowerCase()));
  let added = 0;
  for (const name of names) {
    if (existing.has(name.toLowerCase())) continue;
    existing.add(name.toLowerCase());
    S.people.push({
      id: uid(), name, type: 'friend', tier: 'unsorted', stage: null, interests: [],
      notes: '', nextStep: '', handles: {}, preferredChannel: null, birthday: null, lastContact: null, snoozedUntil: null,
      createdAt: todayIso(), log: [],
    });
    added++;
  }
  persist();
  if (added) location.hash = '#triage';
  render();
  return added;
}

const ACTIONS = {
  // ---------- taste feedback ----------
  evSave(id) { applyTasteFeedback('event', id, 'save'); save(); toast('Noted — more like this ✦'); },
  evDismiss(id) { applyTasteFeedback('event', id, 'dismiss'); save(); },
  vnSave(id) { applyTasteFeedback('venue', id, 'save'); save(); toast('Noted — more like this ✦'); },
  vnDismiss(id) { applyTasteFeedback('venue', id, 'dismiss'); save(); },

  // ---------- concierge / planner ----------
  cgMode(mode) { ACTIONS.plRange(mode === 'week' ? 'week' : mode === 'weekend' ? 'weekend' : 'tonight'); },
  cgJump(mode) {
    S.planner.range = mode === 'week' ? 'week' : mode === 'weekend' ? 'weekend' : 'tonight';
    persist();
    location.hash = mode === 'weekend' ? '#weekend' : mode === 'week' ? '#plan' : '#tonight';
  },
  cgGo() { ACTIONS.plGo(); },
  cgRefresh() { ACTIONS.plRefresh(); },
  cgStop() { ACTIONS.plStop(); },
  cgShareAll() { ACTIONS.plShareAll(); },
  plRange(id) {
    S.planner.range = ['tonight', 'weekend', 'week'].includes(id) ? id : 'weekend';
    persist();
    if (route !== 'plan') location.hash = '#plan';
    else VIEWS.plan();
  },
  plGo() {
    const prompt = ($('#plPrompt')?.value || '').trim();
    S.planner.prompt = prompt;
    persist();
    runPlanner({ force: true });
  },
  plRefresh() { runPlanner({ force: true }); },
  plStop() {
    cgAbort?.abort();
    plRun = null;
    renderPlannerBody();
  },
  plMore(cell) {
    if (plOpen.has(cell)) plOpen.delete(cell);
    else plOpen.add(cell);
    renderPlannerBody();
  },
  plLock(id) {
    const opt = findOption(id);
    if (!opt) return;
    const board = currentBoard();
    const cell = cellKey(opt.date, opt.slot);
    if (board.chosen[cell] === id) delete board.chosen[cell];
    else board.chosen[cell] = id;
    persist();
    renderPlannerBody();
  },
  plDismiss(id) {
    const opt = findOption(id);
    if (!opt) return;
    const board = currentBoard();
    const cell = cellKey(opt.date, opt.slot);
    board.options[cell] = (board.options[cell] || []).filter(o => o.id !== id);
    if (board.chosen[cell] === id) delete board.chosen[cell];
    board.dismissed = board.dismissed || [];
    const key = optionDedupeKey(opt);
    if (key && !board.dismissed.includes(key)) board.dismissed.push(key);
    if (opt.refId && (opt.refKind === 'event' || opt.refKind === 'venue')) {
      applyTasteFeedback(opt.refKind, opt.refId, 'dismiss');
    }
    persist();
    renderPlannerBody();
  },
  plSave(id) {
    const pick = findOption(id);
    if (!pick) return;
    S.ideas.unshift({
      id: uid(),
      title: pick.title,
      tags: [pick.kind, ...(pick.price ? [pick.price] : [])],
      hood: pick.neighborhood || pick.venue || '',
      cost: pick.price === 'free' ? 'free' : pick.price,
      best: 'either',
      notes: [pick.why, pick.tip, pick.url].filter(Boolean).join('\n'),
      favorite: false,
    });
    persist();
    toast('Saved to your ideas ✦');
  },
  plShareAll() {
    const board = currentBoard();
    const locked = chosenOptions(board);
    const picks = locked.length ? locked : Object.values(board.options).flatMap(list => list.slice(0, 1));
    const label = S.planner.range === 'tonight'
      ? `${fmtDay(plannerDates()[0])} in ${S.settings.city}`
      : `${S.settings.city} this ${S.planner.range === 'week' ? 'week' : 'weekend'}`;
    shareItinerary(picks, label);
  },
  plAddAll() {
    const board = currentBoard();
    const locked = chosenOptions(board);
    if (!locked.length) { toast('Lock a few options first'); return; }
    let n = 0;
    for (const opt of locked) {
      if (S.plans.some(pl => pl.title === opt.title && pl.date === opt.date)) continue;
      const buddy = personByFirstName(opt.bring);
      S.plans.push({
        id: uid(),
        title: opt.title,
        personIds: buddy ? [buddy.id] : [],
        date: opt.date,
        time: opt.startTime || slotTime(opt.slot),
        place: [opt.venue, opt.neighborhood].filter(Boolean).join(', '),
        notes: [opt.tip, opt.url].filter(Boolean).join('\n'),
        status: 'upcoming',
      });
      n++;
    }
    persist();
    renderPlannerBody();
    toast(n ? `${n} ${n === 1 ? 'plan' : 'plans'} added ✦` : 'Those were already on your calendar');
    if (n && !reduceMotion) confetti(16);
  },
  pickPlan(id) {
    const pick = findPick(id);
    if (!pick) return;
    const buddy = personByFirstName(pick.bring);
    openPlanDialog({
      personId: buddy?.id,
      date: pick.date,
      time: pick.startTime || '19:00',
      title: pick.title,
      place: [pick.venue, pick.neighborhood].filter(Boolean).join(', '),
      notes: [pick.tip, pick.url].filter(Boolean).join('\n'),
    });
  },
  pickSave(id) {
    const pick = findPick(id);
    if (!pick) return;
    S.ideas.unshift({
      id: uid(),
      title: pick.title,
      tags: [pick.kind, ...(pick.price ? [pick.price] : [])],
      hood: pick.neighborhood || pick.venue || '',
      cost: pick.price === 'free' ? 'free' : pick.price,
      best: 'either',
      notes: [pick.why, pick.tip, pick.url].filter(Boolean).join('\n'),
      favorite: false,
    });
    save();
    toast('Saved to your ideas ✦');
  },
  pickShare(id) {
    const pick = findPick(id);
    if (pick) shareItinerary([pick], pick.title);
  },

  // ---------- onboarding ----------
  goWelcome() { location.hash = '#welcome'; },
  obNext() {
    const step = OB_STEPS[ob.step];
    step.collect(ob.data);
    const ok = step.valid ? step.valid(ob.data) : true;
    if (ok !== true) { toast(ok); return; }
    ob.dir = 1;
    ob.step++;
    if (ob.step >= OB_STEPS.length) obSave();
    VIEWS.welcome();
    scrollTo({ top: 0, behavior: 'instant' });
  },
  obBack() {
    OB_STEPS[ob.step]?.collect(ob.data);
    ob.dir = -1;
    ob.step--;
    VIEWS.welcome();
  },
  obExit() { ob = null; location.hash = '#today'; },
  obFinish(where) {
    const first = ob.data.firstName;
    ob = null;
    if (!reduceMotion) confetti(40);
    toast(first ? `You're set, ${first} ✦` : "You're set ✦");
    location.hash = where === 'tonight' ? '#tonight' : where === 'build' ? '#build' : '#today';
  },
  sharedStart() {
    sharedPayload = null;
    history.replaceState(null, '', location.pathname + location.search);
    location.hash = '#welcome';
    render();
  },

  log(id) {
    const p = person(id);
    logContact(p, p.type === 'dating' ? 'date' : 'catchup', '');
    maybeCompleteFocus(id);
    save(); toast(`Logged catch-up with ${p.name} ✓`);
  },
  focusLog(itemId) {
    const item = S.focus?.items.find(i => i.id === itemId);
    if (!item) return;
    const p = person(item.personId);
    logContact(p, p.type === 'dating' ? 'date' : 'catchup', item.kind === 'nextstep' ? p.nextStep : '');
    if (item.kind === 'nextstep') p.nextStep = '';
    item.done = true;
    checkFocusComplete();
    save();
    toast(`${p.name} ✓ — ${S.focus.items.filter(i => i.done).length}/${S.focus.items.filter(i => !i.skipped).length} done`);
  },
  focusSkip(itemId) {
    const item = S.focus?.items.find(i => i.id === itemId);
    if (!item) return;
    item.skipped = true;
    checkFocusComplete();
    save();
  },
  focusPlan(itemId) {
    const item = S.focus?.items.find(i => i.id === itemId);
    if (!item) return;
    focusPending = itemId;
    openPlanDialog({ personId: item.personId, ideaId: item.ideaId || undefined, date: item.date });
  },
  suggestPlan(personId, btn) {
    openPlanDialog({ personId, ideaId: btn.dataset.idea || undefined, date: btn.dataset.date });
  },
  goReview() { location.hash = '#review'; },
  buildAdd() { buildAddPerson(); },
  buildNext() {
    if (buildStep < BUILD_STEPS.length - 1) { buildStep++; VIEWS.build(); return; }
    buildStep = 0;
    confetti(44);
    toast(`${activePeople().length} people in your orbit — it's alive ✦`);
    location.hash = '#today';
  },
  buildBack() { if (buildStep > 0) { buildStep--; VIEWS.build(); } },
  goBuild() { buildStep = 0; location.hash = '#build'; },
  reviewDone() {
    S.streaks.lastReviewDate = todayIso();
    persist();
    confetti(36);
    toast('Week reviewed — next one\'s lined up 🧭');
    location.hash = '#today';
  },
  sayHi(id, btn) {
    const p = person(id);
    const ch = CHANNELS[btn.dataset.ch];
    const draft = draftFor(p);
    navigator.clipboard?.writeText(draft).catch(() => {});
    const url = ch.url(p.handles || {}, draft);
    if (url.startsWith('sms:')) location.href = url;
    else window.open(url, '_blank', 'noopener');
    toast(`Draft copied — say hi on ${ch.name} ✉️`);
  },
  snooze(id) {
    const p = person(id);
    p.snoozedUntil = addDays(todayIso(), 7);
    save(); toast(`Snoozed ${p.name} for a week`);
  },
  plan(id) { openPlanDialog({ personId: id }); },
  openPerson(id) { openPersonDialog(id); },
  addPerson() { openPersonDialog(null); },
  addProspect() { openPersonDialog(null, { type: 'dating', tier: 'inner' }); },
  pfilter(id) { peopleFilter = id; VIEWS.people(); },
  ifilter(id) { ideaFilter = id || null; VIEWS.ideas(); },
  triageStart() { location.hash = '#triage'; },
  backToPeople() { location.hash = '#people'; },
  triageAssign(tier) { triageAssign(tier); },
  triageAdd() {
    const names = $('#triageNames').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!names.length) { toast('Paste some names first'); return; }
    const added = addToTriage(names);
    toast(`${added} added to triage${names.length - added ? ` (${names.length - added} already existed)` : ''}`);
  },
  stageMove(id, btn) {
    const p = person(id);
    const idx = STAGES.indexOf(p.stage || 'new') + Number(btn.dataset.dir);
    p.stage = STAGES[Math.max(0, Math.min(STAGES.length - 1, idx))];
    save();
  },
  fav(id) {
    const i = S.ideas.find(x => x.id === id);
    i.favorite = !i.favorite;
    save();
  },
  planIdea(id) { openPlanDialog({ ideaId: id }); },
  addIdea() { openIdeaDialog(null); },
  editIdea(id) { openIdeaDialog(id); },
  newPlan() { openPlanDialog({}); },
  planDone(id) { markPlanDone(id); },
  planEdit(id) { openPlanDialog({ planId: id }); },
  planDelete(id) {
    S.plans = S.plans.filter(x => x.id !== id);
    save(); toast('Plan deleted');
  },
  removeSamples() { removeSamples(); },
  copyDigest() {
    navigator.clipboard.writeText($('#view').dataset.digestMd || '');
    toast('Digest copied');
  },
  toggleGmail() {
    S.settings.connections.gmail = !S.settings.connections.gmail;
    save(); toast(S.settings.connections.gmail ? 'Marked Gmail as connected ✉️' : 'Marked as not connected');
  },
  saveSlack() {
    const v = $('#slack-hook').value.trim();
    if (v && !v.startsWith('https://hooks.slack.com/')) { toast('That doesn\'t look like a Slack webhook URL'); return; }
    S.settings.integrations.slackWebhook = v || undefined;
    save(); toast(v ? 'Slack connected — digest will post there 💬' : 'Slack removed');
  },
  clearSlack() {
    S.settings.integrations.slackWebhook = undefined;
    save(); toast('Slack removed');
  },
  async syncCreate(_, btn) {
    const pass = $('#sync-pass').value;
    const token = $('#sync-token').value.trim();
    if (pass.length < 6) { toast('Passphrase needs 6+ characters'); return; }
    if (!token) { toast('Paste a GitHub token (gist scope)'); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spin">◌</span> Encrypting…';
    try {
      await syncCreate(pass, token);
      toast('Sync live — connect your other devices with the same passphrase 🔄');
      confetti(24);
    } catch (e) { alert(e.message); }
    VIEWS.connect();
  },
  async syncConnect(_, btn) {
    const pass = $('#sync-pass').value;
    const token = $('#sync-token').value.trim();
    if (!pass || !token) { toast('Enter your passphrase and token'); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spin">◌</span> Connecting…';
    try {
      await syncConnect(pass, token);
      toast('Connected — data synced 🔄');
      render();
      return;
    } catch (e) { alert(e.message); }
    VIEWS.connect();
  },
  async syncNow() {
    await pullSync({ silent: false });
    await pushSync();
    toast('Synced ✓');
    render();
  },
  syncOff() {
    if (!confirm('Disconnect sync on this device? (The encrypted gist is left untouched.)')) return;
    syncCfg = null;
    localStorage.removeItem(LS_SYNC);
    setSyncDot('off');
    VIEWS.connect();
    toast('Sync disconnected');
  },
  async alwaysOn(mode, btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin">◌</span> Working…';
    try {
      const r = await (await fetch('api/setup/launchagent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: mode === 'on' }),
      })).json();
      toast(r.enabled ? 'Always-on enabled ⚡ Orbit starts at login now' : 'Always-on disabled');
    } catch { toast('⚠️ Could not update launch agent'); }
    VIEWS.connect();
  },
  async importContacts(_, btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin">◌</span> Reading Contacts… (grant permission if asked)';
    try {
      const r = await (await fetch('api/import/macos-contacts', { method: 'POST' })).json();
      if (r.error) throw new Error(r.error);
      const existing = new Set(S.people.map(p => p.name.toLowerCase()));
      const fresh = r.names.filter(n => !existing.has(n.toLowerCase()));
      if (!fresh.length) { toast('No new contacts found'); VIEWS.connect(); return; }
      if (!confirm(`Found ${r.names.length} contacts (${fresh.length} new). Add them to Triage so you can sort your circle?`)) {
        VIEWS.connect(); return;
      }
      addToTriage(fresh);
      toast(`${fresh.length} contacts ready to triage ⚡`);
    } catch (e) {
      alert(e.message);
      VIEWS.connect();
    }
  },
  cgSaveProxy() {
    const v = $('#cg-proxy').value.trim();
    if (v && !/^https?:\/\//.test(v)) { toast('That needs to be a full https:// URL'); return; }
    S.settings.integrations.proxyUrl = v;
    S.concierge.runs = {};
    persist();
    toast(v ? 'Using your proxy ✦' : 'Back to the default proxy');
    VIEWS.connect();
  },
  cgClearProxy() {
    S.settings.integrations.proxyUrl = '';
    persist();
    toast('Reset to the default proxy');
    VIEWS.connect();
  },
  async cgTestProxy(_, btn) {
    const url = ($('#cg-proxy').value.trim() || DEFAULT_PROXY_URL).replace(/\/+$/, '');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin">◌</span> Testing…';
    try {
      const r = await fetch(url + '/health');
      const j = await r.json();
      if (!j.ok) throw new Error('Unexpected response');
      toast(j.providers?.length
        ? `Connected — ${j.providers.join(' + ')} ready ✦`
        : 'Reachable, but no model key is set on that proxy');
    } catch {
      toast('Could not reach that proxy');
    }
    btn.disabled = false;
    btn.textContent = 'Test connection';
  },
  exportJson() {
    const a = document.createElement('a');
    a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(S, null, 2));
    a.download = `orbit-export-${todayIso()}.json`;
    a.click();
    toast('Exported');
  },
};

$('#view').addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  if (t.tagName === 'A' && t.getAttribute('href') === '#') e.preventDefault();
  const fn = ACTIONS[t.dataset.act];
  if (fn) fn(t.dataset.id, t);
});

$('#settingsBtn').addEventListener('click', () => { ob = null; openWizard(); });
$('#themeBtn').addEventListener('click', toggleTheme);
$('#paletteBtn').addEventListener('click', openPalette);
$('#moreTab').addEventListener('click', openMoreSheet);
$('#themeBtn').textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '☾';

// ---------- init ----------
(async function init() {
  try {
    await loadState();
  } catch (e) {
    $('#view').innerHTML = `<div class="empty" style="margin-top:40px">Couldn't load Orbit. ${LOCAL ? 'Start the server with <code>node ~/orbit/server.js</code> and reload.' : 'Check your connection and reload.'}</div>`;
    return;
  }
  if (syncCfg?.gistId) {
    setSyncDot('on');
    pullSync().then(changed => { if (changed) { snapshotHistory(); render(); } });
  }
  snapshotHistory();
  persist();
  initStarfield();
  refreshCityFeed().then(changed => { if (changed && !location.hash.slice(1).startsWith('s=')) render(); });

  // A shared link arrives as #s=<token>. Decode before the first paint so the
  // recipient never sees someone else's Today view flash past.
  const hash = location.hash.slice(1);
  if (hash.startsWith('s=')) {
    if (await applyShareToken(hash.slice(2))) return;
    route = 'today';
  }

  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
