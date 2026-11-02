// The heavy routes, each its own chunk: the hub loads none of them (no player, no console, no pdf.js, no MoQ stack
// on first paint). `preloadWatch` starts the watch chunk early, when a room card is hovered or focused.

export const loadWatch = () => import("./pages/WatchPage");
export const loadTalk = () => import("./pages/TalkPage");
export const loadDemo = () => import("./pages/DemoPage");
export const loadRewindDemo = () => import("./playback/RewindDemo");

let watch: ReturnType<typeof loadWatch> | undefined;

/** Starts loading the watch page once; a failed load is forgotten so the next hover or the route itself retries. */
export function preloadWatch(): void {
  if (watch) return;
  watch = loadWatch();
  watch.catch(() => {
    watch = undefined;
  });
}
