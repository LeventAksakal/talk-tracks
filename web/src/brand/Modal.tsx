import { type ReactNode, useEffect, useRef } from "react";
import { Glyph } from "./Glyph";
import "./modal.css";

/**
 * The app's modal: a native <dialog> (focus kept inside, Escape and the backdrop close it) with a fixed header (the
 * title and Close), a body and a fixed footer for the actions. The body is sized to fit the viewport, so ordinary
 * content never scrolls; only an unusually long body scrolls, between the header and the footer.
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
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** The heading's id, for aria-labelledby. */
  titleId: string;
  size?: "sm" | "md" | "lg";
  className?: string;
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
      (el.querySelector<HTMLElement>(".tt-modal-body input, .tt-modal-body button") ?? el)?.focus();
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`tt-modal tt-modal-${size}${className ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself, outside its panel) closes it.
        if (e.target === dialog.current) onClose();
      }}
    >
      {open ? (
        <div className="tt-modal-panel">
          <header className="tt-modal-head">
            <h2 id={titleId} className="tt-modal-title">
              {title}
            </h2>
            <button type="button" className="tt-modal-close" aria-label="Close" onClick={onClose}>
              <Glyph name="close" />
            </button>
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
