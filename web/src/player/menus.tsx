// The control bar's menus (ui-design §3.1, §4.1–§4.2, §4.7): subtitles (one list with type-ahead) and layout. Each
// is a small dialog of ordinary buttons, so Tab reaches everything.

import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { guardOf } from "../package/download";
import { MoqHistorySource } from "../playback/moqSource";
import { MoqTransport } from "../transport/moq";
import type { Transport } from "../transport/types";
import { usePlayer } from "./context";
import { fold, languageOption, searchLanguages, SUPPORTED_LANGUAGES } from "./languages";
import { type BoardKind, type LayoutKind } from "./prefs";
import { StatsFeed } from "./roomStats";
import { effectiveLayout, stageSources } from "./Stage";
import { type LanguageReadiness, languageReadiness, translationFor } from "./tracks";

/** The quiet note beside a language the room already has: it shows at once. */
const READINESS_NOTE: Record<LanguageReadiness, string | undefined> = {
  running: "running",
  recorded: "recorded",
  "on-request": undefined,
  absent: undefined,
};

/** Keys typed this close together make one type-ahead prefix, ms. */
const TYPE_AHEAD_MS = 800;

/**
 * The tracks the room's stats track lists as running (decision 0028), read while the subtitles menu is open; undefined
 * without a relay or before the first snapshot.
 */
function useStatsRunning(transport: Transport | undefined, room: string): ReadonlySet<string> | undefined {
  const feed = useMemo(
    () => (transport instanceof MoqTransport ? new StatsFeed(new MoqHistorySource(transport), room) : undefined),
    [transport, room],
  );
  useEffect(() => {
    feed?.start();
    return () => feed?.stop();
  }, [feed]);
  useSyncExternalStore(feed?.subscribe ?? (() => () => {}), feed?.getVersion ?? (() => 0));
  const stats = feed?.view().stats;
  return useMemo(
    () =>
      stats
        ? new Set(stats.tracks.filter((t) => t.state === "running").map((t) => `${t.namespace}/${t.name}`))
        : undefined,
    [stats],
  );
}

