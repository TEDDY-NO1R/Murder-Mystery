# Murder Mystery — Firebase Setup

Follow this once, top to bottom. Every step is done in a browser.
No terminal, no npm, no build step.

Budget about 20 minutes.

---

## Current state of your project (checked 29 Aug 2026)

Project **murder-mystery-online**, Spark plan, Firestore in **eur3**,
Native mode. Some of this guide is already done.

| Step | State |
|---|---|
| 1. Project created | Done |
| 2. Firestore created | Done — `(default)`, eur3 |
| 3a. Email/Password enabled | Done |
| 3b. Anonymous enabled | Done — 29 Aug, with auto clean-up of stale guest accounts |
| 4. Host account | Done — `hasthimunisilva@icloud.com`, UID `B8CkPp6XqTcHfvOcZHE8ghqNahI3` |
| 5. Web app registered | Done — "Murder Mystery Web"; config already baked into `js/firebase-init.js` |
| 6. Rules | **Temporary deny-all published 29 Aug.** Replace with the real `firestore.rules` — see Sequence below. |

### What was found, and why the rules are locked

The rules in place until 29 Aug were:

```
match /stories/{storyId} {
  allow read: if true;
}
```

`if true` means no login of any kind. All five stories — 31 `secret`
fields — were fetchable over plain HTTP by anyone who knew the project
ID. Verified with curl, then closed the same day. A deny-all rule set is
live now and returns `403 PERMISSION_DENIED` on every path.

### The structural problem to fix before reopening

The existing stories store characters as an **array field inside the
story document** (`characters[0].secret`, `characters[1].secret`, …).

Firestore has no field-level read permission — a read returns the whole
document or nothing. So no rule can show a player the title and synopsis
while hiding the secrets in the same document. Changing `if true` to
`if request.auth != null` fixes nothing, because players are signed in
too.

That is why `firestore.rules` puts characters in a **subcollection**
(`stories/{id}/characters/{charId}`). It is not a style preference; it is
the only shape in which the guarantee is expressible.

**Sequence:**

1. Deny-all published — done.
2. Publish the real `firestore.rules` (section 6).
3. Deploy (section 8), then run `admin/seed.html` once (section 7).

Step 2 is safe to do before seeding because the whole `stories` tree is
admin-only in the real rules — players never read it at all, so the
legacy `characters` array still sitting in the old documents is
unreadable either way. The seed then replaces `speckled-band` outright,
which deletes that array. The other four stories stay locked and
untouched until you want them.

---

## What you are building

People sit in one room. Each person opens `play.html` on their phone and
joins with a room code. You open `host.html` on a laptop and run the game.
Firestore keeps every phone in sync in real time.

The whole design rests on one rule: **a phone can only ever download the
character it owns.** Not "the UI hides the others" — the database itself
refuses to hand them over. Section 6 is where that gets switched on, and
section 9 is where you prove it works.

---

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com
2. Click **Create a project** (or **Add project**).
3. Name it `murder-mystery` (any name is fine — the ID gets a random suffix).
4. Google Analytics: **turn it off**. You don't need it and it adds a
   consent step you'd have to handle.
5. Click **Create project**, wait for it, then **Continue**.

---

## 2. Create the Firestore database

1. In the left sidebar: **Build → Firestore Database**.
2. Click **Create database**.
3. Choose **Start in production mode**. This locks everything down by
   default and denies all reads and writes until you paste the rules in
   section 6. That is exactly what you want — an open database would leak
   the killer to anyone who asked.
4. Pick a location close to you. **This cannot be changed later.**
   - Europe → `eur3` or `europe-west2`
   - US → `nam5`
   - Asia → `asia-south1`
5. Click **Enable** and wait.

---

## 3. Turn on the two sign-in methods

The game uses two different kinds of login, and the security model depends
on the difference between them.

- **Players** sign in **anonymously**. Firebase hands the phone a throwaway
  user ID with no password. This is what lets the rules say "this specific
  phone owns this specific character."
- **You** — as host and as story editor — sign in with **email and
  password**. The rules treat a real login as trusted and an anonymous
  login as untrusted. That single distinction is what stops a player from
  ever reading the story's character list.

Do both:

1. Left sidebar: **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Add new provider**.
3. Click **Anonymous** → toggle **Enable** → **Save**.
4. Click **Add new provider** again → **Email/Password** → toggle the first
   **Enable** (leave "Email link / passwordless" off) → **Save**.

