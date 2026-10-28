# Benchmark: Talk Tracks' MoQ against LL-HLS, LL-DASH and WebRTC

Talk Tracks needs one transport that carries a speaker's audio and video and many named AI tracks (captions,
translations, slide descriptions, chapters) to every viewer, live, with each viewer taking only the tracks it wants.
This page compares Media over QUIC (MoQ), as Talk Tracks uses it, with the three usual alternatives on two axes:

1. **What each protocol can do at all**, against the features the app requires (the capability matrix, from specs
   and vendor docs).
2. **How fast it is**, measured: glass-to-glass latency, text-track latency and join time, with every protocol fed
   from the same encode on the same machine (the harness in [`bench/`](../bench/)).

Background in [ticket 0016](../tickets/0016-benchmark.md); scope and viewer placement are filed for the owner as
ticket 0017.

## Scope

Agreed with the coordinator on 2026-10-28: option B of ticket 0016 plus two cheap extras ("B+"), about 26 hours,
fitted to the plan (harness Sat Oct 31, runs Sun Nov 1, write-up Mon Nov 2). Viewers run on the VM, next to the
servers.

| Piece | In scope | Hours |
|---|---|---|
| Capability matrix with citations (this page) | yes | 4 |
| Source: barcode clock in every frame, one encode teed to MoQ and MediaMTX | yes | 3 |
| Compose stack: relay, MediaMTX, source, text publisher, viewer | yes | 3 |
| Measuring page (MoQ, MoQ over WebSocket, LL-HLS, WebRTC) and Playwright runner | yes | 5 |
| Join time, many fresh joins per protocol | yes | 1 |
| Text-track latency, published through the agents' MoQ code | yes | 2 |
| Extra: bytes per viewer, captions only against everything (selective subscription) | yes | 1 |
| Extra: behaviour under 2 % and 5 % loss (`tc netem`) | yes | 2 |
| Analysis, tables and chart, results on this page | yes | 3 |
| Local validation, VM hand-over | yes | 2 |
| Stretch: server CPU, memory and egress at 10 and 100 viewers, MoQ against WebRTC and LL-HLS | owner decides Sun Nov 1 | 5 |
| Not planned: 500 viewers (needs a bigger load generator); LL-DASH measured (MediaMTX has no DASH) | no | — |

## Summary

*(Filled in after the VM runs.)*

## The app's requirements

Derived from the code and the decisions:

| Requirement | Where it comes from |
|---|---|
| Many independent tracks per room: media plus one per agent and language | `talk/<room>/teacher`, `talk/<room>/slides`, `talk/<room>/agents/<agent>/<instance>` ([contracts](../web/src/contracts/names.ts)) |
| Non-media tracks: JSON snapshots, slide images | agent `state` envelopes, `slides/frames` ([contracts](../contracts/)) |
| Selective subscription: a viewer takes only the tracks it switched on, and the publisher can tell nobody is listening | [decision 0010](decisions/0010-agent-tracks-are-opt-in-and-lazy.md) |
| Late join with the latest state: a viewer who arrives mid-talk sees the current captions and slide at once | snapshot envelopes, one per group |
| Rewind and history | [decisions 0007](decisions/0007-rewind-from-a-static-track-archive.md) and [0009](decisions/0009-agents-restart-from-durable-track-history.md) |
| Fan-out through a cache or CDN, not per-viewer work at the publisher | one relay on one VM ([decision 0004](decisions/0004-relay-web-and-agents-on-one-vm.md)), relays in front later |
| Browsers: Chrome, Firefox, Safari, phones | [plan](plan.md) end-to-end checks |
| Latency class: captions must arrive while the sentence is still on screen | lecture viewing |
| Server push of agent output as it is produced, without polling | agents publish every line and heartbeat |

## Capability matrix

