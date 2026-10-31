import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchRoute } from "../router";
import { FakeTransport } from "../transport/fake";
import { createRoom, speakerPathFrom } from "./createRoom";
import { DEMO_ROOMS } from "./demoRooms";
import { LandingPage } from "./LandingPage";

const CREATED = {
  room: "quantum-101",
  speaker_path: "/talk/quantum-101?token=t0k",
  watch_path: "/watch/quantum-101",
  cap_usd: 2,
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The lobby with a relay in memory (no badges unless it is connected) and a fetch stand-in for POST /api/rooms. */
function setup(answer: (body: unknown) => Response | Promise<Response>) {
  const transport = new FakeTransport();
  transport.setStatus("connecting");
  const sent: { url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body));
    sent.push({ url: String(url), body });
    return answer(body);
  });
  render(<LandingPage transport={transport} create={(r) => createRoom(r, fetchImpl as typeof fetch)} />);
  return { transport, sent };
}

const field = (name: string | RegExp) => screen.getByLabelText(name, { selector: "input" });
const type = (name: string | RegExp, value: string) => fireEvent.change(field(name), { target: { value } });
const createForm = () => screen.getByRole("form", { name: "Create talk" });

describe("the lobby", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("lists the four demo lectures, each opening its room, with its live state once the relay answers", () => {
    const { transport } = setup(() => jsonResponse(500, {}));
    const cards = screen.getAllByRole("listitem").filter((li) => li.classList.contains("lobby-card"));
    expect(cards).toHaveLength(4);
    for (const demo of DEMO_ROOMS) {
      const link = screen.getByRole("link", { name: demo.title });
      expect(matchRoute(new URL(link.getAttribute("href")!, "http://x").pathname)).toEqual({
        page: "watch",
        room: demo.room,
      });
    }
    // No badge while the relay has not answered.
    expect(document.querySelector("[data-live]")).toBeNull();

    act(() => {
      transport.announce("talk/dataviz/teacher");
      transport.setStatus("connected");
    });
    const live = Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("[data-live]")].map((el, i) => [DEMO_ROOMS[i]!.room, el.dataset.live]),
    );
    expect(live).toEqual({ virus: "false", dataviz: "true", rsa: "false", qrcode: "false" });
  });

  it("joins a room by name or by its audience link", () => {
    setup(() => jsonResponse(500, {}));
    const join = screen.getByRole("form", { name: "Join a room" });
    type("Room name or link", "Physics-101");
    fireEvent.submit(join);
    expect(location.pathname).toBe("/watch/physics-101");

    type("Room name or link", "https://example.org/watch/rsa");
    fireEvent.submit(join);
    expect(location.pathname).toBe("/watch/rsa");
  });

  it("creates a talk: the private speaker link, the audience link and QR, then into the console", async () => {
    const { sent } = setup(() => jsonResponse(201, CREATED));
    type("Talk title", "Quantum 101");
    type("Speaker", "Ada");
    type("Access code", "judge-code");
    // The room name follows the title until edited.
    expect((field("Room name") as HTMLInputElement).value).toBe("quantum-101");
    await act(async () => fireEvent.submit(createForm()));

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
    type("Talk title", "Quantum 101");
    type("Speaker", "Ada");
    type("Access code", "x");
    await act(async () => fireEvent.submit(createForm()));
    expect(field(at).getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByLabelText("Your speaker link")).toBeNull();
  });

  it("sends nothing for an incomplete form, and says so when rate limited", async () => {
    const { sent } = setup(() => jsonResponse(429, {}));
    await act(async () => fireEvent.submit(createForm()));
    expect(sent).toHaveLength(0);

    type("Talk title", "Quantum 101");
    type("Speaker", "Ada");
    type("Access code", "x");
    await act(async () => fireEvent.submit(createForm()));
    expect(sent).toHaveLength(1);
    expect(within(createForm()).getByRole("alert")).toBeTruthy();
  });

  it("opens a pasted speaker link in the console, and refuses anything else", () => {
    setup(() => jsonResponse(500, {}));
    const paste = screen.getByRole("form", { name: "Open a speaker link" });
    type("Paste your speaker link", "https://example.org/watch/rsa");
    fireEvent.submit(paste);
    expect(location.pathname).toBe("/");
    expect(field("Paste your speaker link").getAttribute("aria-invalid")).toBe("true");

    type("Paste your speaker link", "https://example.org/talk/quantum-101?token=abc");
    fireEvent.submit(paste);
    expect(location.pathname + location.search).toBe("/talk/quantum-101?token=abc");
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
