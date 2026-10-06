// ============================================================
//  MURDER MYSTERY — story editor
// ============================================================
//
//  CRUD over /stories and its two subcollections. Writing any of
//  them needs the story-editor login on the allowlist in
//  firestore.rules; anyone else is bounced to the login page.
//
//  Only stories with status "published" appear in the host's
//  story list on the home page.
// ============================================================

import {
  waitForAuth, signOutNow, describeError,
  db, paths, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  deleteField, writeBatch,
  PHASES, PHASE_IDS, phaseMeta, ROLES, ROLE_FIELDS,
  MIN_PLAYERS, MAX_PLAYERS, IS_FILE_PROTOCOL
} from './firebase-init.js';

const $ = id => document.getElementById(id);

const state = {
  stories: [],     // [{id, ...meta}]
  id:      null,   // selected story id
  story:   null,
  chars:   [],
  phases:  {},     // phaseId -> { name, order, clues[] }
  editing: null    // character id being edited, or '' for new
};

// ------------------------------------------------------------
//  Chrome
// ------------------------------------------------------------

function toast(msg, bad = false) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function fail(ex) {
  toast(ex?.code ? describeError(ex) : (ex?.message || 'Something went wrong.'), true);
  console.error(ex);
}

// Tabs
document.querySelectorAll('#tabs li').forEach(li => {
  li.addEventListener('click', () => {
    document.querySelectorAll('#tabs li').forEach(x => x.classList.toggle('now', x === li));
    document.querySelectorAll('[data-panel]').forEach(p => {
      p.hidden = (p.dataset.panel !== li.dataset.tab);
    });
  });
});

$('signout').addEventListener('click', async () => {
  await signOutNow();
  location.replace('login.html');
});

// ------------------------------------------------------------
//  Story list
// ------------------------------------------------------------

async function loadStories() {
  const snap = await getDocs(paths.stories());
  state.stories = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  renderStoryList();
}

function renderStoryList() {
  const ul = $('story-list');
  ul.innerHTML = '';

  state.stories.forEach(s => {
    const li = document.createElement('li');
    li.style.cursor = 'pointer';

    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = s.title || s.id;
    li.appendChild(nm);

    if (s.status) {
      const st = document.createElement('span');
      st.className = 'prole';
      st.textContent = s.status;
      li.appendChild(st);
    }

    li.addEventListener('click', () => selectStory(s.id));
    ul.appendChild(li);
  });

  $('story-count').textContent = state.stories.length || '';
  $('story-empty').hidden = state.stories.length > 0;
}

// ------------------------------------------------------------
//  Load one story
// ------------------------------------------------------------

async function selectStory(id) {
  try {
    const snap = await getDoc(paths.story(id));
    if (!snap.exists()) { toast('That story no longer exists.', true); await loadStories(); return; }

    state.id = id;
    state.story = snap.data();

    const chars = await getDocs(paths.characters(id));
    state.chars = chars.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order || 99) - (b.order || 99));

    const phases = await getDocs(paths.storyPhases(id));
    state.phases = Object.fromEntries(phases.docs.map(d => [d.id, d.data()]));

    $('editor').hidden = false;
    $('editing-id').textContent = id;

    renderDetails();
    renderChars();
    renderClues();
  } catch (ex) { fail(ex); }
}

// ------------------------------------------------------------
//  Details
// ------------------------------------------------------------

