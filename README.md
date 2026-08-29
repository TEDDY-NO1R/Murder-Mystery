# Murder Mystery

A murder mystery party game for people sitting in the same room.

Everyone joins with a room code. Each guest's phone becomes their private
character card — their name, their secret, what they want from the evening.
One person hosts from a laptop: they see a control panel, deal the parts,
release clues one at a time, and move the evening through its phases. Nobody
reads a booklet, and nobody has to be the person who already knows the ending.

Play it at **[murder-mystery-online.netlify.app](https://murder-mystery-online.netlify.app)**.

Ships with one story: *The Speckled Band Mystery*, adapted from Arthur Conan
Doyle (public domain). Four to six players, about ninety minutes.

---

## How it works

| | |
|---|---|
| **Players** | `play.html` — join, open a sealed envelope, read your card, follow the clue feed, accuse |
| **Host** | `host.html` — room code, live roster, deal, release clues, advance phases, trigger the reveal |
| **Editor** | `admin/story.html` — write and edit stories, characters and clues |

Roles scale with the table: three players is Killer, Detective and Suspect;
four adds a Witness; five adds an Accomplice; six to eight add more Suspects.
The Detective wins it for the innocents by accusing correctly — and loses it
for everyone by getting it wrong.

Phases run `lobby → arrival → investigation → confrontation → accusation →
reveal`, advanced by the host, never on a timer.

## Secrets

The whole design rests on one rule: **a phone can only download the character
it owns.** Not hidden by the interface — refused by the database.

- Nothing under `/stories` is readable by a player. Not the characters, not
  the clues, not the metadata. The host copies the public parts (story title,
  synopsis, each released clue) into the session document.
- Characters live in a **subcollection**, never as an array on the story
  document. Firestore returns whole documents or nothing, so an array field
  could not be secured while the title stayed readable.
- At game start the host deals each character into
  `sessions/{code}/private/{uid}`, whose read rule is one condition:
  `request.auth.uid == uid`. Listing that collection is admin-only, so it
  cannot be pulled in a single query.
- Clue text reaches a session only when the host releases it. An unreleased
  clue was never transmitted.
- The solution's read rule is gated on the live phase — it is genuinely
  unfetchable until the host reaches the reveal.
- Players authenticate anonymously; the host signs in with email and password.
  The rules treat anonymous as untrusted throughout.

The test that matters: open DevTools as a player and try to read another
character. You get `Missing or insufficient permissions` from Google's
servers, not filtered data.

## Stack

Plain HTML, CSS and JavaScript. No framework, no npm, no build step.
Firebase v10 via CDN modules for Firestore and Auth; deployed on Netlify with
an empty build command.

Setup lives in [SETUP.md](SETUP.md) — Firebase project, security rules,
seeding and deployment, in order.

> `js/admin-seed.js` is deliberately not in this repository. It holds every
> secret in The Speckled Band, including the solution. It is a one-time
> seeding script run from `localhost`; afterwards the story lives in Firestore
> and is edited through the story editor.

## Licence

MIT — see [LICENSE](LICENSE). The Speckled Band is adapted from a public
domain work.
