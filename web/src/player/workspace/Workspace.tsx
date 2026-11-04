import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../icons";
import {
  activate,
  applyView,
  close,
  DEFAULT_PRESET,
  dock,
  float,
  type FloatBox,
  forgetLayout,
  isPicture,
  type Layout,
  moveFloat,
  open,
  type PanelId,
  PANELS,
  preset,
  type PresetId,
  PRESETS,
  promote,
  readLayout,
  resizeZone,
  resolve,
  setShare,
  setSplit,
  togglePanel,
  visible,
  writeLayout,
  type Zone,
  ZONES,
} from "./layout";

/** Each stream's icon (its tile's name label, the view thumbnails). */
export const STREAM_ICON: Record<string, IconName> = { slides: "slides", screen: "screen", camera: "camera" };
import "./workspace.css";

/** The workspace as the rest of the player sees it: what is open and on screen, and the moves. */
export interface WorkspaceApi {
  /** The saved layout. */
  layout: Layout;
  /** The layout as shown here: only the panels this room has (layout.resolve). */
  shown: Layout;
  /** The panels on screen (a front tab, a split zone's panels, the windows). */
  visible: ReadonlySet<PanelId>;
  /** The panels this room has, in menu order. */
  available: readonly PanelId[];
  label(id: PanelId): string;
  change(move: (l: Layout) => Layout): void;
  /** Open a panel (where it was last docked) and bring it to the front. */
  open(id: PanelId): void;
  /** A side panel button: show a reading panel in the right-hand card, or close it when it is on screen. */
  togglePanel(id: PanelId): void;
  /** Adjust view: arrange the streams as a view does. */
  preset(id: PresetId): void;
  /** Back to the default layout, and forget the saved one. */
  reset(): void;
}

