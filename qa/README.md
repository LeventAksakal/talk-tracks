# QA harness (workstream 06)

One command runs the automated QA against a deployed or local Talk Tracks:

1. **Journeys:** Playwright walks the journeys that need no human (`wiki/product/journeys.md`) in Chromium, branded
   Chrome and Edge (when installed), Firefox and WebKit, in the dark and the light theme, and screenshots every state.
2. **Lighthouse:** desktop preset on the hub, a demo watch page and the offline demo: performance, accessibility,
   best practices and SEO, saved as JSON and HTML.
3. **Performance trace:** a Chrome DevTools trace of a watch page: load, 60 s of playback with subtitles, a seek back
   and Go live. Long tasks, the main thread's busy share, frame rate and memory growth go into the report.

Captures are evidence, not assertions. A failed step is written to the report and the walk goes on; nothing passes
or fails on pixels. Read the frames against the intent written next to each one.

## Run it

```powershell
npm ci --prefix qa                     # once
npx --prefix qa playwright install chromium chromium-headless-shell firefox webkit   # once

$env:TT_BASE_URL = "https://<the deployed host>/"   # never commit the hostname
npm run qa --prefix qa

# or a local build, offline parts only (no relay needed)
npm run build --prefix web
npm run preview --prefix web -- --port 4319 --strictPort   # stop it when done
npm run qa --prefix qa -- --base "http://[::1]:4319/" --offline
```

`npm run qa --prefix qa -- --help` lists the options: `--browsers`, `--themes`, `--journeys`, `--room`,
`--trace-path`, `--trace-seconds`, `--lighthouse-pages`, `--run`, and `--skip-capture|lighthouse|trace`.

Vite preview listens on `localhost`, which on Windows resolves to `::1` first: use `http://[::1]:<port>/`.

## Output

```
qa/out/<run>/
  report.md                          every capture with its intent and console errors, failed steps, Lighthouse, trace
  summary.json                       the same, machine-readable
  <browser>/<journey>-<state>-<theme>.png
  lighthouse/<page>.json, <page>.html
  trace/watch-trace.json.gz          load it in the DevTools Performance panel
```

`<run>` defaults to `<yyyymmdd-hhmm>-local` or `-deployed`. Every text output is redacted of the deployed host
(`<TT_BASE_URL>`, `<host>`), so a run can be shared; the screenshots carry no URL bar.

## Journeys

| Journey | What it walks | Needs the relay |
|---|---|---|
| `hub` | the hub, top and full page | no (says the relay can't be reached) |
| `create` | the Create talk form, its errors, the join and speaker-link errors; never submits a valid form | no |
| `watch` | a demo room (`--room`, default `dataviz`): playing, rewound a minute, back live, subtitles, a translation, each side-panel tab, layout, settings, subtitle style, Stats for nerds, shortcuts | yes |
| `demo` | the same walk on the offline demo at `/demo`, then each forced player state (`/demo?state=…`) | no |
| `unknown` | a room nobody is on air in, an invalid room name, a page that does not exist | yes |
| `console` | the speaker console's pre-flight with no token, fake camera and microphone | yes |

## Cost and safety guards

- Subtitles and translations are picked only from what the room lists as running ("in this room"), and of those only
  `--translation` (default Arabic, generated once for every demo room). A language the
  room does not run would wake a paid translation agent; the harness never picks one.
- No room is created: no journey submits a valid Create talk form, and every context aborts a POST to `/api/rooms`
  (a tripped guard shows up as a failed step).
- The console is opened with no token and never goes on air.
- One browser at a time.

## What it cannot cover

A real camera and microphone, a live speaker going on air, drawing on a live deck, and listener annotations in a live
room: the owner's human QA covers those. Live rooms change between runs (no injected clock or seed), so two runs are
not byte-comparable. WebKit on Windows is not Safari, and the phone layouts are out of scope (desktop only).
