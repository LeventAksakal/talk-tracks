// Chalky v2, the mascot (wiki/product/brand.md §1): a stick of chalk rigged like a 3D character. A port of the rig
// on the Reference Canvas's "Chalky v2, rigged" board: the body is a cylinder, so each face part sits at an angle on
// it and slides and narrows as Chalky turns; limbs are posed in 3D and projected, so an arm pointing at you gets
// shorter. Bones: root (ground) > body > head (brows, eyes, mouth); arm > fore > hand per side; legs on the root.
//
// Pure and dependency-free: the app renders this markup inside an <svg> (Chalky.tsx, animated by chalky.css), and
// web/scripts/brand/build.ts renders the same markup into the static brand images.

export type ChalkyFace =
  | "neutral"
  | "happy"
  | "laugh"
  | "surprised"
  | "curious"
  | "thinking"
  | "listening"
  | "sleepy"
  | "sad"
  | "wink"
  | "confused";

export type ChalkyCycle =
  "still" | "idle" | "wave" | "walk" | "hop" | "nod" | "shake" | "think" | "listen" | "talk" | "sleep";

type EyeKind = "open" | "wide" | "half" | "happy" | "closed";
type MouthKind = "smile" | "grin" | "laugh" | "o" | "small" | "flat" | "frown" | "wavy";
type Prop = "" | "spark" | "q" | "dots" | "phones" | "bubble" | "z";
/** Upper arm abduction and flexion, forearm abduction and flexion, in degrees. */
type ArmPose = readonly [number, number, number, number];

interface FaceDef {
  eyes: readonly [EyeKind, EyeKind];
  browTilt: readonly [number, number];
  browLift: readonly [number, number];
  mouth: MouthKind;
  gaze: readonly [number, number];
}

interface CycleDef {
  face: ChalkyFace;
  armL: ArmPose;
  armR: ArmPose;
  prop: Prop;
}

// [filled shape, stroke, highlight shown]
const EYE: Record<EyeKind, readonly [string, string, boolean]> = {
  open: ["M-5.5 0a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0", "", true],
  wide: ["M-6.8 0a6.8 6.8 0 1 0 13.6 0a6.8 6.8 0 1 0-13.6 0", "", true],
  half: ["M-5.5 -0.5a5.5 5.5 0 0 0 11 0Z", "M-6.5 -0.5h13", false],
  happy: ["", "M-5 1.5q5-6.5 10 0", false],
  closed: ["", "M-5 0.5h10", false],
};

// [filled shape, stroke]
const MOUTH: Record<MouthKind, readonly [string, string]> = {
  smile: ["", "M-9 0q9 9 18 0"],
  grin: ["M-10 -1q10 13 20 0z", ""],
  laugh: ["M-11 -2q11 17 22 0z", ""],
  o: ["M-4.5 2a4.5 5.5 0 1 0 9 0a4.5 5.5 0 1 0-9 0", ""],
  small: ["", "M-4 1q4 3 8 0"],
  flat: ["", "M-6 2h12"],
  frown: ["", "M-8 5q8-8 16 0"],
  wavy: ["", "M-8 2q2-3 4 0t4 0t4 0t4 0"],
};

/** The 11 faces, built from brows, eyes, mouth and gaze. */
export const FACES: Record<ChalkyFace, FaceDef> = {
  neutral: { eyes: ["open", "open"], browTilt: [0, 0], browLift: [0, 0], mouth: "smile", gaze: [0, 0] },
  happy: { eyes: ["happy", "happy"], browTilt: [0, 0], browLift: [-1, -1], mouth: "grin", gaze: [0, 0] },
  laugh: { eyes: ["happy", "happy"], browTilt: [-8, 8], browLift: [-3, -3], mouth: "laugh", gaze: [0, 0] },
  surprised: { eyes: ["wide", "wide"], browTilt: [0, 0], browLift: [-6, -6], mouth: "o", gaze: [0, 0] },
  curious: { eyes: ["open", "open"], browTilt: [-10, 4], browLift: [-4, -1], mouth: "small", gaze: [2, -1] },
  thinking: { eyes: ["open", "open"], browTilt: [6, -6], browLift: [1, -4], mouth: "flat", gaze: [3, -3] },
  listening: { eyes: ["half", "half"], browTilt: [0, 0], browLift: [0, 0], mouth: "small", gaze: [0, 0] },
  sleepy: { eyes: ["closed", "closed"], browTilt: [0, 0], browLift: [2, 2], mouth: "small", gaze: [0, 0] },
  sad: { eyes: ["open", "open"], browTilt: [-16, 16], browLift: [0, 0], mouth: "frown", gaze: [0, 2] },
  wink: { eyes: ["open", "happy"], browTilt: [0, -6], browLift: [0, -2], mouth: "grin", gaze: [0, 0] },
  confused: { eyes: ["open", "wide"], browTilt: [12, -14], browLift: [0, -3], mouth: "wavy", gaze: [-1.5, 0] },
};