/** The workspace's state for a room: kept per browser, resolved against the panels the room has. */
export function useWorkspace(available: readonly PanelId[], labels: Readonly<Record<string, string>>): WorkspaceApi {
  const [layout, setLayout] = useState(readLayout);
  const saved = useRef(false);
  useEffect(() => {
    // The first render is what was read: write only what the viewer changes.
    if (!saved.current) {
      saved.current = true;
      return;
    }
    writeLayout(layout);
  }, [layout]);
  const key = available.join(",");
  const shown = useMemo(() => resolve(layout, new Set(available)), [layout, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScreen = useMemo(() => visible(shown), [shown]);
  const change = useCallback((move: (l: Layout) => Layout) => setLayout((l) => move(l)), []);
  return useMemo(
    () => ({
      layout,
      shown,
      visible: onScreen,
      available,
      label: (id) => labels[id] ?? PANELS.find((p) => p.id === id)?.label ?? id,
      change,
      open: (id) => setLayout((l) => open(l, id)),
      togglePanel: (id) => setLayout((l) => togglePanel(l, id, onScreen)),
      preset: (id) => setLayout((l) => applyView(l, id)),
      reset: () => {
        forgetLayout();
        saved.current = false;
        setLayout(preset(DEFAULT_PRESET));
      },
    }),
    [layout, shown, onScreen, available, labels, change],
  );
}

/** A drag of a panel by its tab or title: a dock target under the pointer, or a spot to float it at. */
interface Drag {
  id: PanelId;
  pointer: number;
  startX: number;
  startY: number;
  /** The pointer, as fractions of the workspace. */
  fx: number;
  fy: number;
  moved: boolean;
  /** A floating window's grab point inside it, as fractions of the workspace. */
  grab?: { dx: number; dy: number };
}

/** The dock target at a point of the workspace (fractions), or undefined: float there. */
export function dropTarget(fx: number, fy: number): Zone | undefined {
  if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return undefined;
  if (fx < 0.14) return "left";
  if (fx > 0.86) return "right";
  if (fy > 0.8) return "bottom";
  if (fx > 0.32 && fx < 0.68 && fy > 0.28 && fy < 0.62) return "centre";
  return undefined;
}

const ZONE_NAME: Record<Zone, string> = { left: "left", centre: "centre", right: "right", bottom: "bottom" };
const ZONE_LABEL: Record<Zone, string> = { left: "Left", centre: "Centre", right: "Right", bottom: "Bottom" };

/**
 * The workspace: the zones with their panels, the floating windows, and a drag to move a panel. Each panel's content
 * is rendered once into a host element of its own that the panel's place adopts, so moving a panel (a dock, a tab, a
 * float) moves the same DOM: the camera's live picture and its sound never restart. A picture whose panel is closed
 * stays mounted, unseen: a recording's sound comes from the camera's element.
 */
export function Workspace({
  api,
  content,
  overlay,
  overlayRef,
  onCaption,
  aspects = {},
}: {
  api: WorkspaceApi;
  content: Readonly<Record<string, ReactNode>>;
  /** The pictures' shapes (width / height), for a floating window of the picture's own shape. */
  aspects?: Readonly<Record<string, number>>;
  /** Over the main picture: the subtitles and notices that belong to the talk's picture. */
  overlay?: ReactNode;
  overlayRef?: RefObject<HTMLDivElement | null>;
  /** Told which panel holds the overlay. */
  onCaption?: (id: PanelId | undefined) => void;
}) {
  const { shown, change } = api;
  const root = useRef<HTMLDivElement>(null);
  const park = useRef<HTMLDivElement>(null);
  const [hosts] = useState(() => new Map<PanelId, HTMLDivElement>());
  const host = useCallback(
    (id: PanelId) => {
      let h = hosts.get(id);
      if (!h) {
        h = document.createElement("div");
        h.className = "tt-ws-host";
        h.dataset.panel = id;
        hosts.set(id, h);
      }
      return h;
    },
    [hosts],
  );
  // A host no place has adopted (a closed picture, a panel just made) waits in the park, in the document.
  useLayoutEffect(() => {
    for (const h of hosts.values()) if (!h.parentElement) park.current?.appendChild(h);
  });
  const [menu, setMenu] = useState<PanelId>();
  const [drag, setDrag] = useState<Drag>();
  // The drag as the pointer handlers see it (state is for drawing it).
  const dragRef = useRef<Drag | undefined>(undefined);
  const setDragBoth = useCallback((d: Drag | undefined) => {
    dragRef.current = d;
    setDrag(d);
  }, []);

  // The picture the subtitles sit over: the centre's picture in front, else any picture on screen.
  const main = mainPicture(shown);
  useEffect(() => onCaption?.(main), [main, onCaption]);

  // A menu closes on a press outside it.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-ws-menu]")) setMenu(undefined);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  const frac = (x: number, y: number) => {
    const r = root.current?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height } : undefined;
  };

  const startDrag = (id: PanelId, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const win = shown.floating.find((f) => f.id === id);
    const at = frac(e.clientX, e.clientY);
    if (!at) return;
    const grab = win ? { dx: at.fx - win.x, dy: at.fy - win.y } : undefined;
    setDragBoth({ id, pointer: e.pointerId, startX: e.clientX, startY: e.clientY, ...at, moved: false, grab });
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointer) return;
      const moved = d.moved || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6;
      const at = frac(e.clientX, e.clientY);
      if (!at) return;
      setDragBoth({ ...d, ...at, moved });
      if (moved && d.grab) {
        const win = shown.floating.find((f) => f.id === d.id);
        if (win) change((l) => moveFloat(l, { ...win, x: at.fx - d.grab!.dx, y: at.fy - d.grab!.dy }));
      }
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointer) return;
      setDragBoth(undefined);
      if (!d.moved) return;
      const at = frac(e.clientX, e.clientY);
      if (!at) return;
      const target = dropTarget(at.fx, at.fy);
      if (target) change((l) => dock(l, d.id, target));
      else if (!d.grab) {
        const pic = isPicture(d.id);
        const w = pic ? 0.2 : 0.26;
        const h = pic ? 0.28 : 0.5;
        change((l) => float(l, d.id, { x: at.fx - w / 2, y: at.fy - 0.02, w, h }));
      }
    };
    const cancel = () => setDragBoth(undefined);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    // Bound once per drag: the latest drag is read through dragRef.
  }, [drag?.id, drag?.pointer]); // eslint-disable-line react-hooks/exhaustive-deps

  const paneProps = { api, host, park, menu, setMenu, startDrag, overlay, overlayRef, main };
  const hover = drag?.moved ? drag : undefined;
  const target = hover ? dropTarget(hover.fx, hover.fy) : undefined;
  const sideW = (z: "left" | "right") => (shown.zones[z].panels.length ? shown.size[z] : 0);

  return (
    <div
      ref={root}
      className={`tt-ws${drag?.moved ? " tt-ws-dragging" : ""}`}
      style={
        {
          "--ws-left": `${sideW("left")}px`,
          "--ws-right": `${sideW("right")}px`,
          "--ws-bottom": `${shown.zones.bottom.panels.length ? shown.size.bottom : 0}px`,
        } as CSSProperties
      }
    >
      {ZONES.map((z) => (
        <ZoneView key={z} zone={z} {...paneProps} />
      ))}
      {shown.floating.map((f, i) => (
        <FloatWindow
          key={f.id}
          box={f}
          top={i === shown.floating.length - 1}
          aspect={aspects[f.id]}
          {...paneProps}
          root={root}
        />
      ))}
      {drag?.moved ? (
        <div className="tt-ws-drop" aria-hidden="true">
          {ZONES.map((z) => (
            <span key={z} className="tt-ws-target" data-zone={z} data-over={target === z ? "" : undefined}>
              <span className="tt-ws-chip">Dock {ZONE_NAME[z]}</span>
            </span>
          ))}
          {!target && !drag.grab && hover ? (
            <span className="tt-ws-ghost" style={{ left: `${hover.fx * 100}%`, top: `${hover.fy * 100}%` }}>
              <span className="tt-ws-chip">Float here</span>
            </span>
          ) : null}
        </div>
      ) : null}
      <div ref={park} className="tt-ws-park" hidden />
      {[...new Set([...api.available, ...Object.keys(content)])].map((id) =>
        content[id] !== undefined && (isPicture(id) || placed(shown, id))
          ? createPortal(content[id], host(id), id)
          : null,
      )}
    </div>
  );
}

