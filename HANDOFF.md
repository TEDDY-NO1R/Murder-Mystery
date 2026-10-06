# Handoff — read this first

Current as of 6 Oct 2026 (end of day). If you are a fresh Claude session or a future
me, this is the whole state of play. Earlier designs are in git history.

---

## What this project is

A murder mystery party game for people in one room. Each guest's phone is
their private character card. Anyone can host from the home page: they pick
a story, open a room, and play too. Plain HTML/CSS/JS, no framework, no npm,
no build step. Firebase v10 via CDN for Firestore and Auth. Deployed on
Netlify.

- **Live:** https://murder-mystery-online.netlify.app
- **Repo:** https://github.com/TEDDY-NO1R/Murder-Mystery (**public**)
- **Firebase project:** `murder-mystery-online` (Spark/free, Firestore in `eur3`)
- **Story-editor account:** `hasthimunisilva@icloud.com`, UID `B8CkPp6XqTcHfvOcZHE8ghqNahI3`

Read `README.md` for the game, `SETUP.md` for setup and deployment.

---

## Status

| | |
|---|---|
| Deployed to Netlify from `main` | done |
| Firestore rules ("anyone can host") published | done, 6 Oct 2026 |
| *The Speckled Band* (`the-speckled-band`) seeded and published | done, 6 Oct 2026 |
| Live 3-player test (host + 2 players joined) | done, 6 Oct 2026 |
| Old pre-2026 stories in Firestore | being deleted by the owner via the story editor |
| Editor **Rooms** tab (`edb4310`) | deployed 6 Oct 2026 — tested on a mock only |
| Table alerts, round timer, screen awake (`0c8a78d`) | deployed 6 Oct 2026 — tested on a mock only |
| Editor copy / export / import JSON (`0fb8591`) | deployed 6 Oct 2026 — tested on a mock only |

### Not yet verified for real

Each of the three features above passed a mocked-Firestore test in a
browser, but none has touched the real database or real phones yet:

1. **Export a backup of *The Speckled Band*** (editor → Export JSON) —
   none exists outside Firestore and the one PC's seed file. Do this
   first.
2. **Rooms tab:** make a small edit on a test story, save, reload.
3. **Alerts and timer:** a game with 3+ phones — release a clue (banner,
   chime, buzz on every phone; no buzz on iPhone, chime only after a tap)
   and start a 5-minute timer. Check a phone left alone doesn't sleep.
4. **Copy / import:** copy a story, import an export under a new id,
   delete both.

### Next feature candidates

- **Cheat-proof dealing** — see the security model below. Needs the owner
  to create a Firebase service-account key and add it to Netlify's
  environment variables.
- **A second story** — public domain, written to the data shapes below.
  Its text must never appear in chat (the owner plays).

---

## How a game runs

1. A player opens the site and taps **Host a game**, picks a published
   story and opens a room. Their phone creates `sessions/{CODE}` with
   `hostUid` = their UID and joins them as the first player.
2. Others join with the code while the room is in the lobby. The host can
   remove anyone.
3. **Start game**: the host's phone reads the story, deals one character
   per player (roles scale 3–8 players), writes each card to
   `sessions/{CODE}/private/{uid}`, writes the ending to
   `sessions/{CODE}/reveal/summary`, and stores sorted `castIds`.
4. A bar at the bottom of the host's screen releases the next clue (never
   previewed), advances phases, counts searches and accusations, reveals,
   and closes the room — deleting every child document, then the session.
5. **Search the house** (added 6 Oct 2026, the owner wanted more to do):
   in arrival, investigation and confrontation each dealt player searches
   one room per round from the Search tab. A search claims the next
   unclaimed find in that room whose phase has been reached (first come,
   first served); finds are private until shown to the table, and who
   searched where is public. Rooms live in `stories/{id}/locations` and
   are seeded from `js/admin-seed.js` and edited in the story editor's
   **Rooms** tab. Keep find ids stable: live games record claims by id.
