import { dirOf } from "../viewer/lang";
import { usePlayer } from "./context";
import { SourceTile } from "./SourceTile";

/**
 * The slide on screen at the playhead. Until the deck and slide tracks are drawn (Player step 3), a slide-shaped
 * tile that names the slide from the descriptions track when it is on; its overlay layer is where ink and the
 * laser will go.
 */
export function SlideSurface() {
  const { tracks, prefs } = usePlayer();
  const describe = tracks.describe?.enabled ? tracks.describe : undefined;
  const slide = describe?.sliced?.slide;
  const lang = describe?.lang ?? "en";
  return (
    <SourceTile kind="slides" aspect={16 / 9} label={slide ? `Slide ${slide.id + 1}` : "Slides"}>
      <div className="tt-slide">
        <span className="tt-slide-eyebrow">Slides</span>
        <strong className="tt-slide-title">{slide ? `Slide ${slide.id + 1}` : "Slides appear here"}</strong>
        {slide && prefs.describe !== "off" ? (
          <p className="tt-slide-description" lang={lang} dir={dirOf(lang)}>
            {slide.description}
          </p>
        ) : (
          <p className="tt-slide-hint">
            {tracks.describe && prefs.describe === "off"
              ? "Turn on slide descriptions in Settings to follow the slides as text."
              : "The speaker's slides, ink and laser pointer show here."}
          </p>
        )}
      </div>
    </SourceTile>
  );
}
