import { useEffect, useRef } from "react";

export const SHORTCUTS: [string, string][] = [
  ["Space or K", "Play or pause"],
  ["J / L or ← / →", "Back or forward 10 s"],
  ["← / → or PgUp / PgDn", "Previous or next slide (in the slide controls)"],
  ["↑ / ↓", "Louder or quieter"],
  ["M", "Mute"],
  ["< / >", "Slower or faster (rewound)"],
  ["G", "Go live"],
  ["C", "Subtitles on or off"],
  ["[ / ]", "Smaller or larger subtitles"],
  ["F or double-click", "Full screen"],
  ["/", "Search the transcript"],
  ["I or right-click", "Stats for nerds"],
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
