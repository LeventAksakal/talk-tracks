# 05 · Platform gaps and integration (coordinator)

**Status:** in progress · **Session:** coordinator · **Due:** Mon Nov 2, 20:00 +03 · **Feeds:** every workstream

## Goal

Keep `main` whole and deployed while 01–04 build, and close the backend and infrastructure gaps the journeys need.
This is the coordinator's workstream: it briefs, merges, deploys, and owns contract changes.

## Checklist

### Today (Sat Oct 31)

- [x] **Save the annotations lane.** The worktree `.claude/worktrees/agent-a4253973…` on `lane/audience-annotations` Done (merged f9b2e6a).
      has 7 modified files and new UI files that are not committed. Commit and push them, finish or park the lane,
      and merge what is ready.
- [x] **Ticket 0020** (shape of audience annotation tracks): owner answers; record the decision; draft decision Done (closed 4efd7ab).
      0024 accepted or changed.
- [ ] **Hostname.** The live hostname is kept out of the repo (`$TT_HOST` on the VM). `wiki/howto/demo-moments.md`
      names `talk-tracks.org`, which does not resolve: replace it with `<host>`, and confirm the real host with
      the owner for 06 and 07.
- [ ] **Deploy `main`** and run the four-moment rehearsal ([howto/demo-moments.md](../howto/demo-moments.md)).
- [ ] Remove the untracked `.claude/` folder from `git status` (add to `.gitignore`, or move worktrees out).

### Sun Nov 1

- [x] **Room creation endpoint** for J5, as decided in 01: for example `POST /api/rooms` on the room service with Done (268e0b9).
      `{name, title, code}` → checks the access code, reserves the room, mints a speaker token capped per room and
      against a batch total (reuse `deploy/mint-judge-tokens.sh` logic and decision 0008), rate-limited. Returns
      the speaker and audience links. Behind the `/api/` proxy that already exists.
- [ ] **Room metadata** (title, speaker name) in the room catalog, so the lobby and player can show them.
- [x] **Contract change for shapes** (from 04): Python model, schemas, TS types, validators, archive check. Done (261cbc2).
- [ ] Agent **kill-and-restart** test on every agent (plan, Sun) and record the result.
- [x] Decide on **any-language translation** (decision 0019): there is no merged lane; keep tr/es/ar unless it is Done (translate-any on the VM, 268e0b9).
      nearly done.
- [ ] Merge 03 and 04 work in progress daily; deploy every evening.

### Mon Nov 2

- [ ] Merge 03 and 04 by 18:00; deploy; hand the URL to 06.
- [ ] **Cross-browser transport:** WebTransport in Chrome and Firefox 153+, the WebSocket fallback in Safari and
      iPhone, on the VM; note delay and stability.
- [ ] **Load pass** on the VM (the benchmark harness from decision 0016) with 50–100 viewers on a demo room.
- [ ] **Mint judge tokens** (`deploy/mint-judge-tokens.sh`), or create access codes if the endpoint shipped.
- [ ] Check the spend ledger and caps before the judging window.

## Definition of done

- Every workstream branch is merged or parked with a reason; `main` deployed; the rehearsal passes on the VM.
- J5 works from the site (or the fallback is in place and journeys.md says so).
- Judges' access (tokens or codes) is ready and recorded on the VM, never in the repo.

## Log

