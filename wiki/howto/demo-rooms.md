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

## Generating the public rooms on the VM

Real agents make the recordings once, on the VM (its spend ledger, decision 0004), one lecture at a time. The VM's
live agents are lazy and serve every room a speaker opens, so a generation room `gen-<room>` needs no agent setup.

**1. Copy the prepared lectures.** Copy them from a machine that ran `sh deploy/media/demo-lectures.sh`; re-encoding
on a 2-vCPU VM would hold both cores for over half an hour. Copy only `lecture.mp4`: a local folder may also hold a
fake-agent recording.

| Room | `lecture.mp4` size | SHA-256 |
|---|---|---|
| `virus` | 198,131,908 B | `289ba3285df3e5ef45e6660032c2ed46a40e1e6f9061517da4019185af9a3810` |
| `dataviz` | 223,180,421 B | `e26f170e17ccab899f637bc72515bf4f9c5655956cb7ec82e5efdcc66c1aa37f` |

```bash
ssh $VM 'mkdir -p ~/tt-data/demo/virus ~/tt-data/demo/dataviz'
scp data/demo/virus/lecture.mp4   $VM:tt-data/demo/virus/lecture.mp4
scp data/demo/dataviz/lecture.mp4 $VM:tt-data/demo/dataviz/lecture.mp4
ssh $VM 'cd ~/tt-data/demo && sha256sum virus/lecture.mp4 dataviz/lecture.mp4'   # must match the table
```

**2. Generate**, on the VM in `tmux` (each run lasts its lecture plus about 1.5 min):

```bash
cd ~/talk-tracks && git pull
(cd agents && docker build -q -t talk-tracks-agents:dev .)
D="docker compose -f deploy/compose.vm.yml"
$D --profile live up -d captions translate-tr describe chapters   # the new image and exclude list

# A cap batch for the generation rooms, read when a room opens: $3 a room, $4 for both
cat > ~/tt-data/caps/gen-demo.json <<'EOF'
{"group": "gen-demo", "room_usd": 3, "total_usd": 4, "rooms": ["gen-virus", "gen-dataviz"]}
EOF
ls ~/tt-data/state/ | grep gen- && echo "move these aside first: captions resumes line ids per room"

sign() { docker run --rm -u $(id -u):$(id -g) -v ~/tt-keys:/keys talk-tracks-auth:0.14.8 auth sign \
  --key /keys/private.jwk --expires $(date -d "+6 hours" +%s) "$@"; }
for L in virus dataviz; do   # one after the other
  GEN=$(sign --publish talk/gen-$L/teacher --publish talk/gen-$L/slides --subscribe "talk/gen-$L/**")
  $D run --rm -e TT_ROOM=gen-$L -e TT_TOKEN="$GEN" looper-$L \
    generate --insecure --media /data/demo/$L/lecture.mp4 --out /data/demo/$L --slides 0,0,0.77,0.77
  unset GEN
done
grep gen-demo ~/tt-data/ledger.jsonl | awk -F'"usd": ' '{split($2,a,","); s+=a[1]} END{printf "spent %.4f\n", s}'
```

- **Tokens.** The speaker token is per run and is never printed; `generate` uses it for its speaker and its recorder.
  The live agents' `TT_AGENT_TOKEN` (`talk/*/agents/**`) already covers the generation rooms.
- **What a run does:**
  1. scans the keyframes for slides (about 1 min);
  2. announces `talk/gen-<room>/teacher`; the agents pick the room up and wake when the recorder subscribes (1 s
     debounce);
  3. after a 5 s lead-in, plays the lecture in real time with its slide frames;
  4. records 15 s more.

  The recording lands in `~/tt-data/demo/<room>/` (`recording.json`, `agents/*.jsonl`). Run it before the agents
  move to the sliced contract: `record` reads the instance tracks until it is ported.
- **Spend.** A batch cap file scopes the cap to the generation rooms. An env override (`TT_ROOM_CAP_USD`) would apply
  to every room, judges' included, and would have to be put back. `TT_SPEND_CEILING_USD` needs no change.

**Cost per lecture.**

| Agent | virus (17:00) | dataviz (19:00) | From |
|---|---|---|---|
| captions | $0.054 | $0.060 | ASR $0.003 per started minute, paid a minute ahead (`asr/meta.py`) |
| translate-tr | $0.14 | $0.16 | about 12 lines a minute, about $0.0007 a line ($1.25 / $4.25 per M tokens in / out, `llm/ledger.py`) |
| chapters | $0.20 | $0.23 | a revision every 6 lines or 60 s (`cores/outline.py`), about 2k tokens in and 0.8k out, about $0.006 each |
| describe | $0.08 | $0.14 | 21 / 34 slide frames, a high-detail image of about 1.5k tokens in and 0.45k out, about $0.004 each |
| **Total** | **about $0.47** | **about $0.59** | up to about $0.65 / $0.75 at the fake script's pace of 17 lines a minute |

A live test on 2026-10-27 cost about $0.02 a minute of speech, which agrees.

**Checks after generation:**
- `recording.json` lists four agents, its `media_last_ms` is near the lecture length (1,020,200 / 1,138,800), and
  `ended_wall_ms` is set.
- Each agent has well over zero snapshots. Fake runs had about 3,200 captions, 300 translations, 21 / 34 slide notes
  and 50 chapter revisions.
- `describe.jsonl` holds real descriptions.
- The `gen-demo` spend is near the estimate.
- `$D logs --since 1h captions translate-tr describe chapters | grep -i cap` finds nothing.

**3. Switch the public rooms on.** Do this once the web viewer reads the sliced tracks; until then `demo` loops as
before, and the new rooms would show video with empty AI panels.