function renderDetails() {
  const s = state.story;
  $('f-title').value      = s.title || '';
  $('f-synopsis').value   = s.synopsis || '';
  $('f-setting').value    = s.setting || '';
  $('f-min').value        = s.minPlayers ?? MIN_PLAYERS;
  $('f-max').value        = s.maxPlayers ?? MAX_PLAYERS;
  $('f-difficulty').value = s.difficulty || 'Medium';
  $('f-time').value       = s.estimatedTime || '';
  $('f-source').value     = s.source || '';
  $('f-status').value     = s.status || 'draft';

  const sol = s.solution || {};
  const sel = $('f-killer');
  sel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = '—';
  sel.appendChild(blank);
  state.chars.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name || c.id} (${c.role || '?'})`;
    sel.appendChild(o);
  });
  sel.value = sol.killerId || '';

  $('f-headline').value = sol.headline || '';
  $('f-method').value   = sol.method || '';
  $('f-motive').value   = sol.motive || '';
  $('f-epilogue').value = sol.epilogue || '';
}

$('save-details').addEventListener('click', async () => {
  const btn = $('save-details');
  btn.disabled = true;
  try {
    const min = Number($('f-min').value) || MIN_PLAYERS;
    const max = Number($('f-max').value) || MAX_PLAYERS;
    if (min > max) throw new Error('Minimum players cannot exceed maximum.');
    if (min < MIN_PLAYERS || max > MAX_PLAYERS) {
      throw new Error(`Player range must sit within ${MIN_PLAYERS}–${MAX_PLAYERS}.`);
    }

    // The solution must name the story's KILLER. Anything else and
    // the ending players read would contradict the card that was
    // dealt. The host refuses to deal such a story as well.
    const killerId = $('f-killer').value;
    const named = state.chars.find(c => c.id === killerId);
    if (killerId && named?.role !== ROLES.KILLER) {
      throw new Error(`The solution must name the KILLER character — "${named?.name || killerId}" is ${named?.role || 'not a character'}.`);
    }

    await updateDoc(paths.story(state.id), {
      title:         $('f-title').value.trim(),
      synopsis:      $('f-synopsis').value.trim(),
      setting:       $('f-setting').value.trim(),
      minPlayers:    min,
      maxPlayers:    max,
      difficulty:    $('f-difficulty').value,
      estimatedTime: $('f-time').value.trim(),
      source:        $('f-source').value.trim(),
      status:        $('f-status').value,
      solution: {
        killerId,
        headline: $('f-headline').value.trim(),
        method:   $('f-method').value.trim(),
        motive:   $('f-motive').value.trim(),
        epilogue: $('f-epilogue').value.trim()
      }
    });
    state.story = (await getDoc(paths.story(state.id))).data();
    await loadStories();
    toast('Details saved.');
  } catch (ex) { fail(ex); } finally { btn.disabled = false; }
});

// ------------------------------------------------------------
//  Characters
// ------------------------------------------------------------

function renderChars() {
  const ul = $('char-list');
  ul.innerHTML = '';

  state.chars.forEach(c => {
    const li = document.createElement('li');
    li.style.cursor = 'pointer';

    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = c.name || c.id;
    li.appendChild(nm);

    if (c.title) {
      const t = document.createElement('span');
      t.className = 'pchar';
      t.textContent = `· ${c.title}`;
      li.appendChild(t);
    }

    const r = document.createElement('span');
    r.className = `prole ${c.role || ''}`;
    r.textContent = (c.role || 'no role').toLowerCase();
    li.appendChild(r);

    li.addEventListener('click', () => editChar(c.id));
    ul.appendChild(li);
  });

  $('char-empty').hidden = state.chars.length > 0;
  $('cast-check').textContent = castProblems().join(' ');
}

// The same consistency check the seeder runs, surfaced live so a
// story cannot quietly become undealable while being edited.
function castProblems() {
  const out = [];
  const n = r => state.chars.filter(c => c.role === r).length;
  if (n(ROLES.KILLER) !== 1)    out.push(`Needs exactly 1 killer (has ${n(ROLES.KILLER)}).`);
  if (n(ROLES.DETECTIVE) !== 1) out.push(`Needs exactly 1 detective (has ${n(ROLES.DETECTIVE)}).`);
  if (n(ROLES.ACCOMPLICE) > 1)  out.push('At most 1 accomplice.');
  const max = state.story?.maxPlayers || MAX_PLAYERS;
  if (state.chars.length < max) out.push(`${state.chars.length} characters for ${max} max players.`);
  const noRole = state.chars.filter(c => !Object.values(ROLES).includes(c.role)).length;
  if (noRole) out.push(`${noRole} character${noRole === 1 ? ' has' : 's have'} no role.`);
  const killer = state.chars.find(c => c.role === ROLES.KILLER);
  const solId = state.story?.solution?.killerId;
  if (killer && solId && killer.id !== solId) out.push('Solution killer does not match the KILLER character.');
  if (out.length) out.push('The host may refuse to deal this story until these are fixed.');
  return out;
}

// Show only the fields this role actually uses, so the editor
// can't create data the player client would never render.
function syncRoleFields() {
  const role = $('c-role').value;
  const allowed = new Set(ROLE_FIELDS[role] || []);
  ['coverStory', 'clueConnections', 'protectObjective'].forEach(k => {
    $(`wrap-${k}`).hidden = !allowed.has(k);
  });
}

$('c-role').addEventListener('change', syncRoleFields);

function openCharForm(c) {
  state.editing = c ? c.id : '';
  $('char-form').hidden = false;

  $('c-id').value    = c?.id || '';
  $('c-id').disabled = !!c;              // ids are document names
  $('c-order').value = c?.order ?? (state.chars.length + 1);
  $('c-role').value  = c?.role || ROLES.SUSPECT;
  $('c-name').value  = c?.name || '';
  $('c-title').value = c?.title || '';
  $('c-bio').value   = c?.bio || '';
  $('c-secret').value    = c?.secret || '';
  $('c-objective').value = c?.objective || '';
  $('c-coverStory').value = c?.coverStory || '';
  $('c-protectObjective').value = c?.protectObjective || '';
  $('c-clueConnections').value = Array.isArray(c?.clueConnections)
    ? c.clueConnections.join('\n') : '';

  $('delete-char').hidden = !c;
  syncRoleFields();
  $('char-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function editChar(id) { openCharForm(state.chars.find(c => c.id === id)); }

$('new-char').addEventListener('click', () => openCharForm(null));
$('cancel-char').addEventListener('click', () => { $('char-form').hidden = true; state.editing = null; });

$('save-char').addEventListener('click', async () => {
  const btn = $('save-char');
  btn.disabled = true;
  try {
    const id = ($('c-id').value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!id) throw new Error('A character needs an id.');
    if (!$('c-name').value.trim()) throw new Error('A character needs a name.');

    const role = $('c-role').value;
    const allowed = new Set(ROLE_FIELDS[role] || []);

    const data = {
      order:     Number($('c-order').value) || 99,
      role,
      name:      $('c-name').value.trim(),
      title:     $('c-title').value.trim(),
      bio:       $('c-bio').value.trim(),
      secret:    $('c-secret').value.trim(),
      objective: $('c-objective').value.trim()
    };

    // Only write role-appropriate extras. Switching a character
    // from killer to suspect must not leave a stale cover story
    // sitting in the document.
    if (allowed.has('coverStory'))       data.coverStory = $('c-coverStory').value.trim();
    else                                 data.coverStory = deleteField();
    if (allowed.has('protectObjective')) data.protectObjective = $('c-protectObjective').value.trim();
    else                                 data.protectObjective = deleteField();
    if (allowed.has('clueConnections')) {
      data.clueConnections = $('c-clueConnections').value
        .split('\n').map(l => l.trim()).filter(Boolean);
    } else {
      data.clueConnections = deleteField();
    }

    const existed = state.chars.some(c => c.id === id);
    if (existed) {
      await updateDoc(paths.character(id, state.id), data);
    } else {
      // deleteField() is meaningless on a create — strip it out.
      const clean = Object.fromEntries(
        Object.entries(data).filter(([, v]) => !(v && v._methodName))
      );
      await setDoc(paths.character(id, state.id), clean);
    }

    $('char-form').hidden = true;
    state.editing = null;
    await selectStory(state.id);
    toast('Character saved.');
  } catch (ex) { fail(ex); } finally { btn.disabled = false; }
});

$('delete-char').addEventListener('click', async () => {
  if (!state.editing) return;
  if (!confirm(`Delete character "${state.editing}"? This cannot be undone.`)) return;
  try {
    await deleteDoc(paths.character(state.editing, state.id));
    $('char-form').hidden = true;
    state.editing = null;
    await selectStory(state.id);
    toast('Character deleted.');
  } catch (ex) { fail(ex); }
});

// ------------------------------------------------------------
//  Clues
// ------------------------------------------------------------

function renderClues() {
  const host = $('clue-editor');
  host.innerHTML = '';

  PHASES.forEach(phase => {
    const group = document.createElement('div');

    const h = document.createElement('p');
    h.className = 'phase-group';
    h.textContent = phase.label;
    group.appendChild(h);

    const clues = state.phases[phase.id]?.clues || [];
    const list = document.createElement('div');
    list.dataset.phase = phase.id;

    clues.forEach(c => list.appendChild(clueRow(phase.id, c)));

    const add = document.createElement('button');
    add.className = 'btn ghost sm';
    add.type = 'button';
    add.textContent = 'Add clue';
    add.addEventListener('click', () => {
      list.appendChild(clueRow(phase.id, { id: `${phase.id}-${Date.now().toString(36)}`, title: '', text: '' }));
    });

    group.append(list, add);
    host.appendChild(group);
  });
}

function clueRow(phaseId, clue) {
  const row = document.createElement('div');
  row.className = 'clue';
  row.dataset.clueId = clue.id;

  const fields = document.createElement('div');

  const title = document.createElement('input');
  title.value = clue.title || '';
  title.placeholder = 'Clue title';
  title.dataset.field = 'title';

  const text = document.createElement('textarea');
  text.value = clue.text || '';
  text.placeholder = 'What the table learns';
  text.dataset.field = 'text';
  text.style.marginTop = '.5rem';

  fields.append(title, text);

  const del = document.createElement('button');
  del.className = 'btn ghost sm';
  del.type = 'button';
  del.textContent = 'Remove';
  del.addEventListener('click', () => row.remove());

  row.append(fields, del);
  return row;
}

$('save-clues').addEventListener('click', async () => {
  const btn = $('save-clues');
  btn.disabled = true;
  try {
    const batch = writeBatch(db);

    PHASE_IDS.forEach((phaseId, i) => {
      const list = document.querySelector(`#clue-editor [data-phase="${phaseId}"]`);
      const clues = Array.from(list?.querySelectorAll('.clue') || []).map(row => ({
        id:    row.dataset.clueId,
        title: row.querySelector('[data-field="title"]').value.trim(),
        text:  row.querySelector('[data-field="text"]').value.trim()
      })).filter(c => c.title || c.text);

      batch.set(paths.storyPhase(phaseId, state.id), {
        name:  phaseMeta(phaseId).label,
        order: i,
        clues
      });
    });

    await batch.commit();
    await selectStory(state.id);
    toast('Clues saved.');
  } catch (ex) { fail(ex); } finally { btn.disabled = false; }
});

