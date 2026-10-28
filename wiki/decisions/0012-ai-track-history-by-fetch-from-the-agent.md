---
status: accepted
date: 2026-10-28
decision-makers: project owner
supersedes: 0007 in part (rewind of AI tracks), 0011 in part (who records agent tracks)
refines: 0009 (restore from the agent's own slices, under a stable name)
---

# AI-track history is served by FETCH from the agent, in 4 s time slices

## Context and Problem Statement

The owner wants the build to use what MoQT is rather than features built beside it. The draft treats live and past
as two requests: "Subscribe only requests newly published or received Objects. Objects from the past are retrieved
using FETCH" (draft-ietf-moq-transport-18 §10.7). A relay that misses a FETCH may forward it to the publisher
(§10.12.3).

Our relay, moq-relay 0.17.8, is a live fan-out relay with a short cache: about 30 s, nothing once the publisher
leaves, and one group per FETCH. A cache miss is forwarded to the publisher (spikes S1, S4). Decision 0007 put all
rewind on HTTP files, and decision 0011 had the archiver subscribe to every track, which makes every lazy agent
eager.

The full reasoning, the spec and stack comparison, and the spike numbers are in
[the track system design](../design/moq-track-system.md).

## Considered Options

* History origin: **the agent serves its own track's past by FETCH**; a separate store publisher; HTTP files only.
* Media rewind: **HTTP fMP4 with MSE**; a MoQ media origin with our own WebCodecs player.
* Groups: **4 s time slices on the media clock, with a carry-in object**; a snapshot per change plus a time index
  track.
* Back-fill: **on FETCH, per slice, within the room cap**; eager from switch-on; none.

## Decision Outcome

Chosen: the first option of each.

* Every AI track except the outline cuts group k as media time [4k, 4k+4) s. Object 0 is a small carry-in state;
  items follow, one per object; the group ends with End of Group.
* Agents publish under stable names, `talk/R/agents/<agent>`, without an instance segment. A restarted agent
  announces the same name, takes over new subscriptions, and continues at the next slice.
* Each agent writes every object it publishes to the room archive, and answers FETCH misses for its track from that
  archive (disk, then the bucket). The archiver does not subscribe to agent tracks.
* A FETCH of a slice that was never produced makes the agent produce it once, store it and answer, charged to the
  room's cap. At the cap it answers an empty group marked `capped`.
* Agents treat a subscription as demand only after 1 s, because moq-relay opens a short upstream SUBSCRIBE to
  forward any FETCH.
* Speaker media rewinds over HTTP from the archiver's fMP4 segments, with MSE, on the same media clock (0007 stands
  for media).
* A room service (the archiver) publishes `talk/R/catalog`, an MSF-shaped list of the room's tracks with status.
* The outline (chapters, glossary, recap) stays a snapshot track: one group per revision.

### Consequences

* Good, because live and past are the same track under the same name, SUBSCRIBE and FETCH, with the relay cache in
  front. That is the MoQT model the judges will look for.
* Good, because recording creates no demand: agents record what they send.
* Good, because back-fill is paid only for slices someone actually fetches, and once.
* Good, because seek is arithmetic from time to group, and group ids never collide across restarts or demo loops.
* Bad, because media history leaves MoQ: viewers use two sources while rewound.
* Bad, because agents of a listed room must stay connected to serve its history (moq-relay serves nothing once the
  publisher leaves).
* Bad, because the wire contract changes (slice, carry-in, one item per object), touching agents, the looper and the
  web client.
* Bad, because a restart loses up to 4 s of output, and the first viewer waits 1 s longer for live output.
* Bad, because aiomoqt's whole-group FETCH_OK carries an End Location moq-relay reads as empty, so our FETCH handler
  sets it from the archive (verified in spikes S4c and S3).
* Bad, because a killed agent leaves its tracks silent for about 12–15 s, until the relay times its connection out
  (spike S5); agents close their session on SIGTERM so planned restarts hand over at once.
