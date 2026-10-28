// Spike 3: what the browser's client (@moq/net 0.4.5, moq-lite-06 to the relay) can do with an aiomoqt (IETF
// draft-18) publisher's track. Runs in Node over the relay's WebSocket path (Node has no WebTransport), which is
// also what Safari and iPhone viewers use. The publisher is web_publisher.py: one JSON object per group, 2/s.
//
// A. live subscribe (maxAge 0, then a 60 s budget)   B. fetchGroup of a cached group and of a 40 s old one
// C. fetchGroup with no live subscription            D. after the publisher has gone
import * as Moq from "@moq/net";

const RELAY = process.env.SPIKE_RELAY_HTTP ?? "http://relay:4443/";
const PATH = "spike/web";
const T0 = performance.now();
const log = (...a) => console.log(`${((performance.now() - T0) / 1000).toFixed(2).padStart(7)}s`, ...a);
const results = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (frame) => JSON.parse(new TextDecoder().decode(frame.payload ?? frame));

const origin = new Moq.Origin.Producer();
const connection = new Moq.Connection({
  url: new URL(RELAY),
  consume: origin,
  websocket: { enabled: true },
  delay: { timeout: Moq.Time.Milli(0) },
});

async function broadcast() {
  const req = origin.request(Moq.Path.from(PATH), { announced: true });
  for (let i = 0; i < 200; i++) {
    const b = req.active.peek();
    if (b) return b;
    await sleep(100);
  }
  throw new Error("broadcast never announced");
}

async function fetchOne(b, seq, label) {
  const t = performance.now();
  try {
    const group = await Promise.race([
      b.track("t").fetchGroup(seq),
      sleep(6000).then(() => {
        throw new Error("timeout 6 s");
      }),
    ]);
    const frame = await group.readFrame();
    results[label] = { ok: true, group: group.sequence, payload: frame ? decode(frame) : null, ms: Math.round(performance.now() - t) };
  } catch (e) {
    results[label] = { ok: false, error: String(e?.message ?? e), ms: Math.round(performance.now() - t) };
  }
  log(label, results[label]);
}

const b = await broadcast();
log("announced; transport:", connection.status?.peek?.());
const live = b.track("t").subscribe({ maxAge: Moq.Time.Milli(0) });
const seen = [];
let reading = true;
(async () => {
  try {
    while (reading) {
      const g = await live.recvGroup();
      if (!g) break;
      seen.push(g.sequence);
    }
  } catch (e) {
    results.A_live_ended = String(e?.message ?? e);
    log("live subscription ended:", results.A_live_ended);
  }
})();
await sleep(4000);
results.A_live_first_groups = seen.slice(0, 3);
log("A: live groups so far", seen.length, "first", seen.slice(0, 3));

// A2 (first run, 2026-10-28): a second subscription to the same track with maxAge 60 s made @moq/net send a
// subscribe update; the relay answered "subscribe error ... remote error: 0" and the live subscription ended.
// Not repeated here: one subscription per track per session, options fixed at subscribe time.
await sleep(36_000); // the publisher is now about 40 s in
const edge = seen.at(-1);
await fetchOne(b, edge - 2, "B_fetch_cached");
await fetchOne(b, 4, "B_fetch_40s_old");
await fetchOne(b, 4, "B_fetch_40s_old_again");

reading = false;
live.close();
await sleep(1500);
await fetchOne(b, 6, "C_fetch_without_subscription");

log("waiting for the publisher to leave");
await sleep(Number(process.env.SPIKE_WAIT_GONE_MS ?? 25_000));
await fetchOne(b, edge - 2, "D_fetch_after_publisher_gone");

console.log("RESULTS " + JSON.stringify(results));
connection.close();
process.exit(0);
