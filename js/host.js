// ============================================================
//  MURDER MYSTERY — host control panel
// ============================================================
//
//  This page is the trusted party in the whole design. It signs
//  in with a real email/password account, which is the only
//  identity the security rules let read /stories. It therefore:
//
//    - reads the story, its characters and its clues
//    - deals the characters and writes each player's card into
//      sessions/{code}/private/{that player's uid}
//    - copies a clue's text into the session when releasing it
//    - advances the phase
//
//  Players' phones do none of that. They cannot: every path this
//  file touches under /stories is admin-only.
//
//  Because this page holds every secret, treat the screen itself
//  as the security boundary — the solution panel starts blurred.
// ============================================================

import {
  waitForAuth, signInHost, signOutNow, describeError,
  db, paths, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, writeBatch, arrayUnion,
  STORY_ID, PHASES, PHASE_IDS, phaseMeta, nextPhase,
  ROLES, ROLE_FIELDS, rolesForPlayerCount, MIN_PLAYERS, MAX_PLAYERS,
  generateRoomCode, IS_FILE_PROTOCOL
} from './firebase-init.js';

const $ = sel => document.querySelector(sel);

const state = {
  user:      null,
  story:     null,   // story metadata (admin-only read)
  chars:     [],     // full character list, secrets and all
  cluesByPhase: [],  // [{ phase, clues:[…] }]
  code:      null,
  session:   null,
  players:   [],
  votes:     [],
  cast:      []      // uid → character mapping, after dealing
};

const unsub = { session: null, players: null, votes: null };

const LAST = 'mm:host-room';

// ------------------------------------------------------------
//  Chrome
// ------------------------------------------------------------

function view(name) {
  ['login', 'setup', 'game'].forEach(v => { $(`#${v}-view`).hidden = (v !== name); });
  $('#boot').hidden = true;
}

function toast(msg, bad = false) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

// ------------------------------------------------------------
//  Sign in
// ------------------------------------------------------------

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn'), err = $('#login-error');
  err.hidden = true; btn.disabled = true;
  try {
    state.user = await signInHost($('#email').value, $('#password').value);
    await afterSignIn();
  } catch (ex) {
    err.textContent = describeError(ex);
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

['#setup-signout', '#game-signout'].forEach(sel =>
  $(sel).addEventListener('click', async () => {
    detach();
    localStorage.removeItem(LAST);
    await signOutNow();
    location.reload();
  })
);

// ------------------------------------------------------------
//  Story load
//
//  Three admin-only reads. A player's token is refused on all of
//  them, which is what makes it safe for the clue text to sit
//  here in the host's memory.
// ------------------------------------------------------------

async function loadStory() {
  const snap = await getDoc(paths.story());
  if (!snap.exists()) throw new Error(`Story "${STORY_ID}" not found. Run admin/seed.html first.`);
  state.story = snap.data();

  const chars = await getDocs(paths.characters());
  state.chars = chars.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order || 99) - (b.order || 99));

  const phases = await getDocs(paths.storyPhases());
  const byId = Object.fromEntries(phases.docs.map(d => [d.id, d.data()]));
  state.cluesByPhase = PHASE_IDS
    .map(id => ({ phase: id, name: phaseMeta(id).label, clues: (byId[id]?.clues) || [] }))
    .filter(g => g.clues.length);
}

async function afterSignIn() {
  try {
    await loadStory();
  } catch (ex) {
    view('setup');
    $('#setup-error').textContent = ex.code ? describeError(ex) : ex.message;
    $('#setup-error').hidden = false;
    return;
  }

  $('#setup-who').textContent = state.user.email;
  $('#setup-title').textContent = state.story.title || STORY_ID;
  $('#setup-synopsis').textContent = state.story.synopsis || '';
  $('#setup-meta').textContent =
    `${state.story.minPlayers}–${state.story.maxPlayers} players · ` +
    `${state.story.difficulty} · ${state.story.estimatedTime} · ` +
    `${state.chars.length} characters`;

  // Resume a room this browser opened earlier.
  const last = localStorage.getItem(LAST);
  if (last) {
    const s = await getDoc(paths.session(last));
    if (s.exists()) { await attach(last); return; }
    localStorage.removeItem(LAST);
  }
  view('setup');
}

// ------------------------------------------------------------
//  Open a room
//
//  The document id IS the room code, so a collision would mean
//  hijacking a live game. Reroll until the id is free.
// ------------------------------------------------------------

