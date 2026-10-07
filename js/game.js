// ============================================================
//  MURDER MYSTERY — the one page everyone uses
// ============================================================
//
//  Every guest joins with a room code. Any guest can instead
//  host: pick a story, open a room, and play like everyone else.
//
//  The host's phone does the dealing — it reads the story's
//  characters, shuffles them, and writes each player's card to
//  sessions/{code}/private/{that player's uid}. It also releases
//  clues and moves the phases on. None of that is ever drawn on
//  the host's screen: the host sees buttons and counts, and
//  learns each clue, card and the ending at the same moment as
//  everyone else. (The data does pass through the host's
//  browser, so this relies on the host not digging for it.)
//
//    session doc      → phase, and clues the host has released
//    players/*        → the lobby list and the ballot (no secrets)
//    private/{my uid} → this player's character, and only theirs
//    reveal/summary   → refused by the rules until phase = reveal
// ============================================================

import {
  waitForAuth, signInPlayer, describeError,
  db, paths, getDoc, setDoc, updateDoc, deleteDoc, getDocs, onSnapshot,
  serverTimestamp, writeBatch, arrayUnion,
  normaliseRoomCode, generateRoomCode, CODE_LENGTH,
  PHASE_IDS, SEARCH_PHASES, phaseMeta, nextPhase,
  ROLES, ROLE_FIELDS, rolesForPlayerCount, MIN_PLAYERS, MAX_PLAYERS,
  IS_FILE_PROTOCOL
} from './firebase-init.js';

const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

// ------------------------------------------------------------
//  State
// ------------------------------------------------------------

const state = {
  uid:       null,
  code:      null,   // room code, which is also the session doc id
  session:   null,   // live session document
  players:   [],     // live roster (public fields only)
  card:      null,   // this player's private character document
  vote:      null,   // characterId this player voted for
  screen:    null,
  isHost:    false,  // did this player open the room?
  voteCount: 0,      // host only: how many have accused (not for whom)
  hostClues: null,   // host only: the story's clues, in release order — never rendered
  stories:   [],     // the story picker
  closing:   false,  // host pressed "Close room"

  // Searching the house
  locations: null,   // the story's rooms, loaded once the game starts — only your own finds are ever rendered
  searches:  [],     // who searched where, every round (public)
  claims:    {},     // findId → uid of the player holding it
  shared:    [],     // evidence shown to the table
  lastResult: null,  // what your most recent search turned up
  searching: false
};

const unsub = {
  session: null, players: null, card: null, votes: null,
  searches: null, finds: null, shared: null
};

let picked = null;       // ballot choice not yet submitted
let pickedStory = null;  // story chosen on the host screen
let revealed = false;    // reveal already fetched for this room

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
  renderHostControls();
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

    // Already on this roster (e.g. came back after leaving the page):
    // just take the seat again. The rules only allow a rename here.
    const mine = await getDoc(paths.player(code, state.uid));
    if (mine.exists()) {
      if (mine.data().name !== name) await updateDoc(paths.player(code, state.uid), { name });
    } else {
      const session = snap.data();
      if (session.status !== 'open' || session.currentPhase !== 'lobby') {
        throw new Error('That game has already begun.');
      }

      // Rules allow exactly these two fields, require joinedAt to be
      // the server's clock, and refuse the write once the lobby has
      // closed — the check above is only a friendlier message.
      await setDoc(paths.player(code, state.uid), {
        name,
        joinedAt: serverTimestamp()
      });
    }

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
//  Host: choose a story and open a room
// ------------------------------------------------------------

$('#host-start').addEventListener('click', async () => {
  $('#join-error').hidden = true;
  $('#host-error').hidden = true;
  if (!$('#host-name').value) $('#host-name').value = $('#name').value;
  show('host');
  await loadStories();
});

$('#host-back').addEventListener('click', () => show('join'));
$('#host-name').addEventListener('input', syncHostOpen);

function syncHostOpen() {
  $('#host-open').disabled = openingRoom || !pickedStory || !$('#host-name').value.trim();
}

// Only stories the editor has published. The picker shows title,
// blurb and table size — nothing from inside the story.
async function loadStories() {
  const list = $('#story-list');
  $('#story-loading').hidden = false;
  list.innerHTML = '';
  try {
    const snap = await getDocs(paths.stories());
    state.stories = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(s => s.status === 'published')
      .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  } catch (err) {
    state.stories = [];
    hostError(describeError(err));
  }
  $('#story-loading').hidden = true;
  if (!state.stories.some(s => s.id === pickedStory)) pickedStory = state.stories[0]?.id || null;
  renderStories();
}

function renderStories() {
  const list = $('#story-list');
  list.innerHTML = '';

  if (!state.stories.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'No stories are ready to play yet.';
    list.appendChild(li);
  }

  state.stories.forEach(s => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(pickedStory === s.id));

    const t = document.createElement('span');
    t.className = 'story-title';
    t.textContent = s.title || s.id;
    btn.appendChild(t);

    if (s.synopsis) {
      const b = document.createElement('span');
      b.className = 'story-blurb';
      b.textContent = s.synopsis;
      btn.appendChild(b);
    }

    const m = document.createElement('span');
    m.className = 'story-meta';
    m.textContent = [
      `${s.minPlayers || MIN_PLAYERS}–${s.maxPlayers || MAX_PLAYERS} players`,
      s.estimatedTime
    ].filter(Boolean).join(' · ');
    btn.appendChild(m);

    btn.addEventListener('click', () => { pickedStory = s.id; renderStories(); });
    li.appendChild(btn);
    list.appendChild(li);
  });

  syncHostOpen();
}