6. **Table alerts and round timer** (added Oct 2026): a new clue, a new
   phase, evidence shown by someone else, or the timer running out gets
   a banner, a synthesised chime and a vibration (per-phone **Sound**
   toggle). Nothing alerts on the first snapshot after joining or a
   refresh. The host can start a 5/10/15-minute countdown that every
   phone shows; it only alerts — phases still advance by hand — and is
   cleared on each phase change. Phones ask to keep the screen awake
   during a game (Wake Lock API, where supported).

Everything is in `js/game.js`; the page is `play.html` (served at `/`).

---

## Security model — honour system, by the owner's choice

The host's phone deals, so it must be able to read the story. Therefore
**any signed-in browser can read `/stories`**, and the secrecy of the ending
rests on the host's screen never showing it. Someone digging in DevTools
could find it. The owner chose this deliberately ("don't worry about
cheating for now").

To make it cheat-proof later: move dealing, clue release and the reveal
into a server-side function (a Netlify Function using the Firebase Admin
SDK works on the free Spark plan; Cloud Functions would need Blaze), and
close `/stories` to everyone but the editor and that function.

What the rules do enforce:

- Only the story editor (allowlisted, non-anonymous UID) can **write**
  stories.
- Anyone signed in can create a room, but only as its own `hostUid`, and
  only that host (or the editor) can update or delete it and its children.
  Creating over an existing code counts as an update, so live rooms cannot
  be hijacked.
- A player's card is readable only by that player (and the host, who wrote
  it — the host screen never shows it).
- Joining only while `status == 'open'` and phase is `lobby`.
- Votes: create-only, during `accusation`, by a dealt player, naming
  another dealt character (`castIds`), with a server timestamp.
- The reveal is unreadable from the room until phase `reveal`.
- Searches: one per dealt player per search round (doc id
  `{uid}_{phase}`), each find claimed once (create-only, written in the
  same batch as its search), and only a find's holder can share it.
- Player reads of a session's children require the session to exist.

---

## The story seed files — not in git

`js/admin-seed.js` (the whole story, ending included) and `admin/seed.html`
(the one-time loader) are **gitignored** and **404'd on Netlify**. They
exist only on the owner's PC. The story itself lives in Firestore and is
edited through `admin/story.html` — which displays every secret, so whoever
wants to play a story should not open it there.

