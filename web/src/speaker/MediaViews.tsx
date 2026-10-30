import { useEffect, useRef, useState } from "react";

/** The microphone's level, 0..1, about 15 times a second (pre-flight: "say something"). */
export function useLevel(track: MediaStreamTrack | undefined): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!track || typeof AudioContext === "undefined") return;
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let frame = 0;
    let last = 0;
    const loop = (t: number) => {
      frame = requestAnimationFrame(loop);
      if (t - last < 66) return;
      last = t;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      // Speech sits around −30 dBFS RMS: map −60..0 dB onto the bar.
      const db = 10 * Math.log10(sum / buf.length + 1e-12);
      setLevel(Math.min(1, Math.max(0, (db + 60) / 60)));
    };
    frame = requestAnimationFrame(loop);
    void ctx.resume().catch(() => undefined);
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void ctx.close();
      setLevel(0);
    };
  }, [track]);
  return level;
}

export function LevelMeter({ level, label }: { level: number; label: string }) {
  const bars = 12;
  const lit = Math.round(level * bars);
  return (
    <div
      className="level"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
    >
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} className={i < lit ? (i >= bars - 2 ? "bar hot" : "bar on") : "bar"} />
      ))}
    </div>
  );
}

/** The camera as the speaker sees themself (mirrored, like a mirror; viewers see it unmirrored). */
export function SelfView({ track, className }: { track: MediaStreamTrack | undefined; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.srcObject = track ? new MediaStream([track]) : null;
    if (track) void v.play().catch(() => undefined);
  }, [track]);
  if (!track) return null;
  return <video ref={video} className={className ?? "self-view"} muted playsInline autoPlay aria-label="Your camera" />;
}
