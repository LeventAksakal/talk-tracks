import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRoomService } from "../annotate/fake";
import { CHAT_TRACK, chatPath } from "../contracts/names";
import type { ChatRecord } from "../contracts/types";
import { FakeHistorySource } from "../playback/fakeSource";
import { Chat, type ChatProps } from "./Chat";
import { randomName } from "./chatFeed";

const ROOM = "talk1";
const PATH = chatPath(ROOM);
const json = (records: ChatRecord[]) => new TextEncoder().encode(JSON.stringify(records));
const msg = (m: number, id: string, name: string, text: string): ChatRecord => ({
  m,
  data: { kind: "message", id, by: { id: `u-${name.toLowerCase()}`, name }, text },
});

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const texts = () =>
  within(screen.getByRole("list", { name: "Chat messages" }))
    .queryAllByRole("listitem")
    .map((li) => li.querySelector(".tt-chat-text")?.textContent);

function setup(props: Partial<ChatProps> = {}) {
  const source = new FakeHistorySource();
  source.announce(PATH);
  const service = new FakeRoomService({ now: 30_000 });
  const base: ChatProps = {
    source,
    room: ROOM,
    service,
    rewound: false,
    at: undefined,
    talkClock: (ms) => `${Math.floor(ms / 1000)}s`,
  };
  const view = render(<Chat {...base} {...props} />);
  return { source, service, view, rerender: (p: Partial<ChatProps>) => view.rerender(<Chat {...base} {...p} />) };
}

describe("the chat drawer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes while open, shows the conversation so far and every new message, and unsubscribes when closed", async () => {
    const before = new FakeHistorySource();
    before.announce(PATH);
    // The room service's current slice: its carry-in (the last messages), then one new message.
    before.publish(PATH, CHAT_TRACK, 7, json([msg(9_000, "m1", "Ada", "Hello from Lisbon")]));
    before.publish(PATH, CHAT_TRACK, 7, json([msg(28_100, "m2", "Grace", "Merhaba!")]));
    const service = new FakeRoomService({ now: 30_000 });
    const props: ChatProps = { source: before, room: ROOM, service, rewound: false, at: undefined, talkClock: String };
    const view = render(<Chat {...props} />);
    expect(before.subscriberCount(PATH, CHAT_TRACK)).toBe(1);
    expect(screen.getByRole("status").textContent).toMatch(/Loading/);
    await advance(10);
    expect(texts()).toEqual(["Hello from Lisbon", "Merhaba!"]);

    act(() =>
      before.publish(
        PATH,
        CHAT_TRACK,
        8,
        json([msg(9_000, "m1", "Ada", "Hello from Lisbon"), msg(28_100, "m2", "Grace", "Merhaba!")]),
      ),
    );
    act(() => before.publish(PATH, CHAT_TRACK, 8, json([msg(32_500, "m3", "Alan", "Rewind to 0:09")])));
    expect(texts()).toEqual(["Hello from Lisbon", "Merhaba!", "Rewind to 0:09"]); // the carry-in repeats nothing

    view.unmount();
    expect(before.subscriberCount(PATH, CHAT_TRACK)).toBe(0);
  });

  it("starts from now when nobody has said anything yet", async () => {
    setup();
    await advance(2_000);
    expect(texts()).toEqual([]);
    expect(screen.getByRole("status").textContent).toMatch(/Starting from now/);
  });

  it("gives a listener a random name, sends what they type, and lets them change the name", async () => {
    const { service } = setup();
    await advance(10);
    const me = service.me()?.name;
    expect(me).toBeTruthy();

    const box = screen.getByRole("textbox", { name: "Chat message" });
    fireEvent.change(box, { target: { value: "  Is the deck shared?  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await advance(10);
    expect(service.writes).toEqual([{ track: "chat", data: { text: "Is the deck shared?" } }]);
    expect((box as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Change name" }));
    const name = screen.getByRole("textbox", { name: /Your name/ });
    fireEvent.change(name, { target: { value: "Ada" } });
    fireEvent.submit(name.closest("form")!);
    expect(service.me()?.name).toBe("Ada");
  });

  it("rewound, shows the chat as it was at the playhead, fetched from the archive", async () => {
    const { source, rerender } = setup();
    // An archived slice: its carry-in, then two messages, one before and one after the playhead.
    source.store(PATH, CHAT_TRACK, 3, [
      json([msg(9_000, "m1", "Ada", "Hello from Lisbon")]),
      json([msg(12_400, "m2", "Grace", "Merhaba!")]),
      json([msg(15_100, "m3", "Alan", "Later")]),
    ]);
    rerender({ rewound: true, at: 13_000 });
    expect(screen.getByRole("status").textContent).toMatch(/Loading/);
    await advance(10);
    expect(source.fetchedGroups(PATH, CHAT_TRACK)).toEqual([3]);
    expect(texts()).toEqual(["Hello from Lisbon", "Merhaba!"]);
    rerender({ rewound: true, at: 15_500 });
    expect(texts()).toEqual(["Hello from Lisbon", "Merhaba!", "Later"]); // the same group: no new FETCH
    expect(source.fetchedGroups(PATH, CHAT_TRACK)).toEqual([3]);

    rerender({ rewound: true, at: 40_000 }); // a stretch nobody published
    await advance(10);
    expect(texts()).toEqual([]);
    expect(screen.getByRole("status").textContent).toMatch(/Nothing said/);
  });

  it("names a listener with two words", () => {
    expect(randomName(() => 0)).toMatch(/^\S+ \S+$/);
    expect(randomName(() => 0.999)).toMatch(/^\S+ \S+$/);
  });
});