function hostError(msg) {
  $('#host-error').textContent = msg;
  $('#host-error').hidden = false;
}

// Opening a room takes several round trips (a free code, the room,
// clearing leftovers, your seat), so say so — and keep the button
// locked until it is done, whatever else is tapped meanwhile.
let openingRoom = false;

$('#host-open').addEventListener('click', async () => {
  if (openingRoom) return;
  const btn = $('#host-open');
  openingRoom = true;
  btn.disabled = true;
  btn.textContent = 'Opening the room…';
  $('#host-error').hidden = true;

  const name = $('#host-name').value.trim().slice(0, 24);
  const story = state.stories.find(s => s.id === pickedStory);

  try {
    if (!story) throw new Error('Choose a story first.');
    if (!name) throw new Error('Enter the name you want on the table.');

    // The document id IS the room code. Reroll until it is free —
    // the rules also refuse to let anyone but its host overwrite a
    // live room.
    let code = null;
    for (let i = 0; i < 8 && !code; i++) {
      const candidate = generateRoomCode();
      if (!(await getDoc(paths.session(candidate))).exists()) code = candidate;
    }
    if (!code) throw new Error('Could not find a free room code. Try again.');

    // Title and blurb are copied here so the lobby needs nothing
    // from the story itself.
    await setDoc(paths.session(code), {
      roomCode:      code,
      storyId:       story.id,
      storyTitle:    story.title || '',
      storySynopsis: story.synopsis || '',
      status:        'open',
      currentPhase:  'lobby',
      revealedClues: [],
      hostUid:       state.uid,
      createdAt:     serverTimestamp()
    });

    // A code whose earlier room was never cleaned up may still have
    // children. Clear them so an old roster, card or vote cannot
    // leak into this room. (Done after creating the room, because
    // the rules let only this room's host delete them.)
    await purgeRoom(code);

    await setDoc(paths.player(code, state.uid), { name, joinedAt: serverTimestamp() });

    localStorage.setItem(LAST, code);
    await attach(code);
  } catch (ex) {
    hostError(ex.code ? describeError(ex) : ex.message);
  } finally {
    openingRoom = false;
    btn.textContent = 'Open the room';
    syncHostOpen();
  }
});

// ------------------------------------------------------------
//  Live listeners
// ------------------------------------------------------------

async function attach(code) {
  detach();
  resetRoomState();
  state.code = code;
  keepAwake();

  // Per-room memory: notes from this phone, and a vote already cast
  // (votes are final, so the ballot must stay locked after a refresh).
  notepad.value = store.get('notes', '');
  try {
    const myVote = await getDoc(paths.vote(code, state.uid));
    if (myVote.exists()) { state.vote = myVote.data().suspectId; picked = state.vote; }
  } catch { /* no vote yet */ }
  if (state.code !== code) return;   // left again while loading

  unsub.session = onSnapshot(paths.session(code),
    snap => {
      if (!snap.exists()) { leave(state.closing ? 'Room closed.' : 'The host ended this game.'); return; }
      const prev = state.session;
      state.session = snap.data();
      noticeSession(prev, state.session);
      renderTimer();
      state.isHost = state.session.hostUid === state.uid;
      if (state.isHost) watchVotes(code);
      if (state.session.status !== 'open' && state.locations === null) loadLocations();
      renderSession();
      renderLobby();
      renderSearch();
      route();
    },
    err => lost(err)
  );

  unsub.searches = onSnapshot(paths.searches(code),
    snap => {
      state.searches = snap.docs.map(d => d.data());
      renderSearch();
      renderHostControls();
    },
    err => lost(err)
  );

  unsub.finds = onSnapshot(paths.finds(code),
    snap => {
      state.claims = Object.fromEntries(snap.docs.map(d => [d.id, d.data().uid]));
      renderSearch();
    },
    err => lost(err)
  );

  unsub.shared = onSnapshot(paths.shared(code),
    snap => {
      state.shared = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.at?.seconds || 0) - (b.at?.seconds || 0));
      noticeShared(state.shared);
      renderClues();
      renderSearch();
    },
    err => lost(err)
  );

  unsub.players = onSnapshot(paths.players(code),
    snap => {
      state.players = snap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .sort((a, b) => (a.joinedAt?.seconds || 0) - (b.joinedAt?.seconds || 0));
      if (!state.players.some(p => p.uid === state.uid)) { leave(state.closing ? 'Room closed.' : GONE); return; }
      renderLobby();
      renderBallot();
      renderHostControls();
    },
    err => lost(err)
  );

  // Only ever this player's own card. Another player's path is
  // refused by the rules.
  unsub.card = onSnapshot(paths.private(code, state.uid),
    snap => {
      state.card = snap.exists() ? snap.data() : null;
      renderCard();
      renderSearch();
      route();
    },
    err => lost(err)
  );
}

// The host counts accusations so they know when to reveal. The
// count is all that is used — who voted for whom stays unread.
function watchVotes(code) {
  if (unsub.votes) return;
  unsub.votes = onSnapshot(paths.votes(code),
    snap => { state.voteCount = snap.size ?? snap.docs.length; renderHostControls(); },
    err => lost(err)
  );
}

function detach() {
  Object.keys(unsub).forEach(k => { if (unsub[k]) { unsub[k](); unsub[k] = null; } });
}

function fail(err) {
  console.error(err);
  boot(describeError(err));
}

const GONE = 'You are no longer in that room — the host ended the game or removed you.';

