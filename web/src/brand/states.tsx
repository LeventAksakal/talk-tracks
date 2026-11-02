import "./states.css";
import type { ReactNode } from "react";

/**
 * The loading mark: the logomark's three lanes filling in turn, like tracks arriving. Decorative; the words beside
 * it carry the meaning. It fades in only after a moment, so a quick load never flashes it.
 */
export function Spinner({ size = 40 }: { size?: number }) {
  return (
    <span className="tt-spinner" style={{ width: size, height: size }} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/** Loading a page or a room: the spinner above one line. */
export function Loading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`tt-state${className ? ` ${className}` : ""}`} role="status">
      <Spinner />
      <p className="tt-state-line">{children}</p>
    </div>
  );
}

/** An empty or error state: a title, a line and the next step. */
export function StateNote({
  title,
  children,
  headingLevel = 1,
}: {
  title: string;
  children?: ReactNode;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className="tt-state tt-state-note">
      <span className="tt-state-mark" aria-hidden="true" />
      <Heading className="tt-state-title">{title}</Heading>
      {children}
    </div>
  );
}
