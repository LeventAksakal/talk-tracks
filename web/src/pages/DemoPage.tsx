import { useState } from "react";
import { createDemoPlayback } from "../playback/usePlayback";
import { FakeTransport } from "../transport/fake";
import { useResource } from "../useResource";
import { Viewer } from "../viewer/Viewer";

export const DEMO_ROOM = "demo";

/** The viewer on a scripted room: works offline, with no relay and no agents. */
export function DemoPage() {
  const [transport] = useState(() => new FakeTransport());
  const playback = useResource(() => createDemoPlayback(DEMO_ROOM, 0, { arabic: true }), []);
  return (
    <>
      <p className="demo-note" role="note">
        Offline demo: a scripted talk replayed in this tab, its agents publishing 4 s slices the way real ones do. Turn
        tracks on to follow it; drag the position back to rewind.
      </p>
      {playback ? (
        <Viewer transport={transport} room={DEMO_ROOM} title="Demo: how rivers shape the land" playback={playback} />
      ) : null}
    </>
  );
}