const REST: ArmPose = [20, 0, 25, 10];

/** The 11 cycles: each is a loop on its own layer (chalky.css), with a default face, arm poses and a prop. */
export const CYCLES: Record<ChalkyCycle, CycleDef> = {
  still: { face: "neutral", armL: REST, armR: REST, prop: "" },
  idle: { face: "neutral", armL: REST, armR: REST, prop: "" },
  wave: { face: "happy", armL: [140, 0, 172, 0], armR: REST, prop: "" },
  walk: { face: "neutral", armL: [8, 0, 12, 20], armR: [8, 0, 12, 20], prop: "" },
  hop: { face: "laugh", armL: [155, 0, 170, 0], armR: [155, 0, 170, 0], prop: "spark" },
  nod: { face: "happy", armL: REST, armR: REST, prop: "" },
  shake: { face: "confused", armL: [35, 0, 70, 30], armR: [35, 0, 70, 30], prop: "q" },
  think: { face: "thinking", armL: REST, armR: [25, 55, -125, 35], prop: "dots" },
  listen: { face: "listening", armL: [150, 0, -150, 0], armR: [150, 0, -150, 0], prop: "phones" },
  talk: { face: "happy", armL: [40, 40, 95, 60], armR: REST, prop: "bubble" },
  sleep: { face: "sleepy", armL: [8, 0, 8, 0], armR: [8, 0, 8, 0], prop: "z" },
};

/** Rig space: the ground is y = 0 under the feet, the top of the stick is at y ≈ -131. Props may spill past it. */
export const CHALKY_VIEWBOX = "-64 -172 128 182";

const CHALK = "#f7f4ea";
const SHADE = "#e2dccb";
const FAR = "#cfc8b5";
const INK = "#1b2420";
// The outline: Blackboard, so it melts into a dark ground and draws a pencil line on Paper.
const LINE = "stroke:var(--chalky-line,#1b2420)";
const LINE_FILL = "fill:var(--chalky-line,#1b2420)";
// Props drawn in chalk on the board: the page's text colour on Paper.
const MARK = "fill:var(--chalky-mark,#f7f4ea)";

const R = 28;
const RD = Math.PI / 180;
const f1 = (n: number) => Math.round(n * 10) / 10;
const surf = (th: number, y: number) => ({ x: R * Math.sin(th + y), z: Math.cos(th + y) });
const proj = (X: number, Y: number, Z: number, y: number) => ({
  x: X * Math.cos(y) + Z * Math.sin(y),
  y: Y,
  z: Z * Math.cos(y) - X * Math.sin(y),
});
/** One limb segment posed in 3D and projected: its screen angle, its foreshortened length and its depth. */
function seg(sd: number, a: number, f: number, y: number) {
  const A = a * RD;
  const F = f * RD;
  const p = proj(sd * Math.sin(A), Math.cos(A) * Math.cos(F), Math.abs(Math.cos(A)) * Math.sin(F), y);
  return { ang: Math.atan2(-p.x, p.y) / RD, len: Math.max(0.25, Math.hypot(p.x, p.y)), z: p.z };
}

export interface ChalkyPose {
  /** The cycle: which loop chalky.css plays and which arm poses and prop it uses. Default idle. */
  cycle?: ChalkyCycle;
  /** The face; default the cycle's own. */
  face?: ChalkyFace;
  /** Turn in degrees: 0 faces you, 90 is side on, 180 shows the back with the three-track mark. */
  yaw?: number;
}

/** The figure's classes: the cycle and whether it is seen from the front or the side (the walk differs). */
export function chalkyClasses({ cycle = "idle", yaw = 0 }: ChalkyPose): string {
  return `chalky-fig cyc-${cycle} ${Math.abs(Math.sin(yaw * RD)) > 0.5 ? "v-side" : "v-front"}`;
}

