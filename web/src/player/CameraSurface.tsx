import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { RoomTt } from "../contracts/types";
import type { MediaStatus } from "../playback/media";
import { usePlayer } from "./context";
import { SourceTile } from "./SourceTile";

/** [x, y, w, h], fractions of the video frame. */
export type Rect = readonly [number, number, number, number];

/**
 * The webcam inset of a composed lecture video (a recorded conference talk: the slides as the main area, the speaker
 * as a small picture in a corner), from the room catalog's `tt.regions.camera` (agents' `find-regions`). Undefined
 * for a speaker's own camera, or a region that is not a non-empty box inside the frame.
 */
export function cameraRegion(tt: RoomTt | undefined): Rect | undefined {
  const regions = (tt as { regions?: { camera?: unknown } | null } | undefined)?.regions;
  const r = regions?.camera;
  if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => typeof v === "number" && Number.isFinite(v)))
    return undefined;
  const [x, y, w, h] = r as [number, number, number, number];
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001) return undefined;
  return [x, y, w, h];
}

/**
 * The camera tile for a video of frame aspect `frame` (width / height): with a region, the tile takes the region's
 * shape and the picture is scaled and shifted so exactly the region fills it (the tile clips the rest); without
 * one, the whole picture.
 */
export function framing(frame: number, region: Rect | undefined): { aspect: number; media?: CSSProperties } {
  if (!region) return { aspect: frame };
  const [x, y, w, h] = region;
  const pct = (v: number) => `${+(v * 100).toFixed(4)}%`;
  return {
    aspect: (frame * w) / h,
    media: { inset: "auto", left: pct(-x / w), top: pct(-y / h), width: pct(1 / w), height: pct(1 / h) },
  };
}

/** A canvas @moq/watch has not sized yet keeps the HTML default 300 × 150. */
const unsized = (w: number, h: number) => (w === 300 && h === 150) || w === 0 || h === 0;

/**
 * What the camera tile says while it has no picture. Live, the picture comes with the live player, which starts on
 * play (a browser plays sound only after a tap): before that there is nothing to say, the stage asks for the tap.
 * Only a live player that plays and has painted no frame has audio without a picture. Rewound or in a recording,
 * the archive's picture loads with its first segment: only archived media that plays without one is audio only.
 */
export function cameraNote(live: boolean, status: MediaStatus): string | undefined {
  if (!live) {
    if (status === "playing") return "Audio only here";
    if (status === "no-media") return "Nothing recorded here";
    return status === "loading" ? "Loading the picture…" : undefined;
  }
  if (status === "playing") return "Speaker audio, no picture yet";
  if (status === "loading") return "Loading the picture…";
  return undefined;
}

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
  const [region, setRegion] = useState<Rect>();
  const [status, setStatus] = useState<MediaStatus>("idle");

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
      const r = cameraRegion(media.catalog()?.tt);
      setRegion((old) => (old?.join() === r?.join() ? old : r));
      setStatus(media.status());
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

  const note = cameraNote(live, status);
  // A recorded talk's video is the whole stage frame: the tile shows only its webcam inset, once the frame is known.
  const framed = aspect === undefined ? undefined : framing(aspect, region);
  return (
    <SourceTile kind="camera" aspect={framed?.aspect ?? 16 / 9} label="Speaker camera">
      <canvas
        ref={canvas}
        className={live ? "tt-media" : "tt-media tt-hidden"}
        style={framed?.media}
        aria-label="Speaker video, live"
      />
      <video
        ref={video}
        className={live ? "tt-media tt-hidden" : "tt-media"}
        style={framed?.media}
        aria-label="Speaker video, rewound"
        playsInline
      />
      {aspect === undefined && (note !== undefined || !live) ? (
        <div className="tt-camera-empty">{note ? <span className="tt-camera-note">{note}</span> : null}</div>
      ) : null}
      <span className="tt-source-tag">Camera</span>
    </SourceTile>
  );
}
