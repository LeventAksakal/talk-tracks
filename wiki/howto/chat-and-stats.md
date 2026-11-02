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
- **Console.** `Chat` takes `readOnly` for the speaker console's audience area; wiring it in is the Speaker lane's.

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
- **Demo rooms.** The looped demo rooms are skipped by the room service (`TT_ARCHIVE_SKIP`), so they have no chat
  and no stats track. The panel says the room service sends no stats for the room.

## Check it locally

```bash
docker compose -f deploy/compose.local.yml up -d relay archive
```

Then open a room in the player and open Stats for nerds. The room tracks list fills within a second.
