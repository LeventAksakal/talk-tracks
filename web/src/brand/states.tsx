import { type ReactNode, useEffect, useState } from "react";
import { Chalky, type ChalkyCycle, type ChalkyFace } from "./Chalky";

/** The hub's hero: Chalky waves hello for a few seconds, then breathes and blinks. */
export function HeroChalky({ size = 240 }: { size?: number }) {
  const [cycle, setCycle] = useState<ChalkyCycle>("wave");
  useEffect(() => {
    const t = window.setTimeout(() => setCycle("idle"), 3000);
    return () => window.clearTimeout(t);
  }, []);
  return <Chalky cycle={cycle} size={size} className="chalky-hero" />;
}

/** Which loop and face Chalky plays for each room state the player shows a card for (the rig board's "where used"). */
const ROOM_STATE: Partial<Record<string, { cycle: ChalkyCycle; face?: ChalkyFace; late?: boolean }>> = {
  connecting: { cycle: "think", late: true },
  "not-started": { cycle: "sleep" },
  unknown: { cycle: "shake" },
  ended: { cycle: "wave" },
  failed: { cycle: "idle", face: "sad" },
};

/**
 * Chalky for a room-state card in the player, by the state's kind. Nothing for the states that hold a frame on the
 * stage (paused, reconnecting) or play (live, behind): he never sits over a talk.
 */
export function RoomStateChalky({ kind, size = 120 }: { kind: string; size?: number }) {
  const pose = ROOM_STATE[kind];
  return pose ? <Chalky {...pose} size={size} className="chalky-card" /> : null;
}

/** Loading a page or a room: Chalky thinks, after a second, above the words. */
export function ChalkyLoading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`chalky-note${className ? ` ${className}` : ""}`} role="status">
      <Chalky cycle="think" size={96} late />
      <p>{children}</p>
    </div>
  );
}

/** An empty or error state: Chalky with a title, a line and the next step. */
export function ChalkyNote({
  cycle,
  face,
  title,
  children,
  headingLevel = 1,
}: {
  cycle: ChalkyCycle;
  face?: ChalkyFace;
  title: string;
  children?: ReactNode;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className="chalky-note">
      <Chalky cycle={cycle} face={face} size={128} />
      <Heading className="chalky-note-title">{title}</Heading>
      {children}
    </div>
  );
}
