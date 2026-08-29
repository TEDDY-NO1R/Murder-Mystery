// ============================================================
//  MURDER MYSTERY — player client
// ============================================================
//
//  This file runs on every guest's phone, so treat everything in
//  it as public. It contains no story text whatsoever. Every word
//  a player reads is fetched from Firestore against their own
//  anonymous auth token:
//
//    session doc      → phase, and clues the host has released
//    players/*        → the lobby list and the ballot (no secrets)
//    private/{my uid} → this player's character, and only theirs
//    reveal/summary   → refused by the rules until phase = reveal
//
//  There is no client-side filtering of secrets anywhere below,
//  because no secrets ever arrive. If a fetch is refused, we show
//  a message; we never "hide" data we were given.
// ============================================================

import {
  waitForAuth, signInPlayer, describeError,
  paths, getDoc, setDoc, getDocs, onSnapshot, serverTimestamp,
  normaliseRoomCode, CODE_LENGTH, phaseMeta, ROLE_FIELDS, ROLES,
  IS_FILE_PROTOCOL
} from './firebase-init.js';

const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

// ------------------------------------------------------------
//  State
// ------------------------------------------------------------

const state = {
  uid:      null,
  code:     null,   // room code, which is also the session doc id
  session:  null,   // live session document
  players:  [],     // live roster (public fields only)
  card:     null,   // this player's private character document
  vote:     null,   // characterId this player voted for
  screen:   null
};

const unsub = { session: null, players: null, card: null };

// Per-device memory. Notes and "have I opened my envelope" are
// deliberately local — there is no Firestore path a player is
// allowed to write them to, and they don't belong on the server.
const store = {
  key: (k) => `mm:${state.code}:${state.uid}:${k}`,
  get(k, fallback = null) {
    try { const v = localStorage.getItem(this.key(k)); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(this.key(k), JSON.stringify(v)); } catch { /* private mode */ } }
};

// Remember the last room so a refresh mid-game doesn't drop the
// player back to the join form.
const LAST = 'mm:last-room';

// ------------------------------------------------------------
//  Screens
// ------------------------------------------------------------

function show(name) {
  if (state.screen === name) return;
  state.screen = name;
  $('#boot').classList.toggle('is-on', name === 'boot');
  $$('#app .screen').forEach(s => s.classList.toggle('is-on', s.dataset.screen === name));
  $('#app').hidden = (name === 'boot');
  window.scrollTo(0, 0);
}

function boot(msg) {
  $('#boot-msg').textContent = msg;
  show('boot');
}

// Decide which screen the current state implies. Called on every
// snapshot, so the phone follows the host without any polling.
function route() {
  if (!state.code || !state.session) return show('join');

  const phase = state.session.currentPhase || 'lobby';

  if (phase === 'lobby')  return show('lobby');
  if (phase === 'reveal') return show('reveal');

  // Past the lobby but the host hasn't dealt us in — a late join,
  // or a player who was removed.
  if (!state.card) return boot('Waiting for the host to deal you in');

  if (!store.get('opened', false)) return show('envelope');
  if (phase === 'arrival' && !store.get('read', false)) return show('card');
  if (phase === 'accusation') return show('vote');

  return show('game');
}

// ------------------------------------------------------------
//  Join
// ------------------------------------------------------------