// ------------------------------------------------------------
//  New story
// ------------------------------------------------------------

$('new-btn').addEventListener('click', async () => {
  const raw = prompt('Id for the new story (letters, numbers and hyphens):', '');
  if (!raw) return;
  const id = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!id) return;

  try {
    if ((await getDoc(paths.story(id))).exists()) { toast('A story with that id exists.', true); return; }
    await setDoc(paths.story(id), {
      title: raw.trim(),
      synopsis: '', setting: '', source: '',
      minPlayers: 4, maxPlayers: 6,
      difficulty: 'Medium', estimatedTime: '90 minutes',
      status: 'draft',
      solution: { killerId: '', headline: '', method: '', motive: '', epilogue: '' }
    });
    await loadStories();
    await selectStory(id);
    toast('Story created.');
  } catch (ex) { fail(ex); }
});

$('delete-story').addEventListener('click', async () => {
  if (!state.id) return;
  if (!confirm(`Delete "${state.id}" and all its characters and clues?`)) return;
  try {
    // Firestore does not cascade. Remove the children first or they
    // become orphans that still cost storage.
    const batch = writeBatch(db);
    (await getDocs(paths.characters(state.id))).docs.forEach(d => batch.delete(d.ref));
    (await getDocs(paths.storyPhases(state.id))).docs.forEach(d => batch.delete(d.ref));
    batch.delete(paths.story(state.id));
    await batch.commit();

    state.id = null; state.story = null;
    $('editor').hidden = true;
    await loadStories();
    toast('Story deleted.');
  } catch (ex) { fail(ex); }
});

// ------------------------------------------------------------
//  Start
// ------------------------------------------------------------

(async function start() {
  if (IS_FILE_PROTOCOL) {
    $('boot').textContent = 'Open this page from its web address, not from a file.';
    return;
  }

  const user = await waitForAuth();
  if (!user || user.isAnonymous) { location.replace('login.html'); return; }

  $('who').textContent = user.email || '';

  // Populate the role dropdown from the single source of truth.
  const sel = $('c-role');
  Object.values(ROLES).forEach(r => {
    const o = document.createElement('option');
    o.value = r; o.textContent = r;
    sel.appendChild(o);
  });

  try {
    await loadStories();
    $('boot').hidden = true;
  } catch (ex) {
    // Stories are readable by any signed-in account, so this is rare;
    // an account missing from the allowlist fails on save instead.
    $('boot').textContent = describeError(ex);
    if (ex?.code === 'permission-denied') {
      $('boot').textContent += ' This account is not in the admin list in firestore.rules.';
    }
  }
})();
