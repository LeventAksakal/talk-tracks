import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A scrollback that follows the newest line while the reader is at the bottom and stays put when
 * they scroll up to read back, with a button to jump to the latest. `role="log"` makes screen
 * readers announce appended lines politely, not the whole transcript.
 */
export function ScrollLog({
  label,
  lang,
  dir,
  children,
  footer,
  count,
}: {
  label: string;
  lang?: string;
  dir?: "rtl" | "ltr";
  children: ReactNode;
  /** Shown under the log, outside the live region (e.g. interim text). */
  footer?: ReactNode;
  /** Changes whenever content grows, to drive following. */
  count: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [count, footer, following]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="scrolllog">
      <div
        ref={ref}
        className="scrolllog-body"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={label}
        lang={lang}
        dir={dir}
        tabIndex={0}
      >
        {children}
        {footer}
      </div>
      {!following && (
        <button
          type="button"
          className="scrolllog-jump"
          onClick={() => {
            setFollowing(true);
            const el = ref.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