const codeInput = $('#code');
codeInput.addEventListener('input', () => {
  const clean = normaliseRoomCode(codeInput.value);
  if (clean !== codeInput.value) codeInput.value = clean;
});

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#join-btn');
  const err = $('#join-error');
  err.hidden = true;
  btn.disabled = true;

  const code = normaliseRoomCode(codeInput.value);
  const name = $('#name').value.trim().slice(0, 24);

  try {
    if (code.length !== CODE_LENGTH) throw new Error(`Room codes are ${CODE_LENGTH} letters.`);
    if (!name) throw new Error('Enter the name you want on the table.');

    const snap = await getDoc(paths.session(code));
    if (!snap.exists()) throw new Error('No game with that code. Check with the host.');

    const session = snap.data();
    if (session.status && session.status !== 'open') {
      throw new Error('That game has already begun.');
    }

    // Rules allow exactly these two fields, and require joinedAt to
    // be the server's clock — a phone cannot backdate itself to the
    // front of the queue.
    await setDoc(paths.player(code, state.uid), {
      name,
      joinedAt: serverTimestamp()
    });

    localStorage.setItem(LAST, code);
    await attach(code);
  } catch (e2) {
    err.textContent = e2.code ? describeError(e2) : e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------
//  Live listeners
// ------------------------------------------------------------

async function attach(code) {
  detach();
  state.code = code;

  unsub.session = onSnapshot(paths.session(code),
    snap => {
      if (!snap.exists()) { leave('The host ended this game.'); return; }
      state.session = snap.data();
      renderSession();
      route();
    },
    err => fail(err)
  );

  unsub.players = onSnapshot(paths.players(code),
    snap => {
      state.players = snap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .sort((a, b) => (a.joinedAt?.seconds || 0) - (b.joinedAt?.seconds || 0));
      renderLobby();
      renderBallot();
    },
    err => fail(err)
  );

  // The load-bearing read. If someone tampered with this path to
  // point at another player, Firestore refuses it outright and we
  // land in fail() — there is nothing to filter client-side.
  unsub.card = onSnapshot(paths.private(code, state.uid),
    snap => {
      state.card = snap.exists() ? snap.data() : null;
      renderCard();
      route();
    },
    err => fail(err)
  );
}

function detach() {
  Object.keys(unsub).forEach(k => { if (unsub[k]) { unsub[k](); unsub[k] = null; } });
}

function fail(err) {
  console.error(err);
  boot(describeError(err));
}

function leave(message) {
  detach();
  localStorage.removeItem(LAST);
  state.code = state.session = state.card = null;
  show('join');
  const err = $('#join-error');
  if (message) { err.textContent = message; err.hidden = false; }
}

// ------------------------------------------------------------
//  Rendering
// ------------------------------------------------------------

function renderSession() {
  const s = state.session;
  const meta = phaseMeta(s.currentPhase);

  $('#lobby-code').textContent     = state.code;
  $('#lobby-title').textContent    = s.storyTitle || 'Gathering';
  $('#lobby-synopsis').textContent = s.storySynopsis || '';

  $('#game-phase').textContent = meta.label;
  $('#game-blurb').textContent = meta.blurb;

  renderClues();
  if (s.currentPhase === 'reveal') renderReveal();
}

function renderLobby() {
  const list = $('#lobby-players');
  list.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name;
    if (p.uid === state.uid) li.classList.add('is-you');
    list.appendChild(li);
  });
  $('#lobby-count').textContent = state.players.length ? `· ${state.players.length}` : '';
}

// Build one labelled block of the character card.
function field(label, value, isPrivate) {
  const wrap = document.createElement('div');
  wrap.className = 'field' + (isPrivate ? ' is-private' : '');

  const h = document.createElement('p');
  h.className = 'field-label';
  h.textContent = label;
  wrap.appendChild(h);

  if (Array.isArray(value)) {
    const ul = document.createElement('ul');
    value.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;          // textContent, never innerHTML
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
  } else {
    const p = document.createElement('p');
    p.className = 'field-body';
    p.textContent = value;
    wrap.appendChild(p);
  }
  return wrap;
}

const FIELD_LABELS = {
  bio:              'Who you are',
  secret:           'Your secret',
  objective:        'Your objective',
  coverStory:       'Your alibi',
  clueConnections:  'What you have pieced together',
  protectObjective: 'What you must protect'
};

// Fields that only exist for one role, drawn with the red rule.
const PRIVATE_FIELDS = new Set(['secret', 'coverStory', 'clueConnections', 'protectObjective']);

