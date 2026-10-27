import { Button } from "@astryxdesign/core";
import { useEffect, useRef, useState } from "react";
import { teacherPath } from "../contracts/names";
import type { MoqTransport } from "../transport/moq";

type Status = "offline" | "loading" | "live";

/**
 * The speaker's audio (and video, when the broadcast has it) through @moq/watch. Nothing plays
 * until the viewer taps Play: phones only start an AudioContext from a user gesture, and the
 * library resumes it on that gesture.
 */
export function TeacherMedia({ transport, room, live }: { transport: MoqTransport; room: string; live: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState<Status>("offline");
  const [hasVideo, setHasVideo] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!playing) return;
    let disposed = false;
    const cleanup: (() => void)[] = [];
    import("@moq/watch")
      .then((Watch) => {
        if (disposed || !canvasRef.current) return;
        const player = new Watch.Player({
          origin: transport.origin,
          name: Watch.Net.Path.from(teacherPath(room)),
          canvas: canvasRef.current,
          catalogFormat: "hang",
          muted: false,
          // ~500 ms behind the live edge: audio groups older than that are skipped, not queued.
          delay: Watch.Net.Time.Milli(500),
        });
        cleanup.push(() => player.close());
        cleanup.push(player.broadcast.out.status.subscribe((s) => setStatus(s)));
        cleanup.push(
          player.broadcast.out.catalog.subscribe((c) =>
            setHasVideo(Object.keys(c?.video?.renditions ?? {}).length > 0),
          ),
        );
      })
      .catch((e: unknown) => setError(String(e)));
    return () => {
      disposed = true;
      for (const fn of cleanup) fn();
      setStatus("offline");
      setHasVideo(false);
    };
  }, [playing, transport, room]);

  return (
    <section className="panel media" aria-labelledby="media-heading">
      <div className="panel-head">
        <h2 id="media-heading" className="panel-title">
          Speaker
        </h2>
        <span className="muted">{live ? (playing ? statusText(status) : "on air") : "not on air"}</span>
      </div>
      <canvas
        ref={canvasRef}
        className={hasVideo ? "media-canvas" : "media-canvas hidden"}
        aria-label="Speaker video"
      />
      <Button
        label={playing ? "Stop audio" : "Play speaker audio"}
        variant={playing ? "secondary" : "primary"}
        onClick={() => setPlaying((p) => !p)}
      />
      {error ? <p role="alert">Could not start playback: {error}</p> : null}
    </section>
  );
}

function statusText(status: Status): string {
  return status === "live" ? "playing" : status === "loading" ? "connecting…" : "waiting for the speaker";
}
