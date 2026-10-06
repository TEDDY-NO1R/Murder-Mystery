# Murder Mystery

> **Picking this up fresh?** Read **[HANDOFF.md](HANDOFF.md)** first — it has
> the current status, how a game runs, and where to find the files that are
> deliberately not in this repo.

A murder mystery party game for people sitting in the same room.

Everyone joins with a room code. Each guest's phone becomes their private
character card — their name, their secret, what they want from the evening.
Anyone can host: they pick a story, open a room, and play like everyone else.
Their phone deals the parts, and they release clues and move the evening
through its phases with a few buttons — but nothing secret is ever shown on
their screen. Nobody reads a booklet, and nobody has to be the person who
already knows the ending.

Play it at **[murder-mystery-online.netlify.app](https://murder-mystery-online.netlify.app)**.

Ships with one story: *The Speckled Band*, adapted from Arthur Conan Doyle
(public domain). Three to eight players, sixty to ninety minutes.

---

## How it works

| | |
|---|---|
| **Players** | `play.html` (the home page) — join, open a sealed envelope, read your card, follow the clue feed, accuse |
| **Host** | the same page → **Host a game** — pick a story, open a room, start, release clues, advance phases, reveal, close. The host plays too. |
| **Editor** | `admin/story.html` — write, edit and publish stories (only published stories appear in the host's list) |

Roles scale with the table: three players is Killer, Detective and Suspect;
four adds a Witness; five adds an Accomplice; six to eight add more Suspects.
The Detective wins it for the innocents by accusing correctly — and loses it
for everyone by getting it wrong.

Phases run `lobby → arrival → investigation → confrontation → accusation →
reveal`, advanced by the host, never on a timer.

## Secrets — honour system

Anyone can host, and the host plays too, so the host's phone does the
dealing. To deal, it must read the story — so **story data is readable by
any signed-in browser**, and the secrecy of the ending rests on the host's
screen never showing it, not on the database. Someone opening DevTools to dig
for it could find it. That trade-off was chosen deliberately; making it
cheat-proof would need a server-side dealer (e.g. a Netlify or Cloud
Function), which can be added later.

What is still enforced by the rules:

- Only the story editor (email login on the allowlist) can **write** stories.
- Only a room's own host can deal, pace, release clues or close it; a live
  room cannot be taken over by guessing its code.
- Each player's card is at `sessions/{code}/private/{uid}`; other players are
  refused it.
- Joining only while the lobby is open; one final vote per dealt player, for
  another dealt character; the ending is unreadable from the room until the
  reveal; leftovers of a closed room are unreadable.

The host's screen shows buttons and counts only. Clues are released without a
preview, so the host reads each one at the same moment as everyone else.

## Stack

Plain HTML, CSS and JavaScript. No framework, no npm, no build step.
Firebase v10 via CDN modules for Firestore and Auth; deployed on Netlify with
an empty build command.

Setup lives in [SETUP.md](SETUP.md) — Firebase project, security rules,
deployment and seeding, in order.

> `js/admin-seed.js` is deliberately not in this repository: the repo is
> public and that file is the whole story, ending included. It is a one-time
> seeding script run from `localhost`; afterwards the story lives in Firestore
> and is edited through the story editor.

## Licence

MIT — see [LICENSE](LICENSE). The Speckled Band is adapted from a public
domain work.
