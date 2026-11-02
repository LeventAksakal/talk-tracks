import { memo, useId } from "react";
import type { LectureArt } from "../demoRooms";

// Generated key art for the hub's cards and hero: one drawing per demo lecture's subject, and a seeded abstract one
// for any other talk. Never a frame of the talk itself: the lectures' slides hold other people's images (ticket
// 0001). Decorative, so hidden from assistive tech; the card's title carries the meaning.

const W = 320;
const H = 180;

/** A small seeded random generator (mulberry32), so a room's art is the same on every visit. */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export interface ArtProps {
  /** A demo lecture's drawing, or undefined for a seeded abstract one. */
  art?: LectureArt;
  /** Seeds the abstract drawing (the room name). */
  seed: string;
  className?: string;
}

export const Art = memo(function Art({ art, seed, className }: ArtProps) {
  const id = `a${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {art === "virus" ? (
        <Virus id={id} />
      ) : art === "dataviz" ? (
        <Charts id={id} />
      ) : art === "rsa" ? (
        <Lattice id={id} />
      ) : art === "qrcode" ? (
        <Code id={id} />
      ) : (
        <Abstract id={id} seed={seed} />
      )}
    </svg>
  );
});

function Virus({ id }: { id: string }) {
  const rand = rng("virus");
  const spikes = (cx: number, cy: number, r: number, n: number, len: number) =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      const x1 = cx + Math.cos(a) * r;
      const y1 = cy + Math.sin(a) * r;
      const x2 = cx + Math.cos(a) * (r + len);
      const y2 = cy + Math.sin(a) * (r + len);
      return { x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2) };
    });
  const small = Array.from({ length: 7 }, () => ({
    x: r1(20 + rand() * 150),
    y: r1(20 + rand() * 140),
    r: r1(5 + rand() * 9),
    o: r1(0.25 + rand() * 0.4),
  }));
  return (
    <>
      <defs>
        <radialGradient id={`${id}bg`} cx="70%" cy="45%" r="85%">
          <stop offset="0" stopColor="#3a0f3f" />
          <stop offset="0.55" stopColor="#12122a" />
          <stop offset="1" stopColor="#05060c" />
        </radialGradient>
        <radialGradient id={`${id}core`} cx="38%" cy="35%" r="70%">
          <stop offset="0" stopColor="#ffd1e4" />
          <stop offset="0.35" stopColor="#ff4f8b" />
          <stop offset="1" stopColor="#5b1a8c" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}bg)`} />
      <circle cx="-30" cy="200" r="150" fill="none" stroke="#20d3ae" strokeOpacity="0.35" strokeWidth="2" />
      <circle cx="-30" cy="200" r="140" fill="none" stroke="#20d3ae" strokeOpacity="0.15" strokeWidth="6" />
      {small.map((s, i) => (
        <g key={i} opacity={s.o}>
          {spikes(s.x, s.y, s.r, 10, 3).map((l, j) => (
            <line key={j} {...l} stroke="#ff8fb7" strokeWidth="1" />
          ))}
          <circle cx={s.x} cy={s.y} r={s.r} fill="#ff4f8b" />
        </g>
      ))}
      <g>
        {spikes(222, 88, 50, 22, 14).map((l, i) => (
          <g key={i}>
            <line {...l} stroke="#ff9cc2" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx={l.x2} cy={l.y2} r="3.6" fill="#ffd1e4" />
          </g>
        ))}
        <circle cx="222" cy="88" r="52" fill={`url(#${id}core)`} />
        {Array.from({ length: 16 }, (_, i) => {
          const a = rand() * Math.PI * 2;
          const d = rand() * 38;
          return (
            <circle
              key={i}
              cx={r1(222 + Math.cos(a) * d)}
              cy={r1(88 + Math.sin(a) * d)}
              r={r1(2 + rand() * 4)}
              fill="#ffffff"
              opacity={r1(0.08 + rand() * 0.2)}
            />
          );
        })}
      </g>
    </>
  );
}

