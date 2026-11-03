// The journeys the harness walks without a human (wiki/product/journeys.md J1-J8, ui-design §5). Each one drives the
// app by its user-visible labels, the way a person would, and calls `shot(state, intent)` at every state worth a
// look. The intent says what the frame should show, so a reviewer measures the frame against a claim, not taste.
//
// Cost guard (deployed site): subtitles and translations are picked only from what the room already lists as running
// ("in this room"); a new language would wake a paid translation agent. Nothing here submits a valid Start a talk
// form, and capture.mjs aborts any POST to /api/rooms on top of that.
//
// Every translation is lazy (decision 0035): none is made ahead, so none is free. With TT_DEMO_LIVE_AGENTS off the
// demo and recording rooms offer no translation at all; on, each one is paid while watched. So the translation steps
// run only when asked (--translation <name>), and even then only on a language the room already runs.

import { sleep } from "./util.mjs";

const NO_TRANSLATION =
  "skipped: every translation is lazy and paid (decision 0035), none is made ahead; pass --translation <name> to pick one the room already runs";

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * The player is ready when the room's media element (decision 0031: Media Chrome drives it) has a timeline: its
 * readyState says it has metadata, as a video element's would.
 */
async function waitForPlayer(page, timeout = 25_000) {
  await page.locator("media-controller").waitFor({ state: "visible", timeout });
  await page.waitForFunction(() => (document.querySelector("tt-room-media")?.readyState ?? 0) >= 1, null, { timeout });
}

/** Press a player key with the focus on the page, not in a field. */
async function key(page, k, times = 1) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(k);
    await sleep(120);
  }
}

/**
 * Close whatever menu is open. Escape in a Media Chrome submenu (Settings > Speed) goes back to its parent menu
 * instead of closing it, so press it until no settings menu shows (at most three times).
 */
async function closeMenus(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await sleep(300);
    const open = await page.evaluate(() => {
      const m = document.querySelector("media-settings-menu");
      return (m && !m.hidden) || document.querySelector("[data-menu-root] [role=dialog], .tt-menu") !== null;
    });
    if (!open) return;
  }
}

