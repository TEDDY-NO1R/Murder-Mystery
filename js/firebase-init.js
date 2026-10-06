// ============================================================
//  MURDER MYSTERY — Firebase bootstrap + shared constants
// ============================================================
//
//  Every other script imports from this one file. Two reasons:
//
//  1. The CDN version is pinned in one file. To move SDK
//     version, change the three import URLs below and nothing
//     else in the project needs touching.
//  2. No build step means no bundler to deduplicate imports.
//     Re-exporting the Firestore/Auth functions here keeps the
//     long gstatic URLs out of every other file.
//
//  SAFE TO SHIP: this file is downloaded by every player's phone.
//  Nothing story-related may ever be added to it — no character
//  names, no clues, no solutions. Story data lives in Firestore.
// ============================================================

// Firebase JS SDK v10, modular, straight from the CDN.
// These three URLs must stay on the same version as each other.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInAnonymously, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField,
  collection, getDocs, onSnapshot, query, where, orderBy, limit,
  serverTimestamp, writeBatch, arrayUnion, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

export const SDK_VERSION = '10.12.2';

// ------------------------------------------------------------
//  Project config
//
//  Not a secret. It ships in every Firebase web app and is
//  visible in DevTools by design — it identifies the project,
//  it does not grant access to it. Access is decided entirely
//  by firestore.rules.
// ------------------------------------------------------------

const firebaseConfig = {
  apiKey:            'AIzaSyDqXH6--Eov62ahdnvvM_M22Q52b-GbLZ4',
  authDomain:        'murder-mystery-online.firebaseapp.com',
  projectId:         'murder-mystery-online',
  storageBucket:     'murder-mystery-online.firebasestorage.app',
  messagingSenderId: '722223486630',
  appId:             '1:722223486630:web:80a0aa1dfe1aa7436d4667'
};

export const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

// ------------------------------------------------------------
//  Re-exports — so other files import from here, not the CDN
// ------------------------------------------------------------

export {
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField,
  collection, getDocs, onSnapshot, query, where, orderBy, limit,
  serverTimestamp, writeBatch, arrayUnion, Timestamp,
  signInAnonymously, signInWithEmailAndPassword, signOut, onAuthStateChanged
};

// ============================================================
//  GAME CONSTANTS
//
//  Rules of the game, not contents of the story. A player
//  learning that a 5-player game contains one accomplice is
//  reading the rulebook, not the solution.
// ============================================================

// Ordered. The host walks this list one step at a time.
export const PHASES = [
  { id: 'lobby',         label: 'Gathering',     blurb: 'Waiting for guests to arrive.' },
  { id: 'arrival',       label: 'Arrival',       blurb: 'Envelopes are opened. Read your character.' },
  { id: 'investigation', label: 'Investigation',  blurb: 'Question each other. Clues are released.' },
  { id: 'confrontation', label: 'Confrontation', blurb: 'Accusations in the open. Alibis break.' },
  { id: 'accusation',    label: 'Accusation',    blurb: 'The detective names the killer.' },
  { id: 'reveal',        label: 'Reveal',        blurb: 'The truth.' }
];

export const PHASE_IDS = PHASES.map(p => p.id);

export function nextPhase(current) {
  const i = PHASE_IDS.indexOf(current);
  return (i === -1 || i === PHASE_IDS.length - 1) ? null : PHASE_IDS[i + 1];
}

export function phaseMeta(id) {
  return PHASES.find(p => p.id === id) || PHASES[0];
}

export const ROLES = {
  KILLER:     'KILLER',
  DETECTIVE:  'DETECTIVE',
  ACCOMPLICE: 'ACCOMPLICE',
  WITNESS:    'WITNESS',
  SUSPECT:    'SUSPECT'
};

// Which fields a character card shows, per role. The player's
// own document only ever contains the fields listed here — the
// host strips the rest before writing it. Defence in depth: even
// if the card markup were wrong, the data isn't there.
export const ROLE_FIELDS = {
  KILLER:     ['name', 'bio', 'secret', 'objective', 'coverStory'],
  DETECTIVE:  ['name', 'bio', 'secret', 'objective', 'clueConnections'],
  ACCOMPLICE: ['name', 'bio', 'secret', 'objective', 'protectObjective'],
  WITNESS:    ['name', 'bio', 'secret', 'objective'],
  SUSPECT:    ['name', 'bio', 'secret', 'objective']
};

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;

// Scaling, exactly as specified:
//   3 = Killer / Detective / Suspect
//   4 adds Witness
//   5 adds Accomplice
//   6-8 add further Suspects
export function rolesForPlayerCount(n) {
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) {
    throw new Error(`Player count must be ${MIN_PLAYERS}-${MAX_PLAYERS}, got ${n}`);
  }
  const roles = [ROLES.KILLER, ROLES.DETECTIVE, ROLES.SUSPECT];
  if (n >= 4) roles.push(ROLES.WITNESS);
  if (n >= 5) roles.push(ROLES.ACCOMPLICE);
  while (roles.length < n) roles.push(ROLES.SUSPECT);
  return roles;
}