// A live listener died. Once a room is closed or we are removed
// from it, the rules refuse its documents — that is the expected
// end of the game, not an error to sit on.
function lost(err) {
  if (err?.code === 'permission-denied') { leave(state.closing ? 'Room closed.' : GONE); return; }
  fail(err);
}

function leave(message) {
  detach();
  localStorage.removeItem(LAST);
  forgetRoom();
  resetRoomState();
  show('join');
  const err = $('#join-error');
  if (message) { err.textContent = message; err.hidden = false; }
}

// Drop this phone's notes and envelope flags for a room that is
// over. Room codes can be reused, and a new game under the same
// code must not open with the old envelope already broken.
function forgetRoom() {
  if (!state.code) return;
  const prefix = store.key('');
  try {
    Object.keys(localStorage).filter(k => k.startsWith(prefix)).forEach(k => localStorage.removeItem(k));
  } catch { /* private mode */ }
}

// Wipe everything that belongs to one room — memory and screen —
// so a second game on the same phone starts exactly like the first.
function resetRoomState() {
  state.code = state.session = state.card = state.vote = null;
  state.players = [];
  state.isHost = false;
  state.voteCount = 0;
  state.hostClues = null;
  state.closing = false;
  state.locations = null;
  state.searches = [];
  state.claims = {};
  state.shared = [];
  state.lastResult = null;
  state.searching = false;
  picked = null;
  revealed = false;
  sharedSeen = null;
  timerRunning = timerAlerted = null;
  renderTimer();
  $('#notice').hidden = true;
  keepAwake();

  ['#rooms', '#evidence', '#search-result'].forEach(sel => { $(sel).innerHTML = ''; });
  $('#search-result').dataset.key = '';
  ['#search-status', '#evidence-count'].forEach(sel => { $(sel).textContent = ''; });
  $('#search-result').hidden = true;
  $('#search-error').hidden = true;
  $('#search-tab').hidden = true;
  $('#search-badge').toggleAttribute('data-zero', true);

  const env = $('#envelope');
  env.classList.remove('is-open');
  $('#envelope-hint').textContent = 'Tap to break the seal';
  $('#envelope-name').textContent = 'You';

  ['#lobby-players', '#clue-feed', '#ballot', '#card-fields',
   '#game-card', '#reveal-body', '#reveal-cast'].forEach(sel => { $(sel).innerHTML = ''; });
  ['#lobby-count', '#card-role', '#card-name', '#card-title',
   '#game-whoami', '#vote-status', '#start-hint'].forEach(sel => { $(sel).textContent = ''; });
  ['#start-error', '#hb-error'].forEach(sel => { $(sel).hidden = true; });

  $('#clue-empty').hidden = false;
  const badge = $('#clue-count');
  badge.textContent = '0';
  badge.toggleAttribute('data-zero', true);

  $('#vote-btn').disabled = true;
  const verdict = $('#reveal-verdict');
  verdict.textContent = '…';
  verdict.classList.remove('win', 'lose');

  notepad.value = '';
  document.querySelector('.tab[data-tab="clues"]').click();
  renderHostControls();
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
  const canKick = state.isHost && state.session?.currentPhase === 'lobby';

  state.players.forEach(p => {
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.textContent = p.name;
    li.appendChild(nm);
    if (p.uid === state.uid) li.classList.add('is-you');

    // The host can turn away someone who joined by mistake, or trim
    // an overfull room before dealing.
    if (canKick && p.uid !== state.uid) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'kick';
      kick.textContent = 'Remove';
      kick.addEventListener('click', () => removePlayer(p, kick));
      li.appendChild(kick);
    }
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

  // The fields get their own box (two columns on a desktop).
  // Without a header, `into` is already that box.
  const box = header
    ? into.appendChild(Object.assign(document.createElement('div'), { className: 'card-fields' }))
    : into;

  // Drive off ROLE_FIELDS rather than "render whatever arrived", so
  // the card can't grow a field just because the data did.
  const order = ROLE_FIELDS[c.role] || ROLE_FIELDS[ROLES.SUSPECT];
  order.forEach(key => {
    if (key === 'name') return;
    const value = c[key];
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value) && !value.length) return;
    box.appendChild(field(FIELD_LABELS[key] || key, value, PRIVATE_FIELDS.has(key)));
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

// The table's shared knowledge: clues the host released, then
// evidence players chose to show, each marked with who showed it.
function renderClues() {
  const clues = state.session?.revealedClues || [];
  const feed = $('#clue-feed');

  // Unchanged feed: leave it alone rather than replaying every
  // item's slide-in on each unrelated update.
  const key = [...clues.map(c => c.id), ...state.shared.map(s => s.id)].join('|');
  if (feed.dataset.key === key && feed.childElementCount) return;
  feed.dataset.key = key;
  feed.innerHTML = '';

  const item = (label, title, text, shared) => {
    const li = document.createElement('li');
    if (shared) li.className = 'is-shared';

    const n = document.createElement('p');
    n.className = 'clue-num';
    n.textContent = label;
    li.appendChild(n);

    const t = document.createElement('h3');
    t.className = 'clue-title';
    t.textContent = title || '';
    li.appendChild(t);

    const p = document.createElement('p');
    p.className = 'clue-text';
    p.textContent = text || '';
    li.appendChild(p);

    feed.appendChild(li);
  };

  clues.forEach((clue, i) => item(`Clue ${i + 1}`, clue.title, clue.text, false));
  state.shared.forEach(s => item(`Shown by ${s.name || 'a player'}`, s.title, s.text, true));

  const total = clues.length + state.shared.length;
  $('#clue-empty').hidden = total > 0;
  const badge = $('#clue-count');
  badge.textContent = total;
  badge.toggleAttribute('data-zero', total === 0);
}

// ------------------------------------------------------------
//  Search the house
//
//  One search per player per round. Each room holds evidence that
//  appears round by round; whoever searches first takes the next
//  piece, and later searchers find the room already gone through.
//  Who searched where is public; what they found is not, unless
//  they show it to the table.
// ------------------------------------------------------------

async function loadLocations() {
  if (state.locations !== null || !state.session) return;
  state.locations = [];            // mark as loading
  const code = state.code;
  try {
    const snap = await getDocs(paths.locations(state.session.storyId));
    if (state.code !== code) return;
    state.locations = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order || 99) - (b.order || 99));
  } catch (err) {
    console.error(err);
  }
  renderSearch();
  renderHostControls();
}

