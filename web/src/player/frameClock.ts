// The one frame loop (decision 0020): a main-thread requestAnimationFrame loop that reads the room time of
// the frame on screen once per frame and hands it to the overlays. It runs only while something listens;
// rAF itself pauses in background tabs. React state changes only when a derived value changes.

import { useEffect, useRef, useState } from "react";

type Listener = (t: number | undefined) => void;

export class FrameClock {
  #read: () => number | undefined;
  #listeners = new Set<Listener>();
  #handle: number | undefined;

  constructor(read: () => number | undefined) {
    this.#read = read;
  }

  /** The room ms of the frame on screen now. */
  now(): number | undefined {
    return this.#read();
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#start();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stop();
    };
  }

  #start(): void {
    if (typeof requestAnimationFrame === "undefined") return;
    const tick = () => {
      const t = this.#read();
      for (const fn of [...this.#listeners]) fn(t);
      this.#handle = requestAnimationFrame(tick);
    };
    this.#handle = requestAnimationFrame(tick);
  }

  #stop(): void {
    if (this.#handle !== undefined && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.#handle);
    this.#handle = undefined;
  }
}

/**
 * `derive(t)` of the frame time, recomputed every frame and on every render; the component re-renders
 * only when the result changes under `same` (a cue, a slide, a chapter: never 60 times a second).
 */
export function useFrameValue<T>(
  clock: FrameClock,
  derive: (t: number | undefined) => T,
  same: (a: T, b: T) => boolean = Object.is,
): T {
  const value = derive(clock.now());
  const [, setTick] = useState(0);
  const latest = useRef({ value, derive, same });
  useEffect(() => {
    latest.current = { value, derive, same };
  });
  useEffect(
    () =>
      clock.subscribe((t) => {
        const { value: before, derive: d, same: eq } = latest.current;
        const next = d(t);
        if (!eq(before, next)) {
          latest.current.value = next;
          setTick((n) => n + 1);
        }
      }),
    [clock],
  );
  return value;
}
