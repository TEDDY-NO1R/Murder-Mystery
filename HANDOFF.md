# Handoff — read this first

Written 29 Aug 2026, at the end of the Phase 1 build, immediately before
the development machine was to be reformatted. If you are a fresh Claude
session or a future me, this is the whole state of play.

---

## What this project is

A murder mystery party game for people in one room. Each guest's phone is
their private character card; one host runs the evening from a laptop.
Plain HTML/CSS/JS, no framework, no npm, no build step. Firebase v10 via
CDN for Firestore and Auth. Deployed on Netlify.

- **Live:** https://murder-mystery-online.netlify.app
- **Repo:** https://github.com/TEDDY-NO1R/Murder-Mystery (**public**)
- **Firebase project:** `murder-mystery-online` (Spark/free, Firestore in `eur3`)
- **Host account:** `hasthimunisilva@icloud.com`, UID `B8CkPp6XqTcHfvOcZHE8ghqNahI3`

Read `README.md` for the game, `SETUP.md` for the Firebase setup in order.

---

## Status: built, deployed, secured — NOT yet seeded

| | |
|---|---|
| All 12 spec files + 2 extras built | done |
| Pushed to GitHub | done |
| Deployed to Netlify | done, verified live |
| Firestore security rules published | done, verified with a real anonymous token |
| Favicon, OG thumbnail, README | done |
| **Story seeded into Firestore** | **NOT DONE — blocked on the host password** |
| Seed files preserved off-machine | sent as chat attachments 29 Aug 2026 — see below |

Nobody can play until the story is seeded. The host panel will say
*"Story `speckled-band` not found"* or load the old, wrong story.

---

## THE ONE BLOCKER: the host password

The seed page and the host panel both need a sign-in as
`hasthimunisilva@icloud.com`. **The password was never known to Claude and
could not be found.** Firebase stores passwords hashed — nobody, including
the project owner, can read one back.

To get in again, either:

**A. Reset it.** Firebase Console → Authentication → Users → the `⋮` menu
on that row → **Reset password**. Firebase emails a reset link to
`hasthimunisilva@icloud.com`. Set a new one and save it in a password
manager this time.

**B. Make a new host account.** Authentication → Users → **Add user**,
with any email and a password you choose. Then copy its **User UID** into
the allowlist in `firestore.rules`:

```
&& request.auth.uid in [
     'B8CkPp6XqTcHfvOcZHE8ghqNahI3',   // hasthimunisilva@icloud.com
     'PASTE_THE_NEW_UID_HERE'
   ];
```

…and republish the rules (Firestore Database → Rules → paste → Publish).
Option B is more steps but doesn't depend on receiving email.

---

## CRITICAL: a file that is not in the repo

`js/admin-seed.js` and `admin/seed.html` are **gitignored on purpose** —
the repo is public and `admin-seed.js` contains every character secret and
the full solution to The Speckled Band. Committing them would publish the
ending permanently in git history.

**Consequence:** they exist nowhere but the dev machine. They are NOT on
GitHub and NOT on Netlify, by design.

### Where to find them again

They were **sent to the user as chat attachments on 29 Aug 2026**, in the
Claude conversation that built this project. Look for a message with two
attached files, `admin-seed.js` and `seed.html`, captioned *"NOT in GitHub
— these are the only copies."* Download both from that message.

Restore them to exactly these paths:

```
js/admin-seed.js
admin/seed.html
```

`.gitignore` already lists both, so they will not be committed by accident.

Uploading them to GitHub was considered and **rejected**: this repo is
public, so there is no way to "hide" a file in it. Anything committed is
served to anyone and stays in history forever. If you want them version
controlled, the options are (a) switch this repo to Private in GitHub
settings, then remove the two lines from `.gitignore` and commit, or
(b) create a separate private repo for them. Obscure filenames or unlisted
branches are not protection.

### If they are genuinely lost

The story must be rewritten. Either author it by hand in
`admin/story.html` — the editor supports the complete shape, including
role-specific fields — or ask Claude to regenerate a Speckled Band
adaptation (Conan Doyle, public domain) matching the data shapes below.
Nothing else in the project depends on that file; it is a one-time seeder.

---

## Next steps, in order

1. **Recover the host password** (above).
2. **Restore `js/admin-seed.js` + `admin/seed.html`** if the machine was
   wiped.
3. **Seed the story — from localhost, never from the live site.**
   The seed file holds every secret and is deliberately not deployed
   (`_redirects` 404s it, and it is not in the repo).

   ```
   python -m http.server 8767
   ```

   Open `http://localhost:8767/admin/seed.html`, sign in as the host, click
   **Seed "The Speckled Band Mystery"** once. It replaces
   `stories/speckled-band` outright, which also deletes the legacy
   `characters` array still sitting on that document.

4. **Verify the seed:** Firebase Console → Firestore → `stories` →
   `speckled-band`. It must have a `characters` **subcollection** and **no**
   `characters` field.

5. **Run the security test** from a player's browser on the live site —
   this is the acceptance test for the whole build:

   ```js
   const { getFirestore, getDocs, collection } =
     await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
   await getDocs(collection(getFirestore(), 'stories/speckled-band/characters'));
   ```

   Must throw `Missing or insufficient permissions`. If it returns data,
   something has regressed badly — stop and fix the rules.

