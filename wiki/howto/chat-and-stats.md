# Chat and Stats for nerds

Two room tracks the room service publishes: the chat (ticket 0021) and the stats (ticket 0022). Formats:
[container-formats.md](../design/container-formats.md) §2, `talk/R/chat` and `talk/R/stats`.

## Chat

- **Writing.** A listener writes over the same WebSocket as ink and comments (`/api/rooms/<room>`, decision 0024):
  `{"type": "write", "seq", "track": "chat", "data": {"kind": "message", "text"}}`.
  - The room service stamps `id`, `by` (the session's name, `speaker` for the console) and `m` (room time now). A
    client that sends `id` or `by` is refused.
  - The text is trimmed. Empty text is refused; more than 500 characters is refused with `limit`.
  - Rate limit per session: 1 message every 2 s with a burst of 5 (speaker 1/s, burst 10), refused with `rate`.
  - Before the room has a clock (the talk has not started), the write is refused with `not-live`.
- **Reading.** The player subscribes while the Chat tab is open (`web/src/player/chatFeed.ts`). The latest group's
  carry-in brings the last 50 messages; each later object brings one more. Rewound, the player FETCHes the group of
  the playhead and shows the chat up to it.
- **Archive.** The room service archives every slice byte for byte (`ServiceTrack`) and answers FETCH from the
  archive. A restarted room service carries the conversation on.
- **Names.** A listener without a name gets a random "Adjective Animal" name when the drawer opens. "Change name"
  replaces it for the session (no account).
- **Console.** The audience area has a Show chat button (`speaker/Audience.tsx`). Open, it subscribes to the chat
  through the console's viewer connection and shows it read-only (`Chat` with `readOnly`); closed, it unsubscribes.

## Stats for nerds

- **Snapshot.** The room service publishes `talk/<room>/stats` `stats`, one `RoomStats` per group. It lists every
  track of the room:
  - the speaker's media and slides while they are sent;
  - the catalog, the room service's own tracks and the stats track;
  - each agent's tracks: `running` while its `tt.status` says producing, else `on_demand`.
- **Counts.** `subscribers` is the number of sessions subscribed to the track's *broadcast* at the relay. Agents and
  the room service count like browsers. `listeners` is the browsers connected to the room service's WebSocket for
  the room (the speaker not counted).
- **Cadence.** Snapshots are built only while someone subscribes: the first at once, then every 5 s
  (`archive/stats.py`, `StatsTrack`). The player subscribes only while the Stats for nerds panel is open
  (`web/src/player/roomStats.ts`).
- **The relay's counters.** moq-relay 0.17.8 publishes its own counters when started with `--stats-enabled`
  (`--stats-interval 2` here):
  - Broadcast `.stats/node`, track `publisher.json`: a JSON map {broadcast path: traffic}.
  - Each traffic entry carries a `subscriptions` gauge (and cumulative `subscriptions_started` and `_ended`).
  - Checked against a local relay on 2026-11-02: a key is the broadcast path without a leading slash
    (`talk/probe/chat`), and one viewer shows `"subscriptions": 1`.
  - The room service reads it from `TT_RELAY_STATS` (default `.stats/node`; empty: not read). Without a frame for
    15 s, the counts are unknown (`relay: false`, no `subscribers`) and the panel says so.
- **Auth.** On a relay with auth, the room service's token needs subscribe `.stats/**` besides `talk/**`, and
  publish `talk/*/chat` and `talk/*/stats` ([tokens.md](tokens.md)). Viewers stay on `talk/**`, so the relay's
  counters are not public.
- **Demo rooms.** See [Looped demo rooms](#looped-demo-rooms): the room service publishes their stats track too.

## Looped demo rooms

The looper publishes a demo room's media, slides, agent tracks and catalog, and its recording is the room's archive.
The room service (`archive/looped.py`) archives nothing of these rooms and leaves their catalog to the looper; it
publishes only their chat and stats tracks. Which rooms: `TT_LOOPED_ROOMS` (patterns; on the VM it defaults to
`TT_DEMO_ROOMS`, locally to `TT_DEMO_ROOM`). A looped room is never archived, whatever `TT_ARCHIVE_ROOMS` says.

- **One publisher per track.** The looper's catalog lists `talk/R/chat` and `talk/R/stats` (`with_room_service`,
  called in `demo.loop`), so the player finds them; only the room service publishes them. The looper's token needs
  nothing new, and the room service's (`talk/*/chat`, `talk/*/stats`) already covers every room.
- **What the room service reads.** The looper's room catalog (`talk/R/catalog`: E, its tracks and the agents'
  status) and the teacher's hang catalog (`talk/R/teacher` `catalog.json`: the media tracks), both subscribed for as
  long as the room is announced. Nothing that wakes an agent.
- **Stats.** As in a live room: the teacher's media, the deck and slide tracks, the catalog, the chat, the stats
  track and every agent track the catalog lists (running while its status says producing). An agent that serves the
  room without being in the looper's catalog (`translate-any`) is not listed.
- **Chat, writing.** Over the listener WebSocket with a live room's validation, stamps and limits. Drawing, marks
  and comments are refused there (`forbidden`), and the player keeps those tools off in a demo room while the chat
  works. While the looper is not on air (its teacher broadcast is not announced), a write is refused `not-live`.
- **Chat, the clock.** Room time is wall time minus the looper's E. It runs on across loops, so a message's `m` is
  the moment it was said, not a position in the lecture.
- **Chat, slices.** A slice is written when a message is said and, while someone reads the chat, every 4 s with its
  carry-in (the last 50 messages). A drawer opened at any moment gets the history within about a second, also after
  a room-service restart; while nobody reads and nobody writes, nothing is written.
- **Chat, rewinding.** Never replayed. Rewound in a looped room, the drawer stays live and says so: a rewind within
  the loop moves the lecture, not the conversation, so the chat at an earlier room time would be a different
  conversation (or none). Live is the one behaviour that is never wrong there.
- **Chat, kept.** In `TT_LOOPED_DIR` (default `looped/` beside the archive folder; `/data/looped` on the VM), never
  in the archive Caddy serves or the bucket copy. The newest 64 slices per room are kept (`KEEP_SLICES`); a restarted
  room service seeds itself from the newest one, so the last 50 messages carry on.
- **Checked** on 2026-11-02 against a local relay with a stand-in looper: a chat write is acked with `m` = wall - E;
  an ink write is refused; a drawer opened later gets the message at once; after `docker restart` of the room service
  a new drawer gets it within 0.4 s; the stats list the room's tracks with relay counts; the archive folder stays
  empty.

## Check it locally

```bash
docker compose -f deploy/compose.local.yml up -d relay archive
```

Then open a room in the player and open Stats for nerds. The room tracks list fills within a second.
