# Screenshots for the README

Captures from the counted QA run on the freeze candidate (`qa/out/20261103-counted-0769d3d`, main 0769d3d), dark theme,
1440×900, desktop Chromium or Chrome. No private links or tokens on screen (a speaker link carries a token: crop or
blur it).

| File | Screen | URL | Shows | QA frame |
|---|---|---|---|---|
| `01-hub.png` | Home | `/` | The hero with the live talk and its tracks, the Live now row | `chromium/hub-top-dark.png` |
| `02-player-tracks.png` | Recording | `/watch/dataviz-recording` | Slide, camera, and the side panel on Chapters with the recap so far | `chromium/recording-panel-chapters-dark.png` |
| `03-rewind.png` | Player, rewound | `/watch/dataviz`, a minute back, paused | The dock's "−1:03 · Go live" and the transcript | `chrome/watch-paused-dark.png` |
| `04-console.png` | Speaker console | `/talk/<room>` | Before going on air: the checks, the slide stage and the drawing tools | `chromium/console-preflight-dark.png` |
| `05-stats.png` | Stats for nerds | any `/watch/<room>`, press I | Connection, playhead, the room's tracks and subscriber counts | `chromium/watch-stats-dark.png` |

Still wanted: a player shot with translated subtitles on (the QA harness picks a translation only when the room
already runs it, and the recording did not list German at capture time), and the console on air with ink on a slide.