const nameOf = uid => state.players.find(p => p.uid === uid)?.name || 'Someone';
// Mid-sentence form: "You searched the doctor's study".
const roomName = id => (state.locations?.find(l => l.id === id)?.name || 'a room').replace(/^The /, 'the ');

// findId → { find, location } for this story
function findIndex() {
  const out = {};
  (state.locations || []).forEach(loc => (loc.finds || []).forEach(f => { out[f.id] = { find: f, loc }; }));
  return out;
}

function renderSearch() {
  const has = !!state.locations?.length && !!state.card && !!state.session;
  $('#search-tab').hidden = !has;
  if (!has) return;

  const phase = state.session.currentPhase;
  const searchable = SEARCH_PHASES.includes(phase);
  const mine = state.searches.find(s => s.uid === state.uid && s.phase === phase);
  const canSearch = searchable && !mine && !state.searching;
  const laterRound = SEARCH_PHASES.indexOf(phase) < SEARCH_PHASES.length - 1;

  $('#search-badge').textContent = canSearch ? '1' : '';
  $('#search-badge').toggleAttribute('data-zero', !canSearch);

  $('#search-status').textContent = !searchable
    ? 'The searching is over. Use what you know.'
    : state.searching
      ? 'Searching…'
      : mine
        ? `You searched ${roomName(mine.locationId)} this round. ${laterRound ? 'You can search again next round.' : 'That was your last search.'}`
        : 'You may search one room this round. Choose carefully — whoever gets there first takes what is hidden.';

  // Result of your latest search, for the round it happened in.
  // Rebuilt only when it changes, so it doesn't re-animate every
  // time someone else's search arrives.
  const res = $('#search-result');
  const r = state.lastResult;
  const key = r && r.phase === phase ? `${r.phase}:${r.locationId}:${r.find?.id || ''}` : '';
  res.hidden = !key;
  if (res.dataset.key !== key) {
    res.dataset.key = key;
    res.innerHTML = '';
  }
  if (key && !res.firstChild) {
    if (r.find) {
      const card = document.createElement('div');
      card.className = 'parchment';
      const e = document.createElement('p');
      e.className = 'eyebrow';
      e.textContent = `Found in ${roomName(r.locationId)}`;
      const h = document.createElement('h3');
      h.className = 'clue-title';
      h.style.color = 'var(--ink)';
      h.textContent = r.find.title || '';
      const p = document.createElement('p');
      p.style.margin = '0';
      p.textContent = r.find.text || '';
      card.append(e, h, p);
      res.appendChild(card);
    } else {
      const p = document.createElement('p');
      p.className = 'nothing';
      p.textContent = r.before.length
        ? `Nothing new in ${roomName(r.locationId)}. ${r.before.join(' and ')} searched here before you.`
        : `You search ${roomName(r.locationId)} thoroughly and find nothing of interest.`;
      res.appendChild(p);
    }
  }

  // Rooms, with public footprints.
  const rooms = $('#rooms');
  rooms.innerHTML = '';
  state.locations.forEach(loc => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.disabled = !canSearch;

    const n = document.createElement('span');
    n.className = 'room-name';
    n.textContent = loc.name || loc.id;
    btn.appendChild(n);

    if (loc.blurb) {
      const b = document.createElement('span');
      b.className = 'room-blurb';
      b.textContent = loc.blurb;
      btn.appendChild(b);
    }

    const who = [...new Set(state.searches.filter(s => s.locationId === loc.id).map(s => nameOf(s.uid)))];
    if (who.length) {
      const st = document.createElement('span');
      st.className = 'room-steps';
      st.textContent = `Searched by ${who.join(', ')}`;
      btn.appendChild(st);
    }

    btn.addEventListener('click', () => doSearch(loc));
    li.appendChild(btn);
    rooms.appendChild(li);
  });

  // Your evidence — the only finds this phone ever draws.
  const idx = findIndex();
  const shownIds = new Set(state.shared.map(s => s.id));
  const myFinds = Object.entries(state.claims)
    .filter(([, uid]) => uid === state.uid)
    .map(([id]) => idx[id])
    .filter(Boolean);

  const list = $('#evidence');
  list.innerHTML = '';
  myFinds.forEach(({ find, loc }) => {
    const li = document.createElement('li');

    const w = document.createElement('p');
    w.className = 'ev-where';
    w.textContent = loc.name || loc.id;
    const t = document.createElement('h3');
    t.className = 'ev-title';
    t.textContent = find.title || '';
    const p = document.createElement('p');
    p.className = 'ev-text';
    p.textContent = find.text || '';
    li.append(w, t, p);

    if (shownIds.has(find.id)) {
      const s = document.createElement('p');
      s.className = 'ev-shown';
      s.textContent = 'Shown to the table';
      li.appendChild(s);
    } else if (state.session.status === 'live') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = 'Show the table';
      b.addEventListener('click', () => showEvidence(find, b));
      li.appendChild(b);
    }
    list.appendChild(li);
  });
  $('#evidence-count').textContent = myFinds.length ? `· ${myFinds.length}` : '';
  $('#evidence-empty').hidden = myFinds.length > 0;
}

