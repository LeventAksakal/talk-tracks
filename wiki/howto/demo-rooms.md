# Make and run a demo room: live sessions and a recording

A demo room plays a licence-free lecture as a live talk (decisions 0006 and 0032): the lecture video plays on
`talk/<room>/teacher` and every agent track (captions, translation, slide descriptions, chapters) appears under
`talk/<room>/agents/`. Each demo lecture is **two rooms**:

* **The live session**, `talk/<id>`: the lecture plays **once** from 00:00, then the room ends for real (its `room`
  track says `ended`, and every broadcast of the session is withdrawn). After a gap (`TT_DEMO_SESSION_GAP_S`, default
  30 s) a **new session** starts from 00:00 under the same name with a **new room epoch** `E`, so the player's clock
  restarts. Nothing wraps inside one timeline. Its AI tracks come from one switch,
  [`TT_DEMO_LIVE_AGENTS`](#the-live-agents-switch): on, only from the live agents, on the session's real audio; off
  (the default), the recording's tracks, each item at the delay its agent really had.
* **The recording**, `<id>-recording`: the whole lecture as an ended room of the archive, seekable, its AI tracks
  labelled `(recorded)`. It is [built once](#the-recording-rooms) by `record-archive` into the archive layout, so the
  HLS, `rooms.json` and replay paths serve it like any past talk.

Making one takes four steps, all in Docker (see [run-locally](run-locally.md) for the relay and the fake agents):

1. **prepare**: turn the lecture into the player's format (MP4, H.264 without B-frames and a keyframe every 2 s, Opus
   48 kHz mono in 20 ms packets) in `data/demo/<lecture>/lecture.mp4`. `data/` is not in git.
2. **generate**: start fresh agents in a private room, play the lecture into it once as the speaker (with its slide
   frames for the describe agent), and record what the agents publish into `data/demo/<lecture>/`. This is the only
   step that costs API credit with the switch off.
3. **session**: run the live sessions in the public room, one after the other, forever.
4. **record-archive**: build the recording room into the archive, once; `serve-recording` serves it.

## Live sessions

`python -m talk_tracks session --recording DIR [--slides X,Y,W,H] [--gap-s S]` (`agents/src/talk_tracks/demo.py`,
`session.py`) runs each session on two relay connections:

1. **The control connection** publishes the room catalog (`talk/<room>/catalog` track `catalog`) with the session's
   new `E` (the next 4 s boundary of the wall clock, at least a second ahead) and the `room` track, before the teacher
   comes on air, so an agent never stamps anything on the last session's clock.
2. At `E`, the `room` track says `on_air` and **the media connection** comes up: the teacher broadcast (its hang
   catalog's `clock` is `E`, so media time t is session time t), the speaker's `deck` and `slide` tracks with
   `--slides`, and, switch off, the recording's AI tracks; switch on, the slide `frames` for the describe agent instead.
3. The lecture plays once, in real time. The session lasts the lecture plus the recording's tail (its agents' last
   words after the lecture's end, at most 30 s), so no recorded item is moved earlier to fit.
4. At the end the `room` track says `ended` (object 1 or later of its slice, which a joining FETCH finds), and then
   the media connection closes: the relay withdraws the teacher, slides and AI tracks. The live agents see the speaker
   gone and the room ended, End their tracks and stop at once (`rooms.room_ended`, no linger).
5. The control connection stays through the gap (the catalog and `ended` stay readable, chat stays open), then
   closes, and the next session starts at step 1.

Each session's broadcasts are fresh publications whose group numbers start at 0: the relay never sees a group number
go back on one publication. A restarted `session` process starts a new session. The teacher's hang catalog carries
`talk_tracks: {session, duration_ms, session_ms}` (which session this player has started since it came up, the
lecture's length and the session's); it has no `period_ms`, so a player does not treat the room as looped.

The room service keeps a demo room's **chat and stats** (`TT_LOOPED_ROOMS`, the old name kept;
`agents/src/talk_tracks/archive/looped.py`). The chat is open during a session and its gap, and its clock is wall
time minus 2026-10-01 00:00 UTC in every session (the old looper's `E`, so chat kept before sessions carries on): a
chat record's `m` in a demo room is **not** session time.

## The live-agents switch

`TT_DEMO_LIVE_AGENTS` (`1`, `true`, `yes` or `on`; unset by default) says where a live session's AI tracks come from:

* **On:** only from the live agents (`--profile live`), through the same lazy-agent machinery as any room a speaker
  opens ([lazy agents](lazy-agents.md)): they read the session's real audio and slide frames and pay only while
  someone subscribes, each room under its spend cap (the spend ledger, decision 0008). The session player then never
  reads the recording's agent snapshots: no code path publishes recorded AI output into the session. Its catalog lists
  the live agents' tracks from their `track.json`, as the room service does for a live room, `capped` included.
* **Off:** the recording's tracks under the stable names, each item when its agent published it when it was recorded:
  a caption cue once its words were heard, a translation when the whole line's translation came back (never with or
  ahead of its caption), a slide note when its model answered. A note `redescribe` patched in goes out after its
  slide by the describe agent's measured median delay in that recording (10 s when it has no live note). The
  `translate-any` agent still translates other languages live in the demo rooms, against the room's cap.

Either way the agents that serve a demo room do it **session by session**: a new `E` in the room catalog starts each
agent again from the session's group 0 (`TrackArchive.start_session` removes the last session's slices first;
`session.json` beside them keeps the session's `E`, so an agent restarted within a session keeps its slices). A
demo room's slices never go to the bucket. Back-fill stays off in demo rooms.

**Flipping it on the VM** (the coordinator; nothing else changes):

```bash
cd ~/talk-tracks && D="docker compose -f deploy/compose.vm.yml"
grep -q '^TT_DEMO_LIVE_AGENTS=' deploy/.env && sed -i 's/^TT_DEMO_LIVE_AGENTS=.*/TT_DEMO_LIVE_AGENTS=1/' deploy/.env \
  || echo 'TT_DEMO_LIVE_AGENTS=1' >> deploy/.env
$D --profile live up -d    # recreates the live agents (the demo rooms leave their exclude list) and the session players
$D logs --since 2m looper-virus | grep -i "live agents"   # "no recorded AI track is read or published in room virus"
```

To switch back, set `TT_DEMO_LIVE_AGENTS=` (empty) and run the same `up -d`. Both directions start a new session in
every demo room. Before flipping it on, give the demo rooms a cap batch (next section): the default room cap ($2) is
cumulative over a room's whole life.

### Spend per room-hour

With the switch on, a session costs what a live talk of the lecture's length costs, for the tracks someone watches.
From the generation runs (the cost table under [Generating the public rooms](#generating-the-public-rooms-on-the-vm)):
about **$0.75 for a fully watched session** of a 17–20 min lecture with captions, three translations, chapters and
slide notes (captions about $0.05, each translation about $0.14, chapters about $0.20, slide notes about $0.08). A
session and its gap last about 18–21 min, so a room watched without a break, every track subscribed, costs up to about
**$2.50 an hour**; captions alone about $0.20 an hour. Nobody watching costs nothing.

The ledger has the real figure (`$TT_DATA/ledger.jsonl`, one line per call: `t` Unix s, `usd`, `room`). Spend per
room, the hours between its first and last call, and spend per hour of that span, since a given time:

```bash
python3 - ~/tt-data/ledger.jsonl "$(date -d '-24 hours' +%s)" <<'PY'
import json, sys
from collections import defaultdict
rows = defaultdict(list)
for raw in open(sys.argv[1]):
    try: line = json.loads(raw)
    except ValueError: continue
    if line.get("t", 0) >= float(sys.argv[2]) and line.get("room") in ("virus", "dataviz", "rsa", "qrcode"):
        rows[line["room"]].append((line["t"], line.get("usd", 0)))
for room, calls in sorted(rows.items()):
    hours = max(1 / 60, (max(t for t, _ in calls) - min(t for t, _ in calls)) / 3600)
    usd = sum(u for _, u in calls)
    print(f"{room}: ${usd:.4f} over {hours:.2f} h = ${usd / hours:.3f} per room-hour")
PY
```

The span counts only time with spend, so it is an upper estimate while viewers come and go. A cap batch for the demo
rooms, read when a room opens (`caps/`, decision 0008); size `room_usd` to the hours they should stay live:

```bash
cat > ~/tt-data/caps/demo-live.json <<'EOF'
{"group": "demo-live", "room_usd": 6, "total_usd": 20, "rooms": ["virus", "dataviz", "rsa", "qrcode"]}
EOF
```

A capped room's paid tracks say `capped` in the catalog and stop; the session still plays.

## The recording rooms

`python -m talk_tracks record-archive --recording DIR [--room ID-recording]`
(`agents/src/talk_tracks/recording_room.py`) builds the recording room into the archive (`TT_ARCHIVE_DIR`), offline
and free, as the room service writes a real talk ([archive](archive.md)):

* the lecture's media as one run of fMP4 segments with HLS playlists, ended, `room.json` and its entry in
  `rooms.json`; `E` is the 4 s boundary at or before the recording's start, so the room is dated when it was made;
* each AI track's slices with its `track.json`: the recording's tracks at their agents' real delays (as a session
  with the switch off plays them), labelled `<label> (recorded)`, `cost: free`, `status: idle`, the last slice End of
  Track;
* the `room` track's slices in `<room>/catalog/room/`: `on_air` at 00:00, `ended` at the end.

No slide is written to disk (ticket 0001). It refuses a room the archive already has: a recording room is built once
(to build it again, remove `archive/<room>-recording/` and stop the room service first).

`python -m talk_tracks serve-recording` (the `recordings` profile in `deploy/compose.vm.yml`, one service per room)
publishes the recording room for replay: its catalog (`E` from `room.json`, the AI tracks from their `track.json`,
the deck and slide tracks, the `room` track), its `room` and AI tracks answering FETCH from the archived slices (the
last group written live, so Largest Location covers all), and with `--slides` the deck and slide tracks from the
lecture's slides, found at start and kept in memory. The room service skips `*-recording` (`TT_ARCHIVE_SKIP`), so its
catalog has one publisher.

**Building them on the VM**, once, after `git pull` and the image build:

```bash
cd ~/talk-tracks && D="docker compose -f deploy/compose.vm.yml"
$D stop archive        # it rewrites rooms.json from what it read at start
for L in virus dataviz rsa qrcode; do
  $D run --rm --no-deps looper-$L record-archive --recording /data/demo/$L --room $L-recording
done
$D up -d archive
$D --profile recordings up -d   # needs TT_RECORDINGS_TOKEN in deploy/.env (below)
```

Each run prints `<room>: E …, … s, 4 AI tracks` and takes about as long as reading the lecture once. Check:
`~/tt-data/archive/virus-recording/index.m3u8` ends with `#EXT-X-ENDLIST`, `rooms.json` lists the four rooms, and
`/watch/virus-recording` plays with every track labelled recorded.

**The recordings token** (`TT_RECORDINGS_TOKEN` in `deploy/.env`), signed like the others
([tokens](tokens.md)), may publish the recording rooms' catalog, agent, slides and archive paths:

```bash
docker run --rm -v ~/tt-keys:/keys talk-tracks-auth:0.14.8 auth sign --key /keys/private.jwk \
  --publish talk/virus-recording/catalog --publish 'talk/virus-recording/agents/**' \
  --publish talk/virus-recording/slides --publish 'talk/virus-recording/archive/**' \
  --publish talk/dataviz-recording/catalog --publish 'talk/dataviz-recording/agents/**' \
  --publish talk/dataviz-recording/slides --publish 'talk/dataviz-recording/archive/**' \
  --publish talk/rsa-recording/catalog --publish 'talk/rsa-recording/agents/**' \
  --publish talk/rsa-recording/slides --publish 'talk/rsa-recording/archive/**' \
  --publish talk/qrcode-recording/catalog --publish 'talk/qrcode-recording/agents/**' \
  --publish talk/qrcode-recording/slides --publish 'talk/qrcode-recording/archive/**' \
  --subscribe 'talk/**' --expires $(( $(date +%s) + 30*86400 ))
```

## Subtitle cue breaks

Both rooms cut the recorded ASR lines into subtitle cues the same way (`agents/src/talk_tracks/resegment.py`): a cue
breaks at a sentence end first, then at a clause mark (comma, semicolon, colon, dash). It never ends mid-phrase to
meet the 84-character line: a cue may run to two lines or a little over 7 s (up to 8.5 s) to reach a mark. Only a
phrase that has no mark in reach is forced, before a conjunction where there is one, else after a content word.
A recording whose recogniser left out most punctuation (virus and dataviz) gives the rule little to break at; the
[`repunctuate`](#re-punctuating-the-captions-repunctuate) pass adds it, words unchanged.
`python -m talk_tracks cue-report --recording DIR` prints, for a recording, how many cues end at a sentence end, a
clause mark, a forced break and the end of an ASR line, and the longest cue (after any saved punctuation); the test
`test_the_demo_recordings_break_at_sentences_and_clauses` asserts no cue ends mid-phrase unless forced, over the four
recordings where they are (`data/demo/<lecture>/`, or `TT_DEMO_DIR`).

## The four public rooms

The VM plays four CC BY-SA 4.0 talks from EMF 2026 (ticket 0001, decision 0014, credited in the README), one room per
lecture, named after it: `virus`, `dataviz`, `rsa`, and `qrcode` (their session players `looper-virus`,
`looper-dataviz`, `looper-rsa`, and `looper-qrcode` in `deploy/compose.vm.yml`, the old service names kept), and their
recording rooms `virus-recording`, `dataviz-recording`, `rsa-recording` and `qrcode-recording` (`recording-<room>`,
profile `recordings`). Each reads `$TT_DATA/demo/<room>/`. One looper token is signed for all four rooms, one
recordings token for the four recording rooms.

`deploy/media/demo-lectures.sh` downloads each talk once from media.ccc.de and checks its SHA-256, so the cut
timestamps always mean the same frames. It then trims and prepares it as `data/demo/<room>/lecture.mp4`:

| Room | Cut (s of the source) | Start | End |
|---|---|---|---|
| `virus` | 12.60–1032.8 (17:00) | the title, sponsor and speaker cards end with a hard cut; speech starts at 13.0 | in a 3.6 s pause that closes a part; the "Taking Over" section slide follows at 1033.9 |
| `dataviz` | 12.60–1151.4 (18:59) | the same cards; speech starts at 12.7 | the speaker's thanks end at 1150.4; then room sound and the EMF licence card at 1157.6 |
| `rsa` | 12.60–1204.8 (19:52) | the same cards; speech starts at 13.0 | in a 3.4 s pause (1203.1–1206.5) closing the section on lattice-based cryptography and post-quantum migration |
| `qrcode` | 12.60–982.4 (16:10) | the same cards; speech starts at 12.7 | the speaker's talk ends at 981.8; then applause and the EMF licence card at 984.9 |

The cuts were found with ffmpeg `silencedetect`, a 100 ms loudness envelope, scene detection and sampled frames.
`prepare-lecture IN OUT [START END]` cuts in the same encode as the format change.

## Slide frames for the describe agent

A recorded talk has no speaker console sending slides, so `play --slides`, `generate --slides` and a live-agents
`session --slides` find them in the video (`agents/src/talk_tracks/slideshow.py`) and send them on
`talk/<room>/slides` track `frames`. Each frame is a JPEG of the slide area, stamped with the Unix wall time the slide
appeared (`SlideFrame.at_ms`, as the console stamps it) and repeated every 2 s, as the console does. The frames stay in
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

### Slides in the player

`session --slides x,y,w,h` and `serve-recording --slides x,y,w,h` (the VM uses the EMF area `0,0,0.77,0.77`, the local
looper `$TT_SLIDES`) scan the lecture the same way when they start (about a minute, before the room goes up), keep the
frames in memory, and send them as the speaker's tracks
([decision 0022](../decisions/0022-the-room-service-serves-the-speakers-track-history.md)),
`agents/src/talk_tracks/demo_slides.py`:

- `deck`: one group, 0, for the room's life: its `DeckInfo`, then one JPEG `DeckImage` per slide. It reaches a player
  on the live subscription: the relay's joining FETCH for a new subscriber asks for the track's largest group, which
  is the deck. The writer's queue holds the whole deck, written once at start while nobody subscribes; a smaller one
  (it was 2) dropped the deck's first objects and moved the rest to groups 1, 2, …, so the joining FETCH asked for a
  group that does not exist and the slide pane said "Loading the slide…" for good.
- `slide`: 4 s slices up to the room's end; each opens with the slide on screen, then a `show` for each slide at its
  time in the lecture (one pass: a session or the recording room plays it once).
- Both are on `talk/<room>/slides` and, for FETCH, on `talk/<room>/archive/slides`, where a player fetches the past
  of any speaker track. Every group is computed from its number, so any past group is answered. The room catalog
  lists the two tracks and a `slides` source. No ink or laser: a recorded talk has none.

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
| `rsa` | 234,639,158 B | `4a50d67d96ebd8fec73e6137a2e0acbd000f5a0bde51335a799106843766dd34` |
| `qrcode` | 143,801,612 B | `06dff0d6af17d944021a6934a8101b2ed851c14057c32f3a248ca7468d388423` |

```bash
ssh $VM 'mkdir -p ~/tt-data/demo/virus ~/tt-data/demo/dataviz ~/tt-data/demo/rsa ~/tt-data/demo/qrcode'
scp data/demo/virus/lecture.mp4   $VM:tt-data/demo/virus/lecture.mp4
scp data/demo/dataviz/lecture.mp4 $VM:tt-data/demo/dataviz/lecture.mp4
scp data/demo/rsa/lecture.mp4     $VM:tt-data/demo/rsa/lecture.mp4
scp data/demo/qrcode/lecture.mp4  $VM:tt-data/demo/qrcode/lecture.mp4
ssh $VM 'cd ~/tt-data/demo && sha256sum virus/lecture.mp4 dataviz/lecture.mp4 rsa/lecture.mp4 qrcode/lecture.mp4'   # must match the table
```

**2. Generate**, on the VM in `tmux` (each run lasts its lecture plus about 1.5 min):

```bash
cd ~/talk-tracks && git pull
(cd agents && docker build -q -t talk-tracks-agents:dev .)
D="docker compose -f deploy/compose.vm.yml"
$D --profile live up -d captions translate-tr translate-es translate-ar describe chapters   # the new image and exclude list

# A cap batch for the generation rooms, read when a room opens: $3 a room, $8 for all four
cat > ~/tt-data/caps/gen-demo.json <<'EOF'
{"group": "gen-demo", "room_usd": 3, "total_usd": 8, "rooms": ["gen-virus", "gen-dataviz", "gen-rsa", "gen-qrcode"]}
EOF
ls ~/tt-data/state/ | grep gen- && echo "move these aside first: captions resumes line ids per room"

sign() { docker run --rm -u $(id -u):$(id -g) -v ~/tt-keys:/keys talk-tracks-auth:0.14.8 auth sign \
  --key /keys/private.jwk --expires $(date -d "+6 hours" +%s) "$@"; }
for L in virus dataviz rsa qrcode; do   # one after the other
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

  The recording lands in `~/tt-data/demo/<room>/` (`recording.json`, `agents/*.jsonl`). `record` follows every
  agent track the room catalog lists and needs the token to read `talk/<room>/catalog`.
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
- `$D logs --since 1h captions translate-tr translate-es translate-ar describe chapters | grep -i cap` finds nothing.

**3. Run the public rooms.**

1. `TT_LOOPER_TOKEN` in `deploy/.env` is signed for all four rooms (`--publish talk/<room>/teacher --publish
   talk/<room>/slides --publish 'talk/<room>/archive/**' --publish 'talk/<room>/agents/**' --publish
   talk/<room>/catalog --subscribe 'talk/<room>/**'` for each room, [tokens](tokens.md)).
2. Start the session players, then build and serve the recording rooms ([the recording rooms](#the-recording-rooms)):

   ```bash
   $D up -d looper-virus looper-dataviz looper-rsa looper-qrcode archive
   ```

3. Check:
   - each player's log says "session 0 in room virus: E …, 1050.0 s (the lecture 1020.2 s)" and, at the end,
     "session 0 in room virus ended; the next in 30 s";
   - `/watch/virus`, `/watch/dataviz`, `/watch/rsa` and `/watch/qrcode` play from 00:00 with every track, and end;
   - a FETCH of a past slice of `talk/<room>/agents/captions` track `items` comes back in tens of ms.

   The live agents exclude `virus`, `dataviz`, `rsa`, `qrcode` and `demo` (`TT_DEMO_ROOMS`) unless
   [`TT_DEMO_LIVE_AGENTS`](#the-live-agents-switch) is on.

## Fixing a finished recording

Four offline commands fix a recording in place without rewriting it: each saves a file beside the agent's
snapshots, which `session` (switch off), `record-archive` and `cue-report` merge (`agents/src/talk_tracks/revise.py`,
`repunctuate.py`). `retranslate`, `redescribe` and `repunctuate` spend through the ledger of the room given with
`--room`, so a cap batch scopes them; with `--fake` they spend nothing. `resplit` makes no model call and spends
nothing.

| Command | What it does | Saves |
|---|---|---|
| `retranslate --lang L --recording DIR` | translates each translated line again, cut to its subtitle cues: one call per line, the line given as numbered cues, one segment back per cue | `agents/translate-<lang>.cues.json`; a line whose cues have changed since falls back to the split translation |
| `redescribe --recording DIR --slides X,Y,W,H [--media FILE]` | finds the lecture's slides again (the same crop as `generate`, so the same ids) and describes those the recording has no note for | `agents/describe.patch.json`; each note goes out after its slide by the describe agent's measured delay in the recording |
| `repunctuate --recording DIR [--dry-run]` | adds sentence and clause punctuation and sentence capitals to each final caption line, one call per line with the lines around it as context; only punctuation and case change, never a word ([below](#re-punctuating-the-captions-repunctuate)); a line already saved is not sent again | `agents/captions.punct.json` |
| `resplit --lang L --recording DIR` | cuts `retranslate`'s lines that have a cue over 84 characters again over the same cues: the line's segments joined, then cut at word boundaries as near the model's own cut as fits (a sentence or clause end near a cut preferred), so only the words needed move into a neighbouring cue; cue timing is unchanged, and a second run changes nothing | `agents/translate-<lang>.cues.json` rewritten; the first run keeps the model's cut as `agents/translate-<lang>.cues.orig.json` |

On the VM, once the image has these commands, with the live agents' key and ledger, one room after the other:

```bash
cd ~/talk-tracks && D="docker compose -f deploy/compose.vm.yml"
cat > ~/tt-data/caps/revise-demo.json <<'JSON'
{"group": "revise-demo", "room_usd": 0.8, "total_usd": 2.5, "rooms": ["revise-virus", "revise-dataviz", "revise-rsa", "revise-qrcode"]}
JSON
for L in virus dataviz rsa qrcode; do
  for LANG in tr es ar; do
    $D --profile live run --rm --no-deps translate-$LANG retranslate --lang $LANG --room revise-$L --recording /data/demo/$L
  done
  $D --profile live run --rm --no-deps describe redescribe --room revise-$L --recording /data/demo/$L --slides 0,0,0.77,0.77
done
grep revise- ~/tt-data/ledger.jsonl | awk -F'"usd": ' '{split($2,a,","); s+=a[1]} END{printf "spent %.4f\n", s}'
$D restart looper-virus looper-dataviz looper-rsa looper-qrcode   # a session player reads the fixes when it starts
```

A recording room already built keeps the tracks it was built with: rebuild it to take the fixes.

Expected cost: about $0.20 for each room. Reasoning tokens roughly double the first estimate (retranslate about $0.04
a lecture on 12k tokens in and 6k out at $1.25 / $4.25 per M; redescribe about $0.004 a slide). The batch stops all
at $2.50.

### Re-punctuating the captions (repunctuate)

The virus and dataviz recogniser returned long lines with almost no punctuation, so most of their cue breaks were
forced (`cue-report` on the VM, 2026-11-02: virus 200 of 246 cues, dataviz 195 of 234; rsa 3 of 240, qrcode 7 of 238).
`repunctuate` asks Muse Spark (minimal reasoning, a JSON schema) to punctuate each final caption line and saves the
lines as `agents/captions.punct.json`. Every reader of the recording merges it (`revise.read_recording`): the cue
cutter breaks at the new sentence ends and clause marks, the translations are split over the new cues by the existing
rule (sentence by sentence, by character share), and a session and the recording room show the punctuated lines.

* **Words never change.** The model's reply is aligned with the line word by word (ignoring case and punctuation);
  only the punctuation and case of matching words are taken, every other word stays as recorded. A saved line whose
  words no longer match its recorded line is ignored.
* **Retranslated cues.** `retranslate`'s saved segments (`translate-<lang>.cues.json`) were cut for the old cues, so
  the lines whose cues change fall back to the split translation. Running `retranslate` and `resplit` again afterwards
  cuts them to the new cues (about $0.20 a room, [above](#fixing-a-finished-recording)); it is optional.
* **Dry run.** `--dry-run` sends nothing and writes nothing: it prints the lines it would send, an upper estimate of
  the cost and the cue report as it stands. It needs no `--room` and no key.
* **Resuming and undoing.** It saves every 10 lines; a run stopped by a cap goes on where it stopped and a second run
  sends nothing. To undo, remove `agents/captions.punct.json`, then restart the session player and rebuild the
  recording room as below.

**Expected cost:** a few cents a lecture. A 17–19 min lecture is about 60–80 lines and 14–17k characters: about
$0.04 at about 300 tokens in and 150 out a line, at most about $0.11 (the dry run's estimate, which allows 250
reasoning tokens a call). Both lectures: under $0.25, held by a cap batch of $0.30 a room.

**On the VM**, once the deployed agents image has the command (the coordinator; rsa and qrcode need no pass):

```bash
cd ~/talk-tracks && D="docker compose -f deploy/compose.vm.yml"

# 1. A cap batch for the pass, then a dry run (free: no call, no write) and the pass itself
cat > ~/tt-data/caps/repunct-demo.json <<'JSON'
{"group": "repunct-demo", "room_usd": 0.3, "total_usd": 0.6, "rooms": ["repunct-virus", "repunct-dataviz"]}
JSON
for L in virus dataviz; do
  $D run --rm --no-deps looper-$L repunctuate --recording /data/demo/$L --dry-run
  $D --profile live run --rm --no-deps captions repunctuate --room repunct-$L --recording /data/demo/$L
done
grep repunct- ~/tt-data/ledger.jsonl | awk -F'"usd": ' '{split($2,a,","); s+=a[1]} END{printf "spent %.4f\n", s}'

# 2. The session players read the punctuation when they start
$D restart looper-virus looper-dataviz

# 3. Rebuild the two recording rooms with the room service and their servers stopped
$D --profile recordings stop recording-virus recording-dataviz
$D stop archive        # it rewrites rooms.json from what it read at start
for L in virus dataviz; do
  $D run --rm --no-deps --entrypoint rm looper-$L -rf /data/archive/$L-recording
  $D run --rm --no-deps looper-$L record-archive --recording /data/demo/$L --room $L-recording
done
$D up -d archive
$D --profile recordings up -d recording-virus recording-dataviz

# 4. The cue report again, all four lectures
for L in virus dataviz rsa qrcode; do
  $D run --rm --no-deps looper-$L cue-report --recording /data/demo/$L
done
```

Each pass prints the lines it sent, the cue report before and after, how many lines changed and how many of the
model's words were not taken (kept as recorded), and its usage. `rm` runs in a container because the archive's files
belong to the containers' user. **Target:** under 15 % of cues forced in virus and dataviz (`forced` over `cues` in
the report), 0 mid-phrase; then `/watch/virus` and `/watch/virus-recording` show sentence-cased, punctuated subtitles.

### Fitting the subtitle cues to 84 characters (resplit)

`retranslate` keeps the cue count but its model splits subtitle cues unevenly: about one cue in seven ran over 84
characters (up to 117). `resplit` fixes that for free across all languages (`tr`, `es`, `ar`); run it after
`retranslate`, once the image has the command. It needs no key, so it runs in each room's session player container
(which mounts the data and sets `TT_ROOM`):

```bash
cd ~/talk-tracks && D="docker compose -f deploy/compose.vm.yml"
for L in virus dataviz rsa qrcode; do
  for LANG in tr es ar; do
    $D run --rm --no-deps looper-$L resplit --lang $LANG --recording /data/demo/$L
  done
done
$D restart looper-virus looper-dataviz looper-rsa looper-qrcode   # a player reads translate-<lang>.cues.json at start
```

Each run logs how many lines it cut again and the longest cue left. On the recordings of 2026-10-29 it left one line
per room a few characters over (its words cannot fit its cues at any word boundary): virus 86, dataviz 87, against
117 and 116 before. To undo, copy `translate-<lang>.cues.orig.json` back over `translate-<lang>.cues.json` and restart the
session player.

## All at once

```bash
docker compose -f deploy/compose.local.yml up -d --build relay
sh deploy/demo-room.sh                       # a 60 s synthetic test clip, fake agents, room "demo"
TT_LECTURE=intro-to-x sh deploy/demo-room.sh ~/Videos/intro-to-x.mp4   # a real lecture file
TT_ROOM=demo docker compose -f deploy/compose.local.yml --profile dev run --rm watch
```

`demo-room.sh` reads `TT_LECTURE` (folder name, default `test`), `TT_ROOM` (the private generation room, default
`gen-<lecture>`), `TT_DEMO_ROOM` (the demo room's live sessions, default `demo`) and `COMPOSE` (the compose command,
for example with `-p name` or extra `-f` files).

## Step by step

```bash
C="docker compose -f deploy/compose.local.yml"
export TT_LECTURE=test TT_ROOM=gen-test TT_DEMO_ROOM=demo

# 1. prepare: a synthetic clip (ffmpeg test pattern with a clock, a beeping tone), or any video file
$C --profile demo run --rm media "test-clip /data/$TT_LECTURE/lecture.mp4 60"
$C --profile demo run --rm media "prepare-lecture /data/$TT_LECTURE/source.mkv /data/$TT_LECTURE/lecture.mp4"

# 2. generate: fresh agents (a recreated container starts with no captions state), one play, then stop them
$C up -d --force-recreate captions translate-tr translate-es translate-ar describe chapters
$C --profile demo run --rm generate
$C stop captions translate-tr translate-es translate-ar describe chapters

# 3. session: live sessions of the recording, one after the other
$C --profile demo up -d looper

# 4. record-archive: the recording room demo-recording, once (into data/archive/, while the room service is stopped)
$C stop archive
$C --profile demo run --rm -v "$PWD/data/archive:/archive" -e TT_ARCHIVE_DIR=/archive looper \
  record-archive --recording /data/$TT_LECTURE --room demo-recording
$C up -d archive
```

The commands behind the services are `python -m talk_tracks <command>` in the agents image:

| Command | What it does |
|---|---|
| `play --media FILE [--loops N] [--slides [X,Y,W,H]]` | Publishes the lecture as the speaker (`talk/<room>/teacher`), once, N times or forever; with `--slides`, its slide frames too |
| `record --out DIR` | Records every agent in the room until stopped (Ctrl-C or `docker stop`) |
| `generate --media FILE --out DIR [--lead-in-s 5] [--tail-s 15] [--slides [X,Y,W,H]]` | `record` and one `play` together; copies the lecture into DIR |
| `session --recording DIR [--media FILE] [--slides X,Y,W,H] [--gap-s S]` | Live sessions of DIR's lecture in the room, one after the other, forever: each plays it once from 00:00 and ends ([live sessions](#live-sessions)); AI tracks by [`TT_DEMO_LIVE_AGENTS`](#the-live-agents-switch) |
| `record-archive --recording DIR [--room ID-recording] [--media FILE]` | Builds the recording room into `TT_ARCHIVE_DIR`, once; offline, no relay ([the recording rooms](#the-recording-rooms)) |
| `serve-recording [--media FILE] [--slides X,Y,W,H]` | Serves the recording room `--room` from the archive: catalog, room track, AI tracks and slides |
| `cue-report --recording DIR` | Prints where DIR's subtitle cues end; offline, no relay |
| `repunctuate --recording DIR [--dry-run]` | Adds punctuation to DIR's caption lines, words unchanged; spends through `--room`'s ledger ([re-punctuating](#re-punctuating-the-captions-repunctuate)) |

All but the offline ones take `--relay`, `--room`, `--insecure` and `--token` (or `TT_RELAY`, `TT_ROOM`, `TT_TOKEN`;
the token goes to the relay as `?jwt=`). With signed tokens (see [tokens](tokens.md)), `play` and `generate` need
publish rights on `talk/<room>/teacher` (and `talk/<room>/slides` with `--slides`), `session` on
`talk/<room>/teacher`, `talk/<room>/slides`, `talk/<room>/archive/**`, `talk/<room>/agents/**` and
`talk/<room>/catalog`, and `serve-recording` on the recording room's `catalog`, `agents/**`, `slides` and
`archive/**`.

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
| `catalog.json` | hang catalog, plain JSON, one object per group, repeated every 2 s. The root `clock` (`wall`: the wall time of media time 0 in µs since 2020-01-01 UTC, `timescale` 1 000 000) maps a media timestamp to wall time and so to room time. `video.renditions.video`: `avc1.<profile>`, `container: {kind: legacy}`, the avcC record as `description`, size and frame rate. `audio.renditions.audio`: `opus`, legacy container, 48 kHz, mono. An extra section `talk_tracks: {session, duration_ms, session_ms}` says which session is playing, the lecture's length and the session's |
| `video` | H.264, one group per GOP (2 s), each object a QUIC varint of the media time in µs and one access unit (AVCC) |
| `audio` | Opus, one 20 ms packet per object and per group, same varint prefix: the format the speaker's browser publishes and the agents read |

**The agent tracks** follow decision 0012 (wiki/design/moq-track-system.md §4), under stable names
`talk/<room>/agents/<agent>`: track `items` for captions, translation and slide descriptions, track `outline` for
chapters. With the switch on they are the live agents' (decision 0012 as in any room). Off, and in the recording
room, the session player and `record-archive` turn the recording's full-state snapshots into that wire format:

* **Slices.** Group k of an `items` track is room time [4k, 4k + 4) s; an item goes in the slice open when the
  recording published it (§4.2), so a cue finalised after its slice closed lands in a later one, at most `latenessMs`
  later. Object 0 is the carry-in (the last two final cues, or the slide on screen), then one item per object: each
  new interim caption text (`final: false` under the next cue's id, `rev` rising), each new or changed final cue,
  translated cue or slide description. Translated cues carry their source cue's id and times. A slice with nothing new
  is a carry-in alone.
* **Payload.** Every object is an MSF event-timeline array of `{m, data}` records (`contracts/`, `CueObject`,
  `SlideObject`, `OutlineObject`): a cue's `data` is `{start, end, id, text, rev, final}` with `m == start` and `id`
  the caption line id as a decimal string, a slide's `{id, at, text}` with `m == at`, the outline's chapters
  `{kind: "chapter", id, start, title, summary}` with `m == start`, then its glossary terms and recap at the
  revision's time.
* **Cues.** The real ASR's lines are long segments (half a minute is common), so each is first cut into subtitle
  cues ([subtitle cue breaks](#subtitle-cue-breaks)). Word times follow the recorded interims; a cue goes out final
  once all its words were heard. Each translated line is split over its source line's cues, sentence by sentence, by
  character share, and goes out when the translation agent published the line's translation.
* **Outline.** One group per revision of the whole outline (chapters, glossary, recap); an unchanged revision is
  not a new group.
* **FETCH.** The session player is the origin of its tracks' history: any group up to the one in progress is rebuilt
  from the recording on demand, so a FETCH of any past slice of the session is answered (about 35 ms through the
  relay, locally), and its copy is byte for byte what went out live. A future group is refused (code 17). In the
  recording room `serve-recording` answers from the archived slices.
* What generating a track cost once is its `spend_usd` in the room catalog's status, below.

**The room catalog** `talk/<room>/catalog` track `catalog` is the MSF catalog of the room's AI tracks
(wiki/design/moq-track-system.md §5.10, built by `agents/src/talk_tracks/room_catalog.py`), plain JSON, one group per
write, repeated every 2 s:

* root `version: "draft-01"` and the extension `tt`: `E` (room time 0, Unix ms: the session's start, new each
  session), `shift` (ms, a whole number of slices, keyed by the teacher broadcast's `clock.wall` as a decimal string:
  0 here), `status` keyed by bare agent name (switch off: `status: "live"`, `producing: true`, zero `fetches_served`
  and `backfills`, `spend_usd` what generating the track cost, `updated_ms` refreshed with every write; switch on, and
  for `translate-any`, the live agents' own reports, `capped` included; in the recording room `idle`); the names are
  locked in wiki/design/lane-briefs.md, "Catalog field names", and validated by the contracts' `RoomCatalog`;
* one entry per track: `name`, `namespace`, `packaging: "eventtimeline"`, `mimeType`, `eventType`
  (`urn:msf:captions:webvtt` for captions and translation, `com.talktracks.slides`, `com.talktracks.outline`), `role`
  (`caption`, `subtitle`), `lang` and `label` (left out when unset; ending ` (recorded)` in the recording room),
  `isLive`, the slice `template` (none for the outline), and `tt` with `dependsOn` (full track paths), `latenessMs`
  (how late the recording published an item after its own time, at most) and `cost: "free"`;
* the speaker's `deck` and `slide` tracks, the `room` track (`talk/<room>/catalog` track `room`), and in a live
  session the room service's `chat` and `stats` tracks.

`@moq/msf` 0.3's `CatalogSchema` strips every field it does not declare (all but `name`, `packaging`, `isLive` and
`role`, and the root `tt`), so a viewer reads the raw JSON.

**The room clock** of a session is its own: media time m happens at wall time `E + m`, and session time is media
time, from 00:00. So:

* within a session the teacher's media time only rises, so the player and the agents' audio reader never see the
  clock jump back; the next session is a new teacher broadcast with a new `E`, after the last one ended;
* group numbers, media times inside items and ids are the recording's own and start again each session: a viewer
  keeps scrollback per session (a new `E` is a new session);
* a session player that restarts (deploy, crash) starts a new session from 00:00; viewers of the old one see it end.

## The recording

`data/demo/<lecture>/` holds everything a demo room's sessions and its recording room need:

```
recording.json          manifest: room, lecture file, media range, room_origin_ms, agents
                        (contracts/recording.schema.json)
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

**`record` reads the agents' records back into full states** (`agents/src/talk_tracks/follow.py`): it subscribes the
room catalog for its tracks, `E` and shifts, and the teacher's hang catalog for `clock`, then follows each agent
track. Each cue id's highest `rev` wins, final cues become the lines and the newest open cue the interim; slides
collect by id; each outline object is the whole outline. The records are on room time, so the recorder stamps on
room time too: the manifest's `room_origin_ms` is the room time of the lecture's media time 0 (clock.wall as Unix ms
− `E` + the teacher's shift), a session subtracts it, and every snapshot's `media_ms` is teacher media time plus it.
`instance` is empty under a stable name and `seq` counts each agent's snapshots. Recordings without
`room_origin_ms` (the first two, made from full-state envelopes) are on the media clock.

## Checking a demo room

* A subscriber to `talk/<room>/agents/captions` track `items` sees one group per 4 s, each opened by its carry-in, and
  a FETCH of a group k slices back (`StartAt.range(k, k)`) returns the same objects. `watch` prints each agent's
  state rebuilt from the records as they arrive.
* The moq project's own CLI reads the teacher broadcast as hang and writes it to a file that ffprobe can check:
  `docker build -t talk-tracks-moq-cli:0.14.8 -f deploy/Dockerfile.moq-cli deploy`, then
  `docker run --rm --network <compose network> --entrypoint timeout talk-tracks-moq-cli:0.14.8 15 moq --connect moql://relay:4443 --connect-tls-insecure export --broadcast talk/demo/teacher mkv > out.mkv`.
* In a browser, `<moq-watch url="http://localhost:<port>" name="talk/demo/teacher">` plays the video and audio. The
  relay needs `--web-http-listen` on TCP for the self-signed certificate's fingerprint, and the page must be a secure
  context (`localhost` or `127.0.0.1`).

## Known limits

* Two moq-relay 0.17.8 behaviours the session player works around (`agents/src/talk_tracks/origin.py`), and any origin of
  sliced tracks must too: an End of Group object in a FETCH reply fails the whole FETCH (code 18 "short buffer"); and
  a first subscription that starts mid-group gets that group's tail relabelled as the next group, after which the
  real next group is dropped. The player starts every new subscription at the next group (a first viewer waits up
  to 4 s; the slice in progress is reachable by a Joining FETCH).
* A browser's FETCH of a group the relay has not cached (moq-lite FETCH, served upstream by a SUBSCRIBE and a FETCH
  to the player) fails when the group takes more than a few ms to send: the relay cancels its upstream subscription
  at once, which resets the FETCH stream (seen 2026-10-31 on a 7-slide deck of 1.4 MB: 1 in 8 came through). Small
  slices are unaffected; the deck must come on the live subscription (above), not by FETCH from
  `talk/<room>/archive/slides`.
* A viewer who joins in the gap between two sessions sees the last one ended; the next starts within the gap
  (default 30 s) and is a new teacher broadcast under a new `E`.
* With the switch on, a live agent's track of a session starts when the agent picks the session up (a few seconds
  after 00:00: it needs the teacher announced and a subscriber), as in any live room.
* `record` writes a new snapshot per object (an interim or a cue revision is a whole caption state), so a recording
  of the records is larger than one of the old full-state envelopes; a session diffs it back into the same items.
* The session player builds the recording's slices in memory at start (a few MB for a 20-minute lecture) and reads
  the lecture from disk once per session.
* Demo moments in the demo rooms (ticket 0004) are open.
