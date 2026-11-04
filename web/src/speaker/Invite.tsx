import { Button } from "@astryxdesign/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { encode } from "uqr";
import { Glyph } from "../brand/Glyph";
import { LogoMark } from "../brand/LogoMark";
import "./invite.css";

/** A QR code as SVG: one path of dark modules, crisp at any size. */
export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, size: qr.size };
  }, [text]);
  return (
    <svg
      className={className ? `qr ${className}` : "qr"}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function watchUrl(room: string, origin = location.origin): string {
  return `${origin}/watch/${room}`;
}

/** A link as people read it aloud or type it: no scheme, no trailing slash (talk-tracks.example/watch/room). */
export function shortUrl(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
}

/** Copy text, then say whether it worked (for a role="status" line beside the button). */
export function useCopy(text: string) {
  const [copied, setCopied] = useState<"yes" | "no">();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(undefined), 4_000);
  };
  return { copied, copy };
}

/** The audience link as one row: the short link, and Copy. */
export function AudienceLink({ room, label = "Audience link" }: { room: string; label?: string }) {
  const url = watchUrl(room);
  const { copied, copy } = useCopy(url);
  return (
    <div className="link-row">
      <span className="link-row-label">{label}</span>
      <div className="link-row-line">
        <a className="link-row-url" href={url} target="_blank" rel="noreferrer">
          {shortUrl(url)}
        </a>
        <Button
          label={copied === "yes" ? "Copied" : "Copy audience link"}
          size="sm"
          variant="secondary"
          icon={<Glyph name={copied === "yes" ? "checkCircle" : "contentCopy"} />}
          clickAction={copy}
        />
      </div>
      <span className="link-row-status" aria-live="polite">
        {copied === "yes" ? "Audience link copied." : copied === "no" ? "Could not copy; select the link." : ""}
      </span>
    </div>
  );
}

/**
 * "Show full screen": the invitation to project, a QR and the short link sized to the screen. The whole page goes full
 * screen and a modal card covers it; Escape (or Close) leaves both. Where full screen is refused the card still covers
 * the window.
 */
export function ProjectInvite({ room, variant = "secondary" }: { room: string; variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  const show = () => {
    flushSync(() => setOpen(true));
    document.documentElement.requestFullscreen?.().catch(() => {
      // Full screen refused: the card still covers the window until closed.
    });
  };
  const close = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setOpen(false);
  };
  return (
    <>
      <Button label="Show full screen" size="sm" variant={variant} icon={<Glyph name="fullscreen" />} onClick={show} />
      <ProjectionCard room={room} open={open} onClose={close} />
    </>
  );
}

function ProjectionCard({ room, open, onClose }: { room: string; open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const url = watchUrl(room);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
      el.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // Leaving full screen with the browser's own Escape or exit closes the card too.
    let entered = !!document.fullscreenElement;
    const changed = () => {
      if (document.fullscreenElement) entered = true;
      else if (entered) onClose();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, [open, onClose]);
  return (
    <dialog
      ref={dialog}
      className="project-card"
      aria-label="Invitation to project"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      {open ? (
        <div className="project-inner">
          <header className="project-head">
            <span className="project-brand">
              <LogoMark />
              Talk Tracks
            </span>
            <button type="button" className="project-close" aria-label="Close full screen" onClick={onClose}>
              <Glyph name="close" />
              Close <kbd>Esc</kbd>
            </button>
          </header>
          <div className="project-main">
            <QrCode text={url} label={`QR code for ${url}`} className="project-qr" />
            <div className="project-text">
              <p className="project-lead">Scan to watch, with subtitles in your language</p>
              <p className="project-url">
                {/* Broken only after a slash, never inside the room name. */}
                {shortUrl(url)
                  .split("/")
                  .map((part, i) => (
                    <span key={i}>
                      {i ? "/" : ""}
                      {i ? <wbr /> : null}
                      {part}
                    </span>
                  ))}
              </p>
              <p className="project-code">
                Room <strong>{room}</strong>
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