const placed = (l: Layout, id: PanelId) =>
  ZONES.some((z) => l.zones[z].panels.includes(id)) || l.floating.some((f) => f.id === id);

/** The picture that carries the subtitles: the centre's picture on screen first, then any docked, then a window. */
export function mainPicture(l: Layout): PanelId | undefined {
  const on = visible(l);
  const docked = (["centre", "left", "right", "bottom"] as const).flatMap((z) =>
    l.zones[z].panels.filter((p) => isPicture(p) && on.has(p)),
  );
  const rank = (id: PanelId) => ["slides", "screen", "camera"].indexOf(id);
  const centre = docked.filter((p) => l.zones.centre.panels.includes(p)).sort((a, b) => rank(a) - rank(b));
  return centre[0] ?? docked[0] ?? l.floating.find((f) => isPicture(f.id))?.id;
}

interface PaneProps {
  api: WorkspaceApi;
  host: (id: PanelId) => HTMLDivElement;
  park: RefObject<HTMLDivElement | null>;
  menu: PanelId | undefined;
  setMenu: (id: PanelId | undefined) => void;
  startDrag: (id: PanelId, e: ReactPointerEvent<HTMLElement>) => void;
  overlay?: ReactNode;
  overlayRef?: RefObject<HTMLDivElement | null>;
  main: PanelId | undefined;
}

