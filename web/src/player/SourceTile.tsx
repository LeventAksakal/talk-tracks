import { createContext, type CSSProperties, type ReactNode, useContext, useEffect } from "react";
import type { SourceKind } from "./prefs";

/** Tiles tell the stage their shape, so it can keep the corner tile and the subtitles off the main picture. */
export const TileAspects = createContext<((kind: SourceKind, aspect: number) => void) | undefined>(undefined);

/**
 * One source's box (decision 0020): its CSS aspect-ratio is the source's, centred in its layout cell, and
 * its overlays are absolutely placed children of the same box, so a track's fraction (x, y) is simply
 * left: x·100 %, top: y·100 % in every layout and at every size. `chrome` (the slide toolbar) sits beside the box, so it
 * is placed on the tile that holds it (its letterbox, not the slide's own title).
 */
export function SourceTile({
  kind,
  aspect,
  label,
  children,
  overlay,
  chrome,
}: {
  kind: SourceKind;
  /** Width / height. */
  aspect: number;
  label: string;
  children: ReactNode;
  overlay?: ReactNode;
  /** Controls placed on the tile around the picture rather than on the picture. */
  chrome?: ReactNode;
}) {
  const report = useContext(TileAspects);
  useEffect(() => {
    if (Number.isFinite(aspect) && aspect > 0) report?.(kind, aspect);
  }, [report, kind, aspect]);
  return (
    <>
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
      {chrome}
    </>
  );
}
