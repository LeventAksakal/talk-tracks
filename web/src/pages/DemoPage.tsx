import { playDemo } from "../demo/script";
import { useFakeTransport } from "../transport/useTransport";
import { Viewer } from "../viewer/Viewer";

export const DEMO_ROOM = "demo";

/** The viewer on a scripted room: works offline, with no relay and no agents. */
export function DemoPage() {
  const transport = useFakeTransport((t) => playDemo(t, DEMO_ROOM));
  return (
    <>
      <p className="demo-note" role="note">
        Offline demo: a scripted talk replayed in this tab. Mid-talk the caption agent is replaced by a new instance,
        and the viewer follows it.
      </p>
      <Viewer transport={transport} room={DEMO_ROOM} title="Demo: how rivers shape the land" />
    </>
  );
}