async function doSearch(loc) {
  if (state.searching) return;
  if (!confirm(`Search ${roomName(loc.id)}? You get one search this round.`)) return;

  const code = state.code;
  const phase = state.session.currentPhase;
  const now = PHASE_IDS.indexOf(phase);
  const before = [...new Set(state.searches
    .filter(s => s.locationId === loc.id && s.uid !== state.uid)
    .map(s => nameOf(s.uid)))];

  state.searching = true;
  $('#search-error').hidden = true;
  renderSearch();

  try {
    let found = null;
    // Two tries: if someone claims the same piece a moment before
    // us, the rules refuse our batch and we take the next one.
    for (let attempt = 0; attempt < 2; attempt++) {
      const claimed = attempt === 0
        ? new Set(Object.keys(state.claims))
        : new Set((await getDocs(paths.finds(code))).docs.map(d => d.id));
      found = (loc.finds || []).find(f =>
        PHASE_IDS.indexOf(f.phase || 'arrival') <= now && !claimed.has(f.id)) || null;

      const batch = writeBatch(db);
      batch.set(paths.search(code, `${state.uid}_${phase}`), {
        uid: state.uid, locationId: loc.id, phase, findId: found ? found.id : null, at: serverTimestamp()
      });
      if (found) {
        batch.set(paths.find(code, found.id), {
          uid: state.uid, locationId: loc.id, phase, at: serverTimestamp()
        });
      }
      try {
        await batch.commit();
        break;
      } catch (ex) {
        if (attempt === 1 || ex.code !== 'permission-denied') throw ex;
      }
    }
    if (state.code !== code) return;
    state.lastResult = { phase, locationId: loc.id, find: found, before };
  } catch (ex) {
    const el = $('#search-error');
    el.textContent = ex.code ? describeError(ex) : ex.message;
    el.hidden = false;
  } finally {
    state.searching = false;
    renderSearch();
  }
}

async function showEvidence(find, btn) {
  if (!confirm('Show this to everyone? It will appear in every player\'s clue feed.')) return;
  btn.disabled = true;
  try {
    await setDoc(paths.share(state.code, find.id), {
      uid: state.uid,
      name: nameOf(state.uid),
      title: find.title || '',
      text: find.text || '',
      at: serverTimestamp()
    });
  } catch (ex) {
    btn.disabled = false;
    const el = $('#search-error');
    el.textContent = ex.code ? describeError(ex) : ex.message;
    el.hidden = false;
  }
}

// ------------------------------------------------------------
//  Table alerts, round timer, screen awake
//
//  Phones sit face down between turns. A new clue, a new phase,
//  evidence shown to the table, or the timer running out gets a
//  banner, a chime and a buzz — never on the first snapshot after
//  joining or a refresh, only for things that happen while you
//  are here. Sound is a per-phone choice.
// ------------------------------------------------------------

const SOUND = 'mm:sound';
const soundOn = () => { try { return localStorage.getItem(SOUND) !== 'off'; } catch { return true; } };

function renderSoundToggle() {
  const on = soundOn();
  $$('[data-sound]').forEach(b => {
    b.textContent = on ? 'Sound on' : 'Sound off';
    b.setAttribute('aria-pressed', String(on));
  });
}

$$('[data-sound]').forEach(b => b.addEventListener('click', () => {
  try { localStorage.setItem(SOUND, soundOn() ? 'off' : 'on'); } catch { /* private mode */ }
  renderSoundToggle();
  if (soundOn()) chime();
}));

// Browsers only allow audio after a tap, so the context is made on
// the first one and reused.
let audio = null;
document.addEventListener('pointerdown', () => {
  if (audio) return;
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
}, { once: true, capture: true });

// Two soft bell-ish notes, synthesised — no sound file to fetch.
function chime() {
  if (!audio || !soundOn()) return;
  try {
    if (audio.state === 'suspended') audio.resume();
    const t0 = audio.currentTime;
    [[659.25, 0], [987.77, .16]].forEach(([freq, at]) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(.18, t0 + at + .02);
      gain.gain.exponentialRampToValueAtTime(.0001, t0 + at + .9);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 1);
    });
  } catch { /* audio unavailable */ }
}

let noticeTimer = null;
function notify(message) {
  const el = $('#notice');
  el.textContent = message;
  el.hidden = false;
  // Restart the drop-in animation for back-to-back alerts.
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, 4500);
  chime();
  if (soundOn()) { try { navigator.vibrate?.([120, 60, 120]); } catch { /* unsupported */ } }
}

$('#notice').addEventListener('click', () => {
  $('#notice').hidden = true;
  if (state.screen === 'game') document.querySelector('.tab[data-tab="clues"]').click();
});

// Compare the previous session snapshot with the new one. `prev` is
// null on the first snapshot after attaching, which never alerts.
function noticeSession(prev, next) {
  if (!prev || !next) return;
  if (prev.currentPhase !== next.currentPhase) {
    const meta = phaseMeta(next.currentPhase);
    notify(next.currentPhase === 'reveal' ? 'The truth is revealed.' : `${meta.label} begins. ${meta.blurb}`);
    return;
  }
  const before = (prev.revealedClues || []).length;
  const after = (next.revealedClues || []).length;
  if (after > before) notify(after - before === 1 ? 'A new clue has been released.' : `${after - before} new clues released.`);
}