| When (+03) | Session | Entry |
|---|---|---|
| 10-31 12:57 | coordinator | Brief written. Found: no self-serve room creation (tokens minted by script on the VM); `talk-tracks.org` in demo-moments.md does not resolve; annotations lane has uncommitted work. |
| 10-31 13:36 | coordinator | Annotations lane: WIP UI was saved as a5e5293 before the crash; backend endpoint (dd606f3, 99d2691) done. Old worktree pruned; a fresh lane is finishing endpoint + listener tools + Discussion + console Questions on `lane/audience-annotations` (owner chose "finish now"). Ticket 0020 closed by owner (defaults kept). |
| 10-31 13:36 | coordinator | Owner asked (10-31): "setup cloudflare pages deploy so <host> is auto deployed from main; also put the application behind CF_ACCESS Google IdP login with a whitelisted allow policy." **Dropped by owner the same day** after learning the constraint: Pages and Access need the host proxied, but the relay needs QUIC on UDP 443 unproxied on that host. Nothing was changed in Cloudflare. Revisit only with a separate relay hostname. |
| 10-31 14:40 | coordinator | Audience annotations merged (f9b2e6a): listener endpoint, listener tools, Discussion, console questions. Gate on the merged code: pytest 256 passed, web 147 passed, typecheck/lint/build pass. Left: speaker erase/unmark of audience work in the console, `M` comment-on-slide key, Comments setting, comment edit UI, demo rooms have no room service (no listener annotations there). Decision 0024 (listener writes over a WebSocket to the room service) still proposed. |
| 10-31 14:40 | coordinator | **Open:** clock drift. The room service ticks on the speaker's media time, players on wall time; with fake headless audio media ran at ~67% of wall time, so audience ink and marks trailed the playhead. Check with a real mic on the VM. Target: audience records land within one 4 s slice of the playhead after a 30 min talk. Status: unverified. |
| 10-31 14:40 | coordinator | **Open:** `main` fails ruff (21) and pyright (29) since 542d48b (any-language translation, pushed directly, outside a lane; touches `room_catalog.py`). Errors in `cli.py`, `languages.py`, `llm/meta.py`, its test. pytest passes. Status: **fixed** 15:13 in 28715f4 (owner: fix forward). It hid a real bug: `cli.py` imported a missing `records.payloads`, so every translate agent crashed at start; a test now covers that path. ruff, format, pyright clean; pytest 258 passed. |
| 10-31 14:40 | coordinator | **Open:** `playback/aiTracks.test.ts` "FETCH with no answer becomes a hole" is timing-flaky (failed once in the lane, passed at the gate). |
| 10-31 15:40 | coordinator | Owner (10-31): "I see the app isnt built to its full extend ... the app should be built; shipped so I can QA and vet. ETA on that?" Target: a deployed desktop-Chrome build where J2, J3, J4, J5, J6, J7, J8 in `wiki/product/journeys.md` can be walked end to end without a script-minted link. Status: open; audit of journeys against `main` 28c7f57 found gaps: no room creation, `ended` never written (a finished talk shows "Paused"), lobby without demo cards, any-language UI-only (VM runs tr/es/ar), talk title not wired, no shapes/undo, Stats for nerds missing judge proofs. Check: walk each journey on the VM build. |
| 10-31 15:55 | coordinator | Owner answers (10-31 question prompt): room creation = access code (decision 0025); screen share = stretch ("if we finish with some days remianing definetly built in"); QA build "tonight, then nightly"; design tokens via a dedicated session that interviews the owner (proposed as a session card). journeys.md fixed: Cloudflare Access removed, desktop-only scope note, J5/J8 use the access code. Lanes started: room lifecycle (`ended`, `POST /api/rooms`, talk title, any-language on the VM), app shell (lobby, create form, title, demo-room tools), slide tools (shapes, undo, width). |
| 10-31 16:50 | coordinator | Merged app shell (86bf3aa): lobby with the four demo rooms and live badges, Create talk against `POST /api/rooms`, Paste speaker link, talk title/speaker from the room track, recorded-session state, listener tools hidden with a reason in rooms without a room service, slower-path pill from the real transport. Gate on the merge: typecheck 15 s, lint 23 s, test 21 s (165 passed, 5 skipped), build 3 s. Room names now 3–40 chars (`contracts/names.ts`). Unverified: live badges and pill against a real relay (VM deploy). Follow-ups: keep the speaker link across reloads ("Continue <room>")?; start lobby badge connection after first paint (Lighthouse, 06); `Invite` should import its own CSS. |
| 10-31 17:30 | coordinator | Merged slide tools (261cbc2; gate: agents 261 passed, web 174 passed, build ok) and room lifecycle (268e0b9; gate: agents 288 passed, web 176 passed, build ok). **Deployed 268e0b9 to the VM** (was 94cba22; saved as `before-qa1`). Re-signed the looper token (adds `slides`, `archive/**` for the four demo rooms) and the room-service token (`catalog`, `comments`, `annotations`, `archive/**`), 5 days, with owner approval. Created the access-code file (owner code, $2/room, $10 total, 10 rooms). `looper-rsa` not started: its recording folder on the VM is empty. Checked: new bundle served, `/healthz` 200, `POST /api/rooms` 400/403, lobby with live badges. **Open bugs** (lane `demo-slides`): demo-room slide images stay on "Loading the slide…" with no image request; the time reads `734:22:20` (looper clock across loops). Unverified: End talk → Ended, a created room going on air with its token (owner QA). |
| 10-31 18:15 | coordinator | Demo-room bugs **fixed and deployed** (8325c4c; gate: agents 288 passed, web 178 passed, build ok). Slides: the looper wrote the deck into a 2-slot queue, so the relay held no whole group 0; now the deck stays one group. Clock: a looped room shows the time within the loop. Checked on the VM: `/watch/dataviz` shows the slide image and `14:07 · LIVE`. Still unverified on the VM: End talk → Ended, a created room going on air (owner QA). Open: rsa demo room has no recording on the VM. |
