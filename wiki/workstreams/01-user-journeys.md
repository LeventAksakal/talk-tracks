# 01 · User journeys

**Status:** draft authored · **Session:** coordinator & owner · **Due:** Sat Oct 31, 23:00 +03 · **Feeds:** 03, 05, 06, 07

## Goal

Write down every core journey step by step, so the UI build knows what to build, the QA session knows what to walk
through, and the demo video knows what to show. One document: `wiki/product/journeys.md`.

## Why now

The player and console are built as features (ui-design.md), but nobody has written the end-to-end paths: how a
person arrives, what they see at each step, what can go wrong, and where it ends. The owner's verdict on Oct 28 was
"a finished product any teacher or student can use". That needs journeys, not only features.

## Read first

- [product/ui-design.md](../product/ui-design.md): needs L1–L9, S1–S5, E1–E2 (§2), player states (§5), phone (§6),
  console (§7), lobby (§8).
- [product/design-brief.md](../product/design-brief.md) §2–§4: who uses it, screens, states.
- [product/inspection-2026-10-28.md](../product/inspection-2026-10-28.md): the owner's verdict.
- [howto/demo-moments.md](../howto/demo-moments.md): the four moments judges must see.
- [decisions 0005](../decisions/0005-publishing-needs-a-signed-token.md),
  [0008](../decisions/0008-judges-get-capped-room-tokens.md): why a speaker needs a token, and judges' caps.
- What runs today: `npm run dev` in `web/`, then `/`, `/demo`, `/watch/virus`, `/talk/<room>?clock=local`.

## Journeys to write

| ID | Who | Journey | Ends when |
|---|---|---|---|
| J1 | Listener, phone | Scans the projected QR, lands in the live room, hears the speaker, turns on subtitles in their language | they follow the talk with subtitles |
| J2 | Listener, desktop | Opens the site, picks a demo room or types a room name, joins | the player plays |
| J3 | Listener | Takes part: subtitles and language, layout, chapters, transcript, rewind and go live, notes and bookmarks, ink/marks/comments on a slide | they leave or the talk ends |
| J4 | Late joiner or reconnect | Arrives 10 min in or loses the network; catches up through "what you missed", chapters, recap | they are back at live |
| J5 | Presenter | **Creates a room**: name, title, gets the speaker link and the audience link/QR | they are in the console's pre-flight |
| J6 | Presenter | Pre-flight (mic, camera, deck) → on air → slides, drawing, laser → questions → end talk | the room shows "ended" with a replay link |
| J7 | Listener after the talk | Opens the link of an ended talk and replays it with every track and drawing | — |
| J8 | Judge | Lands cold, understands the product in seconds, opens a demo room, opens Stats for nerds, starts a live room with a judge link | they have seen the four demo moments |

For each: **entry point** (URL, QR, button), **steps** (screen → action → result), **states and failures** (no mic,
refused permission, expired token, room not started, ended, WebSocket fallback, budget reached, offline), **phone vs
desktop** differences, **acceptance criteria** written so QA can tick them, and whether it is a **demo-video moment**.

## Decisions to make

1. **How a presenter creates a room (J5).** Today a speaker link is minted on the VM by script.
   - A. **Create room with an access code** (recommended): a form on the site asks for a room name and a code; the
     room service mints a capped speaker token. Judges get a code in the submission text. Needs the endpoint in 05.
   - B. Open self-serve with a small per-room cap and a per-IP rate limit. Simplest UX; open to spend abuse.
   - C. Keep minted links; the lobby says "Paste your speaker link". No backend work; weakest journey.
2. **Does a listener need a display name?** Only on first annotation or comment (current plan), or on joining.
3. **Default layout** when slides and camera are both on: split, picture-in-picture or auto (ui-design §12 q3).
4. **What you missed** (J4): notice, nothing, or recap line (ui-design §12 q5).
5. **Comments made during a replay** (J7): added to the timeline, kept per replay, or not allowed (ui-design §12 q7).

## Deliverables

- `wiki/product/journeys.md`: J1–J8 as above, a screen inventory (every screen and state the journeys touch), and
  a short "golden path" for the demo video (J8 → J1 → J6 in about 3 minutes).
- Answers to the decisions above, recorded as decisions or tickets.
- A handoff list for 03 (screens to build or change) and for 05 (backend needs, such as room creation and room
  metadata like title and speaker name).

## Definition of done

- The owner has read and accepted journeys.md.
- Every journey has acceptance criteria that 06 can test as written.
- Decision 1 is answered, so 05 can build the endpoint on Sunday.

## Start prompt

> You are the User journeys session for Talk Tracks. Read `wiki/workstreams/01-user-journeys.md` and its Read first
> list, run the web app locally to see what exists, then draft `wiki/product/journeys.md`. Ask me the five decisions
> one at a time with your recommendation. Log progress in the workstream file.

## Log

| When (+03) | Session | Entry |
|---|---|---|
| 10-31 12:57 | coordinator | Brief written. |
| 10-31 13:25 | coordinator + owner | Presenter decisions aligned (optional deck, screen share + overlay, unified view, CF Access). Authored wiki/product/journeys.md. |
