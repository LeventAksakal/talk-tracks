// A plain control to exercise playback: the speaker media, a scrubber over the room's media time, and
// Go live. It is a test bench for the playback layer; the UI lane designs the real one.

import { Badge, Button } from "@astryxdesign/core";
import { useEffect, useRef, useState } from "react";
import "./playback.css";
import { RoomMedia } from "./media";
import type { Playback, PlaybackView } from "./playback";
import type { Range } from "./slices";
import { formatClock, type Missed } from "./timeline";

export function PlaybackBar({ playback, view }: { playback: Playback; view: PlaybackView }) {
  const { timeline } = view;
  const media = playback.media instanceof RoomMedia ? playback.media : undefined;
  const live = timeline.mode === "live";
  const end = timeline.liveEdge ?? timeline.position ?? 0;
  const start = Math.min(timeline.start, end);
  const [scrub, setScrub] = useState<number>();
  const commit = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(commit.current), []);
  const shown = scrub ?? (live ? end : (timeline.position ?? end));

  const onScrub = (ms: number) => {
    setScrub(ms);
    clearTimeout(commit.current);
    commit.current = setTimeout(() => {
      setScrub(undefined);
      playback.seek(ms);
    }, 250);
  };

  return (
    <section className="panel playback" aria-labelledby="playback-heading">
      <div className="panel-head">
        <h2 id="playback-heading" className="panel-title">
          Speaker
        </h2>
        {live ? (
          <Badge variant="error" label="● Live" />
        ) : (
          <Badge variant="neutral" label={`${formatClock(timeline.behindMs)} behind live`} />
        )}
      </div>
      {media ? <MediaView media={media} live={live} status={timeline.mediaStatus} /> : null}
      <div className="playback-scrubber">
        <input
          type="range"
          aria-label="Position in the talk"
          aria-valuetext={formatClock(shown)}
          min={start}
          max={Math.max(end, start + 1)}
          step={1000}
          value={shown}
          disabled={timeline.liveEdge === undefined}
          onChange={(e) => onScrub(Number(e.target.value))}
        />
        <Ranges start={start} end={end} ranges={timeline.available} className="available" />
        <Ranges start={start} end={end} ranges={timeline.held} className="held" />
        <div className="playback-times muted">
          <span>{formatClock(shown)}</span>
          <span>{timeline.liveEdge === undefined ? "waiting for the talk" : formatClock(end)}</span>
        </div>
      </div>
      <div className="playback-buttons">
        <Button label="Back 15 s" size="sm" variant="secondary" onClick={() => playback.seekBy(-15_000)} />
        <Button
          label="Forward 15 s"
          size="sm"
          variant="secondary"
          isDisabled={live}
          onClick={() => playback.seekBy(15_000)}
        />
        <Button label="Go live" size="sm" variant="primary" isDisabled={live} onClick={() => playback.goLive()} />
      </div>
      {timeline.mediaStatus === "no-media" ? (
        <p className="muted">This room has no archived audio or video: the tracks rewind on their own.</p>
      ) : null}
      {view.missed ? <MissedView missed={view.missed} playback={playback} /> : null}
    </section>
  );
}

function MediaView({ media, live, status }: { media: RoomMedia; live: boolean; status: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (canvas.current && video.current) media.attach({ canvas: canvas.current, video: video.current });
    return () => media.attach(undefined);
  }, [media]);
  return (
    <>
      <canvas ref={canvas} className={live ? "media-canvas" : "media-canvas hidden"} aria-label="Speaker video, live" />
      <video
        ref={video}
        className={live ? "media-canvas hidden" : "media-canvas"}
        aria-label="Speaker video, rewound"
        playsInline
      />
      <Button
        label={on ? "Stop audio" : "Play speaker audio"}
        variant={on ? "secondary" : "primary"}
        onClick={() => {
          if (on) media.stop();
          else media.play();
          setOn(!on);
        }}
      />
      <span className="muted">{statusText(status, on)}</span>
    </>
  );
}

function statusText(status: string, on: boolean): string {
  if (!on && status !== "no-media") return "audio off";
  return status === "playing"
    ? "playing"
    : status === "loading"
      ? "connecting…"
      : status === "no-media"
        ? ""
        : "waiting";
}

function Ranges({ start, end, ranges, className }: { start: number; end: number; ranges: Range[]; className: string }) {
  const span = Math.max(1, end - start);
  return (
    <div className={`playback-ranges ${className}`} aria-hidden="true">
      {ranges.map((r) => {
        const left = Math.max(0, (r.start - start) / span);
        const right = Math.min(1, (r.end - start) / span);
        if (right <= left) return null;
        return <span key={r.start} style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }} />;
      })}
    </div>
  );
}

function MissedView({ missed, playback }: { missed: Missed; playback: Playback }) {
  return (
    <div className="playback-missed" role="status">
      <h3 className="sub-title">
        What you missed ({formatClock(missed.fromMs)}–{formatClock(missed.toMs)})
      </h3>
      {!missed.outlineOn ? (
        <p className="muted">This room has no chapters track to show what was covered.</p>
      ) : missed.chapters.length === 0 ? (
        <p className="muted">No new chapter started.</p>
      ) : (
        <ol className="chapter-list">
          {missed.chapters.map((c) => (
            <li key={c.id}>
              <span className="chapter-time">{formatClock(c.start_ms)}</span> <strong>{c.title}</strong>
              <p>{c.summary}</p>
            </li>
          ))}
        </ol>
      )}
      {missed.transcript ? (
        <div className="playback-transcript">
          {missed.transcript.length === 0 ? <p className="muted">Nothing was said.</p> : null}
          {missed.transcript.map((l) => (
            <p key={l.id} className="line">
              <span className="chapter-time">{formatClock(l.startMs)}</span> {l.text}
            </p>
          ))}
        </div>
      ) : null}
      <div className="playback-buttons">
        {missed.transcript ? null : (
          <Button
            label={missed.transcriptLoading ? "Loading…" : "Show what was said"}
            size="sm"
            variant="secondary"
            isDisabled={missed.transcriptLoading}
            onClick={() => void playback.loadMissedTranscript()}
          />
        )}
        <Button label="Dismiss" size="sm" variant="ghost" onClick={() => playback.dismissMissed()} />
      </div>
    </div>
  );
}