What each protocol delivers for each requirement. Numbers in brackets point to the [references](#references).
**Bold** marks where a protocol is weakest on a row.

| Requirement | MoQ as Talk Tracks uses it (moq-lite, moq-relay 0.17.8, @moq/watch 0.6) | LL-HLS | LL-DASH | WebRTC (WHIP/WHEP and an SFU) |
|---|---|---|---|---|
| Many independent tracks | Yes: a broadcast is a set of named tracks, each subscribed on its own over one QUIC session [4][6]; the app runs one broadcast per agent instance. | Renditions in a multivariant playlist, each its own media playlist [9]; players pick one audio and one subtitle rendition at a time, so dozens of parallel data tracks is outside the model. | Many AdaptationSets in one MPD [14]; players pick one Representation per set; extra data tracks need app logic. | Many media tracks and data channels per PeerConnection [19][20]; **WHIP/WHEP define no track names or catalogue**, the SFU's own signalling does [10][11]. |
| Non-media (JSON) tracks | Yes: objects are opaque bytes; the hang catalog also lists JSON tracks with snapshot or stream modes [8]. | WebVTT renditions, ID3 timed metadata, `EXT-X-DATERANGE` [9]: tied to media segments, **no free-form channel**. | MPD `EventStream` or inband `emsg` boxes [15]: tied to the media timeline. | Data channels carry any bytes, reliable or not [19]; not synchronised to media by the protocol. |
| Selective subscription | Yes: pull-only, nothing flows until a subscriber asks; relays merge duplicate subscriptions upstream, so a publisher sees when nobody listens [4][6]. | Yes: the client fetches only what it wants [9]; the origin never knows who stopped. | Yes, the same [13][14]. | Per SFU: WHEP has no per-track selection [11]; SFUs add it (for example LiveKit's explicit subscribe [21]). |
| Late join with latest state | Yes: a subscription starts at the latest group, and each group starts at a decodable point (keyframe or full snapshot) [4][7]. | The player starts near the live edge at an independent part [9][12]; metadata sent earlier is gone unless repeated. | Starts at the live edge from the MPD [13][14]; earlier events only if still listed. | Video: the SFU asks the publisher for a keyframe (PLI) [unverified]; **data channels have no history**: the app resends state. |
| Rewind and history | Per-track retention window, 30 s by default (moq-cli `--max-age`); FETCH of one past group at a time [4][7]; **no long DVR window**: Talk Tracks adds a static archive ([decision 0007](decisions/0007-rewind-from-a-static-track-archive.md)). | DVR through a sliding or EVENT playlist, mature [9]. | Time-shift buffer in the MPD [13][14], mature. | **None**: real-time only; rewind needs a parallel recording path. |
| Cache and CDN fan-out | Relays fan out and cache groups; moq-relay clusters [6][7][22]. **One CDN offers MoQ (Cloudflare, beta), speaking MoQT drafts 14 and 16, not moq-lite** [17][18]. | Plain HTTP objects on any CDN; blocking reloads need CDN support for held requests [9][12]. | Plain HTTP; chunked transfer must pass through the CDN [13][14]. | SFU cascades, vendor-specific (for example Cloudflare's per-track trees [23]); no HTTP caching. |
| Browser support | WebTransport in Chrome, Edge, Firefox 114+ and Safari 26.4+ [24][25], but **the pinned @moq/net 0.4.5 sends every WebKit engine (all iOS browsers, Safari) and Firefox before 153 to the WebSocket fallback** over TCP (its `isWebTransportUserAgentSupported`, citing WebKit bug 319818). Playback needs WebCodecs: Chrome, Firefox 130+, Safari 26+; **Firefox for Android has none** [26][27]. | Native in Safari and Chrome 142+; hls.js over MSE elsewhere, Managed Media Source on iPhone (Safari 17.1+) [28][29][30][31]. | No native player; dash.js over MSE, Managed Media Source on iPhone [29][31]. | **Broadest**: every current engine, desktop and mobile [32]. |
| Latency class | Sub-second is claimed [16][4] but nobody publishes measurements; each subscriber sets its own latency budget [6]. Measured below. | Apple's goal 1–2 s [12]; about 3 s in practice [16]. Measured below. | dash.js examples target 3–4 s [13]. Not measured (MediaMTX has no DASH). | Under 500 ms [16]. Measured below. |
| Server push of agent output | Yes: once subscribed, each new group goes out on its own QUIC stream as it is published [4][6]. | **Client pull**: blocking playlist reload and preload hints are long-polling; playlists are refetched several times a second [9][12][33]. | **Client pull**: chunked transfer streams the open segment; new events need an MPD refresh or `emsg` [13][15]. | Yes: RTP and data-channel messages are pushed [19]. |
| Loss and congestion | One QUIC stream per group: a lost packet stalls only its group; priorities pick which tracks get bandwidth, and groups past their age are skipped [4][7]. **Over the WebSocket fallback, TCP head-of-line blocking returns** [5b]. | TCP head-of-line blocking; the player buffers and switches bitrate [9][33]. | The same; dash.js adjusts playback rate to catch up [13]. | UDP with retransmission, FEC and congestion control; late media is dropped [unverified for details]. |
| Maturity and standards | **Weakest**: IETF MoQT is a working-group draft (-22, Oct 2026, IESG target Dec 2026) [1][2]; interop moved draft-16 → -18 in 2026 with regressions [3]; Talk Tracks runs moq-lite, an individual informational draft (-05) [4]. MediaMTX 1.21 now also serves MoQ, a sign of growing support. | LL-HLS shipped in Apple OSes since 2020; rfc8216bis-22 is with the RFC Editor [9]. | ISO/IEC 23009-1; DASH-IF low-latency guidelines [14]. | WebRTC mature; WHIP is RFC 9725 [10]; WHEP draft-05, in AD evaluation [11]. |

### Where MoQ is weaker

- **Maturity.** The standard is still moving, and Talk Tracks depends on one project's dialect (moq-lite and the hang
  catalog) and its releases. Libraries are pinned (relay 0.17.8, @moq/net 0.4.5, @moq/watch 0.6.6) for that reason.
- **Safari and iOS.** Every iOS browser and Safari get MoQ over WebSocket, so on lossy Wi-Fi they lose QUIC's
  per-group independence. The benchmark measures that path as its own row (`moq-ws`).
- **CDN and tools.** HLS and DASH run on any HTTP CDN with mature players and analytics; MoQ has one CDN in beta.
- **DRM.** WebCodecs has no EME path [34][35]. Irrelevant for open lectures, but a gap for paid content.

### Why MoQ still fits this app

No other column has all of: named JSON tracks next to media, selective subscription that the publisher can see,
late join with the latest snapshot, server push, and HTTP-CDN-like fan-out with caching. LL-HLS and LL-DASH have the
fan-out and caching but are pull-based, segment-bound and slower; WebRTC has the latency and the push but no
caching, no history and no standard track naming. The measured part below shows how much latency MoQ gives up
against WebRTC to get there.

## Method

*(Draft; the harness is in [`bench/`](../bench/README.md).)*

- **One source, one encode.** ffmpeg makes a 1280x720, 25 fps test pattern whose top 80 rows carry the wall-clock time
  of each frame (Unix ms modulo 2^32) as a 32-block barcode, plus a beeping Opus tone. It encodes once (H.264 without
  B-frames, x264 zerolatency, keyframe every 2 s as in the demo rooms, 1 Mbit/s; Opus 48 kHz mono, 20 ms) and the
  tee muxer writes the same packets at the same moment to `moq import ts` (moq-cli 0.14.8, publishing to moq-relay
  0.17.8) and over RTSP to MediaMTX 1.21.3, which serves LL-HLS (parts of 200 ms) and WebRTC (WHEP).
- **One viewer page per protocol, in Google Chrome.** `moq`: @moq/watch 0.6.6 as the viewer plays it, with the
  viewer's 500 ms delay setting; `moq-ws`: the same with WebTransport removed, as Safari runs it; `hls`: hls.js 1.7.3
  in low-latency mode, defaults otherwise; `webrtc`: a plain WHEP client and a `<video>` element.
- **Latency** is the page's clock minus the barcode on every rendered frame (`requestVideoFrameCallback` for
  `<video>`, the renderer's frame signal for @moq/watch). The source and the viewer run on one host and read the same
  clock. It includes encoding, packaging, the server, the network, buffering and decoding; it excludes a camera.
  Steady-state latency pools every frame after the first 5 s of each join; the first frame's latency is reported
  apart, since players differ in how they catch up to live.
- **Text-track latency** (MoQ): a JSON object stamped with its publish time, 4 a second, published through the agents'
  own MoQ code (aiomoqt over raw QUIC), received in the page. Measured with the media playing, and alone (`moq-text`,
  a captions-only viewer).
- **Join time**: from creating the player to the first decoded frame, in a fresh browser context each time.
- **Bytes per viewer**: the viewer container's interface counter over each join (headers, playlists and
  retransmissions included), the same count for every protocol.
- **Audio plays in every row.** The viewer container has a PulseAudio null sink, a real-time audio clock. Without it,
  Chrome's fallback output lags under load, and @moq/watch, which paces video by the audio clock, fell seconds behind
  live in the first local check; muted, it did not. The fault was the container's, so the sink is part of the setup.
- **Network**: loopback on one host, plus emulated runs with `tc netem` (added delay and random loss on what the
  servers send to the viewer).

### Local check (a laptop, not the results)

A short check on the development laptop (16 cores, Docker Desktop, Chrome 156 headless), two joins of 20 s per row,
to validate the harness. The VM runs replace it.

| Protocol | Join ms | Latency p50 / p95 ms | First-frame latency ms | Text p50 / p95 ms | Received kbit/s |
|---|---|---|---|---|---|
| MoQ (WebTransport), viewer delay 500 ms | 291–414 | 570 / 595 | 565 | 11 / 30 | 1548 |
| MoQ (WebSocket, as Safari) | 385–407 | 577 / 612 | 3916 | 29 / 64 | 1297 |
| MoQ, text track only | 83–89 | – | – | 3 / 6 | 16 |
| WebRTC (WHEP) | 531–559 | 336 / 397 | 95 | not carried | 1153 |
| LL-HLS (hls.js) | 341–351 | 907 / 923 | 868 | not carried | 2688 |

What it already shows, to be confirmed on the VM: MoQ sits at the viewer's 500 ms setting plus about 70 ms; WebRTC
is lower; LL-HLS is about 1.6 times MoQ. A captions-only viewer receives about 1 % of the bytes of a full one. LL-HLS
takes about twice the media bitrate on the wire; the cause is not checked yet (the likely one: hls.js in low-latency
mode fetches parts, full segments and playlists).
Over WebSocket, MoQ starts from the latest keyframe up to 2 s back and takes longer to catch up to live.

## Setup

*(Filled in with the VM's size, the Chrome version and the run conditions.)*

## Results

*(Filled in after the VM runs.)*

## Limits

- One host and loopback: this measures the protocol stacks and their buffering, not the internet. The netem runs add
  delay and loss in one direction only.
- Text-track latency is measured for MoQ only. MediaMTX carries no data channel or WebVTT track; in LL-HLS text rides
  the part cadence (about the video's latency), and in WebRTC it needs a separate data channel or socket.
- LL-DASH is not measured: MediaMTX has no DASH output.
- Player settings are defaults except where stated (hls.js low-latency mode, @moq/watch 500 ms delay). Tuning moves
  every number.
- Headless Chrome with software decoding on a server; a laptop with hardware decoding can be faster.

## References

1. IETF Datatracker, draft-ietf-moq-transport (rev -22, 2026-10-01): https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
2. draft-ietf-moq-transport-22: https://www.ietf.org/archive/id/draft-ietf-moq-transport-22.html
3. IETF 126 MoQ WG minutes, 20 Jul 2026: https://datatracker.ietf.org/meeting/126/materials/minutes-126-moq-202607201200-01
4. draft-lcurley-moq-lite-05: https://www.ietf.org/archive/id/draft-lcurley-moq-lite-05.txt
5. moq.dev docs, interop: https://doc.moq.dev/concept/standard/interop
   5b. moq.dev docs, transport: https://doc.moq.dev/concept/transport
6. moq.dev docs, layers: https://doc.moq.dev/concept/layer/
7. moq.dev docs, moq-lite: https://doc.moq.dev/concept/moq-lite.html
8. moq.dev docs, hang catalog: https://doc.moq.dev/concept/hang.html
9. draft-pantos-hls-rfc8216bis-22: https://datatracker.ietf.org/doc/draft-pantos-hls-rfc8216bis/
10. RFC 9725, WHIP: https://www.rfc-editor.org/rfc/rfc9725.html
11. draft-ietf-wish-whep (rev -05): https://datatracker.ietf.org/doc/draft-ietf-wish-whep/
12. Apple WWDC19, Introducing Low-Latency HLS: https://developer.apple.com/videos/play/wwdc2019/502/
13. dash.js, low-latency streaming: https://dashif.org/dash.js/pages/usage/low-latency.html
14. DASH-IF IOP v5: https://dashif.org/guidelines/iop-v5/
15. DASH-IF IOP Part 10, events and timed metadata: https://dash-industry-forum.github.io/docs/IOP-Guidelines/DASH-IF-IOP-Part10-v5.0.0.pdf
16. Cloudflare, MoQ: refactoring the internet's real-time media stack (Aug 2025): https://blog.cloudflare.com/moq/
17. Cloudflare, an API for MoQ relays (Jul 2026): https://blog.cloudflare.com/moq-relays/
18. Cloudflare MoQ docs: https://developers.cloudflare.com/moq/
19. RFC 8831, WebRTC data channels: https://www.rfc-editor.org/rfc/rfc8831.html
20. W3C WebRTC 1.0: https://www.w3.org/TR/webrtc/
21. LiveKit, receiving tracks: https://docs.livekit.io/home/client/receive
22. moq.dev blog, first CDN: https://moq.dev/blog/first-cdn/ ; relay clustering: https://doc.moq.dev/app/relay/cluster
23. Cloudflare, Calls cascading trees: https://blog.cloudflare.com/cloudflare-calls-anycast-webrtc/
24. caniuse, WebTransport: https://caniuse.com/webtransport
25. WebKit features in Safari 26.4: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
26. caniuse, WebCodecs: https://caniuse.com/webcodecs
27. WebKit in Safari 26 beta (AudioEncoder/AudioDecoder): https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/
28. caniuse, HTTP Live Streaming: https://caniuse.com/http-live-streaming
29. WebKit features in Safari 17.1 (Managed Media Source): https://webkit.org/blog/14735/
30. MDN, ManagedMediaSource: https://developer.mozilla.org/en-US/docs/Web/API/ManagedMediaSource
31. caniuse, Media Source Extensions: https://caniuse.com/mediasource
32. caniuse, RTCPeerConnection: https://caniuse.com/rtcpeerconnection
33. Mux, on LL-HLS (2019): https://www.mux.com/blog/the-community-gave-us-low-latency-live-streaming-then-apple-took-it-away
34. W3C TAG review of the Media WG charter: https://tag-github-bot.w3.org/gh/w3ctag/design-reviews/1082
35. W3C webrtc-nv-use-cases issue 86: https://github.com/w3c/webrtc-nv-use-cases/issues/86

Citations marked *unverified* were not confirmed against a primary source. Facts about the pinned libraries were
checked in their published code (`@moq/net` 0.4.5 `connection/browser.js`, `moq import --help` of moq-cli 0.14.8).