// Evidence someone else just showed. The first snapshot is the
// baseline, so a refresh doesn't announce everything again.
let sharedSeen = null;
function noticeShared(list) {
  const ids = new Set(list.map(s => s.id));
  if (sharedSeen) {
    const fresh = list.filter(s => !sharedSeen.has(s.id) && s.uid !== state.uid);
    if (fresh.length) notify(`${fresh[0].name || 'Someone'} has shown the table some evidence.`);
  }
  sharedSeen = ids;
}

// Round timer. The host writes { minutes, setAt: server time } and
// every phone counts down to setAt + minutes against its own clock —
// phone clocks are network-synced, so they agree to within a second
// or so, which is plenty for a parlour game.
let timerTick = null;
let timerRunning = null;   // key of a timer seen with time left
let timerAlerted = null;   // key of the timer already announced as done

function timerEnd(t) {
  if (!t?.minutes) return null;
  const start = t.setAt?.toMillis ? t.setAt.toMillis() : Date.now();   // pending local write
  return start + t.minutes * 60000;
}

function renderTimer() {
  const t = state.session?.timer;
  const phase = state.session?.currentPhase;
  const end = phase && phase !== 'lobby' && phase !== 'reveal' ? timerEnd(t) : null;

  if (!end) {
    clearInterval(timerTick); timerTick = null;
    $$('[data-timer]').forEach(el => { el.hidden = true; el.textContent = ''; });
    return;
  }

  const left = end - Date.now();
  const done = left <= 0;
  const secs = Math.max(0, Math.ceil(left / 1000));
  const text = done ? "Time's up" : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} left`;
  $$('[data-timer]').forEach(el => {
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('is-low', !done && secs <= 60);
    el.classList.toggle('is-done', done);
  });

  const key = `${t.minutes}:${t.setAt?.seconds ?? 'pending'}`;
  if (done) {
    clearInterval(timerTick); timerTick = null;
    // Only announce an ending we were counting towards — not one
    // that ran out while this phone was away.
    if (timerRunning === key && timerAlerted !== key) notify("Time's up for this round.");
    timerAlerted = key;
  } else {
    timerRunning = key;
    if (!timerTick) timerTick = setInterval(renderTimer, 1000);
  }
}

async function setTimer(minutes) {
  $('#hb-error').hidden = true;
  try {
    await updateDoc(paths.session(state.code), {
      timer: minutes ? { minutes, setAt: serverTimestamp() } : null
    });
  } catch (ex) { hostFail('#hb-error', ex); }
}

$$('#hb-timer [data-minutes]').forEach(b =>
  b.addEventListener('click', () => setTimer(Number(b.dataset.minutes))));
$('#hb-timer-stop').addEventListener('click', () => setTimer(0));

// Keep the screen from sleeping mid-game, where the browser allows
// it. The lock is dropped whenever the page is hidden, so take it
// again on return.
let wakeLock = null;
async function keepAwake() {
  const want = !!state.code && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* refused, e.g. battery saver */ }
}
document.addEventListener('visibilitychange', keepAwake);

// ------------------------------------------------------------
//  Host controls
//
//  Everything here shows counts and phase names only. Clue text
//  reaches the host's screen through the same feed as everyone
//  else's, after it has been released.
// ------------------------------------------------------------

function renderHostControls() {
  const s = state.session;
  const phase = s?.currentPhase || 'lobby';
  const hosting = state.isHost && !!s;

  // Lobby panel
  $('#lobby-host').hidden = !(hosting && phase === 'lobby');
  $('#lobby-waiting').hidden = hosting;
  if (hosting && phase === 'lobby') {
    const n = state.players.length;
    const min = Math.max(MIN_PLAYERS, storyMeta()?.minPlayers || 0);
    const max = Math.min(MAX_PLAYERS, storyMeta()?.maxPlayers || MAX_PLAYERS);
    $('#start-btn').disabled = n < min || n > max;
    $('#start-hint').textContent = n < min
      ? `${min - n} more player${min - n === 1 ? '' : 's'} needed (you count).`
      : n > max
        ? `Too many players — this story seats ${max}. Remove someone.`
        : `Ready to deal ${n} parts.`;
  }

  // In-game bar
  const bar = $('#host-bar');
  bar.hidden = !(hosting && phase !== 'lobby');
  document.body.classList.toggle('has-host-bar', !bar.hidden);
  if (bar.hidden) return;

  const next = nextPhase(phase);
  const dealt = state.players.filter(p => p.characterId).length;
  const left = cluesLeft();

  const parts = [phaseMeta(phase).label];
  if (phase === 'accusation') parts.push(`${state.voteCount} of ${dealt} have accused`);
  else if (phase !== 'reveal' && left !== null) parts.push(`${left} clue${left === 1 ? '' : 's'} to release`);
  if (SEARCH_PHASES.includes(phase) && state.locations?.length) {
    parts.push(`${state.searches.filter(s => s.phase === phase).length} of ${dealt} searched`);
  }
  $('#hb-status').textContent = parts.join(' · ');

  const clueBtn = $('#hb-clue');
  clueBtn.hidden = phase === 'reveal';
  clueBtn.disabled = left === 0;
  clueBtn.textContent = left === 0 ? 'No clues left' : 'Release a clue';

  const nextBtn = $('#hb-next');
  nextBtn.hidden = !next;
  nextBtn.textContent = next === 'reveal' ? 'Reveal the truth' : (next ? `Next: ${phaseMeta(next).label}` : '');

  $('#hb-timer').hidden = phase === 'reveal';
  $('#hb-timer-stop').hidden = !s.timer;

  if (hosting && state.hostClues === null) loadHostClues();
}

// Story details the lobby can use (table size). From the picker if
// this phone opened the room in this visit; otherwise unknown, and
// the start check falls back to the story itself.
function storyMeta() {
  return state.stories.find(s => s.id === state.session?.storyId) || null;
}

let cluesLoading = false;
async function loadHostClues() {
  if (cluesLoading || !state.session) return;
  cluesLoading = true;
  const code = state.code;
  try {
    const snap = await getDocs(paths.storyPhases(state.session.storyId));
    if (state.code !== code) return;
    const byId = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
    state.hostClues = PHASE_IDS.flatMap((id, phaseIdx) =>
      ((byId[id]?.clues) || []).map(c => ({ phaseIdx, id: c.id, title: c.title || '', text: c.text || '' })));
  } catch (err) {
    console.error(err);
    state.hostClues = [];
  } finally {
    cluesLoading = false;
  }
  renderHostControls();
}

// Clues from the current phase and earlier that are still unreleased.
function availableClues() {
  if (!state.hostClues || !state.session) return null;
  const now = PHASE_IDS.indexOf(state.session.currentPhase);
  const out = new Set((state.session.revealedClues || []).map(c => c.id));
  return state.hostClues.filter(c => c.phaseIdx <= now && !out.has(c.id));
}

function cluesLeft() {
  const a = availableClues();
  return a === null ? null : a.length;
}

function hostFail(where, ex) {
  const el = $(where);
  el.textContent = ex.code ? describeError(ex) : ex.message;
  el.hidden = false;
}

$('#hb-clue').addEventListener('click', async () => {
  const btn = $('#hb-clue');
  const next = (availableClues() || [])[0];
  if (!next) return;
  btn.disabled = true;
  $('#hb-error').hidden = true;
  try {
    // Copies the clue into the session, where every phone —
    // including this one — shows it in the feed.
    await updateDoc(paths.session(state.code), {
      revealedClues: arrayUnion({ id: next.id, title: next.title, text: next.text })
    });
  } catch (ex) { hostFail('#hb-error', ex); }
  renderHostControls();
});

$('#hb-next').addEventListener('click', async () => {
  const cur = state.session?.currentPhase;
  const next = nextPhase(cur);
  if (!next) return;
  if (next === 'reveal') {
    const dealt = state.players.filter(p => p.characterId).length;
    if (!confirm(`Reveal the truth to everyone? ${state.voteCount} of ${dealt} have accused.`)) return;
  }
  const btn = $('#hb-next');
  btn.disabled = true;
  $('#hb-error').hidden = true;
  try {
    await updateDoc(paths.session(state.code), {
      currentPhase: next,
      timer: null,                       // each round's timer is its own
      ...(next === 'reveal' ? { status: 'ended' } : {})
    });
  } catch (ex) { hostFail('#hb-error', ex); }
  btn.disabled = false;
});

async function closeRoom(btn) {
  if (!confirm('Close this room? Everyone will be returned to the join screen.')) return;
  btn.disabled = true;
  state.closing = true;
  try {
    await purgeRoom(state.code, { andSession: true });
  } catch (ex) {
    state.closing = false;
    btn.disabled = false;
    hostFail(state.session?.currentPhase === 'lobby' ? '#start-error' : '#hb-error', ex);
  }
}

$('#lobby-close').addEventListener('click', e => closeRoom(e.currentTarget));
$('#hb-close').addEventListener('click', e => closeRoom(e.currentTarget));

async function removePlayer(p, btn) {
  if (!confirm(`Remove ${p.name} from the room?`)) return;
  btn.disabled = true;
  try {
    await deleteDoc(paths.player(state.code, p.uid));
  } catch (ex) {
    btn.disabled = false;
    hostFail('#start-error', ex);
  }
}

// Firestore does not cascade deletes. Remove every child of a
// session explicitly, in chunks well under the 500-write batch
// limit. When `andSession` is set the session document goes in the
// final chunk, so players see "the host ended this game" only once
// nothing of it is left behind.
async function purgeRoom(code, { andSession = false } = {}) {
  const refs = [];
  for (const col of [paths.players(code), paths.privates(code), paths.votes(code),
                     paths.searches(code), paths.finds(code), paths.shared(code)]) {
    (await getDocs(col)).docs.forEach(d => refs.push(d.ref));
  }
  refs.push(paths.reveal(code));          // deleting a missing doc is a no-op
  if (andSession) refs.push(paths.session(code));

  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    refs.slice(i, i + 400).forEach(r => batch.delete(r));
    await batch.commit();
  }
}

// ------------------------------------------------------------
//  Host: dealing
//
//  The story is read, shuffled and written straight back out as
//  one card per player. Nothing from it is put on this screen.
// ------------------------------------------------------------

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// One character per required role, lowest `order` first, so a
// 4-player game gets the four parts the story leans on.
function pickCharacters(chars, count) {
  const needed = rolesForPlayerCount(count);
  const pool = {};
  chars.forEach(c => { (pool[c.role] ||= []).push(c); });

  const chosen = [];
  const shortfall = [];
  needed.forEach(role => {
    const next = (pool[role] || []).shift();
    if (next) chosen.push(next); else shortfall.push(role);
  });

  if (shortfall.length) {
    throw new Error(`This story cannot seat ${count} players. Try a different number of players.`);
  }
  return chosen;
}

// A story whose ending would contradict the cast cannot be dealt.
// The messages name roles only — never which character holds one.
function storyProblems(story, chars) {
  const out = [];
  const of = r => chars.filter(c => c.role === r);
  const killers = of(ROLES.KILLER);
  if (killers.length !== 1)                 out.push('it needs exactly one killer');
  if (of(ROLES.DETECTIVE).length !== 1)     out.push('it needs exactly one detective');
  if (of(ROLES.ACCOMPLICE).length > 1)      out.push('it has more than one accomplice');
  if (chars.some(c => !Object.values(ROLES).includes(c.role))) out.push('a character has no role');
  const solId = story.solution?.killerId;
  if (killers.length === 1 && solId && solId !== killers[0].id) out.push('its solution names the wrong character');
  return out;
}

// The document that goes to one player's phone. Built field by
// field: a character could grow a new field tomorrow and it still
// would not reach anyone unless ROLE_FIELDS says that role sees it.
function cardFor(character) {
  const allowed = ROLE_FIELDS[character.role] || ROLE_FIELDS[ROLES.SUSPECT];
  const card = {
    characterId: character.id,
    role:        character.role,
    name:        character.name || '',
    title:       character.title || ''
  };
  allowed.forEach(key => {
    if (key === 'name') return;
    const v = character[key];
    if (v !== undefined && v !== null && v !== '') card[key] = v;
  });
  return card;
}

$('#start-btn').addEventListener('click', async () => {
  const btn = $('#start-btn');
  btn.disabled = true;
  $('#start-error').hidden = true;

  try {
    const players = state.players;
    const n = players.length;

    const storySnap = await getDoc(paths.story(state.session.storyId));
    if (!storySnap.exists()) throw new Error('This story no longer exists.');
    const story = storySnap.data();

    if (n < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players.`);
    if (n > MAX_PLAYERS) throw new Error(`No more than ${MAX_PLAYERS} players.`);
    if (story.minPlayers && n < story.minPlayers) throw new Error(`This story needs at least ${story.minPlayers} players.`);
    if (story.maxPlayers && n > story.maxPlayers) throw new Error(`This story seats at most ${story.maxPlayers} players.`);

    const chars = (await getDocs(paths.characters(state.session.storyId))).docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order || 99) - (b.order || 99));

    const problems = storyProblems(story, chars);
    if (problems.length) {
      throw new Error(`This story isn't ready to play (${problems.join('; ')}). Ask the story editor to fix it.`);
    }

    const chosen = shuffle(pickCharacters(chars, n));
    const killer = chosen.find(c => c.role === ROLES.KILLER);
    const batch = writeBatch(db);
    const cast = [];

    players.forEach((p, i) => {
      const ch = chosen[i];

      // The private card — fetched only by this player's own phone.
      batch.set(paths.private(state.code, p.uid), cardFor(ch));

      // The public half: name and character only. No role, ever.
      // This is what builds everyone's ballot.
      batch.update(paths.player(state.code, p.uid), {
        characterId:   ch.id,
        characterName: ch.name || ch.id
      });

      cast.push({
        uid: p.uid,
        playerName: p.name,
        characterId: ch.id,
        characterName: ch.name || ch.id,
        role: ch.role
      });
    });

    // The answer. Written now, but the rules refuse every read of
    // it until currentPhase is actually 'reveal'.
    const sol = story.solution || {};
    batch.set(paths.reveal(state.code), {
      killerId: killer.id,
      headline: sol.headline || '',
      method:   sol.method   || '',
      motive:   sol.motive   || '',
      epilogue: sol.epilogue || '',
      cast
    });

    // castIds lets the rules check that a vote names someone really
    // in this game. Sorted so the list order says nothing about roles.
    batch.update(paths.session(state.code), {
      status: 'live',
      currentPhase: 'arrival',
      castIds: chosen.map(c => c.id).sort(),
      startedAt: serverTimestamp()
    });

    await batch.commit();
  } catch (ex) {
    hostFail('#start-error', ex);
    btn.disabled = false;
  }
});

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
  // Clear the pre-deal message once there is someone to accuse.
  $('#vote-status').textContent = state.vote ? 'Accusation recorded. Wait for the reveal.' : '';

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
    // a player who was dealt in, only for themselves, only once, and
    // only naming another character in this game.
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

