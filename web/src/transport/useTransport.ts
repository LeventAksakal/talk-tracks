import { useState } from "react";
import { RELAY_URL } from "../config";
import { useResource } from "../useResource";
import { FakeTransport } from "./fake";
import { MoqTransport, relayUrl } from "./moq";

/** A MoqTransport for the component's lifetime; a token (decision 0005) is needed to publish only. */
export function useMoqTransport(token?: string): MoqTransport | undefined {
  return useResource(() => new MoqTransport({ url: relayUrl(RELAY_URL, token) }), [token]);
}

/** A FakeTransport for the component's lifetime, handed to `start` once (e.g. to play a script). */
export function useFakeTransport(start: (t: FakeTransport) => () => void): FakeTransport | undefined {
  const [run] = useState(() => start);
  return useResource(() => {
    const t = new FakeTransport();
    t.onClose(run(t));
    return t;
  }, [run]);
}