// `header` is false when the target already sits inside a card
// that has its own name and role printed above it.
function buildCard(into, { header = true } = {}) {
  into.innerHTML = '';
  const c = state.card;
  if (!c) return;

  if (header) {
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = c.role || '';
    into.appendChild(eyebrow);

    const h = document.createElement('h2');
    h.className = 'display sm';
    h.textContent = c.name || '';
    into.appendChild(h);

    if (c.title) {
      const t = document.createElement('p');
      t.className = 'card-title';
      t.textContent = c.title;
      into.appendChild(t);
    }

    const hr = document.createElement('hr');
    hr.className = 'rule thin';
    into.appendChild(hr);
  }

  // Drive off ROLE_FIELDS rather than "render whatever arrived", so
  // the card can't grow a field just because the data did.
  const order = ROLE_FIELDS[c.role] || ROLE_FIELDS[ROLES.SUSPECT];
  order.forEach(key => {
    if (key === 'name') return;
    const value = c[key];
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value) && !value.length) return;
    into.appendChild(field(FIELD_LABELS[key] || key, value, PRIVATE_FIELDS.has(key)));
  });
}

function renderCard() {
  if (!state.card) return;
  $('#envelope-name').textContent = state.card.name || 'You';
  $('#card-role').textContent  = state.card.role || '';
  $('#card-name').textContent  = state.card.name || '';
  $('#card-title').textContent = state.card.title || '';
  buildCard($('#card-fields'), { header: false });
  buildCard($('#game-card'));
  $('#game-whoami').textContent = state.card.name || 'Your card';
}

function renderClues() {
  const clues = state.session?.revealedClues || [];
  const feed = $('#clue-feed');
  feed.innerHTML = '';

  clues.forEach((clue, i) => {
    const li = document.createElement('li');

    const n = document.createElement('p');
    n.className = 'clue-num';
    n.textContent = `Clue ${i + 1}`;
    li.appendChild(n);

    const t = document.createElement('h3');
    t.className = 'clue-title';
    t.textContent = clue.title || '';
    li.appendChild(t);

    const p = document.createElement('p');
    p.className = 'clue-text';
    p.textContent = clue.text || '';
    li.appendChild(p);

    feed.appendChild(li);
  });

  $('#clue-empty').hidden = clues.length > 0;
  const badge = $('#clue-count');
  badge.textContent = clues.length;
  badge.toggleAttribute('data-zero', clues.length === 0);
}

// ------------------------------------------------------------
//  Envelope
// ------------------------------------------------------------

$('#envelope').addEventListener('click', () => {
  const env = $('#envelope');
  if (env.classList.contains('is-open')) return;
  env.classList.add('is-open');
  $('#envelope-hint').textContent = 'Opening…';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {
    store.set('opened', true);
    route();
  }, reduced ? 0 : 950);
});

$('#card-done').addEventListener('click', () => {
  store.set('read', true);
  route();
});

// ------------------------------------------------------------
//  Tabs
// ------------------------------------------------------------

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.toggle('is-on', t === tab));
    $$('.tab-panel').forEach(p => p.classList.toggle('is-on', p.dataset.panel === tab.dataset.tab));
  });
});

$('#game-whoami').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="you"]').click();
});

// Notepad — this phone only, never transmitted.
const notepad = $('#notepad');
notepad.addEventListener('input', () => store.set('notes', notepad.value));

// ------------------------------------------------------------
//  Vote
// ------------------------------------------------------------

let picked = null;

function renderBallot() {
  const list = $('#ballot');
  if (!list) return;
  list.innerHTML = '';

  // Candidates are the other players' public character names. A
  // player's own document carries no role, so nothing here reveals
  // anything — it is the same information as the seating plan.
  const candidates = state.players.filter(p => p.characterId && p.uid !== state.uid);

  if (!candidates.length) {
    $('#vote-status').textContent = 'Waiting for the host to deal.';
    return;
  }

  candidates.forEach(p => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(picked === p.characterId));
    btn.disabled = !!state.vote;

    const who = document.createElement('span');
    who.textContent = p.characterName || p.characterId;
    btn.appendChild(who);

    const sub = document.createElement('span');
    sub.className = 'who';
    sub.textContent = p.name;
    btn.appendChild(sub);

    btn.addEventListener('click', () => {
      picked = p.characterId;
      renderBallot();
      $('#vote-btn').disabled = false;
    });

    li.appendChild(btn);
    list.appendChild(li);
  });

  $('#vote-btn').disabled = !picked || !!state.vote;
}

