// The journeys the harness walks without a human (wiki/product/journeys.md J1-J8, ui-design §5). Each one drives the
// app by its user-visible labels, the way a person would, and calls `shot(state, intent)` at every state worth a
// look. The intent says what the frame should show, so a reviewer measures the frame against a claim, not taste.
//
// Cost guard (deployed site): subtitles and translations are picked only from what the room already lists as running
// ("in this room"); a new language would wake a paid translation agent. Nothing here submits a valid Create talk
// form, and capture.mjs aborts any POST to /api/rooms on top of that.

import { sleep } from "./util.mjs";

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
  await page.waitForFunction(
    () => (document.querySelector("tt-room-media")?.readyState ?? 0) >= 1,
    null,
    { timeout },
  );
}

/** Press a player key with the focus on the page, not in a field. */
async function key(page, k, times = 1) {
  await page.evaluate(
    () =>
      document.activeElement instanceof HTMLElement &&
      document.activeElement.blur(),
  );
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(k);
    await sleep(120);
  }
}

async function closeMenus(page) {
  await page.keyboard.press("Escape");
  await sleep(300);
}

/** The shared player walk: a demo room on the relay, or the offline demo. */
async function walkPlayer(j, { live }) {
  const { page, shot, step } = j;

  await step("player ready", async () => {
    try {
      await waitForPlayer(page);
    } catch (e) {
      await shot(
        "not-ready",
        "watch: the player never showed a time in 25 s; this frame is what a viewer sees then",
      );
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
    await shot(
      "rewound",
      "watch + behind: a minute back, the pill shows a grey −offset and offers Go live",
    );
  });

  await step("paused", async () => {
    await key(page, "k");
    await sleep(1_200);
    await shot(
      "paused",
      "watch + paused: K paused the talk; the dock stays up and its play button offers play",
    );
    await key(page, "k");
    await sleep(800);
  });

  await step("go live", async () => {
    const back = page.getByRole("button", { name: /Go live/ });
    await back.first().click();
    await sleep(3_500);
    await shot(
      "back-live",
      "watch + live again: Go live returned the playhead to the live edge, pill red again",
    );
  });

  await step("subtitles menu", async () => {
    await page.getByRole("button", { name: "Subtitles", exact: true }).click();
    await sleep(600);
    await shot(
      "subtitles-menu",
      "subtitles menu: Off, Original, the languages this room already runs marked 'in this room'",
    );
  });

  await step("subtitles on", async () => {
    const original = page.getByRole("button", { name: /^Original/ });
    const text = (await original.first().textContent()) ?? "";
    if (/not in this room yet/.test(text))
      throw new Error("skipped: no original subtitles in this room");
    await original.first().click();
    await closeMenus(page);
    await sleep(7_000);
    await shot(
      "subtitles-on",
      "watch + subtitles: original-language subtitles over the stage, readable on both slides and camera",
    );
  });

  await step("translation", async () => {
    await page.getByRole("button", { name: "Subtitles", exact: true }).click();
    await sleep(500);
    // Only a language the room already lists as running: never wake a paid agent.
    // And of those, the one asked for (--translation, default Arabic: generated once for every demo room), so a
    // language another viewer happened to wake is never the one the harness keeps subscribed.
    const want = new RegExp(j.opts.translation, "i");
    const running = page
      .getByRole("group", { name: "Languages" })
      .getByRole("button")
      .filter({ hasText: "in this room" })
      .filter({ hasText: want });
    const n = await running.count();
    if (n === 0) {
      await closeMenus(page);
      throw new Error(
        `skipped: the room does not list ${j.opts.translation} as running`,
      );
    }
    const choice = running.first();
    const label = ((await choice.textContent()) ?? "")
      .replace("in this room", "")
      .trim();
    await choice.click();
    await closeMenus(page);
    await sleep(10_000);
    await shot(
      `translation-${slug(label).slice(0, 24) || "picked"}`,
      `watch + translation: subtitles in ${label}, a language the room already runs`,
    );
  });

  await step("side panel", async () => {
    const toggle = page.getByRole("button", { name: "Side panel (S)" });
    if ((await toggle.getAttribute("aria-pressed")) !== "true")
      await toggle.click();
    await sleep(800);
    const tabs = page
      .getByRole("tablist", { name: "Side panel" })
      .getByRole("tab");
    const labels = await tabs.allTextContents();
    for (const label of labels) {
      await step(`panel tab ${label}`, async () => {
        await page.getByRole("tab", { name: label, exact: true }).click();
        await sleep(2_500);
        await shot(
          `panel-${slug(label)}`,
          `side panel + ${label}: the tab says what it holds, loading or starting from now, never blank`,
        );
      });
    }
  });

  await step("layout menu", async () => {
    const layout = page.getByRole("button", { name: "Layout", exact: true });
    if (!(await layout.isVisible().catch(() => false)))
      throw new Error("skipped: one source, no Layout button");
    await layout.click();
    await sleep(500);
    await shot(
      "layout-menu",
      "layout menu: Side by side or One at a time, the current one marked",
    );
    await closeMenus(page);
  });

  await step("settings", async () => {
    await page.getByRole("button", { name: /^settings$/i }).click();
    await sleep(500);
    await shot(
      "settings",
      "settings menu: Speed, Subtitle size, Subtitle style (Quality when the stream has more than one); switches nothing on",
    );
  });

  await step("speed", async () => {
    await page.getByRole("menuitem", { name: /Speed/ }).click();
    await sleep(500);
    await shot(
      "speed",
      "settings + speed: 0.5x to 2x, the current one checked (it takes effect rewound or on a recording)",
    );
    await closeMenus(page);
  });

  await step("subtitle style", async () => {
    await page.getByRole("button", { name: /^settings$/i }).click();
    await sleep(300);
    await page.getByRole("menuitem", { name: /Subtitle style/ }).click();
    await sleep(600);
    await shot(
      "subtitle-style",
      "settings + subtitle style: the presets, the current one checked",
    );
    await closeMenus(page);
  });

  await step("stats for nerds", async () => {
    await key(page, "i");
    await sleep(2_500);
    await shot(
      "stats",
      "stats for nerds (I or right-click): connection kind, the enabled tracks, one summary row for the rest; no money",
    );
    await page.getByRole("button", { name: "Close stats" }).click();
  });

  await step("shortcuts", async () => {
    await key(page, "?");
    await sleep(600);
    await shot(
      "shortcuts",
      "keyboard shortcuts dialog: every key the player answers to",
    );
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
        await page
          .getByText("Checking what is on air…")
          .waitFor({ state: "detached", timeout: 12_000 })
          .catch(() => {});
        await shot(
          "top",
          "hub: one way in (room name or link), Live now, demo lectures; first screen says what this is",
        );
        await shot(
          "full",
          "hub full page: every section reachable, demo cards with live state and credit",
          { fullPage: true },
        );
      });
    },
  },
  {
    id: "create",
    title: "Create talk and join errors (J5)",
    relay: false,
    async run(j) {
      const { page, go, shot, step } = j;
      await go("/");
      const form = page.getByRole("form", { name: "Create talk" });
      await step("form", async () => {
        await form.scrollIntoViewIfNeeded();
        await sleep(300);
        await shot(
          "form",
          "create talk: title, speaker, room name and access code, one primary button",
        );
      });
      await step("errors empty", async () => {
        await form.getByRole("button", { name: "Create talk" }).click();
        await sleep(400);
        await shot(
          "errors-empty",
          "create talk + errors: each empty field says what it needs, at the field",
        );
      });
      await step("errors bad room", async () => {
        await form.getByLabel("Talk title").fill("QA harness check");
        await form.getByLabel("Speaker").fill("QA");
        await form.getByLabel("Room name").fill("x!");
        await form.getByRole("button", { name: "Create talk" }).click();
        await sleep(400);
        await shot(
          "errors-room",
          "create talk + errors: a bad room name and a missing code are refused before any request",
        );
      });
      await step("join error", async () => {
        await page.evaluate(() => window.scrollTo(0, 0));
        const join = page.getByRole("form", { name: "Join a room" });
        await join.getByLabel("Room name or link").fill("!");
        await join.getByRole("button", { name: "Join" }).click();
        await sleep(400);
        await shot(
          "join-error",
          "join + error: a bad room name says what a room name looks like",
        );
      });
      await step("speaker link error", async () => {
        const paste = page.getByRole("form", { name: "Open a speaker link" });
        await paste.getByLabel("Paste your speaker link").fill("not a link");
        await paste.getByRole("button", { name: "Open speaker link" }).click();
        await sleep(400);
        await paste.scrollIntoViewIfNeeded();
        await shot(
          "speaker-link-error",
          "paste speaker link + error: says what a speaker link looks like",
        );
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
    id: "demo",
    title: "Offline demo at /demo",
    relay: false,
    async run(j) {
      const { go, shot, step } = j;
      await go("/demo");
      await walkPlayer(j, { live: false });
      for (const state of [
        "connecting",
        "not-started",
        "paused",
        "ended",
        "reconnecting",
        "failed",
      ]) {
        await step(`state ${state}`, async () => {
          await go(`/demo?state=${state}`);
          await sleep(2_500);
          await shot(
            `state-${state}`,
            `demo + forced state ${state}: the time display and canvas say it in words (ui-design §5)`,
          );
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
        await shot(
          "not-started",
          "watch + unknown room: says nobody is on air here yet, without an error",
        );
      });
      await step("invalid name", async () => {
        await go("/watch/Not_A_Room!!");
        await sleep(800);
        await shot(
          "invalid-name",
          "watch + invalid name: says it is not a room name and links back to the hub",
        );
      });
      await step("not found", async () => {
        await go("/no/such/page");
        await sleep(800);
        await shot(
          "not-found",
          "not found: friendly, one link back to the hub",
        );
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
        await shot(
          "preflight",
          "console pre-flight: mic level, camera, token check explains the missing token; Go on air is the one primary action",
        );
        await shot("preflight-full", "console pre-flight full page", {
          fullPage: true,
        });
      });
      await step("camera on", async () => {
        const cam = page
          .getByRole("switch", { name: /Camera/ })
          .or(page.getByRole("checkbox", { name: /Camera/ }));
        if ((await cam.count()) === 0)
          throw new Error("skipped: no camera switch found");
        if (!(await cam.first().isChecked())) await cam.first().click();
        await sleep(3_000);
        await shot(
          "preflight-camera",
          "console pre-flight + camera: the self-view shows the (fake) camera",
        );
      });
      await step("microphone on", async () => {
        const mic = page
          .getByRole("switch", { name: /Microphone/ })
          .or(page.getByRole("checkbox", { name: /Microphone/ }));
        if ((await mic.count()) === 0)
          throw new Error("skipped: no microphone switch found");
        if (!(await mic.first().isChecked())) await mic.first().click();
        await sleep(2_500);
        await shot(
          "preflight-mic",
          "console pre-flight + microphone: the level meter moves with the (fake) input; nothing is sent before Go on air",
        );
      });
    },
  },
];
