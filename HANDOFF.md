# Handoff — read this first

Current as of 6 Oct 2026. If you are a fresh Claude session or a future
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
   are seeded from `js/admin-seed.js` (not editable in the editor yet).

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
  castIds[] (sorted dealt character ids), startedAt

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

- **git is not on PATH.** Use GitHub Desktop's bundled git:
  `%LOCALAPPDATA%\GitHubDesktop\app-<version>\resources\app\git\cmd\git.exe`.
  It can commit; pushing needs GitHub Desktop's **Push origin** (the CLI has
  no stored credentials). Netlify deploys `main` automatically.
- **Rules** are published by pasting `firestore.rules` into Firebase
  Console → Firestore → Rules → Publish.
- **No Node or Python.** Headless Edge
  (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`) with a
  mocked Firestore module was used to test the game flow.

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
