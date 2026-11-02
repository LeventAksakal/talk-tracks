// Control-bar icons: 24-unit strokes in currentColor, hidden from assistive tech (every button has a label).

const paths = {
  play: <path d="M7 5l12 7-12 7z" fill="currentColor" />,
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </>
  ),
  volume: (
    <>
      <path d="M4 10v4h4l5 4V6L8 10z" fill="currentColor" />
      <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  muted: (
    <>
      <path d="M4 10v4h4l5 4V6L8 10z" fill="currentColor" />
      <path d="M16.5 9.5l5 5M21.5 9.5l-5 5" />
    </>
  ),
  cc: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M10 10.5a2 2 0 1 0 0 3M16 10.5a2 2 0 1 0 0 3" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M10 5v14" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M15 5v14M17.5 9h1M17.5 12h1" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  exitFullscreen: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  back: <path d="M15 5l-7 7 7 7" />,
  forward: <path d="M9 5l7 7-7 7" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
  swap: <path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  live: (
    <>
      <path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  comment: <path d="M5 4h14v12h-6l-4 4v-4H5z" />,
  transcript: <path d="M5 6h14M5 10h14M5 14h10M5 18h7" />,
  chapters: <path d="M4 6h2M9 6h11M4 12h2M9 12h11M4 18h2M9 18h11" />,
  notes: <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5" />,
} as const;

export type IconName = keyof typeof paths;

/** One of the player's icons; `slot` places it in a Media Chrome button's icon slot. */
export function Icon({ name, slot }: { name: IconName; slot?: string }) {
  return (
    <svg className="tt-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" slot={slot}>
      {paths[name]}
    </svg>
  );
}
