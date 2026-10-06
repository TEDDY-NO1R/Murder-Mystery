# Murder Mystery — Firebase Setup

Follow this once, top to bottom. Every step is done in a browser.
No terminal, no npm, no build step.

Budget about 20 minutes.

> **Changed 6 Oct 2026 — anyone can host.** There is no separate host
> page any more: the home page offers **Join** or **Host a game**, and the
> host plays too. Stories are now readable by any signed-in browser (the
> host's phone needs them to deal) and only the story editor can write
> them — see "Secrets" in README.md. Where this guide still talks about
> `host.html` or "the whole stories tree is admin-only", that describes the
> earlier model.

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
| 4. Story-editor account | Done — `hasthimunisilva@icloud.com`, UID `B8CkPp6XqTcHfvOcZHE8ghqNahI3` (password reset 6 Oct) |
| 5. Web app registered | Done — "Murder Mystery Web"; config already baked into `js/firebase-init.js` |
| 6. Rules | Real `firestore.rules` published 29 Aug; audit revision 6 Oct; **"anyone can host" revision must be published** after 6 Oct. |
| 7. Story seeded | New *The Speckled Band* (`the-speckled-band`) written 6 Oct; seed it from localhost (section 7). |

### What was found on 29 Aug (history)

The rules in place until 29 Aug were:

```
match /stories/{storyId} {
  allow read: if true;
}
```

`if true` means no login of any kind. All five stories — 31 `secret`
fields — were fetchable over plain HTTP by anyone who knew the project
ID. Verified with curl, then closed the same day with a temporary
deny-all rule set, which the real `firestore.rules` then replaced.

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
2. Publish the real `firestore.rules` (section 6) — done 29 Aug; 6 Oct
   revision republished.
3. Deploy (section 8), then run `admin/seed.html` once (section 7) — not
   done yet.

Step 2 is safe to do before seeding because the whole `stories` tree is
admin-only in the real rules — players never read it at all, so the
legacy `characters` array still sitting in the old documents is
unreadable either way. The seed then replaces `speckled-band` outright,
which deletes that array. The other four stories stay locked and
untouched until you want them.

---

## What you are building

People sit in one room. Each person opens the site on their phone. One of
them taps **Host a game**, picks a story and reads out the room code; the
rest join with it. The host plays too, with a few extra buttons. Firestore
keeps every phone in sync in real time.

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

| Path | Any player | That room's host | Story editor (email login) |
|---|---|---|---|
| `stories/**` | read | read | read + write |
| `sessions/{id}` | read; create a new room as its host | update / delete own room | everything |
| `sessions/{id}/players/*` | read own, or all once joined; join only while the lobby is open; rename self | deal names, remove guests | everything |
| `sessions/{id}/private/{uid}` | **read own only** | write (deal), clean up | everything |
| `sessions/{id}/votes/*` | read own; cast once, in accusation, only if dealt, for another dealt character; all visible at reveal | count, clean up | everything |
| `sessions/{id}/reveal/summary` | read only at reveal, and only if joined | write | everything |

Every player read of a session's children also requires the session
document to still exist, so a closed room's leftovers are unreadable.
The host deletes those children when closing a room anyway.

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

1. Serve this folder on `http://localhost:8767` with any static web server
   (for example `python -m http.server 8767`, if Python is installed).
2. Go to `http://localhost:8767/admin/seed.html`.
   (`localhost` is already in Firebase's authorised domains, so sign-in
   works.)
3. Sign in with the story-editor email and password.
4. Click **Seed "The Speckled Band"**. The page shows only counts, never
   story text, so whoever seeds can still play.
5. Wait for the confirmation, then stop the server.

This writes the story (id `the-speckled-band`), its eight characters and
its clues into Firestore, published, so it appears in the host's list.
**Run it once.** Running it again overwrites the story with a fresh copy
and wipes any edits you made in the story editor. Opening the story in
the editor shows every secret — don't, if you want to play it.

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

### Authorized domains — not needed for this build

Firebase's **Authentication → Settings → Authorized domains** list gates
**OAuth redirect flows only** — Google, Phone, and other third-party
sign-in. This project uses neither: players sign in anonymously and the
host uses email/password, and both are direct API calls that work from
any origin.

Verified on 29 Aug: the live site authenticates players correctly while
the authorized-domain list contains only `localhost`,
`murder-mystery-online.firebaseapp.com` and `murder-mystery-online.web.app`.

Add your Netlify domain anyway if you ever enable Google sign-in. Until
then it changes nothing.

---

## 9. Prove the security actually works

Do this once. It takes two minutes and it's the only way to know.

Since 6 Oct, story data is readable by any signed-in browser (honour
system — see README.md), so the old "read the characters and expect a
permission error" test no longer applies. What still must hold:

1. Host a game on one device and join from another (or from a **different
   browser profile / private window** — tabs in one profile share one
   identity, so they count as the same player).
2. Start the game. On the **joining** browser, open DevTools → **Console**
   and try to read the host's card (replace `CODE` and `HOST_UID`; the
   host's UID is the id of their document under `sessions/CODE/players`):

   ```js
   const { getFirestore, getDoc, doc } =
     await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
   await getDoc(doc(getFirestore(), 'sessions/CODE/private/HOST_UID'));
   ```

3. **You must see:** `FirebaseError: Missing or insufficient permissions.`
   If you get data back, the rules didn't publish — go back to section 6.

---

## 10. Running a game

1. One person opens the site, taps **Host a game**, picks a story, enters
   their name and taps **Open the room**. A room code appears.
2. Everyone else opens the site, types the code and their name.
3. The host watches them appear in the lobby (and can remove anyone who
   joined by mistake), then taps **Start game**.
4. Characters are dealt — the host gets one too. Each phone shows a sealed
   envelope; tapping it opens that player's card, and theirs alone.
5. The host's bar at the bottom releases clues one at a time (without
   previewing them) and moves to the next phase. Every phone updates live.