function Menu({
  label,
  children,
  wide,
  typeAhead,
  onKeyDown,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  /** Letters typed in it are its own (type-ahead), never the player's shortcuts (typing.ts). */
  typeAhead?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus moves into the menu when it opens, onto its first control, and back to where it was (the menu's
    // button) when it closes, unless the viewer has moved it elsewhere since.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = ref.current;
    menu?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      if (before?.isConnected && (!now || now === document.body || menu?.contains(now)))
        before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      ref={ref}
      className={`tt-menu${wide ? " tt-menu-wide" : ""}`}
      role="dialog"
      aria-label={label}
      data-type-ahead={typeAhead ? "" : undefined}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

function Choice({
  checked,
  onClick,
  children,
  sub,
  lang,
}: {
  checked: boolean;
  onClick: () => void;
  children: ReactNode;
  sub?: string;
  /** The language this row picks, for type-ahead. */
  lang?: string;
}) {
  return (
    <button type="button" className="tt-menu-item" aria-pressed={checked} onClick={onClick} data-lang={lang}>
      <span>{children}</span>
      {sub ? <span className="tt-menu-sub">{sub}</span> : null}
    </button>
  );
}

/**
 * Subtitles: one list, Off, the original, then every supported language A to Z (owner, 11-04). Typing while it is open
 * jumps to the first language whose name starts with what was typed; the arrow keys move along the list.
 */
export function CaptionsMenu() {
  const ctx = usePlayer();
  const { prefs, update, tracks } = ctx;
  const original = tracks.captions;
  const originalLang = original?.lang ?? "en";
  const originalName = languageOption(originalLang).local;
  const statsRunning = useStatsRunning(ctx.transport, ctx.roomName);
  const guard = guardOf(ctx);
  const readiness = (tag: string) => languageReadiness(translationFor(tracks, tag), guard, statsRunning);
  const roomKey = tracks.translations
    .map((t) => t.lang)
    .filter(Boolean)
    .join(" ");
  // Every supported language, a room's regional tag in its language's place, by its name in the viewer's language.
  const options = useMemo(() => {
    const room = roomKey ? roomKey.split(" ") : [];
    const base = (tag: string) => tag.split("-")[0]!;
    const extra = room.filter((tag) => !SUPPORTED_LANGUAGES.some((s) => s === tag || s === base(tag)));
    const inRoom = (tag: string) => room.find((r) => r !== tag && base(r) === tag) ?? tag;
    return [...new Set([...SUPPORTED_LANGUAGES.map(inRoom), ...extra])]
      .filter((tag) => base(tag) !== base(originalLang))
      .map((tag) => languageOption(tag))
      .sort((a, b) => a.local.localeCompare(b.local));
  }, [roomKey, originalLang]);
  const pick = (lang: string) => update({ cc: true, subtitleLang: lang });
  const typed = useRef({ text: "", at: 0 });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const menu = e.currentTarget;
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".tt-menu-item")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => {
      const item = items[Math.max(0, Math.min(items.length - 1, i))];
      item?.focus({ preventScroll: true });
      item?.scrollIntoView?.({ block: "nearest" });
    };
    if (e.key === "ArrowDown" || e.key === "ArrowUp") move(at + (e.key === "ArrowDown" ? 1 : -1));
    else if (e.key === "Home" || e.key === "End") move(e.key === "Home" ? 0 : items.length - 1);
    else if (e.key.length === 1 && e.key !== " ") {
      const t = typed.current;
      const now = Date.now();
      t.text = now - t.at < TYPE_AHEAD_MS ? t.text + e.key : e.key;
      t.at = now;
      const q = fold(t.text);
      const hit = searchLanguages(options, t.text).find(
        (o) => fold(o.local).startsWith(q) || fold(o.autonym).startsWith(q),
      );
      const button = hit && items.find((b) => b.dataset.lang === hit.tag);
      if (button) move(items.indexOf(button));
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Menu label="Subtitles" wide typeAhead onKeyDown={onKeyDown}>
      <Choice checked={!prefs.cc} onClick={() => update({ cc: false })}>
        Off
      </Choice>
      <Choice
        checked={prefs.cc && prefs.subtitleLang === "original"}
        onClick={() => pick("original")}
        sub={original ? undefined : "not in this room yet"}
      >
        Original ({originalName})
      </Choice>
      {options.map((o) => (
        <Choice
          key={o.tag}
          lang={o.tag}
          checked={prefs.cc && prefs.subtitleLang === o.tag}
          onClick={() => pick(o.tag)}
          sub={READINESS_NOTE[readiness(o.tag)]}
        >
          {o.local}
          {o.local !== o.autonym ? (
            <span className="tt-menu-local">
              {" · "}
              <span lang={o.tag} dir={o.dir}>
                {o.autonym}
              </span>
            </span>
          ) : null}
        </Choice>
      ))}
    </Menu>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The stage's layout. The labels name the pictures there are: the slides, a shared screen, the camera. While a screen
 * is shared the slides stay on offer, and the listener picks which of the two is the main picture.
 */
export function LayoutMenu() {
  const { prefs, update, sources, setUi } = usePlayer();
  const placed = stageSources(sources, prefs.board);
  const layout = effectiveLayout(prefs.layout, placed);
  const main = placed.at(-1) ?? "slides";
  const corner = placed.length > 1 ? placed[0]! : "camera";
  const boards = (["screen", "slides"] as const).filter((k) => sources.includes(k));
  const close = () => setUi({ menu: undefined });
  const layouts: [LayoutKind, string][] = [
    ["pip", `${capital(main)}, ${corner} in a corner`],
    ["split", "Side by side"],
    ["single", "One at a time"],
  ];
  const pickBoard = (board: BoardKind) => update({ board, single: board });
  return (
    <Menu label="Layout">
      {layouts.map(([value, label]) => (
        <Choice
          key={value}
          checked={layout === value}
          onClick={() => {
            update({ layout: value });
            close();
          }}
        >
          {label}
        </Choice>
      ))}
      {layout === "single" ? (
        <>
          <span className="tt-menu-heading">Show</span>
          {boards.map((k) => (
            <Choice key={k} checked={prefs.single !== "camera" && main === k} onClick={() => pickBoard(k)}>
              {capital(k)}
            </Choice>
          ))}
          {sources.includes("camera") ? (
            <Choice checked={prefs.single === "camera"} onClick={() => update({ single: "camera" })}>
              Camera
            </Choice>
          ) : null}
        </>
      ) : (
        <>
          {boards.length > 1 ? (
            <>
              <span className="tt-menu-heading">Main picture</span>
              {boards.map((k) => (
                <Choice key={k} checked={main === k} onClick={() => pickBoard(k)}>
                  {capital(k)}
                </Choice>
              ))}
            </>
          ) : null}
          <button type="button" className="tt-menu-item" onClick={() => update({ swap: !prefs.swap })}>
            Swap {corner} and {main}
          </button>
        </>
      )}
    </Menu>
  );
}