/** The shared player walk: a demo room on the relay, or the offline demo. */
async function walkPlayer(j, { live }) {
  const { page, shot, step } = j;

  await step("player ready", async () => {
    try {
      await waitForPlayer(page);
    } catch (e) {
      await shot("not-ready", "watch: the player never showed a time in 25 s; this frame is what a viewer sees then");
      throw e;
    }
  });

  await step("playing", async () => {
    // A browser that blocks autoplay shows "Play the talk"; otherwise Media Chrome's play button (named "play").
    const big = page.getByRole("button", { name: "Play the talk" });
    const play = page.getByRole("button", { name: "play", exact: true });
    if (await big.isVisible().catch(() => false)) await big.click();
    else if (await play.isVisible().catch(() => false)) await play.click();
    await sleep(5_000);
    await shot(
      "playing",
      live
        ? "watch + live: the talk plays full-bleed, the glass dock shows the LIVE marker in red with its word, slides and camera on the stage"
        : "demo + live: the scripted talk plays offline, LIVE marker in the dock, slides with the speaker's ink",
    );
  });

  await step("rewound", async () => {
    // J is ten seconds back (Media Chrome's keys, answered anywhere on the page): six presses, a minute.
    await key(page, "j", 6);
    await sleep(3_500);
    await shot("rewound", "watch + behind: a minute back, the pill shows a grey −offset and offers Go live");
  });

  await step("paused", async () => {
    await key(page, "k");
    await sleep(1_200);
    await shot("paused", "watch + paused: K paused the talk; the dock stays up and its play button offers play");
    await key(page, "k");
    await sleep(800);
  });

  await step("go live", async () => {
    const back = page.getByRole("button", { name: /Go live/ });
    await back.first().click();
    await sleep(3_500);
    await shot("back-live", "watch + live again: Go live returned the playhead to the live edge, pill red again");
  });

  await step("subtitles menu", async () => {
    await page.getByRole("button", { name: "Subtitles", exact: true }).click();
    await sleep(600);
    await shot("subtitles-menu", "subtitles menu: Off, Original, the languages this room already runs marked 'in this room'");
  });

  await step("subtitles on", async () => {
    const original = page.getByRole("button", { name: /^Original/ });
    const text = (await original.first().textContent()) ?? "";
    if (/not in this room yet/.test(text)) throw new Error("skipped: no original subtitles in this room");
    await original.first().click();
    await closeMenus(page);
    await sleep(7_000);
    await shot("subtitles-on", "watch + subtitles: original-language subtitles over the stage, readable on both slides and camera");
  });

  await step("translation", async () => {
    if (!j.opts.translation) throw new Error(NO_TRANSLATION);
    await page.getByRole("button", { name: "Subtitles", exact: true }).click();
    await sleep(500);
    // Only a language the room already lists as running: never wake a paid agent.
    // And of those, the one asked for (--translation), so a language another viewer happened to wake is never the
    // one the harness keeps subscribed unasked.
    const want = new RegExp(j.opts.translation, "i");
    const running = page
      .getByRole("group", { name: "Languages" })
      .getByRole("button")
      .filter({ hasText: "in this room" })
      .filter({ hasText: want });
    const n = await running.count();
    if (n === 0) {
      await closeMenus(page);
      throw new Error(`skipped: the room does not list ${j.opts.translation} as running`);
    }
    const choice = running.first();
    const label = ((await choice.textContent()) ?? "").replace("in this room", "").trim();
    await choice.click();
    await closeMenus(page);
    await sleep(10_000);
    await shot(`translation-${slug(label).slice(0, 24) || "picked"}`, `watch + translation: subtitles in ${label}, a language the room already runs`);
  });

  await step("side panel", async () => {
    const toggle = page.getByRole("button", { name: "Side panel (S)" });
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    await sleep(800);
    const tabs = page.getByRole("tablist", { name: "Side panel" }).getByRole("tab");
    const labels = await tabs.allTextContents();
    for (const label of labels) {
      await step(`panel tab ${label}`, async () => {
        await page.getByRole("tab", { name: label, exact: true }).click();
        await sleep(2_500);
        await shot(`panel-${slug(label)}`, `side panel + ${label}: the tab says what it holds, loading or starting from now, never blank`);
      });
    }
  });

  await step("layout menu", async () => {
    const layout = page.getByRole("button", { name: "Layout", exact: true });
    if (!(await layout.isVisible().catch(() => false))) throw new Error("skipped: one source, no Layout button");
    await layout.click();
    await sleep(500);
    await shot("layout-menu", "layout menu: Side by side or One at a time, the current one marked");
    await closeMenus(page);
  });

  await step("settings", async () => {
    await page.getByRole("button", { name: /^settings$/i }).click();
    await sleep(500);
    await shot("settings", "settings menu: Speed, Subtitle size, Subtitle style (Quality when the stream has more than one); switches nothing on");
  });

  await step("speed", async () => {
    await page.getByRole("menuitem", { name: /Speed/ }).click();
    await sleep(500);
    await shot("speed", "settings + speed: 0.5x to 2x, the current one checked (it takes effect rewound or on a recording)");
    await closeMenus(page);
  });

  await step("subtitle style", async () => {
    await page.getByRole("button", { name: /^settings$/i }).click();
    await sleep(300);
    await page.getByRole("menuitem", { name: /Subtitle style/ }).click();
    await sleep(600);
    await shot("subtitle-style", "settings + subtitle style: the presets, the current one checked");
    await closeMenus(page);
  });

  await step("stats for nerds", async () => {
    await key(page, "i");
    await sleep(2_500);
    await shot("stats", "stats for nerds (I or right-click): connection kind, the enabled tracks, one summary row for the rest; no money");
    await page.getByRole("button", { name: "Close stats" }).click();
  });

  await step("shortcuts", async () => {
    await key(page, "?");
    await sleep(600);
    await shot("shortcuts", "keyboard shortcuts dialog: every key the player answers to");
    await closeMenus(page);
  });
}

