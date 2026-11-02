# Knowledge and investigation model

**Status:** Undecided. The owner is still figuring out what to do with this
area. Do not redesign its UI or change its stored data until a decision is
recorded as an [ADR](../decisions/) and the work moves to the
[backlog](../BACKLOG.md). Bug fixes that keep current behaviour are fine.

**Last reviewed:** 2026-11-02

This note collects how the area works today, what feels wrong, and the
questions a decision has to answer. Add observations as they come up.

## What exists today

### Knowledge levels

- **Characters** have no knowledge level: the owner decided to remove it
  because it was rarely used. Every reader sees the whole profile of a
  character visible to them; secrecy uses record visibility and DM/player
  twins ([core data](../reference/CORE_DATA.md#twin-reading-and-management)).
- **Locations** store `knowledge` 0–4 (editable, filterable), but nothing in
  the host reads it.

### Facts, questions and clues

- **Characters:** `known` is a list of facts ("What is known"); `unknown` is a
  list of questions with optional answers ("Open questions"). An answer closes a
  question but keeps it. Both edit in place on the profile.
- **Mysteries:** `questions` (question and answer pairs), `solved` (a manual
  override; otherwise solved when every question has an answer), `clues` (a
  string list), and linked `characters` and `locations`.
- **Clues** mean two things at once. The editor treats them as free-text lines,
  many stored clues are event keys such as `kela_priznani`. The mystery page currently shows a clue that matches an event
  key as a link to that event; anything else is shown as text.
- The **unanswered-questions list** on the Mysteries page merges character
  questions and mystery questions, with answer history underneath.

### Mind Palace

`#/graph/factions`, `#/graph/relationships` and `#/graph/mysteries`. The
mystery mode links mysteries to their characters and labels a mystery card with
its first question only
([core data](../reference/CORE_DATA.md)).

## What feels wrong

- Location knowledge is stored and edited but has no effect.
- Clues mix prose and record references in one list, and event keys only
  become links by coincidence of matching an event key.
- Characters and mysteries each have their own way to hold facts and open
  threads, so the same investigation can live in two shapes.
- Mind Palace shows only the first question of a mystery.
- Mind Palace colours a mystery's priority only when the value is the Czech
  *kritická* or *vysoká*, so other languages get the default colour.
- Mind Palace has its own context menu instead of the shared record menu, with
  a fixed size and no type-ahead or submenus.

## Questions to answer

1. Should location knowledge go as well, or gain a meaning?
2. Are clues references to records (events, locations, characters), prose, or
   typed entries that can be either?
3. Should character facts and questions stay on characters, move to mysteries,
   or become their own linked records?
4. How should Mind Palace and the questions list present an investigation?
5. How do existing records migrate without losing anything (event-key clues,
   answered questions, unknown fields), and what does the reviewed migration
   look like?

## Code and docs

- `frontend/src/app/campaign-investigation.ts`, `investigation-view.ts`,
  `codex-investigation-queue.ts` — questions, status and the queue
- `frontend/src/app/codex-character-profile.ts` — facts and questions on profiles
- `frontend/src/app/codex-record-page.ts` (`clueLinks`) — clue display
- `frontend/src/app/campaign-graph*.ts`, `codex-campaign-graph.ts` — Mind Palace
- [Core data](../reference/CORE_DATA.md), [editing and browsing](../reference/EDITOR_BROWSING.md)
