import { useEffect, useRef, useState } from "react";
import { usePlayer } from "./context";
import { SourceTile } from "./SourceTile";

/** A canvas @moq/watch has not sized yet keeps the HTML default 300 × 150. */
const unsized = (w: number, h: number) => (w === 300 && h === 150) || w === 0 || h === 0;

/**
 * The speaker's camera: the live `<canvas>` @moq/watch paints and the archive `<video>`, both handed to
 * RoomMedia once and never re-mounted (the live player keeps the canvas it was given), one visible per
 * mode. Volume applies to the archive element here; live audio is @moq/watch's own.
 */
export function CameraSurface() {
  const { media, view, prefs } = usePlayer();
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const live = view.timeline.mode === "live";
  const [aspect, setAspect] = useState<number>();

  useEffect(() => {
    if (!media || !canvas.current || !video.current) return;
    media.attach({ canvas: canvas.current, video: video.current });
    return () => media.attach(undefined);
  }, [media]);

  // The archive element's volume follows the control bar, also after RoomMedia opens a new recording.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const apply = () => {
      v.volume = prefs.volume;
      v.muted = prefs.muted;
    };
    apply();
    v.addEventListener("playing", apply);
    return () => v.removeEventListener("playing", apply);
  }, [prefs.volume, prefs.muted]);

  // The picture's own shape: the canvas backing size (the decoded size) or the video's. Sizes change
  // rarely, so a slow poll is enough and keeps React out of the frame loop.
  useEffect(() => {
    if (!media) return;
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
  }, [media, live]);

  if (!media)
    return (
      <SourceTile kind="camera" aspect={16 / 9} label="Speaker camera">
        <div className="tt-camera-empty">
          <span className="tt-source-tag">Camera</span>
          <span className="tt-camera-note">No camera in this room</span>
        </div>
      </SourceTile>
    );

  return (
    <SourceTile kind="camera" aspect={aspect ?? 16 / 9} label="Speaker camera">
      <canvas ref={canvas} className={live ? "tt-media" : "tt-media tt-hidden"} aria-label="Speaker video, live" />
      <video
        ref={video}
        className={live ? "tt-media tt-hidden" : "tt-media"}
        aria-label="Speaker video, rewound"
        playsInline
      />
      {aspect === undefined ? (
        <div className="tt-camera-empty">
          <span className="tt-camera-note">{live ? "Speaker audio, no picture yet" : "Audio only here"}</span>
        </div>
      ) : null}
      <span className="tt-source-tag">Camera</span>
    </SourceTile>
  );
}
