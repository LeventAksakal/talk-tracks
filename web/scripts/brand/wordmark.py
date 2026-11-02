#!/usr/bin/env python3
"""Outline the wordmark: "Talk Tracks" in the title face (Cabin Sketch Bold, our subset "Talk Tracks Title") as one
SVG path, with the font's pair kerning, so the logo files need no font.

Writes web/scripts/brand/wordmark.json, which build.ts reads. Run from anywhere:
    python web/scripts/brand/wordmark.py
Needs fontTools (pip install fonttools brotli). Cabin Sketch is under the SIL Open Font License 1.1; outlines drawn
from it for a logo are artwork, not a font, so the licence's Reserved Font Name rule does not apply to them.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
FONT = HERE.parent.parent / "public" / "fonts" / "tt-title-700.woff2"
TEXT = "Talk Tracks"


def pair_kerning(font: TTFont) -> dict[tuple[str, str], int]:
    """The x-advance adjustments of the GPOS pair-positioning lookups (formats 1 and 2)."""
    kern: dict[tuple[str, str], int] = {}
    if "GPOS" not in font:
        return kern
    table = font["GPOS"].table
    for lookup in table.LookupList.Lookup:
        subtables = lookup.SubTable
        if lookup.LookupType == 9:  # extension
            subtables = [s.ExtSubTable for s in subtables]
        for st in subtables:
            if getattr(st, "LookupType", 2) != 2 and lookup.LookupType != 9:
                continue
            if not hasattr(st, "Format") or not hasattr(st, "Coverage"):
                continue
            firsts = st.Coverage.glyphs
            if st.Format == 1:
                for first, pairset in zip(firsts, st.PairSet):
                    for rec in pairset.PairValueRecord:
                        v = getattr(rec.Value1, "XAdvance", 0) if rec.Value1 else 0
                        if v:
                            kern.setdefault((first, rec.SecondGlyph), v)
            elif st.Format == 2:
                c1 = st.ClassDef1.classDefs
                c2 = st.ClassDef2.classDefs
                for first in firsts:
                    row = st.Class1Record[c1.get(first, 0)]
                    for second in font.getGlyphOrder():
                        rec = row.Class2Record[c2.get(second, 0)]
                        v = getattr(rec.Value1, "XAdvance", 0) if rec.Value1 else 0
                        if v:
                            kern.setdefault((first, second), v)
    return kern


def main() -> None:
    font = TTFont(FONT)
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font["hmtx"]
    kern = pair_kerning(font)
    ascent = font["hhea"].ascent
    cap = font["OS/2"].sCapHeight

    pen = SVGPathPen(glyphs, ntos=lambda n: str(round(n)))
    bounds = BoundsPen(glyphs)
    x = 0
    names = [cmap[ord(ch)] for ch in TEXT]
    for i, name in enumerate(names):
        if i:
            x += kern.get((names[i - 1], name), 0)
        # Font units are y-up; SVG is y-down with the baseline at y = ascent.
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, ascent)))
        glyphs[name].draw(TransformPen(bounds, (1, 0, 0, -1, x, ascent)))
        x += hmtx[name][0]

    out = {
        "text": TEXT,
        "d": pen.getCommands(),
        "unitsPerEm": font["head"].unitsPerEm,
        "ascent": ascent,
        "capHeight": cap,
        # The ink's box in SVG units (y down, baseline at y = ascent): [x0, y0, x1, y1].
        "bbox": [round(v) for v in bounds.bounds],
        "advance": x,
        "kerned": sorted(f"{a}+{b}" for a, b in zip(names, names[1:]) if kern.get((a, b))),
    }
    text = json.dumps(out, indent=2)
    # Short arrays on one line, as prettier writes them, so a rebuild leaves the file unchanged.
    text = re.sub(r"\[\s*([^\[\]{}]*?)\s*\]", lambda m: "[" + re.sub(r",\s+", ", ", m.group(1)) + "]", text)
    (HERE / "wordmark.json").write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"wordmark.json: {len(out['d'])} chars of path, kerned pairs {out['kerned']}")


if __name__ == "__main__":
    main()
