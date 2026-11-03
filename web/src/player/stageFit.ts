// Where the main picture, the corner tile and the subtitles go on the stage, so that neither the corner tile nor the
// subtitles ever cover the slides (or a shared screen). Pure geometry in CSS pixels; Stage measures and applies it.

/** A box on the stage, CSS px from its top-left corner. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface StageFitInput {
  /** The stage, CSS px. */
  width: number;
  height: number;
  /** The main picture's shape (width / height): the slides or the shared screen. */
  main: number;
  /** The corner tile where the player puts it (not moved by the viewer): its shape and its width preference. */
  corner?: { aspect: number; widthFrac: number };
  /** Room to keep for subtitles the viewer has not moved, px tall; undefined when they are off or moved. */
  captions?: number;
  /** How far the dock reaches up from the stage's bottom edge: the corner tile and the subtitles stay above it. */
  dockReach: number;
  /** Space between the pictures, px. */
  gap: number;
}

export interface StageFit {
  /** Kept clear of the main picture on the stage's right and bottom, px: the main picture is centred in the rest. */
  right: number;
  bottom: number;
  /** The main picture as drawn. */
  main: Box;
  /** The corner tile, when the player places it. */
  corner?: Box;
  /** Where unmoved subtitles go: their top centre, and how wide they may be. */
  captions?: { x: number; top: number; maxWidth: number };
}

/**
 * The corner tile's size: its shape inside the 16:9 box of the viewer's width preference, so a narrow webcam crop is
 * as tall as a 16:9 camera would be, never taller.
 */
export function cornerSize(stageWidth: number, aspect: number, widthFrac: number): { width: number; height: number } {
  const box = widthFrac * stageWidth;
  const width = Math.min(box, ((box * 9) / 16) * aspect);
  return { width, height: width / aspect };
}

/** The main picture of shape `aspect`, as large as fits in `w` × `h` and centred there. */
function contain(w: number, h: number, aspect: number): Box {
  const width = Math.max(0, Math.min(w, h * aspect));
  const height = width / aspect;
  return { left: (w - width) / 2, top: (h - height) / 2, width, height };
}

/**
 * Lay the stage out so nothing covers the main picture. With a corner tile, two ways are tried, and the one that
 * leaves the larger main picture wins: a band along the bottom (the tile at its right, the subtitles left of it), or
 * a column on the right for the tile (the subtitles under the main picture). Without one, a band for the subtitles.
 * The tile and the subtitles stay above the dock, which only covers the picture while the viewer moves the mouse.
 */
export function fitStage(input: StageFitInput): StageFit {
  const { width: W, height: H, main: A, corner, captions, dockReach, gap } = input;
  const capReserve = captions !== undefined ? captions + dockReach + gap : 0;
  // Subtitles hang from the top of the band below the main picture, between `from` and `to`.
  const captionsUnder = (bottom: number, from: number, to: number) =>
    captions === undefined
      ? undefined
      : { x: (from + to) / 2, top: H - bottom + gap, maxWidth: Math.max(0, to - from - 2 * gap) };
  if (!corner) {
    const bottom = capReserve;
    return { right: 0, bottom, main: contain(W, H - bottom, A), captions: captionsUnder(bottom, 0, W) };
  }
  const tile = cornerSize(W, corner.aspect, corner.widthFrac);
  const tileBox: Box = { left: W - gap - tile.width, top: H - dockReach - tile.height, ...tile };
  // A band along the bottom: as tall as the tile above the dock, or the subtitles, whichever needs more.
  const bandBottom = Math.max(tile.height + dockReach + gap, capReserve);
  const band = contain(W, H - bandBottom, A);
  // A column on the right for the tile; the subtitles under the main picture.
  const colRight = tile.width + 2 * gap;
  const colBottom = capReserve;
  const column = contain(W - colRight, H - colBottom, A);
  if (column.width > band.width + 1)
    return {
      right: colRight,
      bottom: colBottom,
      main: column,
      corner: tileBox,
      captions: captionsUnder(colBottom, 0, W - colRight),
    };
  return {
    right: 0,
    bottom: bandBottom,
    main: band,
    corner: tileBox,
    captions: captionsUnder(bandBottom, 0, tileBox.left),
  };
}