$('#create-btn').addEventListener('click', async () => {
  const btn = $('#create-btn');
  btn.disabled = true;
  try {
    let code = null;
    for (let i = 0; i < 8 && !code; i++) {
      const candidate = generateRoomCode();
      const existing = await getDoc(paths.session(candidate));
      if (!existing.exists()) code = candidate;
    }
    if (!code) throw new Error('Could not find a free room code. Try again.');

    // storyTitle and storySynopsis are copied here on purpose:
    // players are not allowed to read /stories, so this document
    // is where the public half of the story reaches them.
    await setDoc(paths.session(code), {
      roomCode:      code,
      storyId:       STORY_ID,
      storyTitle:    state.story.title || '',
      storySynopsis: state.story.synopsis || '',
      status:        'open',
      currentPhase:  'lobby',
      revealedClues: [],
      hostUid:       state.user.uid,
      createdAt:     serverTimestamp()
    });

    localStorage.setItem(LAST, code);
    await attach(code);
    toast(`Room ${code} is open.`);
  } catch (ex) {
    $('#setup-error').textContent = ex.code ? describeError(ex) : ex.message;
    $('#setup-error').hidden = false;
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
  view('game');

  $('#roomcode').textContent = code;
  $('#play-url').textContent = `${location.origin}/play.html`;

  unsub.session = onSnapshot(paths.session(code), snap => {
    if (!snap.exists()) { closedElsewhere(); return; }
    state.session = snap.data();
    renderPhase();
    renderClues();
  }, err => toast(describeError(err), true));

  unsub.players = onSnapshot(paths.players(code), snap => {
    state.players = snap.docs
      .map(d => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (a.joinedAt?.seconds || 0) - (b.joinedAt?.seconds || 0));
    renderRoster();
  }, err => toast(describeError(err), true));

  unsub.votes = onSnapshot(paths.votes(code), snap => {
    state.votes = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    renderVotes();
  }, err => toast(describeError(err), true));

  // Reloading the host page mid-game would otherwise lose the cast,
  // taking the roles off the roster and emptying the solution panel.
  // The reveal document already holds it, and the host can always
  // read that one.
  try {
    const rev = await getDoc(paths.reveal(code));
    if (rev.exists() && Array.isArray(rev.data().cast)) {
      state.cast = rev.data().cast;
      renderRoster();
      renderVotes();
      renderSpoiler();
    }
  } catch { /* not dealt yet */ }
}

function detach() {
  Object.keys(unsub).forEach(k => { if (unsub[k]) { unsub[k](); unsub[k] = null; } });
}

function closedElsewhere() {
  detach();
  localStorage.removeItem(LAST);
  state.code = state.session = null;
  view('setup');
  toast('That room no longer exists.', true);
}

// ------------------------------------------------------------
//  Dealing
// ------------------------------------------------------------

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pick one character per required role, lowest `order` first, so a
// 4-player game gets the four parts the story leans on.
function pickCharacters(count) {
  const needed = rolesForPlayerCount(count);
  const pool = {};
  state.chars.forEach(c => { (pool[c.role] ||= []).push(c); });

  const chosen = [];
  const shortfall = [];
  needed.forEach(role => {
    const next = (pool[role] || []).shift();
    if (next) chosen.push(next); else shortfall.push(role);
  });

  if (shortfall.length) {
    const counts = shortfall.reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {});
    const text = Object.entries(counts).map(([r, n]) => `${n} more ${r}`).join(', ');
    throw new Error(`This story cannot seat ${count} players — it needs ${text}.`);
  }
  return chosen;
}

// Build the document that goes to one player's phone. Explicitly
// constructed field by field: a character could grow a new secret
// field tomorrow and it still would not reach anyone unless
// ROLE_FIELDS says that role sees it.
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

  try {
    const players = state.players;
    const n = players.length;
    if (n < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players.`);
    if (n > MAX_PLAYERS) throw new Error(`No more than ${MAX_PLAYERS} players.`);
    if (state.story.minPlayers && n < state.story.minPlayers) {
      throw new Error(`This story needs at least ${state.story.minPlayers} players.`);
    }
    if (state.story.maxPlayers && n > state.story.maxPlayers) {
      throw new Error(`This story seats at most ${state.story.maxPlayers} players.`);
    }

    const chosen = shuffle(pickCharacters(n));
    const batch = writeBatch(db);
    const cast = [];

    players.forEach((p, i) => {
      const ch = chosen[i];

      // The private card — readable only by this player's own uid.
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
    const sol = state.story.solution || {};
    batch.set(paths.reveal(state.code), {
      killerId: sol.killerId || (chosen.find(c => c.role === ROLES.KILLER)?.id ?? ''),
      headline: sol.headline || '',
      method:   sol.method   || '',
      motive:   sol.motive   || '',
      epilogue: sol.epilogue || '',
      cast
    });

    batch.update(paths.session(state.code), {
      status: 'live',
      currentPhase: 'arrival',
      startedAt: serverTimestamp()
    });

    await batch.commit();
    state.cast = cast;
    renderSpoiler();
    toast(`Dealt ${n} characters. Envelopes are on their phones.`);
  } catch (ex) {
    toast(ex.code ? describeError(ex) : ex.message, true);
    btn.disabled = false;
  }
});

// ------------------------------------------------------------
//  Pacing
// ------------------------------------------------------------

$('#advance-btn').addEventListener('click', async () => {
  const next = nextPhase(state.session?.currentPhase);
  if (!next) return;
  await setPhase(next);
});

$('#reveal-btn').addEventListener('click', async () => {
  if (!confirm('Jump straight to the reveal? This ends the game for everyone.')) return;
  await setPhase('reveal');
});

async function setPhase(phase) {
  const btn = $('#advance-btn');
  btn.disabled = true;
  try {
    await updateDoc(paths.session(state.code), {
      currentPhase: phase,
      ...(phase === 'reveal' ? { status: 'ended' } : {})
    });
    toast(`Phase: ${phaseMeta(phase).label}`);
  } catch (ex) {
    toast(describeError(ex), true);
  } finally {
    btn.disabled = false;
  }
}

$('#close-btn').addEventListener('click', async () => {
  if (!confirm('Close this room? Players will be returned to the join screen.')) return;
  try {
    // Subcollections are not removed by deleting the parent, but
    // the rules make every one of them unreachable without the
    // session document, so nothing is left readable.
    await deleteDoc(paths.session(state.code));
    localStorage.removeItem(LAST);
  } catch (ex) {
    toast(describeError(ex), true);
  }
});

// ------------------------------------------------------------
//  Clue release
// ------------------------------------------------------------

async function releaseClue(clue, btn) {
  btn.disabled = true;
  try {
    // arrayUnion copies the clue's text into the session document.
    // Until this moment that text existed only under /stories,
    // which no player can read.
    await updateDoc(paths.session(state.code), {
      revealedClues: arrayUnion({ id: clue.id, title: clue.title, text: clue.text })
    });
    toast(`Released: ${clue.title}`);
  } catch (ex) {
    toast(describeError(ex), true);
    btn.disabled = false;
  }
}

// ------------------------------------------------------------
//  Rendering
// ------------------------------------------------------------

function renderRoster() {
  const ul = $('#roster');
  ul.innerHTML = '';
  const byUid = Object.fromEntries(state.cast.map(c => [c.uid, c]));

  state.players.forEach(p => {
    const li = document.createElement('li');

    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = p.name;
    li.appendChild(nm);

    if (p.characterName) {
      const ch = document.createElement('span');
      ch.className = 'pchar';
      ch.textContent = `· ${p.characterName}`;
      li.appendChild(ch);
    }

    const role = byUid[p.uid]?.role;
    if (role) {
      const r = document.createElement('span');
      r.className = `prole ${role}`;
      r.textContent = role.toLowerCase();
      li.appendChild(r);
    }

    ul.appendChild(li);
  });

  const n = state.players.length;
  $('#roster-count').textContent = n ? String(n) : '';
  $('#roster-empty').hidden = n > 0;

  const started = state.session && state.session.status !== 'open';
  const btn = $('#start-btn');
  btn.disabled = started || n < MIN_PLAYERS || n > MAX_PLAYERS;
  btn.textContent = started ? 'Game in progress' : 'Start game';

  $('#start-hint').textContent = started
    ? ''
    : n < MIN_PLAYERS
      ? `${MIN_PLAYERS - n} more player${MIN_PLAYERS - n === 1 ? '' : 's'} needed.`
      : n > MAX_PLAYERS
        ? `Too many players — ${MAX_PLAYERS} is the maximum.`
        : `Ready to deal ${n}.`;
}

function renderPhase() {
  const cur = state.session?.currentPhase || 'lobby';
  const i = PHASE_IDS.indexOf(cur);

  const ul = $('#phase-list');
  ul.innerHTML = '';
  PHASES.forEach((p, idx) => {
    const li = document.createElement('li');
    li.textContent = p.label;
    if (idx < i) li.className = 'done';
    if (idx === i) li.className = 'now';
    ul.appendChild(li);
  });

  $('#phase-now').textContent = phaseMeta(cur).label;
  $('#phase-blurb').textContent = phaseMeta(cur).blurb;

  const started = state.session && state.session.status !== 'open';
  const next = nextPhase(cur);
  const adv = $('#advance-btn');
  adv.disabled = !started || !next;
  adv.textContent = next ? `Advance to ${phaseMeta(next).label}` : 'Game complete';
  $('#reveal-btn').disabled = !started || cur === 'reveal';

  $('#votes-panel').hidden = !(cur === 'accusation' || cur === 'reveal');
  renderSpoiler();
}

function renderClues() {
  const out = new Set((state.session?.revealedClues || []).map(c => c.id));
  const host = $('#clue-list');
  host.innerHTML = '';

  let total = 0;
  state.cluesByPhase.forEach(group => {
    const h = document.createElement('p');
    h.className = 'phase-group';
    h.textContent = group.name;
    host.appendChild(h);

    const ul = document.createElement('ul');
    ul.className = 'clues';

    group.clues.forEach(clue => {
      total++;
      const li = document.createElement('li');
      li.className = 'clue' + (out.has(clue.id) ? ' is-out' : '');

      const text = document.createElement('div');
      const t = document.createElement('h4');
      t.textContent = clue.title || '';
      const p = document.createElement('p');
      p.textContent = clue.text || '';
      text.append(t, p);

      const btn = document.createElement('button');
      btn.className = 'btn sm' + (out.has(clue.id) ? ' ghost' : '');
      btn.textContent = out.has(clue.id) ? 'Released' : 'Release';
      btn.disabled = out.has(clue.id) || !state.session || state.session.status === 'open';
      btn.addEventListener('click', () => releaseClue(clue, btn));

      li.append(text, btn);
      ul.appendChild(li);
    });

    host.appendChild(ul);
  });

  $('#clue-count').textContent = `${out.size} / ${total}`;
}

function renderVotes() {
  const names = Object.fromEntries(state.cast.map(c => [c.characterId, c.characterName]));

  const counts = {};
  state.votes.forEach(v => { counts[v.suspectId] = (counts[v.suspectId] || 0) + 1; });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 1;

  const ul = $('#tally');
  ul.innerHTML = '';
  entries.forEach(([charId, n]) => {
    const li = document.createElement('li');

    const label = document.createElement('span');
    label.textContent = names[charId] || charId;
    label.style.minWidth = '9rem';
    li.appendChild(label);

    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('span');
    fill.style.width = `${(n / max) * 100}%`;
    bar.appendChild(fill);
    li.appendChild(bar);

    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = String(n);
    li.appendChild(num);

    ul.appendChild(li);
  });

  const detective = state.cast.find(c => c.role === ROLES.DETECTIVE);
  const dv = detective && state.votes.find(v => v.uid === detective.uid);
  $('#vote-count').textContent = detective
    ? (dv ? 'detective has accused' : 'detective still deciding')
    : `${state.votes.length}`;

  $('#tally-empty').hidden = entries.length > 0;
}

function renderSpoiler() {
  const body = $('#spoiler-body');
  body.innerHTML = '';

  if (!state.cast.length) {
    const p = document.createElement('p');
    p.className = 'small dim';
    p.textContent = 'Start a game to deal the cast.';
    body.appendChild(p);
    return;
  }

  const sol = state.story?.solution || {};
  const killer = state.cast.find(c => c.characterId === sol.killerId);

  const h = document.createElement('p');
  h.textContent = killer
    ? `${killer.characterName} — played by ${killer.playerName}`
    : (sol.headline || '');
  h.style.color = '#c0504d';
  body.appendChild(h);

  if (sol.method) {
    const m = document.createElement('p');
    m.className = 'small';
    m.textContent = sol.method;
    body.appendChild(m);
  }

  const ul = document.createElement('ul');
  ul.className = 'roster';
  state.cast.forEach(c => {
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = c.characterName;
    const who = document.createElement('span');
    who.className = 'pchar';
    who.textContent = `· ${c.playerName}`;
    const r = document.createElement('span');
    r.className = `prole ${c.role}`;
    r.textContent = c.role.toLowerCase();
    li.append(nm, who, r);
    ul.appendChild(li);
  });
  body.appendChild(ul);
}

$('#spoiler-btn').addEventListener('click', () => {
  const box = $('#spoiler');
  const hidden = box.classList.toggle('is-hidden');
  $('#spoiler-btn').textContent = hidden ? 'Show' : 'Hide';
});

// ------------------------------------------------------------
//  Start
// ------------------------------------------------------------

(async function start() {
  if (IS_FILE_PROTOCOL) {
    $('#boot').textContent = 'Open this page from its web address, not from a file.';
    return;
  }

  const user = await waitForAuth();
  if (user && !user.isAnonymous) {
    state.user = user;
    await afterSignIn();
  } else {
    view('login');
  }
})();
