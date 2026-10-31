# 05 · Platform gaps and integration (coordinator)

**Status:** not started · **Session:** coordinator · **Due:** Mon Nov 2, 20:00 +03 · **Feeds:** every workstream

## Goal

Keep `main` whole and deployed while 01–04 build, and close the backend and infrastructure gaps the journeys need.
This is the coordinator's workstream: it briefs, merges, deploys, and owns contract changes.

## Checklist

### Today (Sat Oct 31)

- [ ] **Save the annotations lane.** The worktree `.claude/worktrees/agent-a4253973…` on `lane/audience-annotations`
      has 7 modified files and new UI files that are not committed. Commit and push them, finish or park the lane,
      and merge what is ready.
- [ ] **Ticket 0020** (shape of audience annotation tracks): owner answers; record the decision; draft decision
      0024 accepted or changed.
- [ ] **Hostname.** The live hostname is kept out of the repo (`$TT_HOST` on the VM). `wiki/howto/demo-moments.md`
      names `talk-tracks.org`, which does not resolve: replace it with `<host>`, and confirm the real host with
      the owner for 06 and 07.
- [ ] **Deploy `main`** and run the four-moment rehearsal ([howto/demo-moments.md](../howto/demo-moments.md)).
- [ ] Remove the untracked `.claude/` folder from `git status` (add to `.gitignore`, or move worktrees out).

### Sun Nov 1

- [ ] **Room creation endpoint** for J5, as decided in 01: for example `POST /api/rooms` on the room service with
      `{name, title, code}` → checks the access code, reserves the room, mints a speaker token capped per room and
      against a batch total (reuse `deploy/mint-judge-tokens.sh` logic and decision 0008), rate-limited. Returns
      the speaker and audience links. Behind the `/api/` proxy that already exists.
- [ ] **Room metadata** (title, speaker name) in the room catalog, so the lobby and player can show them.
- [ ] **Contract change for shapes** (from 04): Python model, schemas, TS types, validators, archive check.
- [ ] Agent **kill-and-restart** test on every agent (plan, Sun) and record the result.
- [ ] Decide on **any-language translation** (decision 0019): there is no merged lane; keep tr/es/ar unless it is
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
