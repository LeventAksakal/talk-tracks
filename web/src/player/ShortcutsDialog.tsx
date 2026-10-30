import { useEffect, useRef } from "react";

export const SHORTCUTS: [string, string][] = [
  ["Space or K", "Play or pause"],
  ["← / →", "Back or forward 5 s"],
  ["J / L", "Back or forward 10 s"],
  ["G", "Go live"],
  ["C", "Subtitles on or off"],
  ["[ / ]", "Smaller or larger subtitles"],
  ["S", "Side panel"],
  ["F", "Full screen"],
  ["B", "Bookmark this moment"],
  ["N", "Write a note"],
  ["/", "Search the transcript"],
  ["?", "These shortcuts"],
];

/** The keyboard shortcuts of ui-design §4.10, from Settings or `?`. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => before?.focus?.();
  }, []);
  return (
    <div className="tt-dialog-backdrop" onClick={onClose}>
      <div
        className="tt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tt-shortcuts-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="tt-shortcuts-title">Keyboard shortcuts</h2>
        <dl className="tt-shortcuts">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <button ref={close} type="button" className="tt-button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
