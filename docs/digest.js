// Orbit digest — the morning email.
//
// One module, two editions, shared by server.js (Node, for the 8am agent) and
// the PWA (for the in-app preview):
//
//   owner — yours. Who to reach out to today, with one concrete move each,
//           what's on your calendar, and the handful of things this week that
//           are actually worth leaving the house for.
//   guest — a city edition for friends you forward Orbit to. The same curated
//           picks and nothing else: never your people, your dating pipeline,
//           or your plans.
//
// buildDigest() turns state into a plain model; renderEmail() turns a model
// into { subject, preheader, html, text }. The HTML is table-based with inline
// styles so it holds up in Gmail, Apple Mail, and Outlook.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrbitDigest = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_APP_URL = 'https://getorbit.pages.dev';
  const MAX_FOCUS = 3;      // people cards in the owner edition
  const MAX_PICKS = 5;      // events worth leaving the house for
  const MAX_SPOTS = 3;      // restaurants / venues
  const HORIZON_DAYS = 7;

  // ---------- dates ----------
  const localISO = (d = new Date()) => d.toLocaleDateString('en-CA');
  const at = iso => new Date(iso + 'T12:00:00');
  function addDays(iso, n) { const d = at(iso); d.setDate(d.getDate() + n); return localISO(d); }
  const daysBetween = (a, b) => Math.round((at(b) - at(a)) / 86400000);
  const weekday = (iso, style = 'long') => at(iso).toLocaleDateString('en-US', { weekday: style });

  function dayLabel(iso, today) {
    const n = daysBetween(today, iso);
    if (n <= 0) return 'Tonight';
    if (n === 1) return 'Tomorrow';
    if (n < 7) return weekday(iso);
    return at(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const longDate = iso => at(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  function fmtTime(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
    if (!m) return t || '';
    const h = +m[1];
    return `${h % 12 || 12}${m[2] === '00' ? '' : ':' + m[2]}${h < 12 ? 'am' : 'pm'}`;
  }

  // ---------- text ----------
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';
  function clip(s, n) {
    s = String(s || '').trim();
    return s.length <= n ? s : s.slice(0, n - 1).replace(/[\s,.;:—–-]+\S*$/, '') + '…';
  }
  // "Venue (362 Grand St)" and "Venue (201 Allen St)" are the same place for
  // the purpose of not recommending it three times.
  const venueKey = v => norm(String(v || '').replace(/\(.*?\)/g, ''));
  function listNames(names) {
    if (names.length <= 1) return names.join('');
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
  }
  const NUM = ['Nobody', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  const countWord = n => NUM[n] || String(n);
  // "Atlantic Antic — Brooklyn's oldest street festival" → "Atlantic Antic"
  const shortTitle = t => String(t || '').split(/\s+[—–:|]\s+|\s+\(/)[0].trim();
  const isUrl = s => /^https?:\/\//i.test(String(s || ''));

  // ---------- people ----------
  const TIER_LABEL = { inner: 'Inner circle', close: 'Close', warm: 'Keep warm' };
  const tierWeight = p => p.type === 'dating' ? 3 : ({ inner: 3, close: 2, warm: 1 }[p.tier] || 1);
  const isActive = p => p.tier !== 'archived' && p.tier !== 'unsorted';

  // The log is the record; lastContact is a cache of it. Imports and triage
  // stamp lastContact with the day they ran, so trusting it alone makes
  // anyone with imported history look like you talked today. Only a
  // lastContact newer than the log and not just the creation stamp (a manual
  // edit in the person form) overrides it.
  function lastTouch(p) {
    let logged = null;
    for (const l of p.log || []) if (l && l.date && (!logged || l.date > logged)) logged = l.date;
    if (!logged) return p.lastContact || null;
    if (p.lastContact && p.lastContact > logged && p.lastContact !== p.createdAt) return p.lastContact;
    return logged;
  }

  function cadenceFor(p, settings) {
    if (p.type === 'dating' && p.stage && p.stage !== 'ended') return settings.datingCadence || 5;
    return (settings.tiers || {})[p.tier] || null;
  }

  function nextBirthday(bday, today) {
    if (!/^\d{2}-\d{2}$/.test(bday || '')) return null;
    const iso = `${today.slice(0, 4)}-${bday}`;
    return iso >= today ? iso : `${+today.slice(0, 4) + 1}-${bday}`;
  }

  function suggestIdea(p, ideas, city) {
    const want = p.type === 'dating' ? ['date', 'either'] : ['friends', 'either'];
    const pool = (ideas || []).filter(i => want.includes(i.best) && (!i.city || !city || i.city === city));
    const shared = pool.filter(i => (i.tags || []).some(t => (p.interests || []).includes(t)));
    const list = shared.length ? shared : pool;
    return list.find(i => i.favorite) || list[0] || null;
  }

  // ---------- taste ----------
  function makeTaste({ interests, weights, hoods, nights, flags }) {
    return {
      interests: new Set((interests || []).map(norm)),
      weights: weights || {},
      hoods: (hoods || []).map(norm).filter(Boolean),
      nights: nights || [],
      flags: !!flags,
    };
  }

  function tagScore(tags, taste) {
    let s = 0;
    for (const t of tags || []) {
      const k = norm(t);
      const w = taste.weights[k] != null ? taste.weights[k] : 1;
      s += (taste.interests.size ? (taste.interests.has(k) ? 1 : 0.2) : 0.5) * w;
    }
    return s;
  }

  function hoodMatch(hood, taste) {
    const h = norm(hood);
    return h && taste.hoods.some(m => h.includes(m) || m.includes(h)) ? 1 : 0;
  }

  function buzz(v, today) {
    const cutoff = addDays(today, -30);
    return new Set((v.sources || []).filter(s => (s.date || today) >= cutoff).map(s => norm(s.name))).size;
  }

  function scoreEvent(e, taste) {
    return tagScore(e.tags, taste)
      + hoodMatch(e.neighborhood || e.venue, taste)
      + (e.date && (taste.nights.length ? taste.nights : ['Fri', 'Sat']).includes(weekday(e.date, 'short')) ? 0.5 : 0)
      + (e.endDate && e.endDate > (e.date || '') ? 0.3 : 0)
      + Math.min((e.sources || []).length, 3) * 0.3
      + (taste.flags && e.status === 'saved' ? 2 : 0);
  }

  function scoreVenue(v, taste, today) {
    return tagScore(v.tags, taste)
      + hoodMatch(v.hood, taste)
      + Math.min(buzz(v, today), 4) * 0.5
      + ({ 'opening-soon': 0.75, new: 0.75, hot: 0.5 }[v.status] || 0)
      + (v.availability ? 0.5 : 0)
      + (taste.flags && v.flag === 'saved' ? 2 : 0);
  }

  // ---------- picks ----------
  // A short list beats a long one: rank, drop repeats of the same venue, then
  // present in calendar order so the reader can see their week at a glance.
  function pickEvents(state, taste, today, max) {
    const horizon = addDays(today, HORIZON_DAYS);
    const live = (state.events || []).filter(e =>
      e && e.title && e.status !== 'dismissed'
      && (e.endDate || e.date || today) >= today
      && (!e.date || e.date <= horizon));
    const ranked = live
      .map(e => ({ e, s: scoreEvent(e, taste) }))
      .sort((a, b) => b.s - a.s || String(a.e.date).localeCompare(String(b.e.date)));
    const seenVenue = new Set();
    const seenTitle = new Set();
    const perDay = {};
    const out = [];
    for (const { e } of ranked) {
      const vk = venueKey(e.venue);
      const tk = norm(e.title).split(' ').slice(0, 4).join(' ');
      const dk = e.date && e.date > today ? e.date : today;
      if ((vk && seenVenue.has(vk)) || seenTitle.has(tk) || (perDay[dk] || 0) >= 2) continue;
      perDay[dk] = (perDay[dk] || 0) + 1;
      if (vk) seenVenue.add(vk);
      seenTitle.add(tk);
      out.push({ e, rank: out.length });
      if (out.length >= max) break;
    }
    return out
      .map(({ e, rank }) => {
        // Multi-day things that already started read as "on now" rather than
        // pretending they happen on a single past date.
        const date = e.date && e.date < today ? today : (e.date || null);
        return {
          rank,
          title: e.title,
          short: shortTitle(e.title),
          date,
          day: date ? dayLabel(date, today) : 'This week',
          time: fmtTime(e.startTime || e.time || ''),
          until: e.endDate && e.endDate > (date || today) ? dayLabel(e.endDate, today) : null,
          venue: e.venue ? String(e.venue).replace(/\s*\(.*?\)\s*/g, ' ').trim() : '',
          hood: e.neighborhood && norm(e.neighborhood) !== norm(e.venue) ? e.neighborhood : '',
          price: e.price || '',
          why: e.why || '',
          tags: e.tags || [],
          url: isUrl(e.url) ? e.url : null,
        };
      })
      .sort((a, b) => String(a.date || '9').localeCompare(String(b.date || '9')));
  }

  function pickSpots(state, taste, today, max) {
    const recent = addDays(today, -60);
    return (state.venues || [])
      .filter(v => v && v.name && v.flag !== 'dismissed'
        && (['opening-soon', 'new', 'hot'].includes(v.status) || v.availability)
        && !(v.visited || []).some(d => d >= recent))
      .map(v => ({ v, s: scoreVenue(v, taste, today) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, max)
      .map(({ v }) => ({
        name: v.name,
        hood: v.hood || '',
        kind: v.kind || '',
        status: v.status === 'opening-soon' ? 'Opening soon' : v.status === 'new' ? 'New' : v.status === 'hot' ? 'Hot' : '',
        note: clip(v.notes || '', 120),
        availability: v.availability || '',
        buzz: buzz(v, today),
        url: isUrl(v.bookVia) ? v.bookVia : isUrl(v.url) ? v.url : null,
        bookLabel: isUrl(v.bookVia) || v.availability ? 'Book' : 'Details',
      }));
  }

  // ---------- model ----------
  function buildDigest(state, opts = {}) {
    const today = opts.today || localISO();
    const settings = state.settings || {};
    const profile = settings.profile || {};
    const city = settings.city || 'New York';
    const appUrl = String(settings.appUrl || opts.appUrl || DEFAULT_APP_URL).replace(/\/+$/, '');
    const owner = { name: profile.firstName || '', email: settings.email || null };
    const guest = opts.edition === 'guest' ? (opts.guest || {}) : null;

    if (guest) {
      // Only city-level signal here. Jesse's saves and taste weights say
      // nothing about what Izzy wants to do on a Friday.
      const taste = makeTaste({ interests: guest.interests, hoods: guest.neighborhoods });
      return {
        edition: 'guest',
        date: today,
        city,
        appUrl,
        owner,
        recipient: { name: guest.name || '', email: guest.email || null },
        picks: pickEvents(state, taste, today, MAX_PICKS + 1),
        spots: pickSpots(state, taste, today, MAX_SPOTS),
      };
    }

    const taste = makeTaste({
      interests: settings.interests,
      weights: settings.tasteWeights,
      hoods: profile.neighborhoods,
      nights: profile.nights,
      flags: true,
    });
    const picks = pickEvents(state, taste, today, MAX_PICKS);

    // Everyone who's due, ranked by how much it matters, not just how late.
    const people = (state.people || []).filter(isActive);
    // Someone you already have a plan with this week isn't someone to nag about.
    const planned = new Set((state.plans || [])
      .filter(pl => pl.status !== 'done' && pl.date >= today && pl.date <= addDays(today, HORIZON_DAYS))
      .flatMap(pl => pl.personIds || []));
    const due = [];
    for (const p of people) {
      if (p.snoozedUntil && p.snoozedUntil > today) continue;
      if (planned.has(p.id)) continue;
      const cadence = cadenceFor(p, settings);
      if (!cadence) continue;
      const last = lastTouch(p) || p.createdAt || today;
      const overdue = daysBetween(addDays(last, cadence), today);
      if (overdue < 0) continue;
      due.push({ p, last: lastTouch(p), quiet: daysBetween(last, today), overdue });
    }
    due.sort((a, b) => (b.overdue + 7) * tierWeight(b.p) - (a.overdue + 7) * tierWeight(a.p));

    // Pair people with a real thing on the calendar when their interests line
    // up — "invite Devon to the Flop House Friday" beats "reach out to Devon".
    const bdayIn = p => {
      const d = nextBirthday(p.birthday, today);
      return d ? daysBetween(today, d) : Infinity;
    };
    // A birthday in the next two days jumps the queue, due or not.
    for (const p of people) {
      if (bdayIn(p) > 2) continue;
      const i = due.findIndex(x => x.p === p);
      const entry = i >= 0 ? due.splice(i, 1)[0] : { p, last: lastTouch(p), quiet: daysBetween(lastTouch(p) || today, today) };
      due.unshift(entry);
    }

    const pairedEvent = new Set();
    function matchEvent(p) {
      const want = new Set((p.interests || []).map(norm));
      if (!want.size) return null;
      let best = null;
      for (const ev of picks) {
        if (pairedEvent.has(ev) || !ev.date || ev.date === today) continue;
        const hits = ev.tags.filter(t => want.has(norm(t))).length;
        if (hits && (!best || hits > best.hits)) best = { ev, hits };
      }
      if (best) pairedEvent.add(best.ev);
      return best && best.ev;
    }

    const focus = due.slice(0, MAX_FOCUS).map(({ p, last, quiet }) => {
      const thread = (p.threads || []).find(t => !t.done);
      const ev = !thread && !p.nextStep && bdayIn(p) > 2 ? matchEvent(p) : null;
      const idea = !thread && !p.nextStep && !ev ? suggestIdea(p, state.ideas, settings.city) : null;
      let move = null;
      const bd = bdayIn(p);
      if (bd <= 2) move = { kind: 'birthday', text: `Birthday ${bd === 0 ? 'today' : bd === 1 ? 'tomorrow' : 'in two days'} — ${bd === 0 ? 'call, don’t text' : 'line something up now'}` };
      else if (thread) move = { kind: 'thread', text: thread.text };
      else if (p.nextStep) move = { kind: 'next', text: p.nextStep };
      else if (ev) move = { kind: 'event', text: `Invite to ${ev.short}`, day: ev.day, url: ev.url };
      else if (idea) move = { kind: 'idea', text: idea.title + (idea.hood ? ` in ${idea.hood}` : '') };
      const h = p.handles || {};
      const phone = String(h.phone || '').replace(/[^\d+]/g, '');
      return {
        name: p.name,
        first: firstName(p.name),
        label: p.type === 'dating' ? `Dating · ${p.stage || 'new'}` : (TIER_LABEL[p.tier] || p.tier || ''),
        tier: p.type === 'dating' ? 'dating' : p.tier,
        quiet: last ? quiet : null,
        move,
        action: phone
          ? { label: `Text ${firstName(p.name)}`, url: `sms:${phone}` }
          : h.instagram
            ? { label: 'Message on Instagram', url: `https://ig.me/m/${String(h.instagram).replace(/^@/, '')}` }
            : { label: 'Open in Orbit', url: `${appUrl}/#people` },
      };
    });
    const alsoDue = due.slice(MAX_FOCUS).map(x => firstName(x.p.name));

    const birthdays = people
      .map(p => ({ name: p.name, date: nextBirthday(p.birthday, today) }))
      .filter(b => b.date && daysBetween(today, b.date) <= HORIZON_DAYS)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(b => ({ ...b, day: dayLabel(b.date, today), inDays: daysBetween(today, b.date) }));

    const horizon = addDays(today, HORIZON_DAYS);
    const plans = (state.plans || [])
      .filter(pl => pl.status !== 'done' && pl.date >= today && pl.date <= horizon)
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
      .map(pl => ({
        title: pl.title,
        date: pl.date,
        day: dayLabel(pl.date, today),
        time: fmtTime(pl.time),
        place: pl.place || '',
        people: (pl.personIds || []).map(id => (people.find(p => p.id === id) || {}).name).filter(Boolean).map(firstName),
      }));

    return {
      edition: 'owner',
      date: today,
      city,
      appUrl,
      owner,
      dueCount: due.length,
      focus,
      alsoDue,
      birthdays,
      plans,
      picks,
      spots: pickSpots(state, taste, today, MAX_SPOTS),
    };
  }

  // ---------- copy ----------
  function headline(m) {
    if (m.edition === 'guest') {
      return {
        title: `This week in ${m.city}`,
        lede: `${m.recipient.name ? `Hi ${m.recipient.name} — here` : 'Here'}${m.picks.length > 1 ? ` are ${countWord(m.picks.length).toLowerCase()} things` : '’s what’s'} worth leaving the house for, pulled from the city’s best listings and newsletters.`,
      };
    }
    const hello = m.owner.name ? `Morning, ${m.owner.name}.` : 'Good morning.';
    const bday = m.birthdays.find(b => b.inDays <= 1);
    if (bday) {
      return { title: hello, lede: `${firstName(bday.name)}'s birthday is ${bday.inDays === 0 ? 'today' : 'tomorrow'}. Start there.` };
    }
    if (!m.dueCount) {
      const more = m.picks.length || m.spots.length;
      return { title: hello, lede: `Everyone is in orbit${m.plans.length ? ', and your week has plans in it' : ''}.${more ? ` Here’s what${m.plans.length ? ' else' : ''} is worth doing this week.` : ' Nothing else needs you today.'}` };
    }
    if (m.dueCount <= MAX_FOCUS) {
      return { title: hello, lede: `${listNames(m.focus.map(f => f.first))} ${m.dueCount === 1 ? 'is' : 'are'} due for a hello. One message each and you’re clear.` };
    }
    return { title: hello, lede: `${countWord(m.dueCount)} people are waiting to hear from you. Start with these ${countWord(MAX_FOCUS).toLowerCase()} — they matter most.` };
  }

  function subjectFor(m) {
    const byRank = m.picks.slice().sort((a, b) => a.rank - b.rank);
    const top = byRank[0];
    const when = p => p.day === 'Tonight' ? 'tonight' : p.day === 'Tomorrow' ? 'tomorrow' : /^\w+day$/.test(p.day) ? `on ${p.day}` : p.day;
    if (m.edition === 'guest') {
      if (!top) return `This week in ${m.city}`;
      const two = byRank.slice(0, 2).map(p => clip(p.short, 30));
      return `This week in ${m.city}: ${two.join(', ')}${m.picks.length > 2 ? ` + ${m.picks.length - 2} more` : ''}`;
    }
    const bday = m.birthdays.find(b => b.inDays <= 1);
    if (bday) return `${firstName(bday.name)}’s birthday is ${bday.inDays === 0 ? 'today' : 'tomorrow'} 🎂`;
    if (m.focus.length) {
      const lead = `Reach out to ${listNames(m.focus.slice(0, 2).map(x => x.first))}`;
      return top ? `${lead} · ${clip(top.short, 32)} ${when(top)}` : lead;
    }
    return top ? `${clip(top.short, 40)} ${when(top)}, and ${m.picks.length - 1} more for your week` : `Your Orbit — ${longDate(m.date)}`;
  }

  function preheaderFor(m) {
    if (m.edition === 'guest') return m.picks.slice(0, 3).map(p => `${p.day}: ${clip(p.short, 36)}`).join(' · ');
    const bits = [];
    if (m.focus.length) bits.push(m.focus.map(f => f.first).join(', '));
    if (m.plans.length) bits.push(`${m.plans.length} plan${m.plans.length > 1 ? 's' : ''} this week`);
    if (m.picks.length) bits.push(`${m.picks.length} picks for ${m.city}`);
    return bits.join(' · ');
  }

  // ---------- HTML ----------
  // Palette: Orbit's "Dawn" theme for the body, a Deep Field band up top.
  const C = {
    page: '#F3F2F8', card: '#FFFFFF', ink: '#15142A', ink2: '#56556F', ink3: '#8C8BA3',
    line: '#E8E6F1', soft: '#F7F6FB', accent: '#5B3FD0', accentSoft: '#EFEBFD',
    night: '#0F0D22', night2: '#1C1840', nightInk: '#F4F2FF', nightInk2: '#B7B2D9',
    inner: '#B7790A', close: '#0B7F8E', warm: '#4F5FCB', dating: '#C4337A', ok: '#10825A',
  };
  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const SERIF = "'Instrument Serif','Iowan Old Style','New York',Georgia,'Times New Roman',serif";

  function button(label, url, { primary = false, small = false } = {}) {
    const bg = primary ? C.accent : C.card;
    const fg = primary ? '#FFFFFF' : C.accent;
    const border = primary ? C.accent : '#D9D3F5';
    const pad = small ? '8px 14px' : '12px 22px';
    return `<a href="${esc(url)}" class="${primary ? 'btn-primary' : 'btn'}" style="display:inline-block;background:${bg};color:${fg};border:1px solid ${border};border-radius:999px;padding:${pad};font:600 ${small ? 13 : 15}px/1.2 ${SANS};text-decoration:none;white-space:nowrap">${esc(label)}</a>`;
  }

  function sectionTitle(text, aside) {
    return `<tr><td class="px" style="padding:36px 36px 14px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td class="ink3" style="font:700 11px/1 ${SANS};letter-spacing:1.6px;text-transform:uppercase;color:${C.ink3}">${esc(text)}</td>
        ${aside ? `<td align="right" style="font:500 13px/1 ${SANS}">${aside}</td>` : ''}
      </tr></table>
    </td></tr>`;
  }

  function personCard(f) {
    const dot = C[f.tier] || C.accent;
    const quiet = f.quiet == null ? 'No contact logged yet' : f.quiet === 0 ? 'Talked today' : `${f.quiet} day${f.quiet === 1 ? '' : 's'} since you talked`;
    let move = '';
    if (f.move) {
      const icon = { thread: '💬', next: '→', event: '✦', idea: '✦', birthday: '🎂' }[f.move.kind];
      const text = f.move.kind === 'event'
        ? `${f.move.url ? `<a href="${esc(f.move.url)}" style="color:${C.ink};text-decoration:underline;text-decoration-color:#CFC6F5" class="ink">${esc(f.move.text)}</a>` : esc(f.move.text)}${f.move.day ? ` <span class="ink3" style="color:${C.ink3}">· ${esc(f.move.day)}</span>` : ''}`
        : f.move.kind === 'idea' ? `Idea: ${esc(f.move.text)}` : esc(f.move.text);
      move = `<tr><td colspan="2" style="padding-top:12px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td class="soft" style="background:${C.soft};border-radius:12px;padding:12px 14px;font:400 15px/1.45 ${SANS};color:${C.ink}"><span class="accent" style="color:${C.accent};font-weight:700">${icon}</span>&nbsp; ${text}</td>
        </tr></table>
      </td></tr>`;
    }
    return `<tr><td class="px" style="padding:0 36px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="card" style="border:1px solid ${C.line};border-radius:18px;background:${C.card}">
        <tr><td style="padding:18px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td valign="top">
                <div class="ink" style="font:600 18px/1.25 ${SANS};color:${C.ink}">${esc(f.name)}</div>
                <div style="font:500 13px/1.4 ${SANS};color:${C.ink3};padding-top:4px"><span style="color:${dot}">●</span>&nbsp;${esc(f.label)}<span class="ink3"> · ${esc(quiet)}</span></div>
              </td>
              <td valign="top" align="right" class="hide-sm" style="padding-left:12px">${button(f.action.label, f.action.url, { small: true })}</td>
            </tr>
            ${move}
            <tr class="show-sm" style="display:none;max-height:0;overflow:hidden"><td colspan="2" style="padding-top:12px">${button(f.action.label, f.action.url, { small: true })}</td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>`;
  }

  function pickRows(picks) {
    let html = '';
    let lastDay = null;
    picks.forEach((p, i) => {
      const newDay = p.day !== lastDay;
      lastDay = p.day;
      const meta = [p.time, p.venue, p.hood].filter(Boolean).join(' · ');
      const extra = [p.until ? `through ${p.until}` : '', p.price && !/^\$+$/.test(p.price) ? p.price : ''].filter(Boolean).join(' · ');
      const title = p.url
        ? `<a href="${esc(p.url)}" class="ink" style="color:${C.ink};text-decoration:none">${esc(p.title)}</a>`
        : esc(p.title);
      html += `<tr><td class="px" style="padding:0 36px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${i ? `border-top:1px solid ${C.line}` : ''}" class="rule">
          <tr>
            <td valign="top" width="92" class="day-col${newDay ? ' accent' : ''}" style="padding:16px 12px 16px 0;font:700 12px/1.5 ${SANS};letter-spacing:.4px;text-transform:uppercase;color:${newDay ? C.accent : 'transparent'}">${newDay ? esc(p.day) : '&nbsp;'}</td>
            <td valign="top" style="padding:14px 0">
              <div style="font:600 16px/1.35 ${SANS};color:${C.ink}" class="ink">${title}</div>
              ${meta ? `<div class="ink2" style="font:400 14px/1.45 ${SANS};color:${C.ink2};padding-top:3px">${esc(meta)}</div>` : ''}
              ${extra ? `<div class="ink3" style="font:400 13px/1.4 ${SANS};color:${C.ink3};padding-top:2px">${esc(extra)}</div>` : ''}
            </td>
            ${p.url ? `<td valign="top" align="right" width="28" style="padding:15px 0 0 8px;font:600 16px/1 ${SANS}"><a href="${esc(p.url)}" class="accent" style="color:${C.accent};text-decoration:none">→</a></td>` : ''}
          </tr>
        </table>
      </td></tr>`;
    });
    return html;
  }

  function spotRows(spots) {
    return spots.map((s, i) => {
      const meta = [s.hood, s.buzz > 1 ? `${s.buzz} sources this month` : ''].filter(Boolean).join(' · ');
      return `<tr><td class="px" style="padding:0 36px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${i ? `border-top:1px solid ${C.line}` : ''}" class="rule">
          <tr>
            <td valign="top" style="padding:14px 0">
              <div style="font:600 16px/1.35 ${SANS};color:${C.ink}" class="ink">${esc(s.name)}${s.status ? ` &nbsp;<span class="pill" style="display:inline-block;vertical-align:2px;background:${C.accentSoft};color:${C.accent};border-radius:999px;padding:3px 8px;font:700 10px/1 ${SANS};letter-spacing:.6px;text-transform:uppercase">${esc(s.status)}</span>` : ''}</div>
              ${meta ? `<div class="ink2" style="font:400 14px/1.45 ${SANS};color:${C.ink2};padding-top:3px">${esc(meta)}</div>` : ''}
              ${s.note ? `<div class="ink2" style="font:400 14px/1.5 ${SANS};color:${C.ink2};padding-top:4px">${esc(s.note)}</div>` : ''}
              ${s.availability ? `<div style="font:600 13px/1.4 ${SANS};color:${C.ok};padding-top:6px">● ${esc(s.availability)}</div>` : ''}
            </td>
            ${s.url ? `<td valign="top" align="right" style="padding:14px 0 0 12px">${button(s.bookLabel, s.url, { small: true })}</td>` : ''}
          </tr>
        </table>
      </td></tr>`;
    }).join('');
  }

  function renderHtml(m, subject, preheader) {
    const h = headline(m);
    const rows = [];

    if (m.edition === 'owner') {
      const inFocus = new Set(m.focus.map(f => f.name));
      const bdays = m.birthdays.filter(b => !inFocus.has(b.name));
      if (bdays.length) {
        rows.push(`<tr><td class="px" style="padding:28px 36px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="background:#FFF6E5;border:1px solid #F4DFB5;border-radius:14px;padding:14px 18px;font:500 15px/1.45 ${SANS};color:#6B4A06">🎂&nbsp; ${bdays.map(b => `<b>${esc(firstName(b.name))}</b> ${b.inDays === 0 ? 'today' : b.inDays === 1 ? 'tomorrow' : esc(b.day)}`).join(' &nbsp;·&nbsp; ')}</td>
          </tr></table>
        </td></tr>`);
      }
      if (m.focus.length) {
        rows.push(sectionTitle('Reach out today'));
        rows.push(m.focus.map(personCard).join(''));
        if (m.alsoDue.length) {
          rows.push(`<tr><td class="px ink2" style="padding:4px 36px 0;font:400 14px/1.5 ${SANS};color:${C.ink2}">Also waiting: ${esc(listNames(m.alsoDue))}. <a href="${esc(m.appUrl)}/#people" class="accent" style="color:${C.accent};text-decoration:none;font-weight:600">See everyone →</a></td></tr>`);
        }
      }
      if (m.plans.length) {
        rows.push(sectionTitle('On your calendar'));
        rows.push(m.plans.map((pl, i) => `<tr><td class="px" style="padding:0 36px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${i ? `border-top:1px solid ${C.line}` : ''}" class="rule"><tr>
            <td valign="top" width="92" class="day-col accent" style="padding:14px 12px 14px 0;font:700 12px/1.5 ${SANS};letter-spacing:.4px;text-transform:uppercase;color:${C.accent}">${esc(pl.day)}</td>
            <td valign="top" style="padding:12px 0">
              <div class="ink" style="font:600 16px/1.35 ${SANS};color:${C.ink}">${esc(pl.title)}</div>
              <div class="ink2" style="font:400 14px/1.45 ${SANS};color:${C.ink2};padding-top:3px">${esc([pl.time, pl.people.length ? `with ${listNames(pl.people)}` : '', pl.place].filter(Boolean).join(' · '))}</div>
            </td>
          </tr></table>
        </td></tr>`).join(''));
      }
    }

    if (m.picks.length) {
      rows.push(sectionTitle(m.edition === 'guest' ? 'Worth leaving the house for' : `Worth it this week`, `<a href="${esc(m.appUrl)}/#plan" class="accent" style="color:${C.accent};text-decoration:none">Plan a night →</a>`));
      rows.push(pickRows(m.picks));
    }
    if (m.spots.length) {
      rows.push(sectionTitle(m.edition === 'guest' ? 'New & worth booking' : 'Tables worth booking'));
      rows.push(spotRows(m.spots));
    }

    if (m.edition === 'guest') {
      rows.push(`<tr><td class="px" style="padding:36px 36px 8px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.night}" style="background:${C.night};background-image:linear-gradient(135deg,${C.night} 0%,${C.night2} 100%);border-radius:20px">
          <tr><td style="padding:28px 28px 30px">
            <div style="font:400 26px/1.15 ${SERIF};color:${C.nightInk}">Want this for your own week?</div>
            <div style="font:400 15px/1.55 ${SANS};color:${C.nightInk2};padding:10px 0 20px">Orbit keeps your closest people close and plans your nights around them — with picks tuned to you, not someone else. Two minutes, no account; everything stays on your phone.</div>
            ${button('Start your Orbit', m.appUrl, { primary: true })}
          </td></tr>
        </table>
      </td></tr>`);
    } else {
      rows.push(`<tr><td class="px" align="center" style="padding:36px 36px 8px">${button('Open Orbit', m.appUrl, { primary: true })}</td></tr>`);
    }

    const footer = m.edition === 'guest'
      ? `${m.owner.name ? `${esc(m.owner.name)} shares` : 'You’re getting'} Orbit’s ${esc(m.city)} picks with you. Not your thing? Reply and say so — no hard feelings.`
      : `Sent by your Orbit agent. Change what’s in here, or who gets the city edition, in <a href="${esc(m.appUrl)}/#digest" style="color:${C.ink3}">Orbit → Digest</a>.`;

    return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap" rel="stylesheet">
<style>
  body{margin:0;padding:0;-webkit-text-size-adjust:100%}
  a{text-decoration:none}
  @media (max-width:620px){
    .px{padding-left:20px!important;padding-right:20px!important}
    .hero-px{padding-left:24px!important;padding-right:24px!important}
    .hero-title{font-size:34px!important}
    .day-col{width:72px!important}
    .hide-sm{display:none!important}
    .show-sm{display:table-row!important;max-height:none!important}
    .shell{border-radius:0!important}
  }
  @media (prefers-color-scheme:dark){
    .page{background:#0B0A18!important}
    .shell,.card{background:#15142A!important}
    .card{border-color:#2A2848!important}
    .soft{background:#1E1C38!important;color:#EDEBFA!important}
    .rule{border-color:#2A2848!important}
    .ink{color:#F1EFFB!important}
    .ink2{color:#B9B6D3!important}
    .ink3{color:#8683A6!important}
    .accent{color:#B7A6FF!important}
    .pill{background:#2A2452!important;color:#CFC3FF!important}
    .btn{background:#15142A!important;border-color:#3A3566!important;color:#B7A6FF!important}
  }
</style>
</head>
<body class="page" style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}${'&#8199;&#65279;&#847; '.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="page" bgcolor="${C.page}" style="background:${C.page}">
<tr><td align="center" style="padding:24px 12px 40px" class="outer">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="shell" style="width:100%;max-width:600px;background:${C.card};border-radius:24px;overflow:hidden">
    <tr><td class="hero-px" bgcolor="${C.night}" style="background:${C.night};background-image:radial-gradient(120% 90% at 100% 0%,#3B2C86 0%,rgba(59,44,134,0) 55%),linear-gradient(160deg,${C.night} 0%,${C.night2} 100%);padding:28px 36px 34px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font:700 12px/1 ${SANS};letter-spacing:3px;color:${C.nightInk}"><span style="color:#B7A6FF">✦</span>&nbsp; ORBIT</td>
        <td align="right" style="font:500 12px/1 ${SANS};color:${C.nightInk2}">${esc(longDate(m.date))}</td>
      </tr></table>
      <div style="font:400 11px/1 ${SANS};color:#6E68A8;letter-spacing:10px;padding:22px 0 12px">· ✧ · · ✦ ·</div>
      <div class="hero-title" style="font:400 40px/1.08 ${SERIF};color:${C.nightInk};letter-spacing:-.3px">${esc(h.title)}</div>
      <div style="font:400 17px/1.5 ${SANS};color:${C.nightInk2};padding-top:12px">${esc(h.lede)}</div>
    </td></tr>
    ${rows.join('\n')}
    <tr><td class="px ink3" style="padding:28px 36px 32px;font:400 12.5px/1.6 ${SANS};color:${C.ink3};text-align:center">${footer}</td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
  }

  // ---------- plain text ----------
  function renderText(m) {
    const h = headline(m);
    const out = [`ORBIT · ${longDate(m.date)}`, '', h.title, h.lede, ''];
    if (m.edition === 'owner') {
      if (m.birthdays.length) {
        out.push(`Birthdays: ${m.birthdays.map(b => `${firstName(b.name)} ${b.inDays === 0 ? 'today' : b.inDays === 1 ? 'tomorrow' : b.day}`).join(', ')}`, '');
      }
      if (m.focus.length) {
        out.push('REACH OUT TODAY');
        for (const f of m.focus) {
          out.push(`• ${f.name} — ${f.label}${f.quiet != null ? `, ${f.quiet} days since you talked` : ''}`);
          if (f.move) out.push(`  ${f.move.kind === 'idea' ? 'Idea: ' : ''}${f.move.text}${f.move.day ? ` (${f.move.day})` : ''}`);
        }
        if (m.alsoDue.length) out.push(`Also waiting: ${listNames(m.alsoDue)}`);
        out.push('');
      }
      if (m.plans.length) {
        out.push('ON YOUR CALENDAR');
        for (const pl of m.plans) out.push(`• ${pl.day}${pl.time ? ' ' + pl.time : ''} — ${pl.title}${pl.people.length ? ` with ${listNames(pl.people)}` : ''}${pl.place ? ` @ ${pl.place}` : ''}`);
        out.push('');
      }
    }
    if (m.picks.length) {
      out.push(m.edition === 'guest' ? 'WORTH LEAVING THE HOUSE FOR' : 'WORTH IT THIS WEEK');
      for (const p of m.picks) {
        out.push(`• ${p.day}${p.time ? ' ' + p.time : ''} — ${p.title}${p.venue ? ` @ ${p.venue}` : ''}`);
        if (p.url) out.push(`  ${p.url}`);
      }
      out.push('');
    }
    if (m.spots.length) {
      out.push(m.edition === 'guest' ? 'NEW & WORTH BOOKING' : 'TABLES WORTH BOOKING');
      for (const s of m.spots) {
        out.push(`• ${s.name}${s.hood ? ` (${s.hood})` : ''}${s.status ? ` — ${s.status.toLowerCase()}` : ''}${s.availability ? `. ${s.availability}` : ''}`);
        if (s.url) out.push(`  ${s.url}`);
      }
      out.push('');
    }
    out.push('—');
    out.push(m.edition === 'guest'
      ? `Want this for your own week? Start your Orbit — two minutes, no account: ${m.appUrl}`
      : `Open Orbit: ${m.appUrl}`);
    return out.join('\n');
  }

  function renderEmail(model) {
    const subject = subjectFor(model);
    const preheader = preheaderFor(model);
    return { subject, preheader, html: renderHtml(model, subject, preheader), text: renderText(model) };
  }

  // Every email the agent should send today, one per recipient. The owner's
  // edition only ever goes to the owner.
  function buildDeliveries(state, opts = {}) {
    const settings = state.settings || {};
    const out = [];
    const ownerModel = buildDigest(state, opts);
    if (settings.email) out.push({ to: settings.email, edition: 'owner', ...renderEmail(ownerModel) });
    const seen = new Set([String(settings.email || '').toLowerCase()]);
    for (const g of settings.digestGuests || []) {
      const email = String((g && g.email) || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      const model = buildDigest(state, { ...opts, edition: 'guest', guest: { ...g, email } });
      if (!model.picks.length && !model.spots.length) continue; // an empty city edition is just noise
      out.push({ to: email, edition: 'guest', ...renderEmail(model) });
    }
    return out;
  }

  return { buildDigest, renderEmail, buildDeliveries, lastTouch };
});
