import "./chalky.css";
import { useMemo } from "react";
import { CHALKY_VIEWBOX, type ChalkyPose, chalkyMarkup } from "./chalkyRig";

export type { ChalkyCycle, ChalkyFace } from "./chalkyRig";

export interface ChalkyProps extends ChalkyPose {
  /** Height in CSS px; the width follows the rig's 128:182 box. */
  size?: number;
  /** Fade in only after a second: for loading, so a quick connect never flashes him. */
  late?: boolean;
  className?: string;
}

/**
 * Chalky, the mascot, as a small SVG rig animated in CSS (chalky.css). Decorative: the words beside him carry the
 * meaning, so he is hidden from assistive tech. He belongs to the hub, empty states and loading, never to the stage
 * while a talk plays.
 */
export function Chalky({ cycle = "idle", face, yaw = 0, size = 120, late, className }: ChalkyProps) {
  // The markup is built from the rig's own constants, never from user input.
  const html = useMemo(() => chalkyMarkup({ cycle, face, yaw }), [cycle, face, yaw]);
  return (
    <svg
      className={`chalky${late ? " chalky-late" : ""}${className ? ` ${className}` : ""}`}
      viewBox={CHALKY_VIEWBOX}
      height={size}
      width={Math.round((size * 128) / 182)}
      aria-hidden="true"
      focusable="false"
      data-chalky={cycle}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