// ------------------------------------------------------------
//  Room codes
//
//  The session document ID *is* the room code, so joining is a
//  direct lookup and players never need permission to query the
//  sessions collection. Ambiguous glyphs are excluded — these
//  get read aloud across a room and typed on phones.
// ------------------------------------------------------------

const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679'; // no B/I/O/S/Z/0/1/2/5/8
export const CODE_LENGTH = 5;

export function generateRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normaliseRoomCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

// ============================================================
//  AUTH HELPERS
// ============================================================

// Players. No password, no account, no email — Firebase hands
// the phone a throwaway UID. That UID is what firestore.rules
// matches against sessions/{id}/private/{uid}.
//
// A browser already signed in to the story editor plays under that
// login instead; hosting and playing need no special rights, so it
// behaves like any other player. Tabs in one browser profile share
// one identity, so each test player needs its own device, profile
// or private window.
export async function signInPlayer() {
  if (auth.currentUser) return auth.currentUser;
  const { user } = await signInAnonymously(auth);
  return user;
}

// Host and story editor. A real login is what the rules treat
// as trusted; anonymous is always untrusted.
export async function signInHost(email, password) {
  const { user } = await signInWithEmailAndPassword(auth, email.trim(), password);
  return user;
}

export function signOutNow() {
  return signOut(auth);
}

// Resolves once Firebase has decided whether a session exists.
// Every page waits on this before touching Firestore — reading
// too early is the usual cause of a spurious permission error.
export function waitForAuth() {
  return new Promise(resolve => {
    const stop = onAuthStateChanged(auth, user => { stop(); resolve(user); });
  });
}

// ============================================================
//  ERROR MESSAGES
//
//  Firebase error codes are useless to a guest holding a phone
//  in a dim room. Translate them once, here.
// ============================================================

const ERROR_TEXT = {
  'permission-denied':                'You do not have access to that.',
  'auth/invalid-credential':          'That email and password do not match.',
  'auth/invalid-email':               'That does not look like an email address.',
  'auth/user-not-found':              'No account with that email.',
  'auth/wrong-password':              'Incorrect password.',
  'auth/too-many-requests':           'Too many attempts. Wait a minute and try again.',
  'auth/network-request-failed':      'No connection. Check the wifi.',
  'auth/admin-restricted-operation':  'Anonymous sign-in is switched off in the Firebase console.',
  'auth/operation-not-allowed':       'That sign-in method is switched off in the Firebase console.',
  'auth/unauthorized-domain':         'This web address is not in the Firebase authorised domains list.',
  'unavailable':                      'Cannot reach the server. Check the connection.',
  'not-found':                        'That does not exist.'
};

export function describeError(err) {
  if (!err) return 'Something went wrong.';
  const code = err.code || '';
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  // Firestore reports "permission-denied"; Auth reports "auth/...".
  const bare = code.replace(/^[a-z-]+\//, '');
  return ERROR_TEXT[bare] || err.message || 'Something went wrong.';
}

// ------------------------------------------------------------
//  file:// guard
//
//  Firebase Auth rejects the null origin a double-clicked HTML
//  file produces. This fails in a confusing way, so say it
//  plainly and early.
// ------------------------------------------------------------

export const IS_FILE_PROTOCOL = location.protocol === 'file:';

if (IS_FILE_PROTOCOL) {
  console.error(
    'Murder Mystery: opened from the filesystem (file://). Firebase sign-in ' +
    'will not work. Deploy to Netlify and use that URL instead.'
  );
}

// ------------------------------------------------------------
//  Firestore path builders — one definition of the shape
// ------------------------------------------------------------

export const paths = {
  stories:    () => collection(db, 'stories'),
  story:      (storyId) => doc(db, 'stories', storyId),
  characters: (storyId) => collection(db, 'stories', storyId, 'characters'),
  character:  (charId, storyId) => doc(db, 'stories', storyId, 'characters', charId),
  storyPhases:(storyId) => collection(db, 'stories', storyId, 'phases'),
  storyPhase: (phaseId, storyId) => doc(db, 'stories', storyId, 'phases', phaseId),

  session:    (code) => doc(db, 'sessions', code),
  players:    (code) => collection(db, 'sessions', code, 'players'),
  player:     (code, uid) => doc(db, 'sessions', code, 'players', uid),
  privates:   (code) => collection(db, 'sessions', code, 'private'),
  private:    (code, uid) => doc(db, 'sessions', code, 'private', uid),
  votes:      (code) => collection(db, 'sessions', code, 'votes'),
  vote:       (code, uid) => doc(db, 'sessions', code, 'votes', uid),
  reveal:     (code) => doc(db, 'sessions', code, 'reveal', 'summary')
};
