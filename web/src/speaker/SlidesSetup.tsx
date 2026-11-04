// Adding a deck in the speaker console, before or during the talk: drop or pick a PDF, a PowerPoint file or
// pictures (slideFiles.ts), see the deck as a strip of small thumbnails and the chosen slide large, and step
// through it. The chosen slide is the one the slides broadcast shows: before going on air nothing is sent (the
// publisher keeps it for the moment you go live); on air, choosing a slide shows it to viewers.
//
// Mount it with its own state:          <SlidesSetup publisher={publisher} live={live} onShown={sendFrame} />
// or share the state with a stage:      const slides = useSlideDeck({ publisher, onShown: sendFrame });
//                                       <SlidesSetup publisher={publisher} live={live} state={slides} />
//                                       <Stage slide={slides.current} ... />

import { Button } from "@astryxdesign/core";
import { type ChangeEvent, type DragEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Deck, RenderedSlide } from "./deck";
import type { SlidesPublisher } from "./publisher";
import { MAX_DECK_MB, SLIDE_ACCEPT, openSlides } from "./slideFiles";
import "./slidesSetup.css";

export interface SlideDeck {
  deck: Deck | undefined;
  /** The chosen slide (what viewers see on air). */
  index: number;
  /** The chosen slide, rendered full size; undefined while it renders. */
  current: RenderedSlide | undefined;
  /** Small pictures for the strip, by slide; filled in as they render. */
  thumbs: readonly (string | undefined)[];
  /** The slides are hidden from viewers (B). */
  hidden: boolean;
  /** A file is being opened. */
  busy: string | undefined;
  error: string | undefined;
  add(files: readonly File[]): Promise<void>;
  goTo(index: number): Promise<void>;
  toggleHidden(): void;
}

export interface SlideDeckOptions {
  publisher: SlidesPublisher;
  /** How a file becomes a deck; default `openSlides` (PDF, PowerPoint, pictures). */
  openDeck?: (files: readonly File[]) => Promise<Deck>;
  /** A slide was shown (the console sends it to the describe agent while live). */
  onShown?: (slide: RenderedSlide) => void;
}

