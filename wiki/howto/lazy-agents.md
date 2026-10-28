# Lazy agents and spend caps

An agent does paid work only while its track has a subscriber (decision 0010), and every room has a spend cap
(decision 0008). This page records how the relay signals demand, how the agents use it, and how caps are set.

## What the relay tells a publisher (measured)

Measured on 2026-10-28 against moq-relay 0.17.8 in Docker (local bridge network, `--auth-public '**'`), with an
aiomoqt 0.13.1 publisher on `talk/probe/agents/x/1` track `state` that logs aiomoqt's `PublishedTrack.producing`
every 10 ms. Subscribers were aiomoqt (IETF draft-18 over raw QUIC) and `moq fetch` from moq-cli 0.14.8 (moq-lite
over raw QUIC, the protocol family the browser speaks).

| Case | What the publisher saw | Time |
|---|---|---|
| First viewer subscribes | the relay subscribes upstream (`producing` goes true) | 1-4 ms |
| Viewer cancels its subscription (aiomoqt, draft-18 request-stream cancel) | the relay cancels upstream (`producing` false) | 7 ms |
| moq-lite viewer reads one group and leaves (`moq fetch`) | upstream subscribed, then cancelled | 21 ms between the two |
| Two viewers; the first leaves | nothing: the relay holds one upstream subscription for both | - |
| Two viewers; the last leaves | upstream cancelled | 12 ms |
| Viewer process killed (no close) | upstream cancelled when the relay's QUIC idle timeout fires | 10.2-10.3 s (3 runs) |
| Viewer stays connected but stops reading, never cancels | upstream stays subscribed until that session ends | 2 min (until the probe closed) |

So the relay does signal it usefully: it subscribes upstream on the first downstream subscriber, holds one upstream
subscription for any number of viewers, and cancels it within milliseconds of the last clean leave, or about 10 s
after the last viewer vanishes. The publisher sees each change in aiomoqt as `PublishedTrack.producing` (and the
set of upstream subscription ids), with no polling of the relay.

Two consequences:

- A viewer must cancel the subscription when it switches a track off. Staying subscribed and ignoring the objects
  keeps the agent paying.
- aiomoqt's `AgentSession.close_reader` does not cancel on the wire: it only drops the reader locally, and the relay
  keeps forwarding. The agents call `session.unsubscribe(request_id)` first (in `moq.Relay.objects`), so a
  downstream agent that pauses really releases its upstream track.

Not measured: a browser tab closing its WebTransport session (expected to match the clean case, or the 10 s idle
timeout when the tab dies).

## How an agent idles and wakes

Each agent publishes its track as soon as it serves a room, with its empty or resumed state and a heartbeat, so a
viewer can find it and switch it on. That costs nothing. The agent opens its inputs only while its track is
subscribed (`demand.Gate` polls the writer's `producing` every 100 ms):

| Agent | Input it opens while subscribed | On a pause |
|---|---|---|
| `captions` | the speaker's audio | closes the ASR session: no audio is sent, nothing more is paid |
| `translate` | the captions track | unsubscribes from captions, so captions can pause too |
| `chapters` | the captions track | as translate |
| `describe` | the slide frames | unsubscribes from the slides |

A downstream agent is an ordinary subscriber: a viewer of the Turkish translation keeps translate running, translate
keeps captions running, and nobody else needs to. When the last subscriber leaves, the agent waits
`TT_IDLE_GRACE_S` (default 10 s) before it pauses, so a page reload does not reopen the ASR session or lose the
translation context. The relay's own 10 s timeout for a vanished viewer adds to that.

Waking is debounced too: an agent opens its paid inputs only once its track has been subscribed for
`TT_WAKE_DEBOUNCE_S` (default 1 s) in a row. The MoQT design lane measured that any FETCH through moq-relay 0.17.8
makes the relay subscribe upstream, even a FETCH the relay then refuses: a publisher with no viewers was subscribed
21 ms after the FETCH and cancelled about 80 ms later. Without the debounce such a blip could open an ASR session.
A real viewer waits that second for the first new output; the track's current state reaches it at once.

Checked on 2026-10-28 against moq-relay 0.17.8 with two fake captions agents, one at `TT_WAKE_DEBOUNCE_S=1` and a
control at 0. Each got three aiomoqt FETCHes of group 0, all refused by the relay, then three subscriptions held for
400 ms and cancelled:

| Agent | Refused FETCHes that woke it | 400 ms subscriptions that woke it | A real viewer |
|---|---|---|---|
| debounce 0 (control) | 2 of 3, 14-23 ms after the FETCH | 3 of 3 | - |
| debounce 1 s | 0 of 3 | 0 of 3 | woke 1.02 s after it subscribed, idle 2.1 s after it left (grace 2 s) |

The third FETCH blip fell between two 100 ms polls. A moq-lite `moq fetch` (about 21 ms upstream) woke neither.

Switched on mid-talk, a track starts from that moment (decision 0010): captions take the audio from now; a
translation translates the newest two caption lines and then each new one; chapters summarise the transcript the
captions track still holds (its last 40 lines). Caption line ids carry on over a pause.

Viewers must cancel the subscription when a track is switched off (above). The demo recorder (`record`,
`generate`) and the `watch` stand-in subscribe to every agent track, so they keep every agent working, as a demo
generation needs.

## Which rooms

`--room R` (or `TT_ROOM`) serves one room, as before. `--rooms '*'` (or `TT_ROOMS`) serves every room whose speaker
comes on air (`talk/<room>/teacher` announced); `--rooms a,b` only those. `TT_ROOMS_EXCLUDE` lists rooms never served:
on the VM, the demo room, whose tracks the looper replays. Each room gets its own relay connection and agent
instance. A room is served for `TT_ROOM_LINGER_S` (default 600 s) after its speaker leaves, so a reload keeps the
agent and its history; a room that fails stops the process, and Docker restarts it with every room.

The agent token must let the agents publish under every room they serve (see [tokens](tokens.md)).

## Spend caps

Every line in the spend ledger names its room (and its judge batch). Before each call the ledger refuses it when the
worst case would pass the overall ceiling (`TT_SPEND_CEILING_USD`), the room's cap, or its batch's total cap:

- any room: `TT_ROOM_CAP_USD` (default $2);
- a judge room: the cap its batch was minted with, from `$TT_CAPS_DIR/<batch>.json` (default `data/caps`, on the VM
  `/data/caps`), plus the batch's total over all its rooms ([tokens](tokens.md#judge-tokens)).

At a cap the agent stops paying: captions close the ASR session, and the others stop calling the model. It says so
in its track label, which viewers show in the track list, for example "Turkish translation (paused: this room
reached its spend cap)". Its track stays up with what it had made.

Try it locally with fake agents: `TT_FAKE_USD_PER_CALL=0.25` makes the fake model spend pretend money into
`TT_FAKE_LEDGER` (default `data/fake-ledger.jsonl`, never the real ledger), so a $2 room stops after eight calls.

## Check it locally

`deploy/compose.local.yml` runs the agents for `TT_ROOM` as before; with `TT_ROOMS='*'` set on the agents, they
follow every room instead. With the stack up and a `teacher` stand-in on air, the agents log `idle` until something
subscribes; `watch` subscribes to everything, so it wakes them all.