function ZoneView({ zone: z, ...p }: PaneProps & { zone: Zone }) {
  const { api } = p;
  const s = api.shown.zones[z];
  if (s.panels.length === 0)
    return z === "centre" ? (
      <section className="tt-ws-zone tt-ws-empty" data-zone="centre">
        <p>Nothing on the stage. Pick a view from More options, Adjust view.</p>
      </section>
    ) : null;
  const edge = z === "left" ? "right" : z === "right" ? "left" : z === "bottom" ? "top" : undefined;
  const split = s.split && s.panels.length > 1;
  const resizer = edge ? (
    <Resizer
      edge={edge}
      label={`Resize the ${z} panels`}
      value={api.shown.size[z as "left" | "right" | "bottom"]}
      onChange={(px) => api.change((l) => resizeZone(l, z as "left" | "right" | "bottom", px))}
    />
  ) : null;
  const tabbed = s.panels.length > 1;
  // Arrow keys walk the tabs (and show each), Home and End go to the ends.
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = s.panels.indexOf(s.active ?? s.panels[0]!);
    const n = s.panels.length;
    const next =
      e.key === "ArrowRight"
        ? i + 1
        : e.key === "ArrowLeft"
          ? i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const id = s.panels[(next + n) % n]!;
    api.change((l) => activate(l, z, id));
    document.getElementById(`tt-ws-tab-${id}`)?.focus();
  };
  if (split) {
    const two = s.panels.length === 2;
    const strip = s.strip === true;
    const across = z === "centre" || z === "bottom";
    const pane = (id: PanelId, i: number) => (
      <Pane key={id} id={id} zone={z} {...p}>
        {two && i === 0 && !strip ? (
          <ShareDivider
            across={across}
            share={s.share}
            label={`Resize ${api.label(s.panels[0]!)} and ${api.label(s.panels[1]!)}`}
            onChange={(v) => api.change((l) => setShare(l, z, v))}
          />
        ) : null}
      </Pane>
    );
    return (
      <section
        className="tt-ws-zone"
        data-zone={z}
        data-split=""
        data-strip={strip ? "" : undefined}
        data-count={s.panels.length}
        data-across={across ? "" : undefined}
        style={two && !strip ? ({ "--ws-share": s.share } as CSSProperties) : undefined}
        data-two={two && !strip ? "" : undefined}
      >
        {strip ? (
          <>
            {pane(s.panels[0]!, 0)}
            <div className="tt-ws-strip">{s.panels.slice(1).map((id, i) => pane(id, i + 1))}</div>
          </>
        ) : (
          s.panels.map(pane)
        )}
        {resizer}
      </section>
    );
  }
  const tabs = tabbed ? (
    <div className="tt-ws-tabs" role="tablist" aria-label={`${ZONE_LABEL[z]} panels`} onKeyDown={onTabKey}>
      {s.panels.map((id) => (
        <button
          key={id}
          id={`tt-ws-tab-${id}`}
          type="button"
          role="tab"
          className="tt-ws-tab"
          aria-selected={s.active === id}
          aria-controls={`tt-ws-panel-${id}`}
          tabIndex={s.active === id ? 0 : -1}
          data-panel={id}
          data-stream={isPicture(id) ? id : undefined}
          title="Drag to dock or float"
          onPointerDown={(e) => p.startDrag(id, e)}
          onClick={() => api.change((l) => activate(l, z, id))}
        >
          {isPicture(id) ? <Icon name={STREAM_ICON[id] ?? "slides"} /> : null}
          {api.label(id)}
        </button>
      ))}
    </div>
  ) : null;
  // A zone of streams shown one at a time (Spotlight): a tile, the others' names as chips over its top edge.
  const active = s.active ?? s.panels[0]!;
  if (isPicture(active) && s.panels.every(isPicture))
    return (
      <section className="tt-ws-zone tt-ws-tile" data-zone={z} data-stream={active} data-panel={active}>
        {s.panels.map((id) => (
          <PaneBody key={id} id={id} hidden={s.active !== id} tab={tabbed} {...p} />
        ))}
        {tabs ? <div className="tt-ws-chips">{tabs}</div> : null}
        <TileLabel id={active} {...p} />
        <span className="tt-ws-tile-actions">
          <PaneActions id={active} zone={z} {...p} />
        </span>
        {resizer}
      </section>
    );
  // A reading panel: Meet's side panel card, its title and a close button.
  return (
    <section className="tt-ws-zone tt-ws-card" data-zone={z}>
      <div className="tt-ws-head">
        {tabs ?? (
          <h2 className="tt-ws-title" onPointerDown={(e) => p.startDrag(s.panels[0]!, e)} title="Drag to dock or float">
            {api.label(s.panels[0]!)}
          </h2>
        )}
        {s.active ? <PaneActions id={s.active} zone={z} {...p} /> : null}
      </div>
      {s.panels.map((id) => (
        <PaneBody key={id} id={id} hidden={s.active !== id} tab={tabbed} {...p} />
      ))}
      {resizer}
    </section>
  );
}

/** A stream's name, bottom left of its tile (Meet's participant name); drag it to dock or float the stream. */
function TileLabel({ id, api, startDrag }: PaneProps & { id: PanelId }) {
  return (
    <span
      className="tt-ws-label"
      data-stream={id}
      onPointerDown={(e) => startDrag(id, e)}
      title="Drag to dock or float"
    >
      <Icon name={STREAM_ICON[id] ?? "slides"} />
      {api.label(id)}
    </span>
  );
}