1. In `deploy/.env`, re-sign `TT_LOOPER_TOKEN` for both rooms (`--publish talk/virus/teacher --publish
   'talk/virus/agents/**' --publish talk/dataviz/teacher --publish 'talk/dataviz/agents/**' --subscribe
   'talk/virus/**' --subscribe 'talk/dataviz/**'`, with the same expiry as the current one).
2. `TT_DEMO_ROOM` and `TT_LECTURE` are no longer read.
3. Start the loopers and remove the old one:

   ```bash
   $D up -d looper-virus looper-dataviz
   docker rm -f talk-tracks-looper-1   # the old looper (room demo): /watch/demo goes dark
   ```

4. Check:
   - each looper's log says "a loop every 1024 s" (virus) or "1140 s" (dataviz);
   - `/watch/virus` and `/watch/dataviz` play with every track;
   - a FETCH of a past slice of `talk/<room>/agents/captions` track `items` comes back in tens of ms.

   The live agents keep excluding `virus`, `dataviz` and `demo` (`TT_DEMO_ROOMS`).

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
| `catalog.json` | hang catalog, plain JSON, one object per group, repeated every 2 s. `video.renditions.video`: `avc1.<profile>`, `container: {kind: legacy}`, the avcC record as `description`, size and frame rate. `audio.renditions.audio`: `opus`, legacy container, 48 kHz, mono. An extra section `talk_tracks: {loop, loop_start_ms, duration_ms, period_ms}` says which loop is playing |
| `video` | H.264, one group per GOP (2 s), each object a QUIC varint of the media time in µs and one access unit (AVCC) |
| `audio` | Opus, one 20 ms packet per object and per group, same varint prefix: the format the speaker's browser publishes and the agents read |

**The agent tracks** follow decision 0012 (wiki/design/moq-track-system.md §4), under stable names
`talk/<room>/agents/<agent>`: track `items` for captions, translation and slide descriptions, track `outline` for
chapters. The looper turns the recording's full-state snapshots into that wire format:

* **Slices.** Group k of an `items` track is media time [4k, 4k + 4) s. Object 0 is the carry-in (the last two final
  caption or translated lines, or the slide on screen), then one item per object: each new interim caption text (an
  interim version of the next line id), each new or changed final line, translated line or slide description.
  Translated lines carry their source line's media times. A slice with nothing new is a carry-in alone.
* **Outline.** One group per revision of the whole outline (chapters, glossary, recap); an unchanged revision is
  not a new group.
* **FETCH.** The looper is the origin of its tracks' history: any group up to the one in progress is rebuilt from the
  recording on demand, so a FETCH of any past slice is answered (about 35 ms through the relay, locally), and its copy
  is byte for byte what went out live. A future group is refused (code 17).
* `agent` and `usage` are the recorded ones, so the load panel shows what generating the track cost once. The wire
  types mirror the Lazy agents lane's contract (`v: 2`, `slice`, `kind`, `body`) until it is merged into `contracts/`.

**The room clock** is the wall clock: media time m happens at wall time 2026-10-01 00:00 UTC + m. A loop lasts the
lecture rounded up to whole 4 s slices (up to 4 s of pause between loops), and loop k covers media time
[k·period, (k + 1)·period). So:

* the teacher's media time only rises, so the player and the agents' audio reader never see the clock jump back;
* a looper that restarts (deploy, crash) rejoins the loop in progress at the same position, under the same group
  numbers and ids: the room looks like one broadcast that never stopped;
* group numbers, media times inside items (caption `start_ms`/`end_ms`, slide `at_ms`, chapter `start_ms`) and ids
  (caption, translated line, slide, chapter: moved by k × (largest id + 1)) never repeat in a room's life, so a
  viewer can keep scrollback keyed by id across loops.

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

* A subscriber to `talk/<room>/agents/captions` track `items` sees one group per 4 s, each opened by its carry-in, and
  a FETCH of a group k slices back (`StartAt.range(k, k)`) returns the same objects. (`watch` reads the old instance
  tracks until it moves to the sliced contract.)
* The moq project's own CLI reads the teacher broadcast as hang and writes it to a file that ffprobe can check:
  `docker build -t talk-tracks-moq-cli:0.14.8 -f deploy/Dockerfile.moq-cli deploy`, then
  `docker run --rm --network <compose network> --entrypoint timeout talk-tracks-moq-cli:0.14.8 15 moq --connect moql://relay:4443 --connect-tls-insecure export --broadcast talk/demo/teacher mkv > out.mkv`.
* In a browser, `<moq-watch url="http://localhost:<port>" name="talk/demo/teacher">` plays the video and audio. The
  relay needs `--web-http-listen` on TCP for the self-signed certificate's fingerprint, and the page must be a secure
  context (`localhost` or `127.0.0.1`).

## Known limits

* Two moq-relay 0.17.8 behaviours the looper works around (`agents/src/talk_tracks/origin.py`), and any origin of
  sliced tracks must too: an End of Group object in a FETCH reply fails the whole FETCH (code 18 "short buffer"); and
  a first subscription that starts mid-group gets that group's tail relabelled as the next group, after which the
  real next group is dropped. The looper starts every new subscription at the next group (a first viewer waits up
  to 4 s; the slice in progress is reachable by a Joining FETCH).
* `watch` and `record` still read the old instance tracks (`.../<agent>/<instance>`, track `state`); they move to the
  sliced contract with the agents.
* The looper builds one loop's slices in memory at start (a few MB for a 20-minute lecture) and reads the lecture
  from disk on every loop.
* Rewind (ticket 0002) and the demo moments in looped rooms (ticket 0004) are open; the recording directory is meant
  to be servable as static files for rewind option B.
