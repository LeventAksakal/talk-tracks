import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_TRACK, chatPath } from "../contracts/names";
import type { ChatRecord } from "../contracts/types";
import { FakeHistorySource } from "../playback/fakeSource";
import { Audience } from "./Audience";

const ROOM = "talk1";
const PATH = chatPath(ROOM);
const json = (records: ChatRecord[]) => new TextEncoder().encode(JSON.stringify(records));
const msg = (m: number, id: string, name: string, text: string): ChatRecord => ({
  m,
  data: { kind: "message", id, by: { id: `u-${name.toLowerCase()}`, name }, text },
});

describe("the console's audience area", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the room's chat read-only, subscribed only while the chat is open", async () => {
    const source = new FakeHistorySource();
    source.announce(PATH);
    source.publish(PATH, CHAT_TRACK, 7, json([msg(9_000, "m1", "Ada", "Hello from Lisbon")]));
    render(<Audience catalog={undefined} now={0} chat={{ source, room: ROOM, talkClock: String }} />);
    expect(source.subscriberCount(PATH, CHAT_TRACK)).toBe(0); // closed: not subscribed

    const toggle = screen.getByRole("button", { name: /chat/i });
    fireEvent.click(toggle);
    expect(source.subscriberCount(PATH, CHAT_TRACK)).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const area = screen.getByRole("region", { name: "Chat" });
    act(() => source.publish(PATH, CHAT_TRACK, 7, json([msg(12_000, "m2", "Grace", "Merhaba!")])));
    const list = within(area).getByRole("list", { name: "Chat messages" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(area).queryByRole("textbox")).toBeNull(); // the speaker reads; listeners write

    fireEvent.click(screen.getByRole("button", { name: /chat/i }));
    expect(source.subscriberCount(PATH, CHAT_TRACK)).toBe(0);
  });
});
