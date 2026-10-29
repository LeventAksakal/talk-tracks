import { useState } from "react";
import { useResource } from "../useResource";
import { FakeTransport } from "../transport/fake";
import { Viewer } from "../viewer/Viewer";
import { createDemoPlayback } from "./usePlayback";

const ROOM = "rewind-demo";

/** The viewer on an offline room with sliced tracks and history: try seek and Go live with no relay. */
export function RewindDemo() {
  const [transport] = useState(() => new FakeTransport());
  const playback = useResource(() => createDemoPlayback(ROOM), []);
  return (
    <>
      <p className="demo-note" role="note">
        Offline rewind demo: a scripted talk has been on for three minutes. Its agents publish 4 s slices and serve
        history; there is no sound. Turn tracks on, then drag the position back or press Go live.
      </p>
      {playback ? <Viewer transport={transport} room={ROOM} title="Rewind demo" playback={playback} /> : null}
    </>
  );
}
