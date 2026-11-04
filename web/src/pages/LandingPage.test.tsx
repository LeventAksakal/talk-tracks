import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import languageList from "../../../contracts/languages.json";
import { FakeTransport } from "../transport/fake";
import { type CommunityRoom, parseCommunityRooms } from "./communityRooms";
import { createRoom, speakerPathFrom } from "./createRoom";
import { DEMO_ROOMS } from "./demoRooms";
import { LandingPage } from "./LandingPage";
import { COALESCE_MS, watchRelayRooms } from "./liveRooms";
import { parseRooms, type Recording } from "./recordings";
import { rememberRoom } from "./recentRooms";

const preloadWatch = vi.hoisted(() => vi.fn());
vi.mock("../routes", () => ({ preloadWatch }));

const CREATED = {
  room: "quantum-101",
  speaker_path: "/talk/quantum-101?token=t0k",
  watch_path: "/watch/quantum-101",
  cap_usd: 2,
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const RECORDINGS: Recording[] = [
  { room: "dataviz-recording", of: "dataviz" },
  { room: "virus-recording", of: "virus" },
];

/** The hub with a relay in memory (no badges until it is connected), the archive's recordings, and POST /api/rooms. */
function setup(
  answer: (body: unknown) => Response | Promise<Response> = () => jsonResponse(500, {}),
  recordings: Recording[] = [],
  rooms: CommunityRoom[] = [],
) {
  const transport = new FakeTransport();
  transport.setStatus("connecting");
  const sent: { url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body));
    sent.push({ url: String(url), body });
    return answer(body);
  });
  render(
    <LandingPage
      transport={transport}
      create={(r) => createRoom(r, fetchImpl as typeof fetch)}
      recordings={async () => recordings}
      rooms={async () => rooms}
    />,
  );
  return { transport, sent };
}

const field = (name: string | RegExp) => screen.getByLabelText(name, { selector: "input" });
const type = (name: string | RegExp, value: string) => fireEvent.change(field(name), { target: { value } });
const row = (name: string) => screen.getByRole("region", { name });
/** The card named by a talk's title, in a row. */
const card = (rowName: string, title: string) => within(row(rowName)).getByRole("article", { name: title });
/** A link named by its visible words, then the talk's title. */
const named = (label: string) => new RegExp(`^${label}\\s?: `);
const hrefs = (links: HTMLElement[]) => links.map((l) => l.getAttribute("href"));

