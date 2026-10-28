// Spike 6b: a browser (@moq/net 0.4.5 over WebSocket) late-joins an IETF publisher's track that published one group
// and then went quiet, after `QUIET_S` seconds of silence. Does the relay still deliver the latest group, or does
// its 5 s max age for IETF-sourced tracks drop it? The publisher is `jury_checks.py quiet-pub`.
import * as Moq from "@moq/net";

const RELAY = process.env.SPIKE_RELAY_HTTP ?? "http://relay:4443/";
const QUIET_S = Number(process.env.QUIET_S ?? 12);
const T0 = performance.now();
const log = (...a) => console.log(`${((performance.now() - T0) / 1000).toFixed(2).padStart(7)}s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const origin = new Moq.Origin.Producer();
new Moq.Connection({ url: new URL(RELAY), consume: origin, websocket: { enabled: true }, delay: { timeout: Moq.Time.Milli(0) } });
const req = origin.request(Moq.Path.from("spike/quiet"), { announced: true });
let b;
for (let i = 0; i < 200 && !b; i++) {
  b = req.active.peek();
  if (!b) await sleep(100);
}
log("announced; waiting", QUIET_S, "s of silence");
await sleep(QUIET_S * 1000);

const results = {};
for (const [label, opts] of [
  ["default", {}],
  ["maxAge_0", { maxAge: Moq.Time.Milli(0) }],
]) {
  const t = performance.now();
  const sub = b.track("t").subscribe(opts);
  const got = await Promise.race([sub.recvGroup().then((g) => (g ? `group ${g.sequence}` : "ended")), sleep(3000).then(() => "nothing in 3 s")]);
  results[label] = { got, ms: Math.round(performance.now() - t) };
  log(`late join after ${QUIET_S} s quiet, ${label}:`, results[label]);
  sub.close();
  await sleep(300);
}
console.log("RESULTS " + JSON.stringify(results));
process.exit(0);
