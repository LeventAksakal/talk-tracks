import { describe, expect, it } from "vitest";
import { envelope } from "../test/envelopes";
import { newestInstance, parseAgentPath, SnapshotFilter } from "./follow";

describe("newestInstance", () => {
  it("picks the largest numeric instance and ignores names that are not numbers", () => {
    expect(newestInstance(["1000", "999", "2000", "latest"])).toBe("2000");
    expect(newestInstance(["abc"])).toBeUndefined();
    expect(newestInstance([])).toBeUndefined();
  });

  it("compares numerically, not as text", () => {
    expect(newestInstance(["9", "10"])).toBe("10");
  });
});

describe("parseAgentPath", () => {
  it("splits agent and instance", () => {
    expect(parseAgentPath("captions/1700")).toEqual({ agent: "captions", instance: "1700" });
    expect(parseAgentPath("captions")).toBeNull();
    expect(parseAgentPath("captions/1700/extra")).toBeNull();
    expect(parseAgentPath("")).toBeNull();
  });
});

describe("SnapshotFilter", () => {
  it("lets each state change through once and flags heartbeats", () => {
    const f = new SnapshotFilter();
    expect(f.accept(envelope({ seq: 0 }), "1000")).toBe("new");
    expect(f.accept(envelope({ seq: 0 }), "1000")).toBe("heartbeat");
    expect(f.accept(envelope({ seq: 1 }), "1000")).toBe("new");
    expect(f.accept(envelope({ seq: 0 }), "1000")).toBe("other");
  });

  it("ignores other instances and starts over for a new one", () => {
    const f = new SnapshotFilter();
    expect(f.accept(envelope({ seq: 5 }), "1000")).toBe("new");
    expect(f.accept(envelope({ instance: "900", seq: 9 }), "1000")).toBe("other");
    expect(f.accept(envelope({ instance: "2000", seq: 0 }), "2000")).toBe("new");
  });
});
