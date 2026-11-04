import { type ReactNode, useEffect, useRef } from "react";
import { Glyph } from "./Glyph";
import "./modal.css";

/**
 * The app's modal: a native <dialog> (focus kept inside, Escape and the backdrop close it) with a fixed header (the
 * title and Close), a body and a fixed footer for the actions. The body is sized to fit the viewport, so ordinary
 * content never scrolls; only an unusually long body scrolls, between the header and the footer.
 *
 * A modal that holds something the page cannot give back (the one-time speaker link) is `dismissible={false}`: then
 * Escape, the backdrop and Close do nothing, and only the footer's actions leave it.
 *
 * The body and footer are the caller's (`ModalBody`, `ModalFooter`), so a form can wrap both and its submit button
 * sits in the footer.
 */
export function Modal({
  open,
  onClose,
  title,
  titleId,
  size = "md",
  role,
  className,
  dismissible = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** The heading's id, for aria-labelledby. */
  titleId: string;
  size?: "sm" | "md" | "lg";
  /** "alertdialog" for a confirmation that interrupts (End the talk?). */
  role?: "alertdialog";
  className?: string;
  /** False: no Close, and Escape and the backdrop do nothing (default true). */
  dismissible?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
      // The first field (or else the first action), not Close, takes focus.
      // A confirmation focuses its safe answer (the first action), so Enter never ends anything by accident.
      (
        el.querySelector<HTMLElement>(".tt-modal-body input, .tt-modal-body button") ??
        el.querySelector<HTMLElement>(".tt-modal-actions button") ??
        el
      ).focus();
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`tt-modal tt-modal-${size}${className ? ` ${className}` : ""}`}
      role={role}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself, outside its panel) closes it.
        if (dismissible && e.target === dialog.current) onClose();
      }}
    >
      {open ? (
        <div className="tt-modal-panel">
          <header className="tt-modal-head">
            <h2 id={titleId} className="tt-modal-title">
              {title}
            </h2>
            {dismissible ? (
              <button type="button" className="tt-modal-close" aria-label="Close" onClick={onClose}>
                <Glyph name="close" />
              </button>
            ) : null}
          </header>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

export function ModalBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `tt-modal-body ${className}` : "tt-modal-body"}>{children}</div>;
}

export function ModalFooter({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <footer className="tt-modal-foot">
      {note ? <div className="tt-modal-note">{note}</div> : null}
      <div className="tt-modal-actions">{children}</div>
    </footer>
  );
}
