# Make and run a looping demo room

A demo room replays a licence-free lecture with AI tracks that were generated once (decision 0006). To a viewer it
looks like a live talk: the lecture video plays on `talk/<room>/teacher` and every agent track (captions, translation,
slide descriptions, chapters) appears under `talk/<room>/agents/`, in step with the video, with no model running.

Three steps, all in Docker (see [run-locally](run-locally.md) for the relay and the fake agents):

1. **prepare**: turn the lecture into the looper's format (MP4, H.264 without B-frames and a keyframe every 2 s, Opus
   48 kHz mono in 20 ms packets) in `data/demo/<lecture>/lecture.mp4`. `data/` is not in git.
2. **generate**: start fresh agents in a private room, play the lecture into it once as the speaker (with its slide
   frames for the describe agent), and record what the agents publish into `data/demo/<lecture>/`. This is the only
   step that would cost API credit with real agents.
3. **loop**: serve the recording in the public room, forever.

## The two public rooms

The VM loops two CC BY-SA 4.0 talks from EMF 2026 (ticket 0001, credited in the README), one room per lecture,
named after it: `virus` and `dataviz` (`looper-virus` and `looper-dataviz` in `deploy/compose.vm.yml`). Each reads
`$TT_DATA/demo/<room>/`. One looper token is signed for both rooms.

`deploy/media/demo-lectures.sh` downloads each talk once from media.ccc.de and checks its SHA-256, so the cut
timestamps always mean the same frames. It then trims and prepares it as `data/demo/<room>/lecture.mp4`:

| Room | Cut (s of the source) | Start | End |
|---|---|---|---|
| `virus` | 12.60–1032.8 (17:00) | the title, sponsor and speaker cards end with a hard cut; speech starts at 13.0 | in a 3.6 s pause that closes a part; the "Taking Over" section slide follows at 1033.9 |
| `dataviz` | 12.60–1151.4 (18:59) | the same cards; speech starts at 12.7 | the speaker's thanks end at 1150.4; then room sound and the EMF licence card at 1157.6 |

The cuts were found with ffmpeg `silencedetect`, a 100 ms loudness envelope, scene detection and sampled frames.
`prepare-lecture IN OUT [START END]` cuts in the same encode as the format change.

## Slide frames for the describe agent

A recorded talk has no speaker console sending slides, so `play --slides` and `generate --slides` find them in the
video (`agents/src/talk_tracks/slideshow.py`) and send them on `talk/<room>/slides`. Each frame is a JPEG of the slide
area, sent at the media time the slide appeared and repeated every 2 s, as the console does. The frames stay in
memory for the run. They are never written to disk or stored as assets: the slides contain third-party images
(ticket 0001).

- Only keyframes are decoded (every 2 s), and a screen counts once the next keyframe looks the same. Transitions and
  video clips inside a slide are skipped.
- A still screen that changes the current slide's content is a new slide.
- One that only adds to it is a build: the slide keeps its first time and takes the fuller image, so it is described
  once, complete.
- A return to an earlier slide (after a zoom) is not sent again. Content decides this, not the share of the screen:
  two title slides of one template differ in a few cells but are different slides.
- `--slides x,y,w,h` crops to the slide area, in fractions of the frame. The EMF layout is `0,0,0.77,0.77`, which
  leaves out the speaker inset and the logo. A bare `--slides` sends the whole frame.

| Lecture | Slides sent | Of which | Scan |
|---|---|---|---|
| `virus` | 21 | 17 numbered slides and 4 zoomed views | about 20–45 s |
| `dataviz` | 34 | about 27 distinct slides, the opening stage shot, the closing clip, 2 builds that move earlier content, and 5 frames of an animated scroll | about 25–50 s |

## All at once

```bash
docker compose -f deploy/compose.local.yml up -d --build relay
sh deploy/demo-room.sh                       # a 60 s synthetic test clip, fake agents, room "demo"
TT_LECTURE=intro-to-x sh deploy/demo-room.sh ~/Videos/intro-to-x.mp4   # a real lecture file
TT_ROOM=demo docker compose -f deploy/compose.local.yml --profile dev run --rm watch
```

`demo-room.sh` reads `TT_LECTURE` (folder name, default `test`), `TT_ROOM` (the private generation room, default
`gen-<lecture>`), `TT_DEMO_ROOM` (the looping room, default `demo`) and `COMPOSE` (the compose command, for example
with `-p name` or extra `-f` files).

## Step by step

```bash
C="docker compose -f deploy/compose.local.yml"
export TT_LECTURE=test TT_ROOM=gen-test TT_DEMO_ROOM=demo

# 1. prepare: a synthetic clip (ffmpeg test pattern with a clock, a beeping tone), or any video file
$C --profile demo run --rm media "test-clip /data/$TT_LECTURE/lecture.mp4 60"
$C --profile demo run --rm media "prepare-lecture /data/$TT_LECTURE/source.mkv /data/$TT_LECTURE/lecture.mp4"

# 2. generate: fresh agents (a recreated container starts with no captions state), one play, then stop them
$C up -d --force-recreate captions translate-tr describe chapters
$C --profile demo run --rm generate
$C stop captions translate-tr describe chapters

# 3. loop
$C --profile demo up -d looper
```

The commands behind the services are `python -m talk_tracks <command>` in the agents image:

