/**
 * The logomark (public/brand/logomark-*.svg): a play button cut into three lanes, one per track, in the lane colours
 * (tokens.css --tt-lane-1..3). Decorative.
 */
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="logomark" viewBox="5 2 60 60" width={size} height={size} aria-hidden="true" focusable="false">
      <g strokeWidth="3" strokeLinejoin="round">
        <path d="M14 6L33.4 18H14Z" fill="var(--tt-lane-1)" stroke="var(--tt-lane-1)" />
        <path d="M14 26H46.3L56 32L46.3 38H14Z" fill="var(--tt-lane-2)" stroke="var(--tt-lane-2)" />
        <path d="M14 46H33.4L14 58Z" fill="var(--tt-lane-3)" stroke="var(--tt-lane-3)" />
      </g>
    </svg>
  );
}