/** SVG markup for one posed Chalky in rig space (CHALKY_VIEWBOX), every colour inline so it renders anywhere. */
export function chalkyMarkup(pose: ChalkyPose = {}): string {
  const cycle = CYCLES[pose.cycle ?? "idle"];
  const face = FACES[pose.face ?? cycle.face];
  const y = (pose.yaw ?? 0) * RD;
  const talking = pose.cycle === "talk";
  const out: string[] = [];

  // Body: the cylinder's outline never changes; the broken top flips its slant as it turns.
  const yL = -131 + 5 * Math.cos(y);
  const yR = -131 - 5 * Math.cos(y);
  const k = (yR - yL) / 56;
  const bd = `M-28 -32V${f1(yL + 4)}Q-28 ${f1(yL)} -24 ${f1(yL + 4 * k)}L24 ${f1(yR - 4 * k)}Q28 ${f1(yR)} 28 ${f1(yR + 4)}V-32Q28 -20 16 -20H-16Q-28 -20 -28 -32Z`;
  const bs = `M-28 -32V${f1(yL + 4)}Q-28 ${f1(yL)} -24 ${f1(yL + 4 * k)}L-16 ${f1(yL + 12 * k)}V-20Q-28 -20 -28 -32Z`;

  // Arms: shoulder, elbow, wrist; each drawn behind the body or in front of it by its depth.
  const arm = (side: "L" | "R", sd: number, P: ArmPose) => {
    const sh = surf((sd * Math.PI) / 2, y);
    const u = seg(sd, P[0], P[1], y);
    const w = seg(sd, P[2], P[3], y);
    const L1 = 17 * u.len;
    const L2 = 15 * w.len;
    const back = sh.z * R + 17 * u.z + 15 * w.z < -4;
    const c = back ? FAR : CHALK;
    const limb = (d: string) =>
      `<path d="${d}" fill="none" stroke-linecap="round" style="${LINE}" stroke-width="10.5"/>` +
      `<path d="${d}" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/>`;
    const svg =
      `<g transform="translate(${f1(sh.x * 0.93)} -62) rotate(${f1(u.ang)})"><g class="a-${side}">` +
      limb(`M0 0V${f1(L1)}`) +
      `<g transform="translate(0 ${f1(L1)}) rotate(${f1(w.ang - u.ang)})"><g class="e-${side}">` +
      limb(`M0 0V${f1(L2)}`) +
      `<circle cy="${f1(L2)}" r="5.9" style="${LINE_FILL}"/><circle cy="${f1(L2)}" r="4.2" fill="${c}"/>` +
      `</g></g></g></g>`;
    return { back, svg };
  };
  const armL = arm("L", 1, cycle.armL);
  const armR = arm("R", -1, cycle.armR);

  // Legs from the hips on the root.
  const leg = (side: "L" | "R", sd: number, far: boolean) => {
    const hip = proj(sd * 12, 0, 0, y);
    const foot = proj(sd * 4, 0, 6, y);
    const d = `M0 0V22h${f1(foot.x)}`;
    return {
      z: hip.z,
      svg:
        `<g transform="translate(${f1(hip.x)} -24)"><g class="l-${side}">` +
        `<path d="${d}" fill="none" stroke-linecap="round" stroke-linejoin="round" style="${LINE}" stroke-width="10.5"/>` +
        `<path d="${d}" fill="none" stroke="${far ? FAR : CHALK}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` +
        `</g></g>`,
    };
  };
  const lFar = proj(12, 0, 0, y).z < proj(-12, 0, 0, y).z;

  out.push(`<ellipse class="chalky-shadow" rx="40" ry="5.5" fill="#000" opacity=".28"/>`);
  out.push(`<g class="b-root">`);
  if (armL.back) out.push(armL.svg);
  if (armR.back) out.push(armR.svg);
  if (lFar) out.push(leg("L", 1, true).svg, leg("R", -1, false).svg);
  else out.push(leg("R", -1, true).svg, leg("L", 1, false).svg);

  out.push(`<g class="b-body">`);
  out.push(`<path d="${bd}" fill="${CHALK}" style="${LINE}" stroke-width="3" stroke-linejoin="round"/>`);
  out.push(`<path d="${bs}" fill="${SHADE}"/>`);
  out.push(`<path d="M17 -112V-44" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".55" fill="none"/>`);

  // The three-track mark on the back comes round as Chalky turns.
  const back = surf(Math.PI, y);
  if (back.z >= 0.12)
    out.push(
      `<g transform="translate(${f1(back.x)} -56) scale(${f1(Math.max(0.2, back.z))} 1)" stroke-width="4" stroke-linecap="round">` +
        `<path d="M-9 -6h18" stroke="#ff6fae"/><path d="M-9 0h18" stroke="#5fb3ff"/><path d="M-9 6h12" stroke="#ffd84a"/></g>`,
    );

  out.push(`<g class="b-face">`);
  const eye = (th: number, i: 0 | 1) => {
    const p = surf(th, y);
    if (p.z < 0.12) return;
    const sx = f1(Math.max(0.2, p.z));
    const [fill, stroke, hl] = EYE[face.eyes[i]];
    const gx = face.gaze[0] * Math.max(0, p.z);
    out.push(
      `<g transform="translate(${f1(p.x)} ${f1(-97 + face.browLift[i])}) scale(${sx} 1) rotate(${face.browTilt[i]})">` +
        `<path d="M-5.5 0h11" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/></g>`,
    );
    out.push(
      `<g transform="translate(${f1(p.x + gx)} ${f1(-86 + face.gaze[1])}) scale(${sx} 1)"><g class="chalky-eye">` +
        (fill ? `<path d="${fill}" fill="${INK}"/>` : "") +
        (stroke ? `<path d="${stroke}" stroke="${INK}" stroke-width="3" stroke-linecap="round" fill="none"/>` : "") +
        (hl ? `<circle cx="1.9" cy="-1.9" r="1.7" fill="#fff"/>` : "") +
        `</g></g>`,
    );
  };
  eye(-0.42, 0);
  eye(0.42, 1);
  for (const th of [-0.8, 0.8]) {
    const p = surf(th, y);
    if (p.z >= 0.15)
      out.push(
        `<circle transform="translate(${f1(p.x)} -75) scale(${f1(Math.max(0.3, p.z))} 1)" r="4.6" fill="#ff6fae" opacity=".45"/>`,
      );
  }
  const m = surf(0, y);
  if (m.z >= 0.15) {
    const at = `translate(${f1(m.x)} -70) scale(${f1(Math.max(0.3, m.z))} 1)`;
    if (talking) {
      // Three mouth shapes the talk cycle steps through.
      out.push(
        `<g transform="${at}"><path class="v1" d="M-5 2h10" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>` +
          `<path class="v2" opacity="0" d="M-5 1a5 4.5 0 1 0 10 0a5 4.5 0 1 0-10 0" fill="${INK}"/>` +
          `<path class="v3" opacity="0" d="M-8 -1q8 12 16 0z" fill="${INK}"/></g>`,
      );
    } else {
      const [fill, stroke] = MOUTH[face.mouth];
      out.push(
        `<g transform="${at}">` +
          (fill ? `<path d="${fill}" fill="${INK}"/>` : "") +
          (stroke ? `<path d="${stroke}" stroke="${INK}" stroke-width="3" stroke-linecap="round" fill="none"/>` : "") +
          `</g>`,
      );
    }
  }
  out.push(`</g>`); // b-face

  if (cycle.prop === "phones") {
    const a = surf(Math.PI / 2, y);
    const b = surf(-Math.PI / 2, y);
    out.push(
      `<path d="M${f1(b.x)} -94C${f1(b.x)} -156 ${f1(a.x)} -156 ${f1(a.x)} -94" stroke="#5fb3ff" stroke-width="6" fill="none" stroke-linecap="round"/>`,
    );
    for (const c of [a, b])
      if (c.z >= -0.3)
        out.push(
          `<rect transform="translate(${f1(c.x)} -88) scale(${f1(Math.max(0.45, c.z))} 1)" x="-7" y="-12" width="14" height="24" rx="6" fill="#5fb3ff"/>`,
        );
  }
  out.push(`</g>`); // b-body

  if (!armL.back) out.push(armL.svg);
  if (!armR.back) out.push(armR.svg);
  out.push(`</g>`); // b-root

  out.push(PROPS[cycle.prop]);
  return `<g class="${chalkyClasses(pose)}">${out.join("")}</g>`;
}