6. **Play a test game.** Open `host.html`, sign in, **Open a room**, join
   from 4+ phones or browser windows, **Start game**, walk the phases,
   release clues, reveal.

---

## The security model — do not undo this

One rule governs everything: **a phone can only download the character it
owns.** Not hidden by the UI — refused by Firestore.

- **The whole `/stories` tree is admin-only.** Players read none of it. The
  host copies the public parts (story title, synopsis, and each clue as it
  is released) into the session document.
- **Characters are a subcollection, never an array on the story document.**
  This is the single most important structural decision in the project.
  Firestore returns whole documents or nothing, so if characters sat in an
  array on the story doc, anyone permitted to read the title would receive
  every secret. No rule can prevent that. It is not a style preference.
- **`sessions/{code}/private/{uid}`** holds each player's dealt card. Its
  read rule is one condition: `request.auth.uid == uid`. `list` is
  admin-only — without that a player could pull the whole collection in one
  query and per-document rules would never fire.
- **Clue text reaches a session only when the host releases it.** An
  unreleased clue was never transmitted, not merely hidden.
- **The solution is phase-gated.** `sessions/{code}/reveal/summary` is
  readable only when the session's live `currentPhase` is `reveal`.
- **Players sign in anonymously; the host uses email/password.** The rules
  treat anonymous as untrusted throughout. This is why the host must have a
  real account — it is the only identity permitted to read `/stories`.
- **Static files are not protected by Firestore rules.** Anything in the
  publish directory is a public URL. That is why the seed file is
  gitignored and 404'd rather than "hidden".

### History worth knowing

On 29 Aug 2026 this project was found **actively leaking**. The live rules
were `match /stories/{storyId} { allow read: if true; }` — no login of any
kind. All five stories, 31 `secret` fields, were fetchable over plain HTTP
by anyone with the project ID. Verified with curl, then closed the same day.
Do not reintroduce a readable `/stories` path.

---

## Data shapes

```
stories/{storyId}                      admin-only, whole tree
  title, synopsis, setting, minPlayers, maxPlayers,
  difficulty, estimatedTime, status, source,
  solution: { killerId, headline, method, motive, epilogue }

stories/{storyId}/characters/{charId}
  order, role, name, title, bio, secret, objective
  + coverStory        (KILLER only)
  + clueConnections[] (DETECTIVE only)
  + protectObjective  (ACCOMPLICE only)

stories/{storyId}/phases/{phaseId}
  name, order, clues: [{ id, title, text }]

sessions/{ROOMCODE}                    doc id IS the room code
  roomCode, storyId, storyTitle, storySynopsis,
  status ('open'|'live'|'ended'), currentPhase,
  revealedClues[], hostUid, createdAt

sessions/{ROOMCODE}/players/{uid}      public in-game
  name, joinedAt, characterId, characterName   (never role)

sessions/{ROOMCODE}/private/{uid}      readable only by that uid
  characterId, role, name, title + role-appropriate fields

sessions/{ROOMCODE}/votes/{uid}        suspectId, castAt
sessions/{ROOMCODE}/reveal/summary     killerId, headline, method,
                                       motive, epilogue, cast[]
```

The session document id being the room code is deliberate: joining is a
direct lookup, so players never need `list` permission on `sessions`, which
blocks enumeration of other people's games.

Roles scale as: 3 = Killer/Detective/Suspect, 4 adds Witness, 5 adds
Accomplice, 6–8 add Suspects. See `rolesForPlayerCount()` in
`js/firebase-init.js`.

---

## Gotchas discovered the hard way

- **`file://` does not work.** Firebase Auth rejects the null origin.
  Always use a local server or the deployed site. `IS_FILE_PROTOCOL` in
  `js/firebase-init.js` detects and warns.
- **Authorized domains are NOT needed here.** That list gates OAuth
  redirect flows only (Google, Phone). Anonymous and email/password work
  from any origin — verified: the live site authenticates players while the
  Netlify domain is absent from the list. Do not chase this as a cause.
- **Windows PowerShell 5.1 mangles UTF-8.** `Get-Content -Raw` without
  `-Encoding UTF8` turns em-dashes into `â€"`. Matters when pasting
  `firestore.rules` into the console via clipboard.
- **ES `import` specifiers must be string literals.** A template literal
  there is a SyntaxError — the CDN version is hardcoded in three places in
  `js/firebase-init.js` for this reason.
- **Firestore does not cascade deletes.** Deleting a story leaves orphaned
  characters and phases; `js/admin.js` deletes children explicitly.
- **Netlify `_redirects` needs `!` to shadow a real file.** Without the
  force flag the static file is served and the rule ignored.

---

## Not built (deliberately out of Phase 1 scope)

Marketing pages, story browsing, ads, payments, multiple concurrent
stories in the UI. Four legacy stories (`arrest-of-lupin`,
`blue-cross-betrayal`, `moonstone-manor`, `rue-morgue`) still sit in
Firestore in the **old insecure shape** — characters as an array field.
They are safe only because `/stories` is closed entirely. `admin/story.html`
has a converter that moves them into subcollections; use it before ever
exposing them.