async function renderReveal() {
  if (revealed) return;
  revealed = true;

  const code = state.code;   // a slow fetch must not paint into a later room
  const body = $('#reveal-body');
  const castList = $('#reveal-cast');

  try {
    // Before this moment the rules refuse this document, because
    // sessions/{code}.currentPhase was not yet 'reveal'.
    const snap = await getDoc(paths.reveal(code));
    if (state.code !== code) return;
    if (!snap.exists()) { body.textContent = 'The host has not written a reveal for this game.'; return; }
    const r = snap.data();

    const cast = r.cast || [];
    const detective = cast.find(c => c.role === ROLES.DETECTIVE);
    let verdict = 'The case is closed.';
    let cls = '';

    if (detective) {
      const votes = await getDocs(paths.votes(code));
      if (state.code !== code) return;
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
    v.classList.remove('win', 'lose');
    if (cls) v.classList.add(cls);

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
    if (state.code !== code) return;
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
  renderSoundToggle();

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
    try {
      const mine = await getDoc(paths.player(last, state.uid));
      if (mine.exists()) { await attach(last); return; }
    } catch { /* room gone — fall through to join */ }
    // The room ended while this phone was away: drop its notes and
    // envelope flags too, in case the code is ever reused.
    state.code = last;
    forgetRoom();
    state.code = null;
    localStorage.removeItem(LAST);
  }

  show('join');
})();
