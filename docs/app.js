'use strict';

// ---------- environment ----------
const LOCAL = location.port === '4747'; // served by the Mac server (has /api); otherwise static web/PWA
const WEB_URL = 'https://jlin3.github.io/orbit/';

// ---------- state ----------
let S = null;
let route = location.hash.slice(1) || 'today';
let lastRoute = null;
let peopleFilter = 'active';
let peopleSearch = '';
let ideaFilter = null;

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

// ---------- persistence (local server ⇄ browser storage) ----------
const LS_STATE = 'orbit-state';

function normalizeState() {
  S.settings.profile = S.settings.profile || {};
  S.settings.connections = S.settings.connections || {};
  S.settings.integrations = S.settings.integrations || {};
  S.meta = S.meta || { updatedAt: 0 };
  S.events = S.events || [];
  S.streaks = S.streaks || { focusDays: 0, bestFocus: 0, lastFocusDate: null, lastReviewDate: null };
  S.history = S.history || [];
  S.focus = S.focus || null;
  for (const p of S.people) p.threads = p.threads || [];
  const seedHandles = {
    p_maya: [{ phone: '+1 347 555 0142' }, 'messages'],
    p_jordan: [{ phone: '+1 917 555 0188' }, 'whatsapp'],
    p_sam: [{ instagram: 'samrivera' }, 'instagram'],
    p_dev: [{ x: 'devpatel' }, 'x'],
  };
  for (const p of S.people) {
    if (!p.handles) {
      const sh = p.sample && seedHandles[p.id];
      p.handles = sh ? { ...sh[0] } : {};
      if (sh && !p.preferredChannel) p.preferredChannel = sh[1];
    }
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

function suggestIdea(p) {
  const wantBest = p.type === 'dating' ? ['date', 'either'] : ['friends', 'either'];
  const pool = S.ideas.filter(i => wantBest.includes(i.best));
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
  if (vals.length < 2) return '';
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
}

// ---------- router ----------
const VIEWS = {};
function render() {
  const doRender = () => {
    $$('#nav a, #tabbar a').forEach(a => {
      const on = a.dataset.view === route || (a.dataset.view === 'people' && route === 'triage');
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

window.addEventListener('hashchange', () => {
  route = location.hash.slice(1) || 'today';
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
function constellationSvg() {
  const act = activePeople();
  const RADII = { inner: 62, close: 96, warm: 130 };
  const cx = 160, cy = 160;
  const rings = Object.values(RADII).map(r =>
    `<circle class="ring-line" cx="${cx}" cy="${cy}" r="${r}"/>`).join('');
  const specks = Array.from({ length: 18 }, (_, i) => {
    const a = (hashN('speck' + i) % 3600) / 10 * Math.PI / 180;
    const r = 30 + (hashN('r' + i) % 125);
    return `<circle class="speck" cx="${(cx + r * Math.cos(a)).toFixed(1)}" cy="${(cy + r * Math.sin(a)).toFixed(1)}" r="${1 + (i % 2)}"/>`;
  }).join('');
  const dots = act.map(p => {
    const d = dueInfo(p);
    const r = RADII[p.tier] || RADII.warm;
    const a = (hashN(p.id) % 360) * Math.PI / 180;
    const x = (cx + r * Math.cos(a)).toFixed(1);
    const y = (cy + r * Math.sin(a)).toFixed(1);
    const over = d && !d.snoozed && d.overdue >= 0;
    return `<circle class="p-dot ${over ? 'overdue-dot' : ''}" data-act="openPerson" data-id="${p.id}"
      cx="${x}" cy="${y}" r="${over ? 8.5 : 6.5}" fill="${p.type === 'dating' ? 'var(--dating)' : tierColor(p)}">
      <title>${esc(p.name)}${over ? ` — ${d.overdue}d overdue` : ''}</title></circle>`;
  }).join('');
  const first = (S.settings.profile.firstName || 'You')[0].toUpperCase();
  return `<svg class="constellation" viewBox="0 0 320 320" aria-label="Your circle">
    ${rings}${specks}
    <g class="orbits">${dots}</g>
    <circle class="you-dot" cx="${cx}" cy="${cy}" r="15"/>
    <text class="you-label" x="${cx}" y="${cy + 3.5}" text-anchor="middle">${esc(first)}</text>
  </svg>`;
}

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

VIEWS.today = function renderToday() {
  const due = duePeople();
  const today = todayIso();
  const upcoming = (S.plans || [])
    .filter(pl => pl.status !== 'done' && pl.date >= today && pl.date <= addDays(today, 14))
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const events = (S.events || []).filter(e => !e.date || e.date >= today);
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

  const stats = [
    [act.filter(p => p.tier === 'inner').length, 'inner circle'],
    [act.filter(p => p.tier === 'close').length, 'close'],
    [act.filter(p => p.type === 'dating').length, 'dating'],
    prof.socialBudget ? [`${hangsThisWeek}/${prof.socialBudget}`, 'hangs this week'] : [act.filter(p => p.tier === 'warm').length, 'keep warm'],
  ];

  const bdays = act
    .map(p => ({ p, b: nextBirthdayIso(p.birthday) }))
    .filter(x => x.b && daysBetween(today, x.b) <= 14)
    .sort((a, b) => a.b.localeCompare(b.b));

  const hello = prof.firstName ? `, ${esc(prof.firstName)}` : '';
  const hour = new Date().getHours();

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
            ${streak > 0 ? `<span class="hero-chip">🔥 <b>${streak}</b>-day streak</span>` : ''}
            <button class="hero-chip as-btn" data-act="goReview">🧭 weekly review</button>
          </div>
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
      <span>🧭 <b>${dow === 0 ? "It's Sunday" : 'New week'}</b> — two minutes to review your week and line up the next one.</span>
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
      : `<div class="empty rise"><span class="big">☀️</span>All caught up — nobody is overdue.</div>`}

    <h2>Coming up <span class="sub">next 14 days</span></h2>
    ${upcoming.length
      ? `<div class="plan-list">${upcoming.map((pl, i) => planRow(pl, i)).join('')}</div>`
      : `<div class="empty rise">Nothing planned. Pick someone above and hit <b>Plan</b>, or browse <a href="#ideas">Ideas</a>.</div>`}

    <h2>Happening in New York <span class="sub">curated for your interests</span></h2>
    ${events.length
      ? `<div class="event-list">${events.map((e, i) => `
          <div class="event-row rise" style="--i:${i}">
            <span class="date">${e.date ? fmtDate(e.date) : ''}</span>
            <span>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}${e.venue ? ` <span class="faint">@ ${esc(e.venue)}</span>` : ''}</span>
          </div>`).join('')}</div>`
      : `<div class="empty rise">Your daily agent fills this in each morning — events matched to your interests land here and in your inbox.</div>`}
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
      : `<div class="empty rise"><span class="big">🌱</span>No one here yet. Add people one by one, hit <b>⚡ Triage</b> to paste a list${LOCAL ? ', or <a href="#connect">import your contacts</a>' : ''}.</div>`}
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
  lines.push('', '## Happening in New York');
  const events = (S.events || []).filter(e => !e.date || e.date >= today).slice(0, 12);
  if (!events.length) lines.push('No events loaded yet — the daily agent fills these in.');
  for (const e of events) lines.push(`- ${e.date ? e.date + ' — ' : ''}**${e.title}**${e.venue ? ` @ ${e.venue}` : ''}${e.url ? ` (${e.url})` : ''}`);
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

  const syncCard = connectCard('🔄', 'Sync across devices', 'Mac ⇄ phone ⇄ web, end-to-end encrypted', synced,
    synced
      ? `Your data syncs through a private GitHub gist, encrypted on-device with your passphrase — GitHub only ever sees ciphertext.${lastSyncAt ? ` Last synced ${new Date(lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}`
      : `Use Orbit on your phone and Mac with the same data. Encrypted with a passphrase <b>before</b> it leaves the device — GitHub only stores ciphertext.
        <input id="sync-pass" type="password" placeholder="Choose a sync passphrase" autocomplete="new-password">
        <input id="sync-token" type="password" placeholder="GitHub token with gist scope" autocomplete="off">
        <div style="margin-top:6px"><a href="https://github.com/settings/tokens/new?scopes=gist&description=Orbit%20sync" target="_blank" rel="noopener">Create a token ↗</a> <span class="faint">(classic, “gist” scope only — stays on this device)</span></div>`,
    synced
      ? `<button class="btn" data-act="syncNow">Sync now</button><button class="btn ghost danger" data-act="syncOff">Disconnect</button>`
      : `<button class="btn primary" data-act="syncCreate">Create sync</button><button class="btn ghost" data-act="syncConnect">I already have one</button>`, 2);

  const slackCard = connectCard('💬', 'Slack', 'Digest in your DMs', !!slackHook,
    `Paste an <a href="https://api.slack.com/messaging/webhooks" target="_blank" rel="noopener">incoming webhook URL ↗</a> and the 8am agent posts your digest to Slack too.
     <input id="slack-hook" type="password" placeholder="https://hooks.slack.com/services/…" value="${esc(slackHook)}">`,
    `<button class="btn ${slackHook ? 'ghost' : 'primary'}" data-act="saveSlack">${slackHook ? 'Update' : 'Save'}</button>
     ${slackHook ? '<button class="btn ghost danger" data-act="clearSlack">Remove</button>' : ''}`, 3);

  const gcalCard = connectCard('📅', 'Google Calendar', 'Plans → your calendar', null,
    `Every plan has a <b>GCal ↗</b> button — one click adds it with people, time, and place prefilled. No account linking needed.${LOCAL ? `<br><span class="faint">On this Mac you can also subscribe to the live feed:</span>` : ''}`,
    LOCAL
      ? `<a class="btn" href="webcal://localhost:${c.port}/api/calendar.ics">Subscribe in Apple Calendar</a><a class="btn ghost" href="#plans">See plans</a>`
      : `<a class="btn" href="#plans">See plans</a>`, 4);

  const channelsCard = connectCard('💌', 'Messages · WhatsApp · IG · X', 'One-tap outreach', null,
    `Add a phone number or handle to anyone and channel buttons appear on their cards. Tap one → a ready-to-send draft is copied and the right app opens: <b>iM</b> Messages, <b>WA</b> WhatsApp, <b>IG</b> Instagram DM, <b>𝕏</b> X.`,
    `<a class="btn" href="#people">Add handles to people</a>`, 5);

  let cards;
  if (LOCAL) {
    cards = [
      syncCard,
      connectCard('👥', 'Apple Contacts', 'Import your people in one click', null,
        `Pulls every name from your macOS Contacts straight into Triage so you can sort your real circle. macOS will ask for permission once.`,
        `<button class="btn primary" data-act="importContacts">Import contacts</button>
         <a class="btn ghost" href="#triage">Or paste a list</a>`, 3),
      connectCard('🤖', 'Daily digest agent', 'Runs every morning at 8:00', c.digestTask,
        `Searches NYC events matching your profile, loads them into Orbit, and delivers your digest. <span class="faint">To change the time, just ask Claude.</span>`,
        `<a class="btn ghost" href="#digest">Preview today's digest</a>`, 4),
      connectCard('✉️', 'Email delivery', 'Digest → your inbox', gmail,
        `The agent delivers as a notification until Gmail is connected in Claude:
         <ol><li>Claude desktop → <b>Settings → Connectors</b></li><li>Add <b>Gmail</b> and sign in</li><li>Done — the 8am agent finds it automatically</li></ol>`,
        `<button class="btn ${gmail ? 'ghost' : 'primary'}" data-act="toggleGmail">${gmail ? 'Mark as not connected' : "I've connected Gmail ✓"}</button>`, 5),
      slackCard.replace('--i:3', '--i:6'),
      gcalCard.replace('--i:4', '--i:7'),
      channelsCard.replace('--i:5', '--i:8'),
      connectCard('🌐', 'Orbit on the web', 'Use it anywhere', null,
        `Your app is live at <code>${WEB_URL}</code> — open it on your phone, add it to your home screen, and turn on Sync (above) to share data with this Mac.`,
        `<a class="btn primary" href="${WEB_URL}" target="_blank" rel="noopener">Open web app ↗</a>`, 9),
      connectCard('⚡', 'Always-on', 'Orbit runs itself', c.launchAgent,
        `Starts Orbit at login and keeps it running in the background, so the morning agent and calendar feed always work — no terminal needed.`,
        `<button class="btn ${c.launchAgent ? 'ghost' : 'primary'}" data-act="alwaysOn" data-id="${c.launchAgent ? 'off' : 'on'}">${c.launchAgent ? 'Disable' : 'Enable'}</button>`, 10),
      connectCard('🗂️', 'Your data', 'One JSON file, yours', null,
        `Everything lives in <code>~/orbit/data.json</code> with automatic daily backups. Export any time.`,
        `<button class="btn ghost" data-act="exportJson">Export JSON</button>
         ${S.people.some(p => p.sample) ? `<button class="btn ghost danger" data-act="removeSamples">Remove samples</button>` : ''}`, 11),
    ];
  } else {
    cards = [
      syncCard,
      connectCard('📱', 'Install as an app', 'Home-screen Orbit', null,
        `On iPhone: open this page in Safari → <b>Share</b> → <b>Add to Home Screen</b>. Full-screen, offline-capable, feels native.`,
        `<span class="faint small">Already installed? You're looking at it.</span>`, 3),
      slackCard.replace('--i:3', '--i:4'),
      gcalCard.replace('--i:4', '--i:5'),
      channelsCard.replace('--i:5', '--i:6'),
      connectCard('🤖', 'Daily digest agent', 'Runs on your Mac at 8:00', null,
        `The agent lives on your Mac: it finds NYC events for your profile and delivers your digest by email/Slack. With Sync on, events and updates flow here automatically.`,
        `<a class="btn ghost" href="#digest">Preview the digest</a>`, 7),
      connectCard('🗂️', 'Your data', 'Stored on this device', null,
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
function openPlanDialog({ planId, personId, ideaId, date } = {}) {
  const existing = planId ? S.plans.find(x => x.id === planId) : null;
  const idea = ideaId ? S.ideas.find(i => i.id === ideaId) : null;
  const pl = existing || {
    id: uid(), title: idea ? idea.title : '', personIds: personId ? [personId] : [],
    date: date || addDays(todayIso(), 2), time: '19:00', place: idea ? (idea.hood || '') : '', notes: '', status: 'upcoming',
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

// ---------- ONBOARDING WIZARD ----------
let wiz = null;

function openWizard(startStep = 0) {
  const st = S.settings, prof = st.profile || {};
  wiz = {
    step: startStep, dir: 1,
    data: {
      firstName: prof.firstName || '',
      email: st.email || '',
      neighborhoods: (prof.neighborhoods || []).join(', '),
      interests: [...(st.interests || [])],
      socialBudget: prof.socialBudget || 3,
      nights: [...(prof.nights || ['Thu', 'Fri', 'Sat'])],
      inner: st.tiers.inner, close: st.tiers.close, warm: st.tiers.warm,
      datingCadence: st.datingCadence || 5,
      datingMode: prof.datingMode || 'actively',
      dateStyles: [...(prof.dateStyles || [])],
    },
  };
  renderWizard();
  $('#wizardDialog').showModal();
}

const WIZ_STEPS = [
  {
    title: 'Let’s set you up',
    sub: 'Orbit works better the more it knows about you. Two minutes, five steps.',
    body: d => `
      <div class="form-grid">
        <label class="field">First name<input id="wz-name" value="${esc(d.firstName)}" placeholder="Jesse"></label>
        <label class="field">Digest email<input id="wz-email" value="${esc(d.email)}" placeholder="you@email.com"></label>
        <label class="field full">Your neighborhoods <span style="font-weight:400;text-transform:none">(where you actually hang — biases suggestions)</span>
          <input id="wz-hoods" value="${esc(d.neighborhoods)}" placeholder="Williamsburg, East Village, Fort Greene"></label>
      </div>`,
    collect: d => {
      d.firstName = $('#wz-name').value.trim();
      d.email = $('#wz-email').value.trim();
      d.neighborhoods = $('#wz-hoods').value;
    },
  },
  {
    title: 'What are you into?',
    sub: 'The daily agent hunts NYC events for these, and ideas get matched to people who share them.',
    body: d => `
      <div class="chip-select">
        ${[...new Set([...INTEREST_BANK, ...d.interests])].map(t =>
          `<button class="pick ${d.interests.includes(t) ? 'on' : ''}" data-pick="interests" data-val="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>
      <div class="wiz-row">
        <input id="wz-custom" class="grow" placeholder="Add your own…">
        <button class="btn" id="wz-custom-add">Add</button>
      </div>`,
    collect: () => {},
  },
  {
    title: 'Your social rhythm',
    sub: 'How much time do you actually want to spend? Orbit paces everything to this.',
    body: d => `
      <label class="field">Hangs / dates per week</label>
      <div class="wiz-row">
        <input type="range" id="wz-budget" class="grow" min="1" max="7" value="${d.socialBudget}"
          oninput="document.getElementById('wz-budget-val').textContent=this.value">
        <div class="slider-val" id="wz-budget-val">${d.socialBudget}</div>
      </div>
      <label class="field" style="margin-top:8px">Nights you like going out</label>
      <div class="chip-select" style="margin-top:6px">
        ${NIGHTS.map(n => `<button class="pick ${d.nights.includes(n) ? 'on' : ''}" data-pick="nights" data-val="${n}">${n}</button>`).join('')}
      </div>
      <label class="field" style="margin-top:16px">Follow-up cadence (days between touches)</label>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr;margin-top:6px">
        <label class="field">Inner<input type="number" id="wz-inner" value="${d.inner}" min="1"></label>
        <label class="field">Close<input type="number" id="wz-close" value="${d.close}" min="1"></label>
        <label class="field">Warm<input type="number" id="wz-warm" value="${d.warm}" min="1"></label>
        <label class="field">Dating<input type="number" id="wz-dating" value="${d.datingCadence}" min="1"></label>
      </div>`,
    collect: d => {
      d.socialBudget = +$('#wz-budget').value;
      d.inner = +$('#wz-inner').value || 7;
      d.close = +$('#wz-close').value || 21;
      d.warm = +$('#wz-warm').value || 60;
      d.datingCadence = +$('#wz-dating').value || 5;
    },
  },
  {
    title: 'Dating mode',
    sub: 'So the pipeline pushes exactly as hard as you want it to.',
    body: d => `
      <div class="radio-cards">
        ${[['actively', '🔥', 'Actively looking', 'prioritize dates, fast follow-ups'],
           ['casually', '🌗', 'Casually dating', 'open, not chasing'],
           ['paused', '😌', 'Paused', 'focus on friends for now']].map(([v, e, b, s]) =>
          `<div class="rc ${d.datingMode === v ? 'on' : ''}" data-pick-one="datingMode" data-val="${v}"><span class="e">${e}</span><b>${b}</b>${s}</div>`).join('')}
      </div>
      <label class="field" style="margin-top:16px">Date styles you actually enjoy</label>
      <div class="chip-select" style="margin-top:6px">
        ${DATE_STYLES.map(t => `<button class="pick ${d.dateStyles.includes(t) ? 'on' : ''}" data-pick="dateStyles" data-val="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>`,
    collect: () => {},
  },
  {
    title: 'Wire it up',
    sub: 'The finishing touches that make Orbit run itself — all one click, all in the Connect tab.',
    body: () => `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="card" style="display:flex;gap:12px;align-items:center"><span style="font-size:20px">🔄</span><div style="flex:1"><b>Sync across devices</b><div class="small muted">encrypted — phone ⇄ Mac ⇄ web</div></div></div>
        <div class="card" style="display:flex;gap:12px;align-items:center"><span style="font-size:20px">💌</span><div style="flex:1"><b>Add handles to your people</b><div class="small muted">one-tap drafts into Messages, WhatsApp, IG, X</div></div></div>
        <div class="card" style="display:flex;gap:12px;align-items:center"><span style="font-size:20px">📅</span><div style="flex:1"><b>GCal buttons on every plan</b><div class="small muted">one click to your Google Calendar</div></div></div>
        <div class="card" style="display:flex;gap:12px;align-items:center"><span style="font-size:20px">💬</span><div style="flex:1"><b>Slack webhook</b><div class="small muted">digest in your DMs every morning</div></div></div>
      </div>
      <p class="small faint" style="margin-top:14px">Finish takes you to Connect to knock these out.</p>`,
    collect: () => {},
  },
];

function renderWizard() {
  const step = WIZ_STEPS[wiz.step];
  const last = wiz.step === WIZ_STEPS.length - 1;
  const dlg = $('#wizardDialog');
  dlg.innerHTML = `
    <div class="wiz-dots">${WIZ_STEPS.map((_, i) => `<span class="dot ${i <= wiz.step ? 'on' : ''}"></span>`).join('')}</div>
    <div class="wiz-step ${wiz.dir < 0 ? 'back' : ''}">
      <div class="wiz-title">${step.title}</div>
      <div class="wiz-sub">${step.sub}</div>
      ${step.body(wiz.data)}
    </div>
    <div class="dialog-actions">
      ${wiz.step > 0 ? `<button class="btn ghost" id="wz-back">← Back</button>` : `<button class="btn ghost" id="wz-skip">Later</button>`}
      <span class="spacer"></span>
      <button class="btn accent big" id="wz-next">${last ? 'Finish ✦' : 'Next →'}</button>
    </div>
  `;

  dlg.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    const arr = wiz.data[b.dataset.pick];
    const v = b.dataset.val;
    const i = arr.indexOf(v);
    i >= 0 ? arr.splice(i, 1) : arr.push(v);
    b.classList.toggle('on');
  }));
  dlg.querySelectorAll('[data-pick-one]').forEach(b => b.addEventListener('click', () => {
    wiz.data[b.dataset.pickOne] = b.dataset.val;
    dlg.querySelectorAll(`[data-pick-one="${b.dataset.pickOne}"]`).forEach(x => x.classList.toggle('on', x === b));
  }));
  $('#wz-custom-add')?.addEventListener('click', () => {
    const v = $('#wz-custom').value.trim().toLowerCase();
    if (v && !wiz.data.interests.includes(v)) { wiz.data.interests.push(v); renderWizard(); }
  });
  $('#wz-custom')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('#wz-custom-add').click(); }
  });

  $('#wz-back')?.addEventListener('click', () => { step.collect(wiz.data); wiz.dir = -1; wiz.step--; renderWizard(); });
  $('#wz-skip')?.addEventListener('click', () => {
    S.settings.profile.completed = true;
    persist();
    dlg.close();
  });
  $('#wz-next').addEventListener('click', () => {
    step.collect(wiz.data);
    if (!last) { wiz.dir = 1; wiz.step++; renderWizard(); return; }
    finishWizard();
    dlg.close();
  });
}

function finishWizard() {
  const d = wiz.data;
  S.settings.email = d.email;
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
    completedAt: todayIso(),
  };
  persist();
  confetti(36);
  toast(d.firstName ? `You're set, ${d.firstName} ✦` : "You're set ✦");
  location.hash = '#connect';
  render();
}

// ---------- COMMAND PALETTE ----------
let palSel = 0;
function paletteItems(q) {
  const items = [];
  const add = (icon, label, hint, fn) => items.push({ icon, label, hint, fn });
  if (!q) {
    duePeople().slice(0, 3).forEach(({ p, d }) =>
      add(initials(p.name), `Reach out: ${p.name}`, `${d.overdue}d overdue`, () => openPersonDialog(p.id)));
  }
  add('＋', 'Add person', 'People', () => openPersonDialog(null));
  add('💘', 'Add dating prospect', 'Dating', () => openPersonDialog(null, { type: 'dating', tier: 'inner' }));
  add('🗓', 'New plan', 'Plans', () => openPlanDialog({}));
  add('✨', 'Add idea', 'Ideas', () => openIdeaDialog(null));
  add('⚡', 'Triage contacts', 'People', () => location.hash = '#triage');
  add('🧭', 'Weekly review', 'Ritual', () => location.hash = '#review');
  add('◐', 'Toggle dark mode', 'Theme', toggleTheme);
  add('✦', 'Profile & settings', 'Setup', () => openWizard());
  if (syncCfg?.gistId) add('🔄', 'Sync now', 'Sync', () => { pushSync(); toast('Syncing…'); });
  ['today', 'people', 'dating', 'ideas', 'plans', 'digest', 'connect'].forEach(v =>
    add('▸', `Go to ${v[0].toUpperCase() + v.slice(1)}`, 'Navigate', () => location.hash = '#' + v));
  activePeople().forEach(p =>
    add(initials(p.name), p.name, TIER_LABEL[p.tier], () => openPersonDialog(p.id)));
  S.ideas.forEach(i =>
    add('💡', `Plan: ${i.title}`, i.hood || 'Idea', () => openPlanDialog({ ideaId: i.id })));

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
      <a href="#plans" data-close><span class="si">🗓</span>Plans</a>
      <a href="#review" data-close><span class="si">🧭</span>Weekly review</a>
      <a href="#digest" data-close><span class="si">📰</span>Digest</a>
      <a href="#connect" data-close><span class="si">🔌</span>Connect</a>
      <button data-run="wizard"><span class="si">✦</span>Profile & settings</button>
      <button data-run="theme"><span class="si">◐</span>Toggle theme</button>
      ${syncCfg?.gistId ? '<button data-run="sync"><span class="si">🔄</span>Sync now</button>' : ''}
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

$('#settingsBtn').addEventListener('click', () => openWizard());
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
  render();
  if (!S.settings.profile.completed) setTimeout(() => openWizard(), 600);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
