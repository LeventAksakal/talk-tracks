# Make and run a looping demo room

A demo room replays a licence-free lecture with AI tracks that were generated once (decision 0006). To a viewer it
looks like a live talk: the lecture video plays on `talk/<room>/teacher` and every agent track (captions, translation,
slide descriptions, chapters) appears under `talk/<room>/agents/`, in step with the video, with no model running.

Three steps, all in Docker (see [run-locally](run-locally.md) for the relay and the fake agents):

1. **prepare**: turn the lecture into the looper's format (MP4, H.264 without B-frames and a keyframe every 2 s, Opus
   48 kHz mono in 20 ms packets) in `data/demo/<lecture>/lecture.mp4`. `data/` is not in git.
2. **generate**: start fresh agents in a private room, play the lecture into it once as the speaker, and record what the
   agents publish into `data/demo/<lecture>/`. This is the only step that would cost API credit with real agents.
3. **loop**: serve the recording in the public room, forever.

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
| `play --media FILE [--loops N]` | Publishes the lecture as the speaker (`talk/<room>/teacher`), once, N times or forever |
| `record --out DIR` | Records every agent in the room until stopped (Ctrl-C or `docker stop`) |
| `generate --media FILE --out DIR [--lead-in-s 5] [--tail-s 15]` | `record` and one `play` together; copies the lecture into DIR |
| `loop --recording DIR [--media FILE]` | Replays DIR's lecture and agent tracks as a live room, forever |

All take `--relay`, `--room`, `--insecure` and `--token` (or `TT_RELAY`, `TT_ROOM`, `TT_TOKEN`; the token goes to the
relay as `?jwt=`). With signed tokens (see [tokens](tokens.md)), `play` and `generate` need publish rights on
`talk/<room>/teacher`, and `loop` on both `talk/<room>/teacher` and `talk/<room>/agents/**`.

### With real agents

The agents in `compose.local.yml` run with `--fake`. For real tracks, run the agents of step 2 without `--fake` and
with the Meta key passed through from your environment (as in [run-locally](run-locally.md)), with
`TT_SPEND_CEILING_USD` set to what one lecture may cost. Use a private room nobody else publishes into, and a fresh
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