const TITLE_FONT = `font-family="Talk Tracks Title, Cabin Sketch, sans-serif" font-weight="700"`;
const PROPS: Record<Prop, string> = {
  "": "",
  z:
    `<g style="${MARK}" ${TITLE_FONT}><text class="zz z1" x="30" y="-128" font-size="18">z</text>` +
    `<text class="zz z2" x="44" y="-146" font-size="22">z</text><text class="zz z3" x="60" y="-168" font-size="28">Z</text></g>`,
  q: `<text x="34" y="-142" fill="#ffd84a" font-size="30" ${TITLE_FONT}>?</text>`,
  dots:
    `<g class="dots" style="${MARK}" opacity=".8"><circle cx="34" cy="-124" r="3"/><circle cx="44" cy="-140" r="4.5"/>` +
    `<circle cx="58" cy="-158" r="6"/></g>`,
  spark: `<path d="M-46 -8l-8-4M46 -8l8-4M-40 -22l-10-6M40 -22l10-6" stroke="#ffd84a" stroke-width="3" stroke-linecap="round"/>`,
  bubble:
    `<g class="bub"><rect x="40" y="-176" width="58" height="36" rx="12" fill="#ffd84a"/><path d="M48 -142L36 -128L62 -142Z" fill="#ffd84a"/>` +
    `<text x="69" y="-152" fill="${INK}" font-family="Atkinson Hyperlegible Next, sans-serif" font-weight="600" font-size="17" text-anchor="middle">Aa</text></g>`,
};
