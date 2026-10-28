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