export const JOURNEYS = [
  {
    id: "hub",
    title: "Hub (J2, J8 entry)",
    relay: false,
    async run(j) {
      const { page, go, shot, step } = j;
      await step("hub loads", async () => {
        await go("/");
        await page.getByRole("region", { name: "Live now" }).waitFor({ timeout: 12_000 });
        await sleep(1500);
        await shot("top", "hub: on-air hero, one way in (room name or link), Start a talk, Live now row");
        await shot("full", "hub full page: Live now, Continue watching and Recordings rows of glass cards", { fullPage: true });
      });
      await step("card expands", async () => {
        const card = page.getByRole("region", { name: "Live now" }).locator("article.tile-card").first();
        await card.hover();
        await sleep(900);
        await shot("card-hover", "hub card on hover: extended view with description, speaker, languages, tracks and a play button");
      });
      await step("card by keyboard", async () => {
        await page.mouse.move(0, 0);
        await page.getByRole("region", { name: "Live now" }).getByRole("link").first().focus();
        await sleep(600);
        await shot("card-focus", "hub card by keyboard: the same extended view on focus, play button named with the talk");
      });
    },
  },
  {
    id: "create",
    title: "Start a talk and join errors (J5)",
    relay: false,
    async run(j) {
      const { page, go, shot, step } = j;
      await go("/");
      const form = page.getByRole("form", { name: "Start a talk" });
      await step("modal", async () => {
        await page.getByRole("button", { name: "Start a talk" }).click();
        await form.waitFor({ timeout: 5_000 });
        await sleep(400);
        await shot("form", "Start a talk modal: title, speaker, room name and access code, one primary button");
      });
      await step("errors empty", async () => {
        await form.getByRole("button", { name: "Start" }).click();
        await sleep(400);
        await shot("errors-empty", "Start a talk + errors: each empty field says what it needs, at the field");
      });
      await step("errors bad room", async () => {
        await form.getByLabel("Talk title").fill("QA harness check");
        await form.getByLabel("Speaker").fill("QA");
        await form.getByLabel("Room name").fill("x!");
        await form.getByRole("button", { name: "Start" }).click();
        await sleep(400);
        await shot("errors-room", "Start a talk + errors: a bad room name and a missing code are refused before any request");
      });
      await step("modal closes", async () => {
        await page.keyboard.press("Escape");
        await form.waitFor({ state: "detached", timeout: 5_000 });
      });
      await step("join error", async () => {
        const join = page.getByRole("search", { name: "Join a room" });
        await join.getByLabel("Room name or link").fill("!");
        await join.getByRole("button", { name: "Join" }).click();
        await sleep(400);
        await shot("join-error", "join + error: a bad room name says what a room name or link looks like");
      });
    },
  },
  {
    id: "watch",
    title: "Demo room on the relay (J2, J3, J4, J8)",
    relay: true,
    async run(j) {
      await j.go(`/watch/${j.opts.room}`);
      await walkPlayer(j, { live: true });
    },
  },
  {
    id: "recording",
    title: "A demo lecture's recording (decision 0032): play, seek, subtitles, speed, panel, full screen, end, replay",
    relay: true,
    async run(j) {
      const { page, go, shot, step, opts } = j;
      const room = opts.recording ?? `${opts.room}-recording`;
      await go(`/watch/${room}`);
      await step("opened", async () => {
        try {
          await waitForPlayer(page);
        } catch (e) {
          await shot("not-ready", "recording: the player never showed a time in 25 s; this frame is what a viewer sees then");
          throw e;
        }
        await sleep(3_000);
        await shot("opened", "recording: opens at 0:00 on the first slide, ready to play; the pill says Recording; no chat or live-only tabs");
      });
      await step("playing", async () => {
        const big = page.getByRole("button", { name: /^Play/ }).filter({ hasNotText: /^$/ });
        const play = page.getByRole("button", { name: "play", exact: true });
        if (await play.isVisible().catch(() => false)) await play.click();
        else if (await big.first().isVisible().catch(() => false)) await big.first().click();
        await sleep(5_000);
        await shot("playing", "recording + playing: the time counts up from 0:00 of the whole length");
      });
      await step("seek middle", async () => {
        const range = page.locator("media-time-range").first();
        const box = await range.boundingBox();
        if (!box) throw new Error("no time range");
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
        await sleep(4_000);
        await shot("seeked-middle", "recording + seek: a click on the timeline jumped to the middle; slide and time follow, no live pill");
      });
      await step("subtitles on", async () => {
        await page.getByRole("button", { name: "Subtitles", exact: true }).click();
        await sleep(500);
        await page.getByRole("button", { name: /^Original/ }).first().click();
        await closeMenus(page);
        await sleep(5_000);
        await shot("subtitles-on", "recording + subtitles: the original's recorded subtitles at the playhead");
      });
      await step("translation", async () => {
        if (!opts.translation) throw new Error(NO_TRANSLATION);
        await page.getByRole("button", { name: "Subtitles", exact: true }).click();
        await sleep(500);
        const want = new RegExp(opts.translation, "i");
        const choice = page
          .getByRole("group", { name: "Languages" })
          .getByRole("button")
          .filter({ hasText: /in this room/ })
          .filter({ hasText: want });
        if ((await choice.count()) === 0) {
          await closeMenus(page);
          throw new Error(`skipped: the recording does not list ${opts.translation} as running (picking it would pay)`);
        }
        await choice.first().click();
        await closeMenus(page);
        await sleep(6_000);
        await shot("translation", `recording + translation: ${opts.translation} subtitles at the playhead, back-filled from the recorded captions`);
      });
      await step("subtitles off", async () => {
        await page.getByRole("button", { name: "Subtitles", exact: true }).click();
        await sleep(400);
        await page.getByRole("button", { name: /^Off/ }).first().click();
        await closeMenus(page);
        await sleep(1_500);
        await shot("subtitles-off", "recording + subtitles off: no subtitle box and no status line on the stage");
      });
      await step("speed", async () => {
        await page.getByRole("button", { name: /^settings$/i }).click();
        await sleep(400);
        await page.getByRole("menuitem", { name: /Speed/ }).click();
        await sleep(400);
        await page.getByRole("menuitemradio", { name: /1\.5/ }).first().click();
        await sleep(600);
        await closeMenus(page);
        await sleep(2_000);
        await shot("speed-1-5", "recording + 1.5x: the talk plays faster; nothing on screen claims otherwise");
      });
      await step("side panel", async () => {
        const toggle = page.getByRole("button", { name: "Side panel (S)" });
        if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
        await sleep(600);
        const labels = await page.getByRole("tablist", { name: "Side panel" }).getByRole("tab").allTextContents();
        for (const label of labels) {
          await page.getByRole("tab", { name: label, exact: true }).click();
          await sleep(1_500);
          await shot(`panel-${slug(label)}`, `recording side panel + ${label}: a job that makes sense for a recording`);
        }
      });
      await step("keys", async () => {
        await key(page, "j", 3);
        await sleep(1_500);
        await shot("keys-back", "recording + J three times: thirty seconds back, the time says so");
      });
      await step("fullscreen", async () => {
        await key(page, "f");
        await sleep(1_500);
        await shot("fullscreen", "recording + full screen: the player and its side panel fill the screen");
        await key(page, "f");
        await sleep(800);
      });
      await step("ended", async () => {
        await page.evaluate(() => {
          const m = document.querySelector("tt-room-media");
          if (m && Number.isFinite(m.duration)) m.currentTime = Math.max(0, m.duration - 4);
        });
        await sleep(9_000);
        await shot("ended", "recording + end: the end card says the lecture is over and offers Replay and the hub");
      });
      await step("replay", async () => {
        await page.getByRole("button", { name: /Replay/ }).first().click();
        await sleep(4_000);
        await shot("replayed", "recording + replay: back at 0:00 and playing");
      });
    },
  },
  {
    id: "demo",
    title: "Offline demo at /demo",
    relay: false,
    async run(j) {
      const { go, shot, step } = j;
      await go("/demo");
      await walkPlayer(j, { live: false });
      for (const state of ["connecting", "not-started", "paused", "ended", "reconnecting", "failed"]) {
        await step(`state ${state}`, async () => {
          await go(`/demo?state=${state}`);
          await sleep(2_500);
          await shot(`state-${state}`, `demo + forced state ${state}: the time display and canvas say it in words (ui-design §5)`);
        });
      }
    },
  },
  {
    id: "unknown",
    title: "Unknown room and not found",
    relay: true,
    async run(j) {
      const { go, shot, step } = j;
      await step("unknown room", async () => {
        await go("/watch/qa-no-such-room");
        await sleep(8_000);
        await shot("not-started", "watch + unknown room: says nobody is on air here yet, without an error");
      });
      await step("invalid name", async () => {
        await go("/watch/Not_A_Room!!");
        await sleep(800);
        await shot("invalid-name", "watch + invalid name: says it is not a room name and links back to the hub");
      });
      await step("not found", async () => {
        await go("/no/such/page");
        await sleep(800);
        await shot("not-found", "not found: friendly, one link back to the hub");
      });
    },
  },
  {
    id: "console",
    title: "Speaker console pre-flight, no token (J6)",
    relay: true,
    async run(j) {
      const { page, go, shot, step } = j;
      await step("preflight", async () => {
        await go("/talk/qa-preflight");
        await page
          .getByText(/Speaker token/)
          .first()
          .waitFor({ timeout: 15_000 })
          .catch(() => {});
        await sleep(4_000);
        await shot("preflight", "console pre-flight: mic level, camera, token check explains the missing token; Go on air is the one primary action");
        await shot("preflight-full", "console pre-flight full page", { fullPage: true });
      });
      await step("camera on", async () => {
        const cam = page.getByRole("switch", { name: /Camera/ }).or(page.getByRole("checkbox", { name: /Camera/ }));
        if ((await cam.count()) === 0) throw new Error("skipped: no camera switch found");
        if (!(await cam.first().isChecked())) await cam.first().click();
        await sleep(3_000);
        await shot("preflight-camera", "console pre-flight + camera: the self-view shows the (fake) camera");
      });
      await step("microphone on", async () => {
        const mic = page.getByRole("switch", { name: /Microphone/ }).or(page.getByRole("checkbox", { name: /Microphone/ }));
        if ((await mic.count()) === 0) throw new Error("skipped: no microphone switch found");
        if (!(await mic.first().isChecked())) await mic.first().click();
        await sleep(2_500);
        await shot("preflight-mic", "console pre-flight + microphone: the level meter moves with the (fake) input; nothing is sent before Go on air");
      });
    },
  },
];
