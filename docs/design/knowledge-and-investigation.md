# Knowledge and investigation model

**Status:** Undecided. The owner is still figuring out what to do with this
area. Do not redesign its UI or change its stored data until a decision is
recorded as an [ADR](../decisions/) and the work moves to the
[backlog](../BACKLOG.md). Bug fixes that keep current behaviour are fine.

**Last reviewed:** 2026-10-07

This note collects how the area works today, what feels wrong, and the
questions a decision has to answer. Add observations as they come up.

## What exists today

### Knowledge levels

- **Characters** store `knowledge` 0–4. Level 0 shows "Unknown character",
  level 1 shows only the name, levels 2–4 show everything. Missing or invalid
  values read as 4. Cards, search, facets, activity, graph labels and the
  roster filter (party/NPC is only revealed from level 2) use the same reading
  projection (`frontend/src/app/character-reading.ts`). DMs can inspect the
  authored fields without changing anything.
- Knowledge is a reading convention, **not** a security boundary. Real secrecy
  uses record visibility and DM/player twins
  ([core data](../reference/CORE_DATA.md#character-knowledge-and-dm-inspection)).
- **Locations** also store `knowledge` 0–4 (editable, filterable), but nothing
  in the host reads it. v1 showed it as badges such as "Fully mapped".
- There is one level per record for the whole campaign, not per player or party.

### Facts, questions and clues

- **Characters:** `known` is a list of facts ("What is known"); `unknown` is a
  list of questions with optional answers ("Open questions"). An answer closes a
  question but keeps it. Both edit in place on the profile.
- **Mysteries:** `questions` (question and answer pairs), `solved` (a manual
  override; otherwise solved when every question has an answer), `clues` (a
  string list), and linked `characters` and `locations`.
- **Clues** mean two things at once. The editor treats them as free-text lines,
  but many records carried over from v1 hold event keys such as
  `kela_priznani`. The mystery page currently shows a clue that matches an event
  key as a link to that event; anything else is shown as text.
- The **unanswered-questions list** on the Mysteries page merges character
  questions and mystery questions, with answer history underneath.

### Mind Palace

`#/graph/factions`, `#/graph/relationships` and `#/graph/mysteries`. The
mystery mode links mysteries to their characters and labels a mystery card with
its first question only
([core data](../reference/CORE_DATA.md)).

## What feels wrong

- Levels 2, 3 and 4 look identical to readers, so the scale has more steps than
  meaning.
- Location knowledge is stored and edited but has no effect.
- Clues mix prose and record references in one list, and v1 keys only become
  links by coincidence of matching an event key.
- Characters and mysteries each have their own way to hold facts and open
  threads, so the same investigation can live in two shapes.
- A single campaign-wide level cannot express "the party knows, one player
  does not".
- Mind Palace shows only the first question of a mystery.

## Questions to answer

1. What should each knowledge level reveal, and how many levels are useful?
2. Should knowledge apply to locations, factions and other records, and with
   the same scale?
3. Campaign-wide, per party, or per player?
4. Are clues references to records (events, locations, characters), prose, or
   typed entries that can be either?
5. Should character facts and questions stay on characters, move to mysteries,
   or become their own linked records?
6. How should Mind Palace and the questions list present an investigation?
7. How do existing records migrate without losing anything (v1 clue keys,
   answered questions, unknown fields), and what does the reviewed migration
   look like?

## Code and docs

- `frontend/src/app/character-reading.ts` — knowledge reading projection
- `frontend/src/app/campaign-investigation.ts`, `investigation-view.ts`,
  `codex-investigation-queue.ts` — questions, status and the queue
- `frontend/src/app/codex-character-profile.ts` — facts and questions on profiles
- `frontend/src/app/codex-record-page.ts` (`clueLinks`) — clue display
- `frontend/src/app/campaign-graph*.ts`, `codex-campaign-graph.ts` — Mind Palace
- [Core data](../reference/CORE_DATA.md), [editing and browsing](../reference/EDITOR_BROWSING.md)