| Command | What it does |
|---|---|
| `play --media FILE [--loops N] [--slides [X,Y,W,H]]` | Publishes the lecture as the speaker (`talk/<room>/teacher`), once, N times or forever; with `--slides`, its slide frames too |
| `record --out DIR` | Records every agent in the room until stopped (Ctrl-C or `docker stop`) |
| `generate --media FILE --out DIR [--lead-in-s 5] [--tail-s 15] [--slides [X,Y,W,H]]` | `record` and one `play` together; copies the lecture into DIR |
| `loop --recording DIR [--media FILE]` | Replays DIR's lecture and agent tracks as a live room, forever |

All take `--relay`, `--room`, `--insecure` and `--token` (or `TT_RELAY`, `TT_ROOM`, `TT_TOKEN`; the token goes to the
relay as `?jwt=`). With signed tokens (see [tokens](tokens.md)), `play` and `generate` need publish rights on
`talk/<room>/teacher` (and `talk/<room>/slides` with `--slides`), and `loop` on both `talk/<room>/teacher` and `talk/<room>/agents/**`.

### With real agents

The agents in `compose.local.yml` run with `--fake`. For real tracks, run the agents of step 2 without `--fake` and
with the Meta key passed through from your environment (as in [run-locally](run-locally.md)). Set
`TT_SPEND_CEILING_USD` to the ledger's current total plus what one lecture may cost: the ceiling caps the ledger's
total, not one run. Use a private room nobody else publishes into, and a fresh
room name or recreated containers each time: the captions agent resumes its lines from its state file per room.

## What a viewer receives

**The teacher broadcast** `talk/<room>/teacher` is a hang broadcast, as `@moq/watch` 0.6 plays it (point the player's
`name` at `talk/<room>/teacher`):

| Track | Content |
|---|---|
| `catalog.json` | hang catalog, plain JSON, one object per group, repeated every 2 s. `video.renditions.video`: `avc1.<profile>`, `container: {kind: legacy}`, the avcC record as `description`, size and frame rate. `audio.renditions.audio`: `opus`, legacy container, 48 kHz, mono. An extra section `talk_tracks: {loop, loop_start_ms, duration_ms}` says which loop is playing |
| `video` | H.264, one group per GOP (2 s), each object a QUIC varint of the media time in µs and one access unit (AVCC) |
| `audio` | Opus, one 20 ms packet per object and per group, same varint prefix: the format the speaker's browser publishes and the agents read |

**The agent tracks** are the usual `talk/<room>/agents/<agent>/<instance>` track `state` envelopes, with a heartbeat
every 2 s. `agent` and `usage` are the recorded ones, so the load panel shows what generating the track cost once.

**At each loop restart** the room behaves as if every agent had been restarted:

* the teacher's media time keeps rising (loop k plays lecture time t at k × duration + t), so the player and the
  agents' audio reader never see the clock jump back;
* every agent gets a new instance, named by the wall clock and always larger than the last, published on a new
  connection; the previous loop's instances are withdrawn just after. A viewer that follows the newest instance per
  agent switches by itself;
* sequence numbers start again at 1 (they belong to the instance);
* media times inside states (caption `start_ms`/`end_ms`, slide `at_ms`, chapter `start_ms`) move by k × duration and
  ids (caption, translated line, slide, chapter) by k × (largest id + 1), so a caption still points at the right video
  moment and ids never repeat in a room's life. A viewer may keep scrollback keyed by id across loops, or clear it
  when the instance changes; both look right.

## The recording

`data/demo/<lecture>/` holds everything a looping room needs:

```
recording.json          manifest: room, lecture file, media range, agents (contracts/recording.schema.json)
agents/<agent>.jsonl    one snapshot per line: media_ms, wall_ms, instance, seq, usage, state
                        (contracts/recorded-snapshot.schema.json)
lecture.mp4             the prepared lecture
```

**Media time is the speaker's clock.** The recorder subscribes to the teacher audio and keeps the newest media time
(the varint every audio object starts with); each agent snapshot is stamped with it on arrival. It is not wall time
(which drifts from the media under load) and not caption `end_ms` (only the captions track has it, and it hides the
agents' processing delay). Stamped on arrival, a replay shows each track exactly as late as it was live. Snapshots
from before the first audio are stamped 0; those after the lecture ends play at its end. `generate` publishes the
lecture from media time 0, so recording time is lecture time.

## Checking a looped room

* `watch` prints each snapshot with the teacher media time when it arrived: the last caption's end time stays within
  about 0.1 s of it, through every loop restart.
* The moq project's own CLI reads the teacher broadcast as hang and writes it to a file that ffprobe can check:
  `docker build -t talk-tracks-moq-cli:0.14.8 -f deploy/Dockerfile.moq-cli deploy`, then
  `docker run --rm --network <compose network> --entrypoint timeout talk-tracks-moq-cli:0.14.8 15 moq --connect moql://relay:4443 --connect-tls-insecure export --broadcast talk/demo/teacher mkv > out.mkv`.
* In a browser, `<moq-watch url="http://localhost:<port>" name="talk/demo/teacher">` plays the video and audio. The
  relay needs `--web-http-listen` on TCP for the self-signed certificate's fingerprint, and the page must be a secure
  context (`localhost` or `127.0.0.1`).

## Known limits

* A long-running aiomoqt subscriber (the `watch` stand-in) is not told when an old instance is withdrawn; a new
  subscriber sees only the current one. Viewers should follow the newest instance per agent rather than wait for
  withdrawals.
* The looper reads the recording and the lecture from disk on every loop, so memory stays flat for long lectures.
* Rewind (ticket 0002) and the demo moments in looped rooms (ticket 0004) are open; the recording directory is meant
  to be servable as static files for rewind option B.
