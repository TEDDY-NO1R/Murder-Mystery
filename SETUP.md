# Murder Mystery — Setup

Everything here is done in a browser, apart from seeding a story from
`localhost`. No npm, no build step.

---

## Current state of this project (6 Oct 2026)

Project **murder-mystery-online**, Spark plan, Firestore in **eur3**,
Native mode. All of this is done:

| Step | State |
|---|---|
| 1. Project created | Done |
| 2. Firestore created | Done — `(default)`, eur3 |
| 3. Sign-in methods | Email/Password and Anonymous enabled (auto clean-up of stale guest accounts on) |
| 4. Story-editor account | `hasthimunisilva@icloud.com`, UID `B8CkPp6XqTcHfvOcZHE8ghqNahI3` |
| 5. Web app registered | "Murder Mystery Web"; config is in `js/firebase-init.js` |
| 6. Rules | `firestore.rules` published 6 Oct 2026 |
| 7. Story seeded | *The Speckled Band* (`the-speckled-band`), published |
| 8. Deployed | Netlify, from GitHub `main` |

The sections below are how to redo any step.

---

## How the game is put together

People sit in one room. Each person opens the site on their phone. One of
them taps **Host a game**, picks a story and reads out the room code; the
rest join with it. The host plays too, with a few extra buttons. Firestore
keeps every phone in sync in real time.

The host's phone deals the cards, so it reads the story — which means
stories are readable by any signed-in browser and the ending stays hidden
by the honour system: no screen ever shows it before the reveal. See
"Secrets" in README.md for what the rules still enforce.

---

## 1. Firebase project and Firestore

1. https://console.firebase.google.com → **Create a project**. Analytics
   off.
2. **Build → Firestore Database → Create database**, **production mode**,
   a location near you (cannot be changed later).

## 2. Sign-in methods

**Build → Authentication → Sign-in method**, enable both:

- **Anonymous** — every player and host gets a throwaway ID automatically.
- **Email/Password** — only for the story editor.

## 3. Story-editor account

**Authentication → Users → Add user** with an email and a password you
keep in a password manager (there is no reset page in the app; Firebase's
**⋮ → Reset password** emails a link). Copy the **User UID** — it goes in
the rules. Anyone with this login can read and change every story.

## 4. Web config

**Project settings → Your apps → `</>`**, register the app (no Firebase
Hosting), and put the `firebaseConfig` object into `js/firebase-init.js`.
The config is not a secret; access is decided by the rules.

## 5. Security rules

1. **Firestore Database → Rules**, delete everything in the editor.
2. Paste the whole of `firestore.rules`. (From PowerShell:
   `Get-Content -Raw -Encoding UTF8 firestore.rules | Set-Clipboard`.)
3. Check the UID in `isAdmin()` is the story-editor UID. Add more UIDs to
   allow more editors — hosting needs no allowlist.
4. **Publish**.

## 6. Deploy to Netlify

No build step. Base directory empty, build command empty, publish
directory `.`. Either drag the folder onto https://app.netlify.com/drop or
import the GitHub repo (redeploys on every push to `main`).

`_redirects` serves the game at `/`, sends the old `/host.html` to `/`, and
404s the seed files and `firestore.rules`.

## 7. Seed a story

**Seed from localhost, not from the deployed site.** `js/admin-seed.js`
holds the whole story, ending included. It is gitignored (the repo is
public) and `_redirects` 404s it on Netlify.

1. Serve this folder on `http://localhost:8767` with any static web server
   (e.g. `python -m http.server 8767` if Python is installed; on this PC a
   small PowerShell `HttpListener` script was used).
2. Open `http://localhost:8767/admin/seed.html` and sign in as the story
   editor.
3. Click **Seed "The Speckled Band"**. The page shows counts only, never
   story text, so whoever seeds can still play.

Run it once — running it again replaces the story and discards any edits
made in the story editor. Opening a story in `admin/story.html` shows every
secret; don't, if you want to play it.

New stories can also be written directly in `admin/story.html`. Only
stories with status **published** appear in the host's list.

---

## 8. Check the rules work

1. Host a game on one device and join from another (or a private window —
   tabs in one browser profile count as the same player). Start the game.
2. On the **joining** browser, open DevTools → **Console** and try to read
   the host's card (replace `CODE` and `HOST_UID`; the host's UID is the id
   of their document under `sessions/CODE/players`):

   ```js
   const { getFirestore, getDoc, doc } =
     await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
   await getDoc(doc(getFirestore(), 'sessions/CODE/private/HOST_UID'));
   ```

3. **You must see:** `FirebaseError: Missing or insufficient permissions.`

---

## 9. Running a game

1. One person opens the site, taps **Host a game**, picks a story, enters
   their name and taps **Open the room**. A room code appears.
2. Everyone else opens the site and types the code and their name.
3. The host watches them arrive (and can **Remove** anyone who joined by
   mistake), then taps **Start game**. 3–8 players.
4. Every phone, the host's included, shows a sealed envelope; tapping it
   opens that player's card.
5. The host's bar releases clues one at a time (unseen until released) and
   moves to the next phase. Every phone updates live.
6. At **Accusation** everyone votes; the bar counts how many have.
   **Reveal the truth** opens everything up. **Close room** ends it.

The detective accuses correctly → the innocents win. Wrong → the killer
walks.

---

## Troubleshooting

**"Missing or insufficient permissions" when hosting or starting**
The rules aren't published, or are an old version. Republish
`firestore.rules`.

**"No stories are ready to play yet"**
No story has status **published**. Seed one or publish one in the editor.

**"This story isn't ready to play"**
It needs exactly one KILLER and one DETECTIVE, every character needs a
role, and the solution must name the KILLER character. Fix it in the
editor (ideally someone who won't play it).

**Players can't join**
Joining closes when the host starts the game, and a code stops working
when the room is closed. Reloading or closing the host's page does not end
the room; the host's phone rejoins it when the site is opened again.

**Editor login fails on the live site**
`auth/invalid-credential` means the email or password is wrong. Authorized
domains are not involved.

**Nothing updates in real time**
Check the browser console for the first error, not the last.

---

## File map

```
play.html            the home page — join, or host: pick a story, deal, pace;
                     envelope, card, clues, vote, reveal
admin/login.html     story-editor sign-in
admin/story.html     story editor
admin/seed.html      one-time story loader (not in git, not deployed)
css/game.css         player + host styling
css/admin.css        editor styling
js/firebase-init.js  Firebase config, game constants, path helpers
js/game.js           player and host logic, realtime listeners
js/admin.js          story create/edit
js/admin-seed.js     The Speckled Band story data (not in git, not deployed)
firestore.rules      paste into the console (section 5)
_redirects           Netlify routing and blocked paths
```
