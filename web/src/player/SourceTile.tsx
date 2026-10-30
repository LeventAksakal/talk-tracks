import type { CSSProperties, ReactNode } from "react";
import type { SourceKind } from "./prefs";

/**
 * One source's box (decision 0020): its CSS aspect-ratio is the source's, centred in its layout cell, and
 * its overlays are absolutely placed children of the same box, so a track's fraction (x, y) is simply
 * left: x·100 %, top: y·100 % in every layout and at every size.
 */
export function SourceTile({
  kind,
  aspect,
  label,
  children,
  overlay,
}: {
  kind: SourceKind;
  /** Width / height. */
  aspect: number;
  label: string;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div
      className={`tt-tile tt-tile-${kind}`}
      style={{ "--ar": aspect } as CSSProperties}
      role="group"
      aria-roledescription="source"
      aria-label={label}
    >
      {children}
      <div className="tt-tile-overlay">{overlay}</div>
    </div>
  );
}
