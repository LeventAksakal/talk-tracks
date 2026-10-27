# Run the web app

The speaker console and the viewer live in `web/` (React 19, Vite, TypeScript, Astryx). Needs Node 24.

```bash
cd web
npm ci
npm run dev        # http://localhost:5173
```

| Page | What it is |
|---|---|
| `/` | Landing page: join a room by name |
| `/watch/<room>` | Viewer: captions, translations, slide descriptions, chapters, glossary, recap, the speaker's audio |
| `/talk/<room>` | Speaker console: microphone, slide sharing, agent roster with cost |
| `/demo` | The viewer on a scripted room, offline: no relay, no agents |

## Point it at a relay

The relay URL comes from `VITE_RELAY_URL` at build or dev time; the default is `http://localhost:4443/`, the local
relay from `deploy/compose.local.yml`.

```bash
docker compose -f deploy/compose.local.yml up -d --build
docker compose -f deploy/compose.local.yml --profile dev up -d teacher
VITE_RELAY_URL=http://localhost:4443/ npm run dev
```

Then open `/watch/dev`. Set `TT_RELAY_PORT` to publish the relay on another host port (UDP and TCP), and match
`VITE_RELAY_URL` to it.

Browsers need the relay's web listener (`--web-http-listen`, already in the local compose file). On an `http://`
relay URL the page fetches `/certificate.sha256` from it over TCP and pins the relay's self-signed certificate for
WebTransport; the same listener serves the WebSocket fallback for browsers without WebTransport. A deployed relay uses
`https://` with a real certificate instead.

## Speaking

Open `/talk/<room>`, press **Go on air**, allow the microphone. The badge says **On air** only once a second,
anonymous connection (what any viewer sees) receives this page's own audio back from the relay; a refused publish is
silent, so after 10 seconds without it the console says the relay is not carrying the microphone.

A relay that checks tokens admits publishers only with a signed token: open `/talk/<room>?token=<jwt>`; the console
passes it to the relay as `?jwt=`. Watching needs no token. Stop the stand-in `teacher` container first when you speak
in its room, or the two broadcasts compete for the same path.

**Share slides** shares a window or screen. A JPEG (at most 1280 px wide) goes out on `talk/<room>/slides`, track
`frames`, only when the picture changes, and at most one every two seconds.

## Checks

From `web/`: `npm run build`, `npm run typecheck`, `npm run lint` (ESLint and Prettier), `npm test` (Vitest with
happy-dom: contract validation, instance following and staleness, the room store, speaker logic, the `/demo` page).

The pages against a live relay were checked headless with Playwright driving an installed Chrome, with
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --auto-accept-this-tab-capture` for the
microphone and screen.

## Deploying

`npm run build` writes a static site to `web/dist/`. The web server must:

- send every unknown path to `index.html` (the app routes `/watch/...` and `/talk/...` itself);
- optionally send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which
  give the audio player `SharedArrayBuffer` and lower latency; without them it still plays.
