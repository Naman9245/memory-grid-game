/* Memory Grid: a cozy two-player memory game.
   A grid of pictures shows for a few seconds, then hides; put every picture back in its box.
   Online play goes through Supabase Realtime (broadcast + presence). Each phone only ever adds its
   own part of the game (ready taps, answers), so any two copies merge cleanly and both phones agree. */
(() => {
  'use strict';

  // ---------- Config ----------
  const SUPABASE_URL = 'https://xvsrovvjcnixmhblwdpg.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_oFoG5hKYXWY1cErGkzsqDQ_Byk0MjSl'; // public key, safe in the browser
  const CHANNEL_PREFIX = 'memgrid-v1-';
  const STATE_VER = 1; // bump when the rounds or rules change, so old games and old phones don't mix
  // This build's number, taken from "game.js?v=N" in index.html; version.json holds the deployed one.
  const BUILD = Number((/[?&]v=(\d+)/.exec((document.currentScript && document.currentScript.src) || '') || [])[1]) || 0;
  // "?profile=b" keeps a separate player in the same browser, to try both seats on one computer.
  const PROFILE = ((/[?&]profile=([a-z0-9]{1,8})/i.exec(location.search) || [])[1] || '').toLowerCase();

  // Three rounds, each grid bigger than the last. Times are in seconds.
  const ROUNDS = [
    { n: 3, look: 10, place: 30 },
    { n: 4, look: 15, place: 45 },
    { n: 5, look: 20, place: 60 },
  ];
  const LAST = ROUNDS.length - 1;
  const COUNTDOWN = 3; // "3, 2, 1" before the grid shows
  const MAX_TOTAL = ROUNDS.reduce((t, R) => t + R.n * R.n, 0);
  const SEAT_COLORS = ['#7c3aed', '#ec4899'];
  const ROUND_WORDS = ['one', 'two', 'three'];

  // Pictures that look clearly different from each other at a glance.
  const ITEMS = [
    '🍎', '🍌', '🍇', '🍉', '🍓', '🍒', '🍍', '🥝', '🥕', '🌽', '🍄', '🌵', '🌻', '🌸', '🍀', '🌙',
    '⭐', '🌈', '❄️', '🔥', '💧', '⚡', '🎈', '🎁', '🎸', '🥁', '⚽', '🏀', '🎾', '🚗', '🚀', '✈️',
    '⛵', '🚲', '🏠', '⏰', '🔑', '💡', '📚', '✏️', '🎩', '👓', '👑', '💎', '🧸', '🐶', '🐱', '🐰',
    '🐸', '🐼', '🐧', '🦋', '🐟', '🐢', '🐝', '🦄', '🍩', '🍕', '🍦', '🎂', '☕', '🍔', '🎀', '☂️', '🔔',
  ];

  // ---------- Helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const safe = (fn) => { try { fn(); } catch (e) { console.error('memgrid:', e); } };
  const clip = (str, n) => Array.from(str).slice(0, n).join(''); // never cuts an emoji in half

  function randId(len) {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    return Array.from(buf, (v) => abc[v % abc.length]).join('');
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Same seed, same order: the picture tray stays put after a reload.
  function seededShuffle(arr, seed) {
    let h = 2166136261;
    for (const ch of seed) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    const next = () => {
      h = (h + 0x6d2b79f5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const PREFIX = 'memgrid.' + (PROFILE ? PROFILE + '.' : '');
  const store = {
    get(k) { try { return localStorage.getItem(PREFIX + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(PREFIX + k, v); } catch (e) { /* private mode: no saving */ } },
    del(k) { try { localStorage.removeItem(PREFIX + k); } catch (e) { /* ignore */ } },
  };

  const me = { id: store.get('id') || randId(12), name: clip(store.get('name') || '', 14) };
  store.set('id', me.id);

  // ---------- Rules ----------
  const cellsOf = (r) => ROUNDS[r].n * ROUNDS[r].n;
  const sizeOf = (r) => ROUNDS[r].n + '×' + ROUNDS[r].n;
  const isItem = (v) => Number.isInteger(v) && v >= 0 && v < ITEMS.length;
  // Every round gets its own pictures, so nothing from an earlier grid comes back to confuse you.
  function makeGrids() {
    const pool = shuffle(ITEMS.map((_, i) => i));
    let at = 0;
    return ROUNDS.map((_, r) => pool.slice(at, (at += cellsOf(r))));
  }
  const freshRounds = () => ({ ready: ROUNDS.map(() => [0, 0]), ans: ROUNDS.map(() => [null, null]) });

  function newGame(code) {
    return {
      ver: STATE_VER, room: code, game: 1, gs: randId(8), pv: 1, ps: randId(8),
      players: [{ id: me.id, name: me.name }], grids: makeGrids(), ...freshRounds(),
    };
  }

  const seatOf = (s, id) => (s ? s.players.findIndex((p) => p.id === id) : -1);
  const nameOf = (s, seat) => clip((s && s.players[seat] && s.players[seat].name) || (seat === 0 ? 'Player 1' : 'Player 2'), 14);
  const bothReady = (s, r) => !!(s.ready[r][0] && s.ready[r][1]);
  const bothDone = (s, r) => !!(s.ans[r][0] && s.ans[r][1]);
  const bumpPlayers = (s) => { s.pv += 1; s.ps = randId(8); };

  // The round being played: the first one somebody hasn't answered yet (3 once all are done).
  function curRound(s) {
    for (let r = 0; r < ROUNDS.length; r++) if (!bothDone(s, r)) return r;
    return ROUNDS.length;
  }

  function correctOf(s, r, seat) {
    const a = s.ans[r][seat];
    return a ? a.reduce((n, v, i) => n + (v === s.grids[r][i] ? 1 : 0), 0) : 0;
  }

  // Only finished rounds count, so nobody sees the other's score early.
  function totalOf(s, seat) {
    let t = 0;
    for (let r = 0; r < ROUNDS.length; r++) if (bothDone(s, r)) t += correctOf(s, r, seat);
    return t;
  }

  // Two copies of the same room → one. A newer game (play again) replaces an older one; inside a game,
  // ready taps and answers only ever get added, so taking everything from both sides is always right.
  function merge(a, b) {
    if (!a) return clone(b);
    if (!b) return clone(a);
    let out;
    if (a.game !== b.game || a.gs !== b.gs) {
      const aWins = a.game !== b.game ? a.game > b.game : a.gs > b.gs;
      out = clone(aWins ? a : b);
    } else {
      out = clone(a);
      for (let r = 0; r < ROUNDS.length; r++) {
        for (const seat of [0, 1]) {
          out.ready[r][seat] = a.ready[r][seat] || b.ready[r][seat] ? 1 : 0;
          out.ans[r][seat] = clone(a.ans[r][seat] || b.ans[r][seat] || null);
        }
      }
    }
    // Who sits where: the newer change wins (ties broken the same way on both phones).
    const p = a.pv !== b.pv ? (a.pv > b.pv ? a : b) : a.ps >= b.ps ? a : b;
    out.players = clone(p.players);
    out.pv = p.pv;
    out.ps = p.ps;
    return out;
  }

  const sig = (s) => (s ? JSON.stringify([s.game, s.gs, s.pv, s.ps, s.players, s.grids, s.ready, s.ans]) : '');

  function validState(s, code) {
    try {
      if (!s || typeof s !== 'object' || s.ver !== STATE_VER || s.room !== (code || room)) return false;
      if (!Number.isInteger(s.game) || s.game < 1 || typeof s.gs !== 'string') return false;
      if (!Number.isInteger(s.pv) || typeof s.ps !== 'string') return false;
      if (!Array.isArray(s.players) || s.players.length < 1 || s.players.length > 2) return false;
      if (!s.players.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string')) return false;
      for (const k of ['grids', 'ready', 'ans']) if (!Array.isArray(s[k]) || s[k].length !== ROUNDS.length) return false;
      return ROUNDS.every((_, r) => {
        const g = s.grids[r], cells = cellsOf(r);
        if (!Array.isArray(g) || g.length !== cells || !g.every(isItem) || new Set(g).size !== cells) return false;
        const rd = s.ready[r];
        if (!Array.isArray(rd) || rd.length !== 2 || !rd.every((v) => v === 0 || v === 1)) return false;
        const an = s.ans[r];
        if (!Array.isArray(an) || an.length !== 2) return false;
        return an.every((a) => a === null || (Array.isArray(a) && a.length === cells && a.every((v) => v === -1 || isItem(v))));
      });
    } catch (e) {
      return false;
    }
  }

  // ---------- DOM ----------
  const board = $('#board'), sheet = $('#sheet'), boardWrap = $('#boardWrap');
  const hud = $('#hud'), panel = $('#panel'), countEl = $('#count');

  // ---------- Game + network state ----------
  let room = null; // current room code
  let state = null; // latest known game state (the truth)
  let session = 0; // bumps on entering/leaving a room so stale effects stop
  let enteredAt = 0;

  // This phone only
  let sel = null; // picked-up picture {k: 'item', id} or chosen empty box {k: 'cell', i}
  let draft = null, draftFor = ''; // pictures placed so far this round (-1 = empty box)
  let doneArmed = 0; // "boxes still empty, tap Done again" window
  let tab = 0, tabFor = ''; // results: 0 = my board, 1 = partner's
  let finalOpen = false; // game-over card showing (vs. looking at the boards)
  let shownPhase = '', heardPhase = '', lastBeep = '';
  let stageKey = ''; // what the stage was last built for
  const revealed = new Set(); // rounds whose results already animated
  let finalFx = '';
  const demo = shuffle(ITEMS.map((_, i) => i)).slice(0, 9);

  let sb = null, channel = null, connected = false, connFails = 0;
  let connLostAt = 0; // when the live connection last dropped; short blips are ridden out
  let online = new Set(), presenceReady = false;
  let lastSeen = new Map(); // player id -> last time we heard a message from them
  let ticks = 0;
  const debugLog = []; // recent connection events, readable via window.memgrid.log
  const dlog = (...parts) => {
    debugLog.push(new Date().toISOString().slice(11, 23) + ' ' + parts.join(' '));
    if (debugLog.length > 80) debugLog.shift();
  };

  // Presence is the main signal; recent messages back it up if presence hiccups.
  const recentlySeen = (id) => Date.now() - (lastSeen.get(id) || 0) < 12000;
  // Connected, or dropped only a moment ago.
  const linkOk = () => connected || (connLostAt > 0 && Date.now() - connLostAt < 6000);

  function isOnline(s, seat) {
    const p = s && s.players[seat];
    if (!p) return false;
    return p.id === me.id ? linkOk() : online.has(p.id) || recentlySeen(p.id);
  }

  // ---------- What to show ----------
  function getView() {
    const s = state;
    if (!room) return { kind: 'home' };
    if (!s) return { kind: 'looking' };
    const mine = seatOf(s, me.id);
    if (mine < 0) return { kind: s.players.length >= 2 && presenceReady ? 'seat' : 'looking' };
    if (s.players.length < 2) return { kind: 'lobby' };
    const r = curRound(s);
    if (r > LAST) return { kind: finalOpen ? 'final' : 'results', r: LAST, last: true };
    if (!bothReady(s, r)) return r === 0 ? { kind: 'intro', r } : { kind: 'results', r: r - 1, next: r };
    if (s.ans[r][mine]) return { kind: 'waiting', r };
    return { kind: 'play', r };
  }

  const startKey = (r) => 'start.' + room + '.' + state.gs + '.' + r;
  const draftKey = (r) => 'draft.' + room + '.' + state.gs + '.' + r;

  // Each phone times its own round from the moment it starts, so a slow message never steals seconds.
  // The start is saved, so reloading the page doesn't show the grid again. A phone that's in a pocket
  // (page hidden) waits at "3" until it's looked at again.
  function startOf(r) {
    const key = startKey(r);
    let t = Number(store.get(key));
    if (!Number.isFinite(t) || t <= 0 || t > Date.now() + 1000) {
      t = Date.now();
      if (!document.hidden) store.set(key, String(t));
    }
    return t;
  }

  function clockOf(r) {
    const { look, place } = ROUNDS[r];
    const at = (Date.now() - startOf(r)) / 1000;
    if (at < COUNTDOWN) return { phase: 'count', left: COUNTDOWN - at, total: COUNTDOWN };
    if (at < COUNTDOWN + look) return { phase: 'look', left: COUNTDOWN + look - at, total: look };
    if (at < COUNTDOWN + look + place) return { phase: 'place', left: COUNTDOWN + look + place - at, total: place };
    return { phase: 'up', left: 0, total: place };
  }

  function loadDraft(r) {
    const key = draftKey(r);
    if (draft && draftFor === key) return draft;
    let d = null;
    try { d = JSON.parse(store.get(key) || 'null'); } catch (e) { d = null; }
    const grid = state.grids[r];
    const used = Array.isArray(d) ? d.filter((v) => v !== -1) : [];
    const ok = Array.isArray(d) && d.length === cellsOf(r) && d.every((v) => v === -1 || grid.includes(v)) && new Set(used).size === used.length;
    draft = ok ? d : Array(cellsOf(r)).fill(-1);
    draftFor = key;
    return draft;
  }

  const saveDraft = () => { if (draft && draftFor) store.set(draftFor, JSON.stringify(draft)); };

  // ---------- Board ----------
  // fill(i) → { item, cls, hint, mark, delay } for box i, or nothing for an empty box.
  function buildBoard(n, fill) {
    board.style.setProperty('--n', n);
    board.textContent = '';
    for (let i = 0; i < n * n; i++) {
      const f = (fill && fill(i)) || {};
      const c = el('div', 'cell' + (f.cls ? ' ' + f.cls : ''));
      c.dataset.i = String(i);
      if (isItem(f.item)) c.appendChild(el('span', 'it', ITEMS[f.item]));
      else c.classList.add('empty');
      if (isItem(f.hint)) c.appendChild(el('span', 'hint', ITEMS[f.hint]));
      if (f.mark) c.appendChild(el('span', 'mark', f.mark));
      if (f.delay != null) c.style.setProperty('--d', f.delay + 'ms');
      board.appendChild(c);
    }
  }

  function fitBoard() {
    const size = Math.floor(Math.max(140, Math.min(boardWrap.clientWidth, boardWrap.clientHeight, 560)));
    const n = Number(board.style.getPropertyValue('--n')) || 3;
    const pad = Math.max(8, Math.round(size * 0.04));
    const gap = Math.max(2, Math.round(size * 0.009));
    sheet.style.width = size + 'px';
    sheet.style.height = size + 'px';
    sheet.style.setProperty('--pad', pad + 'px');
    board.style.setProperty('--gap', gap + 'px');
    board.style.setProperty('--cell', (size - 2 * pad - (n - 1) * gap) / n + 'px');
  }

  // ---------- Rendering ----------
  function render() {
    const v = getView();
    // Time ran out (maybe while the phone slept): lock in whatever was placed.
    if (v.kind === 'play' && clockOf(v.r).phase === 'up') { submit(v.r, true); return; }
    document.body.classList.toggle('home', !room);
    renderStage(v);
    refreshChrome(v);
  }

  function refreshChrome(v) {
    v = v || getView();
    renderPlayers(v);
    updateStatus(v);
    updateOverlays(v);
  }

  // Rebuilt only when something on it changed, so a message arriving mid-tap doesn't swap the
  // button under a finger. Sized after the timer row and tray are in place, so the paper takes
  // exactly the room left.
  function renderStage(v) {
    const s = state, mine = seatOf(s, me.id);
    const key = JSON.stringify([
      v, room, sig(s), sel, draft, tab,
      v.kind === 'play' ? clockOf(v.r).phase : '',
      v.kind === 'waiting' ? isOnline(s, 1 - mine) : '',
    ]);
    if (key === stageKey) return;
    stageKey = key;
    fillStage(v);
    fitAll();
  }

  const fitAll = () => { fitTray(); fitBoard(); };
  const SIDEWAYS = matchMedia('(orientation: landscape) and (max-height: 520px)'); // same as style.css

  // The biggest tray pictures that still leave the grid most of the screen (25 of them on a small
  // phone need to get smaller; 9 can stay big).
  function fitTray() {
    const tray = panel.querySelector('.tray');
    if (!tray) return;
    const k = tray.children.length;
    const width = tray.clientWidth - 16;
    const stageH = $('#stage').clientHeight;
    // Sideways phones put the tray beside the grid, so it may use the full height there.
    const budget = SIDEWAYS.matches ? stageH - 56 : Math.max(110, stageH * 0.38);
    let size = 30, gap = 5;
    for (let s = 56; s >= 30; s--) {
      const g = s >= 44 ? 7 : 5;
      const perRow = Math.max(1, Math.floor((width + g) / (s + g)));
      if (Math.ceil(k / perRow) * (s + g) - g + 16 <= budget) { size = s; gap = g; break; }
    }
    tray.style.setProperty('--ts', size + 'px');
    tray.style.gap = gap + 'px';
  }

  function fillStage(v) {
    hud.textContent = '';
    panel.textContent = '';
    hud.className = 'hud';
    countEl.hidden = true;
    board.classList.remove('placing', 'armed');
    sheet.classList.remove('peek');
    if (v.kind !== 'play') shownPhase = '';
    switch (v.kind) {
      case 'intro': return renderIntro(v);
      case 'play': return renderPlay(v);
      case 'waiting': return renderWaiting(v);
      case 'results':
      case 'final': return renderResults(v);
      default: buildBoard(3, (i) => ({ item: demo[i] }));
    }
  }

  function roundTitle(r) {
    const t = el('div', 'title');
    t.append(el('b', '', 'Round ' + (r + 1) + ' of ' + ROUNDS.length), el('span', '', sizeOf(r)));
    return t;
  }

  // "Ready" for round r: a button until tapped, then who we're waiting for.
  function readyBlock(r) {
    const s = state, mine = seatOf(s, me.id), opp = 1 - mine;
    const box = el('div', 'stack');
    if (!s.ready[r][mine]) {
      const b = el('button', 'btn', r === 0 ? "I'm ready! 🙌" : 'Ready for Round ' + (r + 1) + ' · ' + sizeOf(r) + ' ▶');
      b.addEventListener('click', () => pressReady(r));
      box.appendChild(b);
      if (s.ready[r][opp]) box.appendChild(el('p', 'note', nameOf(s, opp) + ' is ready! ✅'));
    } else {
      box.appendChild(el('p', 'waiting', 'Waiting for ' + nameOf(s, opp) + ' to be ready'));
    }
    return box;
  }

  function renderIntro(v) {
    const r = v.r, R = ROUNDS[r];
    buildBoard(R.n, null);
    hud.appendChild(roundTitle(r));
    const card = el('div', 'pcard');
    card.append(
      el('div', 'big', sizeOf(r) + ' grid'),
      el('p', '', '👀 ' + R.look + ' sec to look · ✋ ' + R.place + ' sec to put back'),
      readyBlock(r),
    );
    panel.appendChild(card);
  }

  function renderPlay(v) {
    const r = v.r, R = ROUNDS[r];
    const c = clockOf(r);
    const pk = state.gs + ':' + r + ':' + c.phase;
    shownPhase = pk;
    if (heardPhase !== pk) { heardPhase = pk; phaseFx(r, c.phase); }

    if (c.phase === 'count') {
      buildBoard(R.n, null);
      hud.appendChild(roundTitle(r));
      countEl.hidden = false;
      countEl.textContent = '';
      panel.appendChild(el('div', 'pcard', 'Get ready to remember! 👀'));
    } else if (c.phase === 'look') {
      buildBoard(R.n, (i) => ({ item: state.grids[r][i] }));
      sheet.classList.add('peek');
      hud.classList.add('look');
      hud.append(phaseEl('👀', 'Look!'), timerEl());
      panel.appendChild(el('div', 'pcard', 'Remember where everything is!'));
    } else {
      const d = loadDraft(r);
      buildBoard(R.n, (i) => ({ item: d[i], cls: sel && sel.k === 'cell' && sel.i === i ? 'sel' : '' }));
      board.classList.add('placing');
      board.classList.toggle('armed', !!(sel && sel.k === 'item'));
      hud.classList.add('place');
      const done = el('button', 'btn small green', 'Done ✓');
      done.id = 'doneBtn';
      done.classList.toggle('full', d.every((x) => x !== -1));
      done.addEventListener('click', () => pressDone(r));
      hud.append(phaseEl('✋', 'Put back!'), timerEl(), done);
      panel.appendChild(trayEl(r, d));
    }
    updateClock(c);
  }

  function phaseEl(icon, text) {
    const p = el('div', 'phase', icon);
    p.appendChild(el('span', 'pt', ' ' + text));
    return p;
  }

  function timerEl() {
    const t = el('div', 'timer');
    t.id = 'timer';
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.id = 'bar';
    bar.appendChild(fill);
    const b = el('b', '', '');
    b.id = 'clock';
    t.append(bar, b);
    return t;
  }

  function trayEl(r, d) {
    const tray = el('div', 'tray n' + ROUNDS[r].n);
    for (const id of seededShuffle(state.grids[r], room + ':' + state.gs + ':' + r)) {
      const used = d.includes(id);
      const b = el('button', 'titem' + (used ? ' used' : '') + (sel && sel.k === 'item' && sel.id === id ? ' sel' : ''), used ? '' : ITEMS[id]);
      b.dataset.id = String(id);
      b.disabled = used;
      tray.appendChild(b);
    }
    return tray;
  }

  // Ticks between renders: the countdown, the timer bar, the last-seconds beeps.
  function updateClock(c) {
    const left = Math.max(0, c.left);
    const secs = Math.ceil(left - 1e-6);
    const pk = shownPhase;
    if (c.phase === 'count') {
      const n = String(Math.max(1, secs));
      if (countEl.textContent !== n) {
        countEl.textContent = n;
        countEl.classList.remove('pop');
        void countEl.offsetWidth;
        countEl.classList.add('pop');
      }
    }
    const clock = $('#clock'), bar = $('#bar'), timer = $('#timer');
    if (clock && clock.textContent !== String(secs)) clock.textContent = String(secs);
    if (bar) bar.style.transform = 'scaleX(' + (left / c.total).toFixed(4) + ')';
    const urgent = c.phase === 'place' ? secs <= 5 : c.phase === 'look' ? secs <= 3 : false;
    if (timer) timer.classList.toggle('urgent', urgent);
    if ((c.phase === 'count' || urgent) && secs > 0) {
      const key = pk + ':' + secs;
      if (lastBeep !== key) {
        lastBeep = key;
        if (c.phase === 'count') Sound.count(); else Sound.tick();
      }
    }
  }

  function phaseFx(r, phase) {
    if (phase === 'count') {
      Sound.say('Round ' + ROUND_WORDS[r] + '! Get ready!', 0);
    } else if (phase === 'look') {
      Sound.show();
    } else if (phase === 'place') {
      sel = null;
      Sound.hide();
      Sound.say('Now put them back!', 150);
    }
  }

  function renderWaiting(v) {
    const r = v.r, s = state, mine = seatOf(s, me.id), opp = 1 - mine;
    buildBoard(ROUNDS[r].n, (i) => ({ item: s.ans[r][mine][i] }));
    hud.appendChild(roundTitle(r));
    const card = el('div', 'pcard');
    card.append(
      el('p', '', 'Your answers are locked in 🔒'),
      el('p', 'waiting', isOnline(s, opp) ? 'Waiting for ' + nameOf(s, opp) + ' to finish' : nameOf(s, opp) + ' is offline 💤 waiting'),
    );
    panel.appendChild(card);
  }

  function scoreLine(s, r, seat) {
    const cells = cellsOf(r), ok = correctOf(s, r, seat), wrong = cells - ok;
    return wrong === 0 ? 'Perfect! ' + cells + ' out of ' + cells + ' 🎉' : cells + ' − ' + wrong + ' wrong = ' + ok;
  }

  function renderResults(v) {
    const r = v.r, s = state, mine = seatOf(s, me.id), opp = 1 - mine;
    const key = s.gs + ':' + r;
    if (tabFor !== key) { tabFor = key; tab = 0; }
    const seat = tab === 0 ? mine : opp;
    const grid = s.grids[r], ans = s.ans[r][seat];
    const fresh = !revealed.has(key);
    if (fresh) revealed.add(key);
    const step = [110, 70, 50][r];
    buildBoard(ROUNDS[r].n, (i) => {
      const ok = ans[i] === grid[i];
      return { item: ans[i], cls: (ok ? 'ok' : 'bad') + (fresh ? ' reveal' : ''), hint: ok ? -1 : grid[i], mark: ok ? '✓' : '✗', delay: fresh ? 200 + i * step : null };
    });

    const tabs = el('div', 'tabs');
    for (const [t, st] of [[0, mine], [1, opp]]) {
      const b = el('button', 'tab' + (tab === t ? ' on' : ''));
      b.style.setProperty('--pc', SEAT_COLORS[st]);
      b.append(el('span', 'tn', t === 0 ? 'You' : nameOf(s, st)), el('b', '', String(correctOf(s, r, st))));
      b.addEventListener('click', () => { if (tab !== t) { tab = t; render(); } });
      tabs.appendChild(b);
    }
    hud.appendChild(tabs);

    const card = el('div', 'pcard');
    card.appendChild(el('div', 'calc', (tab === 0 ? 'You: ' : nameOf(s, seat) + ': ') + scoreLine(s, r, seat)));
    card.appendChild(el('p', 'legend', '✓ right box · ✗ wrong box (the small picture is what was there)'));
    if (v.last) {
      const b = el('button', 'btn purple', 'See who won 🏆');
      b.addEventListener('click', () => { finalOpen = true; render(); });
      card.appendChild(b);
    } else {
      card.appendChild(readyBlock(v.next));
    }
    panel.appendChild(card);

    if (fresh) revealFx(r, step);
  }

  function revealFx(r, step) {
    const sess = session, s = state, mine = seatOf(s, me.id), opp = 1 - mine;
    const grid = s.grids[r], ans = s.ans[r][mine];
    ans.forEach((v, i) => setTimeout(() => {
      if (sess !== session) return;
      if (v === grid[i]) Sound.ok(); else Sound.bad();
    }, 200 + i * step));
    setTimeout(() => {
      if (sess !== session) return;
      const a = correctOf(s, r, mine), b = correctOf(s, r, opp), cells = cellsOf(r);
      let big, say;
      if (a === cells) { big = 'Perfect! 🎉'; say = 'Perfect! Wow!'; }
      else if (a > b) { big = 'You win this round! 🥳'; say = 'You win this round!'; }
      else if (a < b) { big = nameOf(s, opp) + ' wins this round!'; say = nameOf(s, opp) + ' wins this round!'; }
      else { big = 'Same score! 🤝'; say = 'Same score!'; }
      showBanner(big, 'You ' + a + ' · ' + nameOf(s, opp) + ' ' + b, SEAT_COLORS[a >= b ? mine : opp], 2200);
      if (a >= b) { Sound.yay(); burst(['⭐', '✨', '🧠', '💖', '🎉'], a === cells ? 26 : 14, null); } else Sound.aww();
      Sound.say(say, 200);
    }, 450 + ans.length * step);
  }

  function renderPlayers(v) {
    const s = state;
    const inGame = !!s && s.players.length === 2 && seatOf(s, me.id) >= 0;
    const r = v.kind === 'intro' || v.kind === 'play' || v.kind === 'waiting' ? v.r : v.next;
    for (const seat of [0, 1]) {
      const card = $('#p' + seat);
      const p = s && s.players[seat];
      const on = !!p && isOnline(s, seat);
      const isMe = !!p && p.id === me.id;
      let meta, lit = false;
      if (!p) meta = 'not joined yet';
      else if (!isMe && !on) meta = 'offline 💤';
      else if (inGame && r != null && (v.kind === 'play' || v.kind === 'waiting')) {
        lit = !!s.ans[r][seat];
        meta = lit ? 'done ✅' : 'playing… 🧠';
      } else if (inGame && r != null) {
        lit = !!s.ready[r][seat];
        meta = lit ? 'ready ✅' : isMe ? 'you' : 'online';
      } else meta = isMe ? 'you' : 'online';
      card.querySelector('.avatar-letter').textContent = p ? (Array.from(p.name.trim())[0] || '?').toUpperCase() : '?';
      card.querySelector('.pname').textContent = p ? nameOf(s, seat) : 'Waiting…';
      card.querySelector('.pmeta').textContent = meta;
      card.classList.toggle('lit', lit);
      card.classList.toggle('online', on);
      card.classList.toggle('empty', !p);
      const b = card.querySelector('.pscore b');
      const sc = String(s ? totalOf(s, seat) : 0);
      const key = room + ':' + (s ? s.gs : '');
      if (b.textContent !== sc) {
        const grew = b.dataset.key === key && Number(sc) > Number(b.textContent);
        b.textContent = sc;
        if (grew) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
      }
      b.dataset.key = key;
    }
    const pill = $('#roundPill');
    pill.hidden = !inGame;
    if (inGame) {
      const showR = v.kind === 'final' ? null : v.r != null ? v.r : 0;
      pill.querySelector('b').textContent = showR == null ? 'Final' : 'Round ' + (showR + 1) + '/' + ROUNDS.length;
      pill.querySelector('span').textContent = showR == null ? '🏁' : sizeOf(showR);
    }
  }

  function updateStatus(v) {
    const st = $('#status');
    const s = state;
    let text = '';
    if (room) {
      const mine = seatOf(s, me.id), opp = 1 - mine, other = nameOf(s, opp);
      if (!s) text = connected ? 'Looking for the game… 🔎' : 'Connecting… 📶';
      else if (!linkOk() && v.kind !== 'play') text = connFails > 1 ? "Can't reach the game server… retrying 📶" : 'Connecting… 📶';
      else if (v.kind === 'seat') text = 'Pick your seat 👀';
      else if (v.kind === 'looking') text = 'Looking for the game… 🔎';
      else if (v.kind === 'lobby') text = 'Waiting for your partner to join… 💌';
      else if (v.kind === 'intro') text = s.ready[v.r][mine] ? 'Waiting for ' + other + '… ⏳' : 'Tap Ready when you are! 🙌';
      else if (v.kind === 'play') {
        const ph = clockOf(v.r).phase;
        text = ph === 'count' ? 'Get ready… 👀' : ph === 'look' ? 'Remember where everything is! 👀' : 'Tap a picture, then tap its box ✋';
      } else if (v.kind === 'waiting') text = isOnline(s, opp) ? other + ' is still playing… ⏳' : other + ' is offline 💤 waiting…';
      else if (v.kind === 'results') {
        if (v.last) text = 'All 3 rounds done! 🏁';
        else text = s.ready[v.next][mine] ? 'Waiting for ' + other + '… ⏳' : 'Round ' + (v.r + 1) + ' done! 🎉';
      } else if (v.kind === 'final') text = 'Game over! 🏁';
    }
    st.textContent = text;
  }

  function updateOverlays(v) {
    const s = state, inRoom = !!room;
    $('#home').hidden = inRoom;
    $('#looking').hidden = v.kind !== 'looking';
    $('#lobby').hidden = v.kind !== 'lobby';
    $('#seat').hidden = v.kind !== 'seat';
    $('#final').hidden = v.kind !== 'final';
    if (v.kind === 'looking') fillLooking();
    if (v.kind === 'lobby') fillLobby();
    if (v.kind === 'seat') fillSeats();
    if (v.kind === 'final') fillFinal(s);
  }

  function fillLooking() {
    $('#lookCode').textContent = room;
    let hint;
    if (!connected) hint = connFails > 1 ? "Can't reach the game server. Check your internet 📶" : 'Connecting to the game server… 📶';
    else if (Date.now() - enteredAt > 5000) hint = 'Make sure your partner has the game open, and the code is right 🙂';
    else hint = "Asking your partner's phone…";
    $('#lookHint').textContent = hint;
  }

  function fillLobby() {
    $('#lobbyCode').textContent = room;
    $('#shareBtn').hidden = !navigator.share;
  }

  function fillSeats() {
    const s = state;
    const box = $('#seatBtns');
    const sig2 = [0, 1].map((seat) => nameOf(s, seat) + (isOnline(s, seat) ? '+' : '-')).join('|');
    if (box.dataset.sig === sig2) return; // unchanged: don't rebuild under a finger
    box.dataset.sig = sig2;
    $('#seatNames').textContent = nameOf(s, 0) + ' & ' + nameOf(s, 1);
    box.textContent = '';
    for (const seat of [0, 1]) {
      const b = el('button', 'btn ' + (seat === 0 ? 'purple' : 'pink'), "I'm " + nameOf(s, seat));
      if (isOnline(s, seat)) {
        b.appendChild(el('small', '', 'playing on another phone right now'));
        b.disabled = true;
      }
      b.addEventListener('click', () => takeSeat(seat));
      box.appendChild(b);
    }
  }

  function fillFinal(s) {
    const mine = seatOf(s, me.id);
    const a = totalOf(s, 0), b = totalOf(s, 1);
    const winner = a === b ? -1 : a > b ? 0 : 1;
    let title, sub, icon = '🏆', speech;
    if (winner < 0) {
      title = "It's a tie! 🤝"; sub = 'Same memory, perfect match 💕'; icon = '🤝'; speech = "It's a tie!";
    } else if (winner === mine) {
      title = 'You win! 🧠✨'; sub = 'What a memory, ' + nameOf(s, winner) + '! 🏆'; speech = 'You win! What a memory!';
    } else {
      title = nameOf(s, winner) + ' wins! 🏆'; sub = 'Rematch? 😜'; icon = '🧠'; speech = nameOf(s, winner) + ' wins!';
    }
    $('#finalIcon').textContent = icon;
    $('#finalTitle').textContent = title;
    $('#finalTitle').style.color = winner < 0 ? '' : SEAT_COLORS[winner];
    $('#finalSub').textContent = sub;

    const box = $('#finalScores');
    box.textContent = '';
    for (const seat of [0, 1]) {
      const d = el('div', 'fs');
      d.style.setProperty('--pc', SEAT_COLORS[seat]);
      const n = el('div', 'n', String(totalOf(s, seat)));
      n.appendChild(el('small', '', ' / ' + MAX_TOTAL));
      d.append(n, el('div', 'nm', nameOf(s, seat)));
      box.appendChild(d);
    }

    const t = $('#breakdown');
    t.textContent = '';
    const head = el('tr');
    head.append(el('th'), el('th', '', nameOf(s, 0)), el('th', '', nameOf(s, 1)));
    t.appendChild(head);
    ROUNDS.forEach((_, r) => {
      const row = el('tr');
      row.append(el('td', '', 'Round ' + (r + 1) + ' · ' + sizeOf(r)));
      for (const seat of [0, 1]) row.appendChild(el('td', '', correctOf(s, r, seat) + ' / ' + cellsOf(r)));
      t.appendChild(row);
    });

    if (finalFx !== s.gs) {
      finalFx = s.gs;
      Sound.win();
      burst(['🎉', '🏆', '🧠', '✨', '💖', '🥳', '⭐'], 30, null);
      Sound.say(speech, 300);
    }
  }

  // ---------- Banner, toast, particles ----------
  let bannerT1 = 0, bannerT2 = 0, toastT = 0;

  function showBanner(big, small, color, ms) {
    const b = $('#banner');
    clearTimeout(bannerT1);
    clearTimeout(bannerT2);
    b.querySelector('.big').textContent = big;
    b.querySelector('.small').textContent = small;
    b.style.setProperty('--bc', color);
    b.classList.remove('out');
    b.hidden = false;
    const card = b.querySelector('.bcard');
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
    bannerT1 = setTimeout(() => {
      b.classList.add('out');
      bannerT2 = setTimeout(() => { b.hidden = true; b.classList.remove('out'); }, 300);
    }, ms);
  }

  function hideBanner() {
    clearTimeout(bannerT1);
    clearTimeout(bannerT2);
    $('#banner').hidden = true;
  }

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    t.style.animation = 'none';
    void t.offsetWidth;
    t.style.animation = '';
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, 2200);
  }

  function burst(emojis, n, origin) {
    const ox = origin ? origin.x : innerWidth / 2;
    const oy = origin ? origin.y : innerHeight / 2;
    for (let i = 0; i < n; i++) {
      const p = el('div', 'particle', pick(emojis));
      const ang = rand(0, Math.PI * 2), dist = rand(90, 230);
      p.style.setProperty('--x', ox + 'px');
      p.style.setProperty('--y', oy + 'px');
      p.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(ang) * dist - 70 + 'px');
      p.style.setProperty('--rot', rand(-180, 180) + 'deg');
      p.style.fontSize = rand(20, 36) + 'px';
      p.style.animationDelay = rand(0, 0.15) + 's';
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 1800);
    }
  }

  // ---------- Sound (all synthesized, no files) ----------
  const Sound = (() => {
    let ctx = null, out = null, noiseBuf = null, primed = false;
    let muted = store.get('muted') === '1';

    function ac() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch (e) { return null; }
        out = ctx.createGain();
        out.gain.value = 0.85;
        out.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function noise(c) {
      if (!noiseBuf) {
        const len = Math.floor(c.sampleRate);
        noiseBuf = c.createBuffer(1, len, c.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      return noiseBuf;
    }

    function envelope(g, t0, peak, a, d) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    }

    function tone(c, o) {
      const t0 = c.currentTime + (o.t || 0), a = o.a || 0.01, d = o.d || 0.2;
      const osc = c.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f0, t0);
      if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + a + d);
      const g = c.createGain();
      envelope(g, t0, o.peak || 0.2, a, d);
      osc.connect(g);
      g.connect(out);
      osc.start(t0);
      osc.stop(t0 + a + d + 0.05);
    }

    function hiss(c, o) {
      const t0 = c.currentTime + (o.t || 0), a = o.a || 0.01, d = o.d || 0.2;
      const src = c.createBufferSource();
      src.buffer = noise(c);
      const f = c.createBiquadFilter();
      f.type = o.filter || 'bandpass';
      f.Q.value = o.q || 0.8;
      f.frequency.setValueAtTime(o.f0 || 1000, t0);
      if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + a + d);
      const g = c.createGain();
      envelope(g, t0, o.peak || 0.2, a, d);
      src.connect(f);
      f.connect(g);
      g.connect(out);
      src.start(t0, Math.random() * 0.3);
      src.stop(t0 + a + d + 0.05);
    }

    // A sound must never break the game.
    const play = (fn) => () => { if (muted) return; try { const c = ac(); if (c) fn(c); } catch (e) { /* ignore */ } };

    function pickVoice() {
      const en = (window.speechSynthesis.getVoices() || []).filter((v) => /^en/i.test(v.lang));
      return en.find((v) => /en[-_]IN/i.test(v.lang)) ||
        en.find((v) => /female|samantha|zira|victoria|karen|moira|tessa|google us english/i.test(v.name)) || en[0] || null;
    }

    return {
      count: play((c) => tone(c, { f0: 660, peak: 0.2, a: 0.005, d: 0.12 })),
      show: play((c) => {
        [784, 988, 1319].forEach((f, i) => tone(c, { t: i * 0.06, f0: f, peak: 0.16, a: 0.01, d: 0.25 }));
      }),
      hide: play((c) => {
        hiss(c, { filter: 'bandpass', f0: 2600, f1: 500, q: 0.7, peak: 0.3, a: 0.05, d: 0.35 });
        tone(c, { type: 'triangle', f0: 700, f1: 300, peak: 0.12, a: 0.01, d: 0.3 });
      }),
      tap: play((c) => tone(c, { f0: 900, f1: 1100, peak: 0.08, a: 0.003, d: 0.05 })),
      pick: play((c) => tone(c, { type: 'triangle', f0: 500, f1: 900, peak: 0.16, a: 0.004, d: 0.09 })),
      drop: play((c) => {
        tone(c, { f0: 1100, f1: 380, peak: 0.22, a: 0.004, d: 0.11 });
        tone(c, { t: 0.06, f0: 720, f1: 520, peak: 0.08, a: 0.004, d: 0.06 });
      }),
      tick: play((c) => {
        tone(c, { type: 'square', f0: 1250, peak: 0.06, a: 0.002, d: 0.04 });
        hiss(c, { filter: 'highpass', f0: 3000, peak: 0.05, a: 0.002, d: 0.03 });
      }),
      ok: play((c) => tone(c, { type: 'triangle', f0: 880, f1: 1320, peak: 0.12, a: 0.005, d: 0.09 })),
      bad: play((c) => tone(c, { type: 'triangle', f0: 260, f1: 170, peak: 0.16, a: 0.005, d: 0.12 })),
      yay: play((c) => {
        [659, 880, 1047, 1319].forEach((f, i) => tone(c, { t: i * 0.09, f0: f, peak: 0.18, a: 0.01, d: 0.3 }));
      }),
      aww: play((c) => {
        tone(c, { type: 'triangle', f0: 523, f1: 494, peak: 0.25, a: 0.02, d: 0.22 });
        tone(c, { t: 0.26, type: 'triangle', f0: 440, f1: 330, peak: 0.25, a: 0.02, d: 0.42 });
      }),
      win: play((c) => {
        [523, 659, 784, 1047].forEach((f, i) => tone(c, { t: i * 0.13, type: 'triangle', f0: f, peak: 0.24, a: 0.01, d: 0.3 }));
        [523, 659, 784].forEach((f) => tone(c, { t: 0.6, f0: f, peak: 0.12, a: 0.02, d: 0.9 }));
      }),
      start: play((c) => {
        [784, 988, 1175].forEach((f, i) => tone(c, { t: i * 0.09, f0: f, peak: 0.15, a: 0.01, d: 0.16 }));
      }),
      say(text, delay) {
        if (muted || !('speechSynthesis' in window)) return;
        setTimeout(() => {
          if (muted) return;
          try {
            const synth = window.speechSynthesis;
            const u = new SpeechSynthesisUtterance(text);
            u.rate = 1.05;
            u.pitch = 1.3;
            const v = pickVoice();
            if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
            if (synth.speaking || synth.pending) {
              synth.cancel();
              setTimeout(() => synth.speak(u), 120);
            } else {
              synth.speak(u);
            }
          } catch (e) { /* no voice on this device */ }
        }, delay || 0);
      },
      // Phones only allow sound after a tap, so call this from a click.
      unlock() {
        const c = ac();
        if (c) {
          try {
            const s = c.createBufferSource();
            s.buffer = c.createBuffer(1, 1, 22050);
            s.connect(c.destination);
            s.start(0);
          } catch (e) { /* ignore */ }
        }
        if (!primed && 'speechSynthesis' in window) {
          primed = true;
          try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } catch (e) { /* ignore */ }
        }
      },
      resume() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
      isMuted: () => muted,
      setMuted(m) {
        muted = m;
        store.set('muted', m ? '1' : '0');
        if (m && 'speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
      },
    };
  })();

  // ---------- Playing ----------
  function inPlacePhase() {
    const v = getView();
    return v.kind === 'play' && clockOf(v.r).phase === 'place' ? v.r : -1;
  }

  // Tap a box: drop the picked-up picture there, or pick up the picture already in it.
  function tapCell(i) {
    const r = inPlacePhase();
    if (r < 0) return;
    const d = loadDraft(r);
    if (sel && sel.k === 'item') {
      d[i] = sel.id; // a picture already there goes back to the tray
      sel = null;
      Sound.drop();
    } else if (d[i] !== -1) {
      sel = { k: 'item', id: d[i] };
      d[i] = -1;
      Sound.pick();
    } else {
      sel = sel && sel.k === 'cell' && sel.i === i ? null : { k: 'cell', i };
      Sound.tap();
    }
    saveDraft();
    render();
  }

  // Tap a picture in the tray: pick it up, or put it in the box chosen first.
  function tapItem(id) {
    const r = inPlacePhase();
    if (r < 0) return;
    const d = loadDraft(r);
    if (d.includes(id)) return;
    if (sel && sel.k === 'cell') {
      d[sel.i] = id;
      sel = null;
      Sound.drop();
    } else {
      sel = sel && sel.k === 'item' && sel.id === id ? null : { k: 'item', id };
      Sound.tap();
    }
    saveDraft();
    render();
  }

  function pressDone(r) {
    const d = loadDraft(r);
    const empty = d.filter((v) => v === -1).length;
    if (empty > 0 && Date.now() - doneArmed > 3000) {
      doneArmed = Date.now();
      toast(empty + (empty === 1 ? ' box is' : ' boxes are') + ' still empty. Tap Done again to finish');
      return;
    }
    doneArmed = 0;
    submit(r, false);
  }

  function submit(r, timeUp) {
    const mine = seatOf(state, me.id);
    if (mine < 0 || state.ans[r][mine]) return;
    const next = clone(state);
    next.ans[r][mine] = loadDraft(r).slice();
    store.del(draftKey(r));
    store.del(startKey(r));
    draft = null;
    draftFor = '';
    sel = null;
    commit(next);
    if (timeUp) { Sound.aww(); showBanner("Time's up! ⏰", 'Your answers are locked in 🔒', '#e8590c', 1600); }
    else Sound.start();
  }

  function pressReady(r) {
    const mine = seatOf(state, me.id);
    if (mine < 0 || state.ready[r][mine]) return;
    if (!linkOk()) { toast('Reconnecting… one sec 📶'); return; }
    Sound.unlock();
    Sound.tap();
    const next = clone(state);
    next.ready[r][mine] = 1;
    commit(next);
  }

  function playAgain() {
    if (!state || state.players.length < 2) return;
    const next = clone(state);
    next.game += 1;
    next.gs = randId(8);
    next.grids = makeGrids();
    Object.assign(next, freshRounds());
    finalOpen = false;
    commit(next);
  }

  // ---------- State changes ----------
  function saveState() {
    if (room && state) store.set('state.' + room, JSON.stringify(state));
  }

  function loadState(code) {
    try {
      const s = JSON.parse(store.get('state.' + code) || 'null');
      return validState(s, code) ? s : null;
    } catch (e) {
      return null;
    }
  }

  function commit(next) {
    const prev = state;
    state = next;
    saveState();
    afterState(prev, true);
    render();
    sendState();
  }

  function applyState(next) {
    const prev = state;
    state = next;
    saveState();
    afterState(prev, false);
    render();
  }

  function afterState(prev, byMe) {
    const s = state;
    if (!s) return;
    const mine = seatOf(s, me.id);
    if (prev && prev.gs !== s.gs) {
      finalOpen = false;
      sel = null;
      draft = null;
      draftFor = '';
      if (!byMe && mine >= 0 && prev.players.length === 2) toast(nameOf(s, 1 - mine) + ' started a new game! 🔁');
    }
    if (prev && prev.players.length < 2 && s.players.length === 2 && mine >= 0) {
      Sound.start();
      showBanner("Let's play! 🧠", nameOf(s, 1 - mine) + (s.players[0].id === me.id ? ' joined!' : ' is here!'), SEAT_COLORS[1 - mine], 1800);
    }
    checkSeat();
  }

  function checkSeat() {
    const s = state;
    if (!room || !s) return;
    const mine = seatOf(s, me.id);
    if (mine >= 0) {
      if (me.name && s.players[mine].name !== me.name) {
        const next = clone(s);
        next.players[mine].name = me.name;
        bumpPlayers(next);
        commit(next);
      }
      return;
    }
    if (s.players.length < 2) { claimSeat(); return; }
    if (!presenceReady) return;
    // Same name, other device offline: that's you on a new phone or browser.
    const same = s.players.findIndex((p, seat) => p.name.trim().toLowerCase() === me.name.trim().toLowerCase() && !isOnline(s, seat));
    if (same >= 0) takeSeat(same);
  }

  function claimSeat() {
    const next = clone(state);
    next.players.push({ id: me.id, name: me.name || 'Player 2' });
    bumpPlayers(next);
    commit(next);
  }

  function takeSeat(seat) {
    if (!state || !state.players[seat]) return;
    const next = clone(state);
    next.players[seat] = { id: me.id, name: me.name || next.players[seat].name };
    bumpPlayers(next);
    commit(next);
  }

  // ---------- Network ----------
  async function getClient() {
    if (sb) return sb;
    for (let i = 0; i < 100 && !(window.supabase && window.supabase.createClient); i++) await wait(100);
    if (!(window.supabase && window.supabase.createClient)) return null;
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      // A quicker heartbeat notices a dead connection (e.g. after the phone slept) sooner.
      realtime: { params: { eventsPerSecond: 20 }, heartbeatIntervalMs: 10000 },
    });
    return sb;
  }

  async function connect(code) {
    const sess = session;
    const client = await getClient();
    if (sess !== session) return;
    if (!client) {
      connFails = 9;
      refreshChrome();
      toast("Couldn't load the game server. Check your internet and reload 🙏");
      return;
    }
    const ch = client.channel(CHANNEL_PREFIX + code, {
      config: { broadcast: { self: false, ack: true }, presence: { key: me.id } },
    });
    channel = ch;
    ch.on('broadcast', { event: 'state' }, (msg) => { if (channel === ch) safe(() => onStateMsg(msg.payload)); })
      .on('presence', { event: 'sync' }, () => { if (channel === ch) safe(onPresence); })
      .subscribe((status, err) => {
        dlog('channel', status, err ? String(err.message || err) : '', channel === ch ? '' : '(stale)');
        if (channel !== ch) return;
        if (status === 'SUBSCRIBED') {
          connected = true;
          connLostAt = 0;
          connFails = 0;
          ch.track({ id: me.id, name: me.name }).catch(() => {});
          sendState();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (connected) connLostAt = Date.now();
          connected = false;
          connFails += 1;
        }
        refreshChrome();
      });
  }

  async function send(event, payload, tries) {
    const ch = channel;
    for (let i = 0; i < tries; i++) {
      if (!ch || channel !== ch) return false;
      try {
        if ((await ch.send({ type: 'broadcast', event, payload })) === 'ok') return true;
      } catch (e) { /* retry below */ }
      await wait(700 * (i + 1));
    }
    return false;
  }

  // With no game yet, this doubles as "hello, send me the game".
  const sendState = () => send('state', { from: me.id, state }, state ? 4 : 2);

  function heard(id) {
    if (typeof id !== 'string' || id === me.id) return;
    const wasOnline = recentlySeen(id) || online.has(id);
    lastSeen.set(id, Date.now());
    if (!wasOnline) refreshChrome();
  }

  function onStateMsg(p) {
    if (!p || p.from === me.id) return;
    heard(p.from);
    const theirs = p.state && validState(p.state) ? p.state : null;
    if (!theirs) { if (state) sendState(); return; }
    const merged = merge(state, theirs);
    if (sig(merged) !== sig(state)) applyState(merged);
    if (sig(state) !== sig(theirs)) sendState(); // they're missing something we have
  }

  function onPresence() {
    const ids = new Set();
    for (const [key, metas] of Object.entries(channel.presenceState())) {
      ids.add(key);
      if (Array.isArray(metas)) metas.forEach((m) => { if (m && typeof m.id === 'string') ids.add(m.id); });
    }
    online = ids;
    presenceReady = true;
    refreshChrome();
    checkSeat();
  }

  function syncTick() {
    if (!room || !channel) return;
    render(); // lets stale "online" marks expire
    if (!connected) return;
    ticks += 1;
    if (ticks % 6 === 0) channel.track({ id: me.id, name: me.name }).catch(() => {}); // heal a lost presence
    sendState();
  }

  // Timers and the countdown move on their own, between messages.
  function frameTick() {
    if (!room || !state) return;
    const v = getView();
    if (v.kind !== 'play') return;
    const c = clockOf(v.r);
    if (c.phase === 'up' || state.gs + ':' + v.r + ':' + c.phase !== shownPhase) { render(); return; }
    updateClock(c);
  }

  // ---------- Rooms ----------
  function genCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(4);
    crypto.getRandomValues(buf);
    return 'GRID-' + Array.from(buf, (v) => abc[v % abc.length]).join('');
  }

  function parseRoom(str) {
    if (!str) return null;
    let c = String(str).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length === 8 && c.startsWith('GRID')) c = c.slice(4);
    return /^[A-Z0-9]{4}$/.test(c) ? 'GRID-' + c : null;
  }

  const profileQuery = PROFILE ? 'profile=' + PROFILE : '';
  function setUrl(code) {
    const q = [code ? 'room=' + code : '', profileQuery].filter(Boolean).join('&');
    try { history.replaceState(null, '', location.pathname + (q ? '?' + q : '')); } catch (e) { /* ignore */ }
  }

  function leaveRoom() {
    session += 1;
    const ch = channel;
    channel = null;
    if (ch && sb) sb.removeChannel(ch).catch(() => {});
    connected = false;
    connLostAt = 0;
    connFails = 0;
    online = new Set();
    lastSeen = new Map();
    presenceReady = false;
    room = null;
    state = null;
    sel = null;
    draft = null;
    draftFor = '';
    finalOpen = false;
    shownPhase = '';
    stageKey = '';
    hideBanner();
  }

  function enterRoom(code, fresh) {
    leaveRoom();
    room = code;
    enteredAt = Date.now();
    store.set('last', code);
    setUrl(code);
    state = fresh || loadState(code);
    if (fresh) saveState();
    if (state) {
      // Rounds finished before this visit don't replay their reveal.
      for (let r = 0; r < ROUNDS.length; r++) if (bothDone(state, r)) revealed.add(state.gs + ':' + r);
      // Coming back to a finished game: start on the results card, without the fanfare again.
      if (curRound(state) > LAST) { finalOpen = true; finalFx = state.gs; }
    }
    render();
    afterState(null, false);
    connect(code);
  }

  function goHome() {
    leaveRoom();
    setUrl(null);
    render();
    showHome(null);
  }

  function showHome(linkCode) {
    $('#nameInput').value = me.name;
    $('#homeErr').textContent = '';
    $('#joinFromLink').hidden = !linkCode;
    $('#mainActions').hidden = !!linkCode;
    if (linkCode) {
      $('#linkCode').textContent = linkCode;
      const saved = loadState(linkCode);
      $('#joinLinkBtn').textContent = saved && seatOf(saved, me.id) >= 0 ? '▶ Continue game' : 'Join Game';
      $('#joinLinkBtn').dataset.code = linkCode;
    }
    const last = store.get('last');
    const saved = last ? loadState(last) : null;
    const cont = $('#continueBtn');
    const mine = seatOf(saved, me.id);
    cont.hidden = !saved || mine < 0;
    if (!cont.hidden) {
      cont.textContent = saved.players.length === 2 ? '▶ Continue game with ' + nameOf(saved, 1 - mine) : '▶ Continue game ' + last;
      cont.dataset.code = last;
    }
  }

  function requireName() {
    const name = clip($('#nameInput').value.trim().replace(/\s+/g, ' '), 14);
    if (!name) {
      $('#homeErr').textContent = 'Type your name first 🙂';
      $('#nameInput').focus();
      return false;
    }
    me.name = name;
    store.set('name', name);
    return true;
  }

  // ---------- Updates ----------
  // When a newer version is published, offer a one-tap refresh so both phones play the same game.
  let updateOffered = false;
  async function checkForUpdate() {
    if (!BUILD || updateOffered) return;
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const v = (await r.json()).v;
      if (Number.isInteger(v) && v > BUILD) {
        updateOffered = true;
        $('#update').hidden = false;
      }
    } catch (e) { /* offline: try again later */ }
  }

  // ---------- Sharing ----------
  const shareLink = () => location.origin + location.pathname + '?room=' + room;

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ---------- Events ----------
  board.addEventListener('click', (ev) => {
    const cell = ev.target.closest('.cell');
    if (cell && board.classList.contains('placing')) tapCell(Number(cell.dataset.i));
  });

  panel.addEventListener('click', (ev) => {
    const b = ev.target.closest('.titem');
    if (b && !b.disabled) tapItem(Number(b.dataset.id));
  });

  $('#createBtn').addEventListener('click', () => {
    if (!requireName()) return;
    Sound.unlock();
    const code = genCode();
    enterRoom(code, newGame(code));
  });

  $('#joinLinkBtn').addEventListener('click', (ev) => {
    if (!requireName()) return;
    Sound.unlock();
    enterRoom(ev.currentTarget.dataset.code);
  });

  $('#continueBtn').addEventListener('click', (ev) => {
    if (!requireName()) return;
    Sound.unlock();
    enterRoom(ev.currentTarget.dataset.code);
  });

  function joinByCode() {
    const code = parseRoom($('#codeInput').value);
    if (!code) {
      $('#homeErr').textContent = 'That code looks wrong. It looks like GRID-AB12 🙂';
      return;
    }
    if (!requireName()) return;
    Sound.unlock();
    enterRoom(code);
  }

  $('#joinCodeBtn').addEventListener('click', joinByCode);
  $('#codeInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') joinByCode(); });
  $('#nameInput').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (!$('#joinFromLink').hidden) $('#joinLinkBtn').click();
    else $('#createBtn').click();
  });

  $('#notThisGame').addEventListener('click', () => {
    setUrl(null);
    showHome(null);
  });

  $('#homeBtn').addEventListener('click', goHome);
  $('#lookBack').addEventListener('click', goHome);
  $('#seatBack').addEventListener('click', goHome);

  $('#muteBtn').addEventListener('click', () => {
    const m = !Sound.isMuted();
    Sound.setMuted(m);
    $('#muteBtn').textContent = m ? '🔇' : '🔊';
    if (!m) { Sound.unlock(); Sound.start(); }
  });

  $('#waBtn').addEventListener('click', () => {
    const text = "Let's play Memory Grid! 🧠 Join my game: " + shareLink();
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  });

  $('#copyBtn').addEventListener('click', async () => {
    if (await copyText(shareLink())) toast('Link copied! 📋 Send it to your partner');
    else toast('Copy failed. The code is ' + room);
  });

  $('#shareBtn').addEventListener('click', () => {
    navigator.share({ title: 'Memory Grid 🧠', text: "Let's play Memory Grid! 🧠", url: shareLink() }).catch(() => {});
  });

  $('#againBtn').addEventListener('click', playAgain);
  $('#finalPeek').addEventListener('click', () => { finalOpen = false; render(); });

  $('#update').addEventListener('click', () => {
    // A fresh query string skips any cached copy of the page.
    const q = [room ? 'room=' + encodeURIComponent(room) : '', profileQuery, 'u=' + Date.now()].filter(Boolean).join('&');
    location.replace(location.pathname + '?' + q);
  });

  document.addEventListener('pointerdown', () => Sound.resume(), { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    checkForUpdate();
    if (room && channel && connected) sendState();
    if (room) render();
  });
  window.addEventListener('unhandledrejection', (e) => console.warn('memgrid:', e.reason));

  if (window.ResizeObserver) new ResizeObserver(fitAll).observe(boardWrap);
  window.addEventListener('resize', fitAll);

  // Read-only peek for debugging in the console.
  window.memgrid = {
    get state() { return state; },
    get view() { return getView(); },
    get connected() { return connected; },
    get online() { return [...online]; },
    get log() { return debugLog.slice(); },
    get socket() { return sb && sb.realtime ? sb.realtime.connectionState() : null; },
    build: BUILD,
  };

  // ---------- Boot ----------
  $('#muteBtn').textContent = Sound.isMuted() ? '🔇' : '🔊';
  render();
  showHome(parseRoom(new URLSearchParams(location.search).get('room')));
  setInterval(syncTick, 5000);
  setInterval(frameTick, 100);
  setTimeout(checkForUpdate, 4000);
  setInterval(checkForUpdate, 10 * 60 * 1000);
})();