$('#vote-btn').addEventListener('click', async () => {
  if (!picked || state.vote) return;
  const btn = $('#vote-btn');
  btn.disabled = true;
  try {
    // Rules accept this only during the accusation phase, only from
    // a player who actually joined, and only for themselves.
    await setDoc(paths.vote(state.code, state.uid), {
      suspectId: picked,
      castAt: serverTimestamp()
    });
    state.vote = picked;
    $('#vote-status').textContent = 'Accusation recorded. Wait for the reveal.';
    renderBallot();
  } catch (err) {
    $('#vote-status').textContent = describeError(err);
    btn.disabled = false;
  }
});

// ------------------------------------------------------------
//  Reveal
// ------------------------------------------------------------

let revealed = false;

async function renderReveal() {
  if (revealed) return;
  revealed = true;

  const body = $('#reveal-body');
  const castList = $('#reveal-cast');

  try {
    // Before this moment the rules refuse this document — not
    // because the app hid it, but because sessions/{code}.currentPhase
    // was not yet 'reveal'.
    const snap = await getDoc(paths.reveal(state.code));
    if (!snap.exists()) { body.textContent = 'The host has not written a reveal for this game.'; return; }
    const r = snap.data();

    const cast = r.cast || [];
    const detective = cast.find(c => c.role === ROLES.DETECTIVE);
    let verdict = 'The case is closed.';
    let cls = '';

    if (detective) {
      const votes = await getDocs(paths.votes(state.code));
      const dv = votes.docs.find(d => d.id === detective.uid);
      const guess = dv?.data()?.suspectId;
      if (!guess) {
        verdict = 'The detective never named anyone.';
        cls = 'lose';
      } else if (guess === r.killerId) {
        verdict = 'The detective was right. The innocents win.';
        cls = 'win';
      } else {
        verdict = 'The detective was wrong. The killer walks free.';
        cls = 'lose';
      }
    }

    const v = $('#reveal-verdict');
    v.textContent = verdict;
    v.className = cls;

    body.innerHTML = '';
    if (r.headline) body.appendChild(field('What happened', r.headline, false));
    if (r.method)   body.appendChild(field('How', r.method, false));
    if (r.motive)   body.appendChild(field('Why', r.motive, false));
    if (r.epilogue) body.appendChild(field('And', r.epilogue, false));

    castList.innerHTML = '';
    cast.forEach(c => {
      const li = document.createElement('li');

      const nm = document.createElement('span');
      nm.textContent = c.characterName || c.characterId;
      li.appendChild(nm);

      const who = document.createElement('span');
      who.className = 'cast-player';
      who.textContent = c.playerName ? `· ${c.playerName}` : '';
      li.appendChild(who);

      const role = document.createElement('span');
      role.className = `role ${c.role}`;
      role.textContent = c.role === ROLES.KILLER ? 'the killer' : String(c.role || '').toLowerCase();
      li.appendChild(role);

      castList.appendChild(li);
    });
  } catch (err) {
    revealed = false;            // let a later snapshot retry
    body.textContent = describeError(err);
    console.error(err);
  }
}

// ------------------------------------------------------------
//  Start
// ------------------------------------------------------------

(async function start() {
  if (IS_FILE_PROTOCOL) {
    boot('Open this page from its web address, not from a file.');
    return;
  }

  boot('Lighting the lamps');

  try {
    await waitForAuth();
    const user = await signInPlayer();
    state.uid = user.uid;
  } catch (err) {
    boot(describeError(err));
    return;
  }

  // Rejoin the last room automatically, but only if we're still on
  // its roster — otherwise fall through to the join form.
  const last = localStorage.getItem(LAST);
  if (last) {
    state.code = last;               // needed for the store key
    try {
      const mine = await getDoc(paths.player(last, state.uid));
      if (mine.exists()) {
        notepad.value = store.get('notes', '');
        const myVote = await getDoc(paths.vote(last, state.uid));
        if (myVote.exists()) { state.vote = myVote.data().suspectId; picked = state.vote; }
        await attach(last);
        return;
      }
    } catch { /* fall through to join */ }
    state.code = null;
    localStorage.removeItem(LAST);
  }

  show('join');
})();
