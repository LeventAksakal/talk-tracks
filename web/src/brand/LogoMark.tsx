/** The logomark (public/brand/logomark-*.svg) in the text colour: a play button cut into three lanes. Decorative. */
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="logomark" viewBox="5 2 60 60" width={size} height={size} aria-hidden="true" focusable="false">
      <path
        d="M14 6L33.4 18H14ZM14 26H46.3L56 32L46.3 38H14ZM14 46H33.4L14 58Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
