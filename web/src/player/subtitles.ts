// Which caption or translation lines are on screen at room time t (ui-design §4.1). Live, the newest lines
// show as they form; rewound, the lines spoken around t.

import type { LineItem } from "../playback/wire";

/** A finished line stays up this long after its last word, ms. */
export const LINGER_MS = 2_500;
/** Live, the newest finished line stays up this long after it ended, ms: a translation lands seconds after its line. */
export const LIVE_HOLD_MS = 8_000;

/**
 * Up to `max` lines on screen at `t`, oldest first. Live (`live`), the newest lines whatever their start (a
 * line can start just after the frame on screen); rewound, lines that started by `t`. A line stays while it
 * is still forming (not final) or ended less than the hold time before `t`.
 */
export function cuesAt(lines: readonly LineItem[], t: number | undefined, live: boolean, max = 2): LineItem[] {
  const hold = live ? LIVE_HOLD_MS : LINGER_MS;
  let end = lines.length;
  if (!live && t !== undefined) while (end > 0 && lines[end - 1]!.startMs > t) end--;
  const out: LineItem[] = [];
  for (let i = end - 1; i >= 0 && out.length < max; i--) {
    const line = lines[i]!;
    const showing = !line.final || t === undefined || t - line.endMs < hold;
    if (!showing) break;
    out.unshift(line);
  }
  return out;
}

/** The text a subtitle shows for a line: interim words hidden when the viewer asked for it. */
export function cueText(line: LineItem, showInterim: boolean): string | undefined {
  return line.final || showInterim ? line.text : undefined;
}