/** A split zone's panel: a stream's tile (framed in its colour, its name bottom left), or a panel with a title bar. */
function Pane({ id, zone: z, children, ...p }: PaneProps & { id: PanelId; zone: Zone; children?: ReactNode }) {
  if (isPicture(id))
    return (
      <div className="tt-ws-pane tt-ws-tile" data-panel={id} data-stream={id}>
        <PaneBody id={id} hidden={false} tab={false} {...p} />
        <TileLabel id={id} {...p} />
        <span className="tt-ws-tile-actions">
          <PaneActions id={id} zone={z} {...p} />
        </span>
        {children}
      </div>
    );
  return (
    <div className="tt-ws-pane" data-panel={id}>
      <div className="tt-ws-head">
        <span className="tt-ws-title" onPointerDown={(e) => p.startDrag(id, e)} title="Drag to dock or float">
          {p.api.label(id)}
        </span>
        <PaneActions id={id} zone={z} {...p} />
      </div>
      <PaneBody id={id} hidden={false} tab={false} {...p} />
      {children}
    </div>
  );
}

/** Where a panel's host is adopted; the main picture also holds the overlay (the subtitles). */
function PaneBody({ id, hidden, tab, ...p }: PaneProps & { id: PanelId; hidden: boolean; tab: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  const { host, park, overlayRef } = p;
  useLayoutEffect(() => {
    const el = slot.current;
    const lot = park.current;
    const h = host(id);
    if (!el) return;
    el.prepend(h);
    return () => {
      // Back to the park, in the document: a picture keeps playing (and sounding) until a place adopts it again.
      if (h.parentElement === el) lot?.appendChild(h);
    };
  }, [id, host, park]);
  const picture = isPicture(id);
  const isMain = p.main === id && !hidden;
  // The subtitles are dragged as fractions of the main picture's panel.
  useLayoutEffect(() => {
    if (isMain && overlayRef) overlayRef.current = slot.current;
  }, [isMain, overlayRef]);
  return (
    <div
      ref={slot}
      className={`tt-ws-body${picture ? " tt-cell" : " tt-tabpanel"}`}
      data-picture={picture ? "" : undefined}
      data-panel={id}
      id={tab ? `tt-ws-panel-${id}` : undefined}
      role={tab ? "tabpanel" : picture ? undefined : "region"}
      aria-labelledby={tab ? `tt-ws-tab-${id}` : undefined}
      aria-label={tab || picture ? undefined : p.api.label(id)}
      hidden={hidden}
    >
      {isMain ? p.overlay : null}
    </div>
  );
}

function PaneActions({ id, zone: z, api, menu, setMenu }: PaneProps & { id: PanelId; zone: Zone | "floating" }) {
  const label = api.label(id);
  const s = z === "floating" ? undefined : api.shown.zones[z];
  const run = (move: (l: Layout) => Layout) => {
    api.change(move);
    setMenu(undefined);
  };
  const picture = isPicture(id);
  return (
    <span className="tt-ws-actions" data-ws-menu="">
      <button
        type="button"
        className="tt-icon-button tt-small"
        aria-label={`Move ${label}`}
        title={`Move ${label}`}
        aria-haspopup="menu"
        aria-expanded={menu === id}
        onClick={() => setMenu(menu === id ? undefined : id)}
      >
        <Icon name="more" />
      </button>
      <button
        type="button"
        className="tt-icon-button tt-small"
        aria-label={`Close ${label}`}
        title={`Close ${label}`}
        onClick={() => api.change((l) => close(l, id))}
      >
        <Icon name="close" />
      </button>
      {menu === id ? (
        <div className="tt-ws-menu" role="menu" aria-label={`Move ${label}`}>
          {picture && s?.split && s.panels.length > 1 && s.panels[0] !== id ? (
            <button type="button" role="menuitem" onClick={() => run((l) => promote(l, id))}>
              Show large
            </button>
          ) : null}
          {ZONES.filter((x) => x !== z).map((x) => (
            <button key={x} type="button" role="menuitem" onClick={() => run((l) => dock(l, id, x))}>
              Dock {ZONE_NAME[x]}
            </button>
          ))}
          {z !== "floating" ? (
            <button type="button" role="menuitem" onClick={() => run((l) => float(l, id))}>
              Float in a small window
            </button>
          ) : null}
          {s && s.panels.length > 1 ? (
            <button type="button" role="menuitem" onClick={() => run((l) => setSplit(l, z as Zone, !s.split))}>
              {s.split ? "Show this side as tabs" : "Show this side side by side"}
            </button>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

function FloatWindow({
  box,
  top,
  root,
  aspect,
  ...p
}: PaneProps & { box: FloatBox; top: boolean; aspect: number | undefined; root: RefObject<HTMLDivElement | null> }) {
  const picture = isPicture(box.id);
  // A picture's window is as tall as a 16:9 one of its width, and as wide as the picture's own shape: a narrow webcam
  // crop is a narrow window, never a strip in a wide black one.
  const ar = picture && aspect && Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const size = useRef<{ x: number; y: number; w: number; h: number; pointer: number } | undefined>(undefined);
  const resize = (e: ReactPointerEvent<HTMLElement>) => {
    const s = size.current;
    const r = root.current?.getBoundingClientRect();
    if (!s || !r || e.pointerId !== s.pointer) return;
    p.api.change((l) =>
      moveFloat(l, {
        ...box,
        w: s.w + (e.clientX - s.x) / r.width,
        h: s.h + (e.clientY - s.y) / r.height,
      }),
    );
  };
  return (
    <div
      className={`tt-ws-float${picture ? " tt-ws-tile" : ""}`}
      data-panel={box.id}
      data-stream={picture ? box.id : undefined}
      data-picture={picture ? "" : undefined}
      data-top={top ? "" : undefined}
      role="dialog"
      aria-label={`${p.api.label(box.id)} (floating)`}
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: picture ? `calc(${box.w * 100}% * ${Math.min(1, (ar * 9) / 16)})` : `${box.w * 100}%`,
        height: picture ? undefined : `${box.h * 100}%`,
        ...({ "--ws-ar": ar } as CSSProperties),
      }}
    >
      {picture ? (
        <>
          <PaneBody id={box.id} hidden={false} tab={false} {...p} />
          <TileLabel id={box.id} {...p} />
          <span className="tt-ws-tile-actions">
            <PaneActions id={box.id} zone="floating" {...p} />
          </span>
        </>
      ) : (
        <>
          <div className="tt-ws-head">
            <span className="tt-ws-title" onPointerDown={(e) => p.startDrag(box.id, e)} title="Drag to move or dock">
              {p.api.label(box.id)}
            </span>
            <PaneActions id={box.id} zone="floating" {...p} />
          </div>
          <PaneBody id={box.id} hidden={false} tab={false} {...p} />
        </>
      )}
      <span
        className="tt-ws-grip"
        title="Drag to resize"
        aria-hidden="true"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          size.current = { x: e.clientX, y: e.clientY, w: box.w, h: box.h, pointer: e.pointerId };
        }}
        onPointerMove={resize}
        onPointerUp={() => (size.current = undefined)}
        onPointerCancel={() => (size.current = undefined)}
      />
    </div>
  );
}

/** A zone's inner edge: drag, or arrow keys when focused, to resize it. */
function Resizer({
  edge,
  label,
  value,
  onChange,
}: {
  edge: "left" | "right" | "top";
  label: string;
  value: number;
  onChange: (px: number) => void;
}) {
  const from = useRef<{ at: number; value: number; pointer: number } | undefined>(undefined);
  const sign = edge === "right" ? 1 : -1;
  const vertical = edge !== "top";
  const onKey = (e: ReactKeyboardEvent) => {
    const step = { ArrowLeft: -16, ArrowRight: 16, ArrowUp: -16, ArrowDown: 16 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(value + step * sign);
  };
  return (
    <div
      className="tt-ws-resizer"
      data-edge={edge}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        from.current = { at: vertical ? e.clientX : e.clientY, value, pointer: e.pointerId };
      }}
      onPointerMove={(e) => {
        const f = from.current;
        if (!f || e.pointerId !== f.pointer) return;
        onChange(f.value + ((vertical ? e.clientX : e.clientY) - f.at) * sign);
      }}
      onPointerUp={() => (from.current = undefined)}
      onPointerCancel={() => (from.current = undefined)}
    />
  );
}

/** The divider between a split zone's two panels. */
function ShareDivider({
  across,
  share,
  label,
  onChange,
}: {
  across: boolean;
  share: number;
  label: string;
  onChange: (share: number) => void;
}) {
  const drag = useRef<number | undefined>(undefined);
  return (
    <div
      className="tt-ws-share"
      data-across={across ? "" : undefined}
      role="separator"
      aria-orientation={across ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = { ArrowLeft: -0.05, ArrowRight: 0.05, ArrowUp: -0.05, ArrowDown: 0.05 }[e.key];
        if (step === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        onChange(share + step);
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = e.pointerId;
      }}
      onPointerMove={(e) => {
        if (drag.current !== e.pointerId) return;
        const zone = e.currentTarget.closest(".tt-ws-zone")?.getBoundingClientRect();
        if (!zone || zone.width === 0 || zone.height === 0) return;
        onChange(across ? (e.clientX - zone.left) / zone.width : (e.clientY - zone.top) / zone.height);
      }}
      onPointerUp={() => (drag.current = undefined)}
      onPointerCancel={() => (drag.current = undefined)}
    />
  );
}

/**
 * Adjust view (Google Meet's dialog, from More options): the four views, each with a small drawing of its stage, the
 * one shown checked; a reset. Picking a view arranges the streams at once and leaves the dialog open, as Meet does,
 * so the viewer sees each one before closing it.
 */
export function AdjustView({ api, onDone }: { api: WorkspaceApi; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = ref.current;
    (box?.querySelector<HTMLElement>("[aria-checked='true']") ?? box?.querySelector<HTMLElement>("button"))?.focus({
      preventScroll: true,
    });
    return () => {
      const now = document.activeElement;
      if (before?.isConnected && (!now || now === document.body || box?.contains(now)))
        before.focus({ preventScroll: true });
    };
  }, []);
  const current = api.layout.view;
  // Arrow keys move the pick through the views, as in any radio group.
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const i = PRESETS.findIndex((p) => p.id === current);
    const next = PRESETS[(i + step + PRESETS.length) % PRESETS.length]!;
    api.preset(next.id);
    ref.current?.querySelector<HTMLElement>(`[data-preset='${next.id}']`)?.focus();
  };
  return (
    <div ref={ref} className="tt-view-dialog" role="dialog" aria-labelledby="tt-view-title" data-menu-root="">
      <div className="tt-view-head">
        <h2 id="tt-view-title">Adjust view</h2>
        <button type="button" className="tt-icon-button" aria-label="Close Adjust view" onClick={onDone}>
          <Icon name="close" />
        </button>
      </div>
      <p className="tt-view-sub">Your choice is kept on this device.</p>
      <div className="tt-view-options" role="radiogroup" aria-label="View" onKeyDown={onKey}>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            className="tt-view-option"
            data-preset={p.id}
            aria-checked={current === p.id}
            tabIndex={current === p.id || (current === undefined && p.id === "auto") ? 0 : -1}
            onClick={() => api.preset(p.id)}
          >
            <span className="tt-view-radio" aria-hidden="true" />
            <span className="tt-view-text">
              <span className="tt-view-name">{p.label}</span>
              <span className="tt-view-hint">{p.hint}</span>
            </span>
            <PresetGlyph id={p.id} />
          </button>
        ))}
      </div>
      {current === undefined ? (
        <p className="tt-view-note" role="status">
          Arranged by hand. Pick a view to tidy the stage.
        </p>
      ) : null}
      <p className="tt-view-note">Drag a stream by its name to dock it on a side or float it in a small window.</p>
      <div className="tt-view-foot">
        <button
          type="button"
          className="tt-view-reset"
          onClick={() => {
            api.reset();
            onDone();
          }}
        >
          <Icon name="reset" />
          Reset layout
        </button>
        <button type="button" className="tt-view-done" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** A small drawing of a view's stage, each stream in its own colour: slides amber, screen green, speaker blue. */
function PresetGlyph({ id }: { id: PresetId }) {
  const r = (x: number, y: number, w: number, h: number, stream: string) => (
    <rect x={x} y={y} width={w} height={h} rx={2.5} data-stream={stream} />
  );
  return (
    <svg className="tt-view-glyph" viewBox="0 0 72 44" aria-hidden="true">
      <rect className="tt-view-glyph-stage" x={0} y={0} width={72} height={44} rx={5} />
      {id === "tiled" ? (
        <>
          {r(4, 4, 31, 17, "slides")}
          {r(37, 4, 31, 17, "screen")}
          {r(20.5, 23, 31, 17, "camera")}
        </>
      ) : id === "spotlight" ? (
        r(4, 4, 64, 36, "slides")
      ) : id === "sidebar" ? (
        <>
          {r(4, 4, 46, 36, "slides")}
          {r(52, 9, 16, 11, "screen")}
          {r(52, 24, 16, 11, "camera")}
        </>
      ) : (
        <>
          {r(4, 4, 46, 36, "slides")}
          {r(52, 16.5, 16, 11, "camera")}
        </>
      )}
    </svg>
  );
}