You should now see both **Anonymous** and **Email/Password** listed as
Enabled.

---

## 4. Create your host account

This is the account you'll use to run games and to edit stories.

1. **Authentication → Users** tab → **Add user**.
2. Enter an email address. It does not need to be real or verified —
   `host@murdermystery.local` works fine.
3. Enter a password. Use something you'll actually remember; there's no
   password reset flow in this build.
4. Click **Add user**.
5. **Copy the User UID** from the table — the long string like
   `kJ2m9XpQ...`. Paste it somewhere for a moment. You need it in step 6.

> Anyone with this login can read every secret in every story. Treat it
> like a spoiler key, because that's what it is. Don't share it with
> players.

---

## 5. Get your web config and paste it in

1. Click the **gear icon** (top left, next to "Project Overview") →
   **Project settings**.
2. Scroll to **Your apps**. Click the **web icon** — `</>`.
3. App nickname: `murder-mystery-web`. Leave **Firebase Hosting
   unchecked** — you're deploying to Netlify.
4. Click **Register app**.
5. You'll see a `firebaseConfig` object. Copy the whole thing.
6. Open `js/firebase-init.js` and replace the config object with yours.
   **Already done for this project** — your real config is in the file.
   It looks like this:

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "murder-mystery-xxxxx.firebaseapp.com",
     projectId: "murder-mystery-xxxxx",
     storageBucket: "murder-mystery-xxxxx.appspot.com",
     messagingSenderId: "123456789012",
     appId: "1:123456789012:web:abc123def456"
   };
   ```

> **This config is not a secret.** It ships in every Firebase web app and
> is visible in DevTools by design. It identifies your project; it does not
> grant access to it. Access is decided entirely by the rules in section 6.
> Don't waste effort trying to hide it — put the effort into the rules.

---

## 6. Paste in the security rules

**This is the step that makes or breaks the build.** Skip it and every
secret in the game is public.

1. **Build → Firestore Database → Rules** tab.
2. Delete everything in the editor.
3. Open `firestore.rules` from this project, copy all of it, paste it in.
4. Check the UID near the top. **Already filled in for this project:**

   ```
   && request.auth.uid in [
        'B8CkPp6XqTcHfvOcZHE8ghqNahI3'  // hasthimunisilva@icloud.com
      ];
   ```

   Add another line to that list to allow a second host.
5. Click **Publish**. Changes go live in under a minute.

### What these rules actually enforce

| Path | Player (anonymous) | Host (email login) |
|---|---|---|
| `stories/**` — the whole tree | **denied — entirely** | read + write |
| `sessions/{id}` | read | read + write |
| `sessions/{id}/players/*` | read all, write own | read + write |
| `sessions/{id}/private/{uid}` | **read own only** | read + write |
| `sessions/{id}/votes/*` | write own only | read + write |

The important row is `private/{uid}`. When you start a game, your host
browser reads the story's characters, deals them out, and writes each
player's character into `sessions/{id}/private/{thatPlayersUid}`. The rule
on that path is a single condition: `request.auth.uid == uid`. A player's
phone asking for anyone else's private document gets a permission error
from Google's servers before a single byte of story text is sent.

Players never read anything under `/stories` — not the metadata, not the
characters, not the clues. The host copies the handful of public bits a
player needs (story title, synopsis, and each released clue) into the
session document. That is blunter than strictly necessary, and
deliberately so: a narrower rule would have to let players read the story
document for its title, and since Firestore returns whole documents or
nothing, one careless field on that document would leak. Closing the tree
removes the possibility rather than managing it.

---

## 7. Seed the story

**Seed from localhost, not from the deployed site.**

`js/admin-seed.js` contains every secret in the story, including the
solution. It is a static file — Firestore rules cannot protect it, only
not serving it can. So it should never be fetched over the public
internet, and `_redirects` blocks it on Netlify as a second line of
defence.

Double-clicking the file will not work either: Firebase Auth rejects the
`null` origin a `file://` page has. You need a local web server, and
Python has one built in.

1. Open a terminal in this folder and run:

   ```
   python -m http.server 8767
   ```

2. Go to `http://localhost:8767/admin/seed.html`.
   (`localhost` is already in Firebase's authorised domains, so sign-in
   works.)
3. Sign in with your host email and password.
4. Click **Seed "The Speckled Band Mystery"**.
5. Wait for the green confirmation, then stop the server with Ctrl+C.

This writes the story, its six characters, and its phases into Firestore.
**Run it once.** Running it twice overwrites the story with a fresh copy
and wipes any edits you made in the story editor.

Once seeded, the story lives in Firestore and is edited through
`admin/story.html`. The seed file has done its job — you can delete
`js/admin-seed.js` and `admin/seed.html` entirely if you prefer not to
rely on the `_redirects` rule.

The story text is never bundled into `play.html` or any file a player's
phone downloads.

---

## 8. Deploy to Netlify

There is no build step. Netlify serves the files exactly as they are.

Settings, when Netlify asks:

| Field | Value |
|---|---|
| Base directory | *empty* |
| Build command | *empty* |
| Publish directory | `.` |
| Functions directory | *empty* |
| Environment variables | *none* |

The Firebase config stays in the source. It is public by design — do not
move it to an environment variable.

**Option A — drag and drop (fastest)**

1. Go to https://app.netlify.com/drop
2. Drag this entire project folder onto the page.
3. You get a URL like `https://cheerful-otter-a1b2c3.netlify.app`.

**Option B — from GitHub (better, redeploys on push)**

1. Push this folder to `github.com/TEDDY-NO1R/Murder-Mystery`.
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. **Build command:** leave empty.
   **Publish directory:** `.` (a single dot).
4. **Deploy**.

### Then do this — it's easy to miss

Firebase blocks logins from domains it doesn't recognise, so your host
login will fail on the live site until you add it:

1. Firebase Console → **Authentication → Settings → Authorized domains**.
2. **Add domain** → paste your Netlify domain (just
   `cheerful-otter-a1b2c3.netlify.app`, no `https://`, no trailing slash).

`localhost` is already on the list, which is why local testing works
without this.

---

## 9. Prove the security actually works

Do this once. It takes two minutes and it's the only way to know.

1. Open `host.html`, sign in, start a game.
2. Join from a phone (or a second browser) at `play.html`.
3. On the **player's** browser, open DevTools → **Console**, and run:

   ```js
   const { getFirestore, getDocs, collection } =
     await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
   await getDocs(collection(getFirestore(), 'stories/SPECKLED_BAND/characters'));
   ```

4. **You must see:** `FirebaseError: Missing or insufficient permissions.`

If you see that error, the rules are working and a player cannot find the
killer no matter how hard they dig. If you get actual data back, stop —
the rules didn't publish. Go back to section 6, confirm you clicked
**Publish**, and confirm the UID on the `isAdmin()` line matches the one
in the Users tab.

Worth repeating in the **Network** tab too: filter to `firestore` and
confirm the only character data crossing the wire is the player's own.

---

## 10. Running a game

1. You open `host.html`, sign in. A room code appears.
2. Players open `play.html`, type the code and their name.
3. You watch them appear in the lobby, then hit **Start Game**.
4. Characters are dealt. Each phone shows a sealed envelope; tapping it
   opens their card, and theirs alone.
5. You advance phases and release clues one at a time. Every phone updates
   live.
6. At **Accusation**, players vote. At **Reveal**, everything opens up.

Detective accuses correctly → innocents win. Wrong → the killer walks.

---

## Troubleshooting

**"Missing or insufficient permissions" when the host tries to start**
The UID on the `isAdmin()` line doesn't match your account. Recopy it from
Authentication → Users and republish the rules.

**Host login fails on the live site but works locally**
You skipped the Authorized domains step at the end of section 8.

**Players can't join / room code not found**
Room codes are per-session and die when you close the host tab. Start a
fresh game and read the new code.

**Seed page says permission denied**
You're signed in as the wrong account, or the rules aren't published yet.

**Nothing updates in real time**
Something threw earlier in the page and killed the listener. Check the
browser console for the first error, not the last.

---

## File map

```
play.html            player's phone — join, envelope, card, clues, vote
host.html            your control panel — pacing, clues, reveal
admin/login.html     host + editor sign-in
admin/story.html     story editor
admin/seed.html      run once, section 7
css/game.css         player styling
css/admin.css        host + admin styling
js/firebase-init.js  your config goes here (section 5)
js/game.js           player logic and realtime listeners
js/host.js           host controls
js/admin.js          story create/edit
js/admin-seed.js     The Speckled Band story data
firestore.rules      paste into console (section 6)
```