6. At **Accusation**, players vote; the host's bar counts how many have.
   **Reveal the truth** opens everything up. **Close room** ends it.

Detective accuses correctly → innocents win. Wrong → the killer walks.

---

## Troubleshooting

**"Missing or insufficient permissions" when hosting or starting**
The "anyone can host" rules haven't been published yet. Republish
`firestore.rules` (section 6).

**Story-editor login fails on the live site but works locally**
Not an authorized-domains problem — email/password works from any origin.
Check the browser console for the real error; `auth/invalid-credential`
means the email or password is simply wrong.

**"No stories are ready to play yet" on the host screen**
Only stories with status **published**, stored in the subcollection shape,
are listed. Seed one (section 7) or publish one in the story editor.

**Players can't join / room code not found**
A room lasts until the host taps **Close room** — closing or reloading the
host's page does not end it, and the host's phone rejoins the same room
when the site is opened again. A code stops working once the room is
closed, and joining is refused once the host has started the game (late
arrivals cannot be dealt in). Check the code, or open a fresh room.

**Too many people joined, or someone joined by mistake**
While the room is still in the lobby, the host taps **Remove** beside their
name. The game deals at most 8.

**Start game says "This story isn't ready to play"**
The story needs exactly one KILLER and one DETECTIVE, every character
needs a role, and the solution's killer must be the KILLER character. Fix
it in `admin/story.html` (which shows the secrets — ideally have someone
who won't play it do this).

**Seed page says permission denied**
You're signed in as the wrong account, or the rules aren't published yet.

**Nothing updates in real time**
Something threw earlier in the page and killed the listener. Check the
browser console for the first error, not the last.

---

## File map

```
play.html            the home page — join, or host: pick a story, deal, pace;
                     envelope, card, clues, vote, reveal
admin/login.html     story-editor sign-in
admin/story.html     story editor
admin/seed.html      run once, section 7 (not in git, not deployed)
css/game.css         player + host styling
css/admin.css        editor styling
js/firebase-init.js  your config goes here (section 5)
js/game.js           player and host logic, realtime listeners
js/admin.js          story create/edit
js/admin-seed.js     The Speckled Band story data (not in git, not deployed)
firestore.rules      paste into console (section 6)
```