function Charts({ id }: { id: string }) {
  const rand = rng("dataviz");
  const bars = Array.from({ length: 11 }, (_, i) => ({ x: 26 + i * 19, h: r1(24 + rand() * 92) }));
  const line = bars.map((b, i) => `${b.x + 6},${r1(150 - b.h - 16 - Math.sin(i / 1.6) * 10)}`).join(" ");
  return (
    <>
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0d1a3d" />
          <stop offset="1" stopColor="#05060c" />
        </linearGradient>
        <linearGradient id={`${id}bar`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#4f8bff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#20d3ae" />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}bg)`} />
      {Array.from({ length: 6 }, (_, i) => (
        <line key={i} x1="16" x2="304" y1={30 + i * 24} y2={30 + i * 24} stroke="#ffffff" strokeOpacity="0.06" />
      ))}
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={150 - b.h} width="12" height={b.h} rx="2.5" fill={`url(#${id}bar)`} />
      ))}
      <polyline points={line} fill="none" stroke="#ff4f8b" strokeWidth="2.5" strokeLinejoin="round" />
      {bars.map((b, i) => (
        <circle
          key={i}
          cx={b.x + 6}
          cy={r1(150 - b.h - 16 - Math.sin(i / 1.6) * 10)}
          r="3"
          fill="#ffd1e4"
          stroke="#ff4f8b"
        />
      ))}
      <g transform="translate(262 52)">
        <circle r="30" fill="none" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="12" />
        <circle r="30" fill="none" stroke="#ff4f8b" strokeWidth="12" strokeDasharray="70 200" transform="rotate(-90)" />
        <circle
          r="30"
          fill="none"
          stroke="#4f8bff"
          strokeWidth="12"
          strokeDasharray="50 200"
          strokeDashoffset="-72"
          transform="rotate(-90)"
        />
        <circle
          r="30"
          fill="none"
          stroke="#20d3ae"
          strokeWidth="12"
          strokeDasharray="40 200"
          strokeDashoffset="-124"
          transform="rotate(-90)"
        />
      </g>
    </>
  );
}

function Lattice({ id }: { id: string }) {
  const b1 = { x: 30, y: 7 };
  const b2 = { x: 11, y: 27 };
  const points: { x: number; y: number; k: string }[] = [];
  for (let i = -6; i <= 12; i++)
    for (let j = -3; j <= 8; j++) {
      const x = 40 + i * b1.x + j * b2.x;
      const y = 10 + i * b1.y + j * b2.y;
      if (x > -10 && x < W + 10 && y > -10 && y < H + 10) points.push({ x: r1(x), y: r1(y), k: `${i},${j}` });
    }
  const o = { x: 40 + 4 * b1.x + 2 * b2.x, y: 10 + 4 * b1.y + 2 * b2.y };
  return (
    <>
      <defs>
        <radialGradient id={`${id}bg`} cx="45%" cy="55%" r="80%">
          <stop offset="0" stopColor="#22124a" />
          <stop offset="1" stopColor="#05060c" />
        </radialGradient>
        <radialGradient id={`${id}glow`}>
          <stop offset="0" stopColor="#ff4f8b" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ff4f8b" stopOpacity="0" />
        </radialGradient>
        <marker id={`${id}tip`} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0 0L8 4L0 8Z" fill="context-stroke" />
        </marker>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}bg)`} />
      {points.map((p) => (
        <circle key={p.k} cx={p.x} cy={p.y} r="1.8" fill="#b9c6ff" opacity="0.45" />
      ))}
      <circle cx={o.x} cy={o.y} r="46" fill={`url(#${id}glow)`} />
      <line
        x1={o.x}
        y1={o.y}
        x2={o.x + b1.x * 2}
        y2={o.y + b1.y * 2}
        stroke="#4f8bff"
        strokeWidth="2.5"
        markerEnd={`url(#${id}tip)`}
      />
      <line
        x1={o.x}
        y1={o.y}
        x2={o.x + b2.x * 2}
        y2={o.y + b2.y * 2}
        stroke="#20d3ae"
        strokeWidth="2.5"
        markerEnd={`url(#${id}tip)`}
      />
      <line
        x1={o.x}
        y1={o.y}
        x2={o.x + b1.x - b2.x}
        y2={o.y + b1.y - b2.y}
        stroke="#ff4f8b"
        strokeWidth="3"
        markerEnd={`url(#${id}tip)`}
      />
      <circle cx={o.x} cy={o.y} r="4" fill="#ffffff" />
      <g transform="translate(250 112)" fill="none" stroke="#ffffff" strokeOpacity="0.22" strokeWidth="5">
        <path d="M-16 0v-14a16 16 0 0 1 32 0v14" strokeLinecap="round" />
        <rect x="-24" y="0" width="48" height="38" rx="7" fill="#ffffff" fillOpacity="0.05" />
      </g>
    </>
  );
}