To seed again: serve this folder on `http://localhost:8767` (no Python or
Node on the owner's PC — a small PowerShell `HttpListener` script works),
open `/admin/seed.html`, sign in as the editor, click Seed. It shows counts
only.

**Backups and copies** (story editor, Oct 2026): **Export JSON** downloads
a story with all its characters, phases and rooms as one file
(`format: "murder-mystery-story"`, `version: 1`; Timestamps travel as
`{ "$timestamp": ISO }`). **Import JSON** writes one back, replacing any
story with that id, children included, after a confirm. Imported under
its own id it keeps its status; under a new id it comes in as a draft.
**Copy** duplicates the open story under a new id, as a draft. Export
files hold the ending, so keep them out of git and out of chat — they
are the recommended backup, since the seed file exists on one PC only.

The owner plays the game: **never reveal story contents in chat.**

---

## Data shapes

```
stories/{storyId}                      read: signed in · write: editor
  title, synopsis, setting, minPlayers, maxPlayers,
  difficulty, estimatedTime, status ('draft'|'published'), source,
  solution: { killerId, headline, method, motive, epilogue }

stories/{storyId}/characters/{charId}
  order, role, name, title, bio, secret, objective
  + coverStory        (KILLER only)
  + clueConnections[] (DETECTIVE only)
  + protectObjective  (ACCOMPLICE only)

stories/{storyId}/phases/{phaseId}
  name, order, clues: [{ id, title, text }]   (released in this order)

stories/{storyId}/locations/{locId}    searchable rooms
  name, blurb, order, finds: [{ id, title, text, phase }]

sessions/{ROOMCODE}                    doc id IS the room code
  roomCode, storyId, storyTitle, storySynopsis,
  status ('open'|'live'|'ended'), currentPhase,
  revealedClues[], hostUid, createdAt,
  castIds[] (sorted dealt character ids), startedAt,
  timer: { minutes, setAt (server time) } | null

sessions/{ROOMCODE}/players/{uid}      public in-game
  name, joinedAt, characterId, characterName   (never role)

sessions/{ROOMCODE}/private/{uid}      that player (and the host)
  characterId, role, name, title + role-appropriate fields

sessions/{ROOMCODE}/votes/{uid}        suspectId, castAt   (create-only)
sessions/{ROOMCODE}/reveal/summary     killerId, headline, method,
                                       motive, epilogue, cast[]
sessions/{ROOMCODE}/searches/{uid}_{phase}  uid, locationId, phase, findId|null, at
sessions/{ROOMCODE}/finds/{findId}     uid, locationId, phase, at   (who holds it)
sessions/{ROOMCODE}/shared/{findId}    uid, name, title, text, at   (shown to table)
```

Roles scale as: 3 = Killer/Detective/Suspect, 4 adds Witness, 5 adds
Accomplice, 6–8 add Suspects (lowest `order` first). See
`rolesForPlayerCount()` in `js/firebase-init.js`. A story needs exactly one
killer and one detective, and its solution must name the killer — the host
refuses to deal otherwise.

---

## Working on this machine

- **git** is installed (Git for Windows, via `winget install Git.Git`,
  Oct 2026) and on PATH. Commits work from the CLI, but the CLI has no
  GitHub login, so **push with GitHub Desktop's Push origin**
  (`Start-Process "x-github-client://openLocalRepo/D:/Projects/Murder-Mystery"`
  opens it on this repo). Netlify deploys `main` automatically.
- **Local server:** `.claude/serve.ps1` is a small PowerShell
  `HttpListener` static server — `powershell -ExecutionPolicy Bypass -File
  .claude\serve.ps1 -Port 8767`. A `murder-mystery` entry in
  `D:\Projects\.claude\launch.json` starts it for the Claude app's
  browser pane.
- **Mock tests:** `.claude/test/` holds fake Firestore modules and test
  copies of the pages. An import map in each test page redirects
  `/js/firebase-init.js` to the mock, so the real `game.js` / `admin.js`
  run against in-memory data with no login: `story.html` (editor, mock
  `mock-init.js`) and `play.html` (a mid-game room where you are the
  host, mock `mock-game-init.js` + `seed-game.js`). Regenerate a test page
  after changing its real page. `.claude/` is gitignored, so these exist
  on this PC only.
- **The seed files are per-machine.** `js/admin-seed.js` is gitignored, so
  pulling does not update it. Copy the current one across by hand before
  seeding from another PC — an old copy lacks `locations` and the
  `the-speckled-band` id.
- **Rules** are published by pasting `firestore.rules` into Firebase
  Console → Firestore → Rules → Publish.
- **No Node or Python.** Headless Edge
  (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`) with a
  mocked Firestore module was used to test the game flow; the mocks above
  do the same in any browser.
- **`*.json` is gitignored** — story exports hold the ending and the repo
  is public. The site has no JSON files of its own.

---

## Gotchas

- **`file://` does not work.** Firebase Auth rejects the null origin.
- **Tabs in one browser profile share one identity** — to test several
  players on one PC, use private windows or other profiles.
- **Windows PowerShell 5.1 mangles UTF-8.** Use `-Encoding UTF8` when
  reading files you will paste (e.g. `firestore.rules`).
- **ES `import` specifiers must be string literals** — the CDN version is
  hardcoded in three places in `js/firebase-init.js`.
- **Firestore does not cascade deletes.** Closing a room and deleting a
  story both remove children explicitly.
- **Netlify `_redirects` needs `!` to shadow a real file.**
- **Authorized domains are not needed** for anonymous or email/password
  sign-in.