/** The deck's state and the publisher calls that go with it. */
export function useSlideDeck({ publisher, openDeck = openSlides, onShown }: SlideDeckOptions): SlideDeck {
  const [deck, setDeck] = useState<Deck>();
  const [index, setIndex] = useState(0);
  const [current, setCurrent] = useState<RenderedSlide>();
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const loading = useRef(0);
  const shown = useRef(onShown);
  useEffect(() => {
    shown.current = onShown;
  }, [onShown]);
  useEffect(() => () => deck?.close(), [deck]);

  /** Full size, published with the deck (before its slide is first shown), then shown. */
  const show = useCallback(
    async (d: Deck, i: number, token: number) => {
      const s = await d.render(i);
      if (token !== loading.current) return;
      if (publisher.deckId !== undefined && !publisher.hasImage(i)) publisher.addImage(s.image);
      publisher.show(i);
      setIndex(i);
      setCurrent(s);
      setHidden(false);
      shown.current?.(s);
      // The next slide is ready before the speaker moves on.
      if (i + 1 < d.count) void d.render(i + 1).catch(() => undefined);
    },
    [publisher],
  );

  const add = useCallback(
    async (files: readonly File[]) => {
      const [first] = files;
      if (!first) return;
      const token = ++loading.current;
      setBusy(files.length > 1 ? `${files.length} pictures` : first.name);
      setError(undefined);
      try {
        const d = await openDeck(files);
        if (token !== loading.current) return d.close();
        publisher.loadDeck({ kind: "deck", count: d.count, aspect: d.aspect, title: d.title });
        setDeck(d);
        setCurrent(undefined);
        setThumbs(Array.from({ length: d.count }));
        await show(d, 0, token);
        setBusy(undefined);
        // Thumbnails one at a time, small: the strip fills in while the speaker looks at slide 1.
        for (let i = 0; i < d.count && token === loading.current; i++) {
          const url = await (d.thumbnail ? d.thumbnail(i) : d.render(i).then((s) => s.url));
          if (token !== loading.current) return;
          setThumbs((prev) => {
            const next = [...prev];
            next[i] = url;
            return next;
          });
        }
      } catch (e) {
        if (token === loading.current) {
          setError(e instanceof Error ? e.message : String(e));
          setBusy(undefined);
        }
      }
    },
    [openDeck, publisher, show],
  );

  const goTo = useCallback(
    async (i: number) => {
      if (!deck || i < 0 || i >= deck.count) return;
      try {
        await show(deck, i, loading.current);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [deck, show],
  );

  const toggleHidden = useCallback(() => {
    if (!deck) return;
    if (hidden) void goTo(index);
    else {
      publisher.hide();
      setHidden(true);
    }
  }, [deck, hidden, goTo, index, publisher]);

  return { deck, index, current, thumbs, hidden, busy, error, add, goTo, toggleHidden };
}

export interface SlidesSetupProps extends SlideDeckOptions {
  /** On air: choosing a slide shows it to viewers. Off air it is a preview. */
  live: boolean;
  /** The deck's state, when the console shares it with its stage; otherwise the component keeps its own. */
  state?: SlideDeck;
}

/** Add, preview and choose slides. */
export function SlidesSetup({ state, ...props }: SlidesSetupProps) {
  return state ? <SlidesView state={state} live={props.live} /> : <OwnSlides {...props} />;
}

function OwnSlides(props: SlideDeckOptions & { live: boolean }) {
  const state = useSlideDeck(props);
  return <SlidesView state={state} live={props.live} />;
}

function SlidesView({ state, live }: { state: SlideDeck; live: boolean }) {
  const { deck, index, current, thumbs, hidden, busy, error } = state;
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const strip = useRef<HTMLOListElement>(null);
  const pick = () => input.current?.click();
  const add = (files: FileList | null | undefined) => void state.add(files ? Array.from(files) : []);

  // The chosen slide stays in view in the strip.
  useEffect(() => {
    const el = strip.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [index]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "PageDown") void state.goTo(index + 1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") void state.goTo(index - 1);
    else return;
    e.preventDefault();
  };

  const status = !deck
    ? undefined
    : hidden
      ? "Hidden from viewers."
      : live
        ? "On air: viewers see this slide."
        : "Preview: viewers see this slide when you go on air.";

  return (
    <section
      className="slides-setup"
      aria-label="Slides"
      data-over={over || undefined}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        add(e.dataTransfer.files);
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={SLIDE_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose slides"
        data-testid="slides-file"
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />
      {deck ? (
        <>
          <header className="slides-head">
            <span className="slides-name" title={deck.name}>
              {deck.name}
            </span>
            <span className="slides-meta">{deck.count === 1 ? "1 slide" : `${deck.count} slides`}</span>
            <Button label="Change slides" size="sm" variant="secondary" onClick={pick} />
          </header>
          <div
            className="slides-preview"
            style={{ aspectRatio: String(deck.aspect) }}
            data-hidden={hidden || undefined}
          >
            {current && current.index === index ? (
              <img src={current.url} alt={`Slide ${index + 1} of ${deck.count}`} data-testid="slides-current" />
            ) : (
              <span className="slides-wait">Preparing slide {index + 1}…</span>
            )}
          </div>
          <nav className="slides-nav" aria-label="Choose a slide" onKeyDown={onKey}>
            <Button
              label="Previous slide"
              size="sm"
              variant="secondary"
              isDisabled={index === 0}
              onClick={() => void state.goTo(index - 1)}
            />
            <span className="slides-count" aria-live="polite" data-testid="slides-count">
              Slide {index + 1} of {deck.count}
            </span>
            <Button
              label="Next slide"
              size="sm"
              variant="secondary"
              isDisabled={index + 1 >= deck.count}
              onClick={() => void state.goTo(index + 1)}
            />
          </nav>
          <p className="slides-status" data-live={live || undefined}>
            {status}
          </p>
          <ol className="slides-strip" ref={strip} aria-label="All slides">
            {Array.from({ length: deck.count }, (_, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="slides-thumb"
                  aria-current={i === index ? "true" : undefined}
                  aria-label={`Slide ${i + 1}`}
                  onClick={() => void state.goTo(i)}
                  onKeyDown={onKey}
                >
                  {thumbs[i] ? <img src={thumbs[i]} alt="" /> : <span className="slides-thumb-wait" />}
                  <span className="slides-thumb-num">{i + 1}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <div className="slides-drop" data-busy={busy ? true : undefined}>
          <p className="slides-drop-title">{busy ? `Opening ${busy}…` : "Add your slides"}</p>
          <p className="slides-drop-hint">
            PDF, PowerPoint or pictures, up to {MAX_DECK_MB} MB. Kept here until you go on air.
          </p>
          <Button label="Choose file" variant="primary" isDisabled={!!busy} onClick={pick} />
        </div>
      )}
      {deck && busy ? <p className="slides-status">Opening {busy}…</p> : null}
      {error ? (
        <p className="slides-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