/** Let the relay watch's coalesced update land. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, COALESCE_MS + 10)));

describe("the hub", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    localStorage.clear();
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    localStorage.clear();
  });

  it("features one demo lecture's live session and has the others in Live now, each once", async () => {
    const { transport } = setup();
    const [first, ...rest] = DEMO_ROOMS;
    const hero = row("Featured talk");
    expect(
      within(hero)
        .getByRole("link", { name: named("Watch live") })
        .getAttribute("href"),
    ).toBe(`/watch/${first!.room}`);
    expect(within(row("Live now")).queryByRole("article", { name: first!.title })).toBeNull();
    for (const demo of rest) {
      const play = within(card("Live now", demo.title)).getAllByRole("link", {
        name: new RegExp(escape(demo.title)),
      })[0]!;
      expect(play.getAttribute("href")).toBe(`/watch/${demo.room}`);
    }
    // On air once the relay says so, and not before.
    expect(within(hero).queryByText(/on air now/)).toBeNull();
    act(() => {
      transport.announce(`talk/${first!.room}/teacher`);
      transport.setStatus("connected");
    });
    await settle();
    expect(within(hero).getByText(/on air now/)).toBeTruthy();
  });

  it("puts the talks on air, apart from the demo lectures, first in Live now", async () => {
    const { transport } = setup();
    act(() => {
      transport.setStatus("connected");
      transport.announce("talk/physics-101/teacher");
      transport.announce("talk/physics-101/slides");
      transport.announce("talk/virus/teacher");
    });
    await settle();
    // Every live session says Watch live, a demo lecture's between its runs too (the hub never changes under the
    // reader): the talk on air comes first, then the demo lectures' sessions.
    const links = within(row("Live now")).getAllByRole("link", { name: named("Watch live") });
    expect(hrefs(links)[0]).toBe("/watch/physics-101");
    expect(hrefs(links).slice(1)).not.toContain("/watch/physics-101");
  });

  it("opens a card's extended view by keyboard: its play button, languages and tracks have names", () => {
    setup();
    const lecture = DEMO_ROOMS[2]!;
    const article = card("Live now", lecture.title);
    const play = within(article).getByRole("link", { name: new RegExp(`^(Watch|Open).*${escape(lecture.title)}`) });
    expect(play.getAttribute("tabindex")).toBeNull();
    play.focus();
    expect(document.activeElement).toBe(play);
    expect(within(article).getByText(lecture.description)).toBeTruthy();
    expect(within(article).getByText(lecture.speaker)).toBeTruthy();
    // The spoken language, and how many it can be subtitled in: every language in the contract, none pre-made.
    expect(within(article).getByText("English")).toBeTruthy();
    expect(article.textContent).toMatch(new RegExp(`\\b${languageList.languages.length}\\b`));
    expect(within(article).queryByText("Español")).toBeNull();
    expect(within(article).getByText(/Slide descriptions/)).toBeTruthy();
  });

  it("starts loading the watch page when a card is hovered or focused, before it is opened", () => {
    setup();
    preloadWatch.mockClear();
    fireEvent.mouseEnter(card("Live now", DEMO_ROOMS[1]!.title));
    fireEvent.focus(within(card("Live now", DEMO_ROOMS[2]!.title)).getAllByRole("link")[0]!);
    expect(preloadWatch).toHaveBeenCalledTimes(2);
  });

  it("lists the archive's recordings, and links each live session to its recording", async () => {
    setup(undefined, RECORDINGS);
    const recordings = await screen.findByRole("region", { name: "Recordings" });
    await waitFor(() =>
      expect(hrefs(within(recordings).getAllByRole("link", { name: named("Play") }))).toEqual([
        "/watch/virus-recording",
        "/watch/dataviz-recording",
      ]),
    );
    // A recording leads back to its live session, and a live session with a recording to it.
    expect(
      within(card("Recordings", DEMO_ROOMS[0]!.title))
        .getByRole("link", { name: named("Live replay") })
        .getAttribute("href"),
    ).toBe("/watch/virus");
    expect(
      within(row("Featured talk"))
        .getByRole("link", { name: named("From the start") })
        .getAttribute("href"),
    ).toBe("/watch/virus-recording");
    expect(
      within(card("Live now", DEMO_ROOMS[2]!.title)).queryByRole("link", { name: named("From the start") }),
    ).toBeNull();
  });

  it("lists the talks presenters gave: on air in Live now, recorded in Recordings, not yet started nowhere", async () => {
    const rooms = parseCommunityRooms({
      rooms: [
        { room: "quantum-101", title: "Intro to Quantum Cryptography", speaker: "Ada", state: "live", started: 100 },
        {
          room: "physics-101",
          title: "Waves",
          state: "ended",
          ended: 50,
          duration: 1800,
          recording: true,
          still: "/archive/physics-101/r1/slides/ab.jpg",
        },
        { room: "walk-in", title: "Ended, nothing kept", state: "ended", recording: false },
        { room: "rehearsal-1", title: "Not started", state: "upcoming", recording: false },
      ],
    });
    const { transport } = setup(undefined, RECORDINGS, rooms);
    act(() => {
      transport.setStatus("connected");
      transport.announce("talk/physics-101/teacher"); // ended with End talk, its broadcast on its way out
    });
    await settle();
    const live = await within(row("Live now")).findByRole("article", { name: "Intro to Quantum Cryptography" });
    expect(within(live).getByText("Ada")).toBeTruthy();
    expect(hrefs(within(row("Live now")).getAllByRole("link", { name: named("Watch live") }))[0]).toBe(
      "/watch/quantum-101",
    );
    const recorded = await within(row("Recordings")).findByRole("article", { name: "Waves" });
    expect(
      within(recorded)
        .getByRole("link", { name: named("Play") })
        .getAttribute("href"),
    ).toBe("/watch/physics-101");
    expect(within(recorded).getByText("30 min")).toBeTruthy();
    expect(within(row("Live now")).queryByRole("article", { name: "Waves" })).toBeNull();
    for (const title of ["Ended, nothing kept", "Not started"])
      expect(screen.queryByRole("article", { name: title })).toBeNull();
  });

  it("keeps the hub as it was when the room list cannot be read", async () => {
    expect(parseCommunityRooms({ error: "x" })).toEqual([]);
    expect(
      parseCommunityRooms({
        rooms: [
          { room: "Bad Name!", state: "live" },
          { room: "ok-room", state: "?" },
        ],
      }),
    ).toEqual([]);
    setup(undefined, RECORDINGS, []);
    await within(row("Recordings")).findAllByRole("link", { name: named("Play") });
    expect(within(row("Recordings")).getAllByRole("article")).toHaveLength(RECORDINGS.length);
  });

  it("has no Recordings row when the archive has none", async () => {
    setup(undefined, []);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Recordings" })).toBeNull());
  });

  it("offers the rooms this browser watched lately", async () => {
    rememberRoom({ room: "physics-101", at: 1 });
    rememberRoom({ room: "rsa", at: 2 });
    setup();
    const recent = row("Continue watching");
    // Once the archive has answered (it has no recordings here, so no From the start link).
    await waitFor(() =>
      expect(hrefs(within(recent).getAllByRole("link"))).toEqual(["/watch/rsa", "/watch/physics-101"]),
    );
  });

  it("joins a room by name, by its audience link, or opens a speaker link, from one box", () => {
    setup();
    const join = screen.getByRole("search", { name: "Join a room" });
    type("Room name or link", "Physics-101");
    fireEvent.submit(join);
    expect(location.pathname).toBe("/watch/physics-101");

    type("Room name or link", "https://example.org/watch/rsa");
    fireEvent.submit(join);
    expect(location.pathname).toBe("/watch/rsa");

    type("Room name or link", "https://example.org/talk/quantum-101?token=abc");
    fireEvent.submit(join);
    expect(location.pathname + location.search).toBe("/talk/quantum-101?token=abc");
  });

  it("says what a room name looks like when Join cannot read one", () => {
    setup();
    type("Room name or link", "!");
    fireEvent.submit(screen.getByRole("search", { name: "Join a room" }));
    expect(location.pathname).toBe("/");
    expect(field("Room name or link").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("Start a talk", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));
  afterEach(() => window.history.replaceState(null, "", "/"));

  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: "Start a talk" }));
    return screen.getByRole("form", { name: "Start a talk" });
  };

  it("is one action that opens a modal with focus inside, and closes again", () => {
    setup();
    expect(screen.queryByRole("form", { name: "Start a talk" })).toBeNull();
    const form = open();
    const dialog = form.closest("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("form", { name: "Start a talk" })).toBeNull();
  });

  it("creates a talk: the private speaker link, the audience link and QR, then into the console", async () => {
    const { sent } = setup(() => jsonResponse(201, CREATED));
    const form = open();
    type("Talk title", "Quantum 101");
    type("Speaker", "Ada");
    type("Access code", "judge-code");
    // The room name follows the title until edited.
    expect((field("Room name") as HTMLInputElement).value).toBe("quantum-101");
    await act(async () => fireEvent.submit(form));

    expect(sent).toEqual([
      { url: "/api/rooms", body: { code: "judge-code", room: "quantum-101", title: "Quantum 101", speaker: "Ada" } },
    ]);
    const speakerLink = screen.getByLabelText("Your speaker link") as HTMLInputElement;
    expect(new URL(speakerLink.value).pathname + new URL(speakerLink.value).search).toBe(CREATED.speaker_path);
    expect(screen.getByRole("img", { name: /QR code for .*\/watch\/quantum-101/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open console" }));
    expect(location.pathname + location.search).toBe(CREATED.speaker_path);
  });

  it.each([
    [409, "Room name"],
    [400, "Room name"],
    [403, "Access code"],
  ])("keeps the form and points at the field when the room service answers %i", async (status, at) => {
    setup(() => jsonResponse(status, { error: "no" }));
    const form = open();
    type("Talk title", "Quantum 101");
    type("Speaker", "Ada");
    type("Access code", "x");
    await act(async () => fireEvent.submit(form));
    expect(field(at).getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByLabelText("Your speaker link")).toBeNull();
  });

  it("sends nothing for an incomplete form and marks every empty field; says so when rate limited", async () => {
    const { sent } = setup(() => jsonResponse(429, {}));
    const form = open();
    await act(async () => fireEvent.submit(form));
    expect(sent).toHaveLength(0);
    for (const name of ["Talk title", "Speaker", "Room name", "Access code"])
      expect(field(name).getAttribute("aria-invalid")).toBe("true");

    type("Talk title", "Quantum 101");
    type("Speaker", "Ada");
    type("Access code", "x");
    await act(async () => fireEvent.submit(form));
    expect(sent).toHaveLength(1);
    expect(within(form).getByRole("alert")).toBeTruthy();
  });
});

describe("the relay watch", () => {
  it("turns a burst of announcements into one update, and keeps only speaker broadcasts", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.setStatus("connected");
      const seen: string[][] = [];
      const w = watchRelayRooms(transport, (r) => seen.push([...r.live].sort()));
      expect(seen).toEqual([[]]);
      for (let i = 0; i < 50; i++) {
        transport.announce(`talk/room-${i}/teacher`);
        transport.announce(`talk/room-${i}/slides`);
        transport.announce(`talk/room-${i}/agents/captions`);
      }
      expect(seen).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toHaveLength(50);
      w.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the archive's recordings", () => {
  it("are the rooms named <id>-recording", () => {
    expect(
      parseRooms({
        format: "talk-tracks-archive",
        v: 2,
        rooms: [
          { room: "gen-rsa", last_wall_ms: 3 },
          { room: "rsa-recording", last_wall_ms: 2 },
          { room: "live", last_wall_ms: 1 },
          { room: "-recording" },
          { room: "Bad Name-recording" },
        ],
      }),
    ).toEqual([{ room: "rsa-recording", of: "rsa", lastWallMs: 2 }]);
    expect(parseRooms(null)).toEqual([]);
    expect(parseRooms({ rooms: "x" })).toEqual([]);
  });
});

describe("the create-room contract", () => {
  it("maps the room service's answers", async () => {
    const answer = (status: number, body: unknown = {}) =>
      createRoom(CREATED_REQ, async () => jsonResponse(status, body));
    expect(await answer(201, CREATED)).toEqual({ ok: true, created: CREATED });
    expect(await answer(400)).toEqual({ ok: false, error: "slug" });
    expect(await answer(403)).toEqual({ ok: false, error: "code" });
    expect(await answer(409)).toEqual({ ok: false, error: "taken" });
    expect(await answer(429)).toEqual({ ok: false, error: "rate" });
    expect(await answer(502)).toEqual({ ok: false, error: "unreachable" });
    expect(
      await createRoom(CREATED_REQ, async () => {
        throw new TypeError("offline");
      }),
    ).toEqual({ ok: false, error: "unreachable" });
  });

  it("reads speaker links as paths", () => {
    expect(speakerPathFrom("/talk/abc?token=x")).toBe("/talk/abc?token=x");
    expect(speakerPathFrom("https://h.example/talk/abc?token=x&local=1")).toBe("/talk/abc?token=x&local=1");
    expect(speakerPathFrom("/talk/abc")).toBeNull();
    expect(speakerPathFrom("/watch/abc?token=x")).toBeNull();
  });
});

const CREATED_REQ = { code: "c", room: "quantum-101", title: "Quantum 101", speaker: "Ada" };

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