function Code({ id }: { id: string }) {
  const rand = rng("qrcode");
  const N = 21;
  const cell = 6;
  const finder = (x: number, y: number) => x < 8 && y < 8;
  const isFinder = (x: number, y: number) => finder(x, y) || finder(N - 1 - x, y) || finder(x, N - 1 - y);
  const modules: { x: number; y: number; c: string }[] = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      if (isFinder(x, y)) continue;
      if (rand() < 0.48) {
        const t = rand();
        modules.push({ x, y, c: t < 0.08 ? "#ff4f8b" : t < 0.16 ? "#20d3ae" : "#e8ecff" });
      }
    }
  const eye = (x: number, y: number, k: string) => (
    <g key={k} transform={`translate(${x * cell} ${y * cell})`}>
      <rect width={cell * 7} height={cell * 7} rx="5" fill="#e8ecff" />
      <rect x={cell} y={cell} width={cell * 5} height={cell * 5} rx="3" fill="#0a1b22" />
      <rect x={cell * 2} y={cell * 2} width={cell * 3} height={cell * 3} rx="2" fill="#4f8bff" />
    </g>
  );
  return (
    <>
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#06303a" />
          <stop offset="1" stopColor="#05060c" />
        </linearGradient>
        <linearGradient id={`${id}scan`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#20d3ae" stopOpacity="0" />
          <stop offset="0.5" stopColor="#20d3ae" stopOpacity="0.55" />
          <stop offset="1" stopColor="#20d3ae" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}bg)`} />
      {Array.from({ length: 26 }, (_, i) => (
        <rect
          key={i}
          x={14 + i * 4.4}
          y="40"
          width={i % 3 === 0 ? 2.6 : 1.2}
          height="100"
          fill="#e8ecff"
          opacity="0.18"
        />
      ))}
      <g transform="translate(170 16) rotate(-8 63 63)">
        <rect x="-8" y="-8" width={N * cell + 16} height={N * cell + 16} rx="10" fill="#0a1b22" />
        {modules.map((m, i) => (
          <rect
            key={i}
            x={m.x * cell + 0.5}
            y={m.y * cell + 0.5}
            width={cell - 1}
            height={cell - 1}
            rx="1.2"
            fill={m.c}
          />
        ))}
        {eye(0, 0, "a")}
        {eye(N - 7, 0, "b")}
        {eye(0, N - 7, "c")}
      </g>
      <rect x="150" y="70" width="170" height="26" fill={`url(#${id}scan)`} />
    </>
  );
}

function Abstract({ id, seed }: { id: string; seed: string }) {
  const rand = rng(seed);
  const lanes = ["#ff4f8b", "#4f8bff", "#20d3ae"];
  const pick = () => lanes[Math.floor(rand() * lanes.length)]!;
  const blobs = Array.from({ length: 3 }, () => ({
    x: r1(rand() * W),
    y: r1(rand() * H),
    r: r1(70 + rand() * 80),
    c: pick(),
  }));
  return (
    <>
      <defs>
        {blobs.map((b, i) => (
          <radialGradient key={i} id={`${id}b${i}`}>
            <stop offset="0" stopColor={b.c} stopOpacity="0.75" />
            <stop offset="1" stopColor={b.c} stopOpacity="0" />
          </radialGradient>
        ))}
      </defs>
      <rect width={W} height={H} fill="#090b14" />
      {blobs.map((b, i) => (
        <circle key={i} cx={b.x} cy={b.y} r={b.r} fill={`url(#${id}b${i})`} />
      ))}
      <g transform="translate(36 112)" strokeLinecap="round" strokeWidth="7">
        <line x1="0" y1="0" x2="54" y2="0" stroke="#ff4f8b" />
        <line x1="0" y1="16" x2="96" y2="16" stroke="#4f8bff" />
        <line x1="0" y1="32" x2="54" y2="32" stroke="#20d3ae" />
      </g>
    </>
  );
}
