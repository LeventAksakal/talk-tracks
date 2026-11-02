import { useEffect, useRef, useState } from "react";
import { usePlayer } from "./context";
import { SourceTile } from "./SourceTile";

/** A canvas @moq/watch has not sized yet keeps the HTML default 300 × 150. */
const unsized = (w: number, h: number) => (w === 300 && h === 150) || w === 0 || h === 0;

/**
 * The speaker's shared screen: the live `<canvas>` its own @moq/watch player paints and the archive `<video>` of
 * screen.m3u8, both handed to ScreenMedia, one visible per mode. Silent: the speaker's sound, a shared tab's mixed in,
 * plays from the camera.
 */
export function ScreenSurface() {
  const { screen, view } = usePlayer();
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const live = view.timeline.mode === "live";
  const [aspect, setAspect] = useState<number>();

  useEffect(() => {
    if (!screen || !canvas.current || !video.current) return;
    screen.attach({ canvas: canvas.current, video: video.current });
    return () => screen.attach(undefined);
  }, [screen]);

  useEffect(() => {
    const read = () => {
      const c = canvas.current;
      const v = video.current;
      const next = live
        ? c && !unsized(c.width, c.height)
          ? c.width / c.height
          : undefined
        : v && v.videoWidth > 0 && v.videoHeight > 0
          ? v.videoWidth / v.videoHeight
          : undefined;
      setAspect((a) => (a === next ? a : next));
    };
    read();
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, [live]);

  return (
    <SourceTile kind="screen" aspect={aspect ?? 16 / 9} label="Shared screen">
      <canvas ref={canvas} className={live ? "tt-media" : "tt-media tt-hidden"} aria-label="Shared screen, live" />
      <video
        ref={video}
        className={live ? "tt-media tt-hidden" : "tt-media"}
        aria-label="Shared screen, rewound"
        playsInline
        muted
      />
      {aspect === undefined ? (
        <div className="tt-camera-empty">
          <span className="tt-camera-note">Loading the shared screen…</span>
        </div>
      ) : null}
      <span className="tt-source-tag">Screen</span>
    </SourceTile>
  );
}
