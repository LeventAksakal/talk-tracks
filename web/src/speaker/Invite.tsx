import { Button } from "@astryxdesign/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { encode } from "uqr";

/** A QR code as SVG: one path of dark modules, crisp at any size. */
export function QrCode({ text, label }: { text: string; label: string }) {
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
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function watchUrl(room: string, origin = location.origin): string {
  return `${origin}/watch/${room}`;
}

/** Invite (S2): the room name large, a QR, copy the link, and a full-screen card to project. */
export function Invite({ room }: { room: string }) {
  const url = watchUrl(room);
  const [copied, setCopied] = useState<"yes" | "no">();
  const card = useRef<HTMLDivElement>(null);
  const [projecting, setProjecting] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  };

  const project = () => {
    // Shown first, so the full-screen request (which needs this click) finds it on the page.
    flushSync(() => setProjecting(true));
    card.current?.requestFullscreen?.().catch(() => {
      // Full screen refused: the card still covers the page until closed.
    });
  };

  useEffect(() => {
    if (!projecting) return;
    // Leaving full screen (Escape, or the browser's own exit) closes the card.
    const left = () => {
      if (!document.fullscreenElement) setProjecting(false);
    };
    document.addEventListener("fullscreenchange", left);
    return () => document.removeEventListener("fullscreenchange", left);
  }, [projecting]);

  const stop = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    setProjecting(false);
  };

  return (
    <section className="panel invite" aria-labelledby="invite-heading">
      <h2 id="invite-heading" className="panel-title">
        Invite
      </h2>
      <div className="invite-body">
        <QrCode text={url} label={`QR code for ${url}`} />
        <div className="invite-text">
          <p className="invite-room">{room}</p>
          <p className="muted small invite-url">{url}</p>
          <div className="row">
            <Button label="Copy link" size="sm" clickAction={copy} />
            <Button label="Show full screen" size="sm" variant="secondary" onClick={project} />
          </div>
          <p className="muted small" role="status">
            {copied === "yes" ? "Link copied." : copied === "no" ? "Could not copy; select the link above." : ""}
          </p>
        </div>
      </div>
      <div
        ref={card}
        className={projecting ? "invite-card open" : "invite-card"}
        hidden={!projecting}
        onClick={stop}
        onKeyDown={(e) => e.key === "Escape" && stop()}
        role="dialog"
        aria-label="Invitation to project"
      >
        <p className="invite-card-lead">Join the talk</p>
        <QrCode text={url} label={`QR code for ${url}`} />
        <p className="invite-card-room">{room}</p>
        <p className="invite-card-url">{url}</p>
        <p className="invite-card-hint">Click or press Escape to close</p>
      </div>
    </section>
  );
}
