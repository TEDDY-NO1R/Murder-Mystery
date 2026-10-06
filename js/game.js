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
  PHASE_IDS, phaseMeta, nextPhase,
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
  closing:   false   // host pressed "Close room"
};

const unsub = { session: null, players: null, card: null, votes: null };

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
  $('#host-open').disabled = !pickedStory || !$('#host-name').value.trim();
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

$('#host-open').addEventListener('click', async () => {
  const btn = $('#host-open');
  btn.disabled = true;
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
      state.session = snap.data();
      state.isHost = state.session.hostUid === state.uid;
      if (state.isHost) watchVotes(code);
      renderSession();
      renderLobby();
      route();
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
  picked = null;
  revealed = false;

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

  let status = phaseMeta(phase).label;
  if (phase === 'accusation') status += ` · ${state.voteCount} of ${dealt} have accused`;
  else if (phase !== 'reveal' && left !== null) status += ` · ${left} clue${left === 1 ? '' : 's'} left to release`;
  $('#hb-status').textContent = status;

  const clueBtn = $('#hb-clue');
  clueBtn.hidden = phase === 'reveal';
  clueBtn.disabled = left === 0;
  clueBtn.textContent = left === 0 ? 'No clues left' : 'Release a clue';

  const nextBtn = $('#hb-next');
  nextBtn.hidden = !next;
  nextBtn.textContent = next === 'reveal' ? 'Reveal the truth' : (next ? `Next: ${phaseMeta(next).label}` : '');

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
  for (const col of [paths.players(code), paths.privates(code), paths.votes(code)]) {
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
