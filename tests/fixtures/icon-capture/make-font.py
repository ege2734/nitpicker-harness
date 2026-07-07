#!/usr/bin/env python3
"""Synthesize a tiny self-hosted icon web font (woff2) with SOLID glyphs at private-use-area codepoints —
mirroring how @loom/ds ships Phosphor (self-hosted @font-face, PUA glyphs). The glyphs are solid filled
shapes so a successful html2canvas capture shows filled marks, while a failed capture shows the browser's
empty .notdef tofu box (□). Regenerate with:  python3 make-font.py"""
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UPM = 1000
# codepoint -> (glyph name, list of contours; each contour a list of (x,y) points, filled)
def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]

def poly(*pts):
    return list(pts)

GLYPHS = {
    0xE000: ("sq", [rect(150, 100, 850, 800)]),                              # solid square
    0xE001: ("tri", [poly((500, 850), (120, 120), (880, 120))]),            # solid triangle
    0xE002: ("plus", [rect(400, 100, 600, 800), rect(150, 350, 850, 550)]), # thick plus
    0xE003: ("diamond", [poly((500, 880), (880, 450), (500, 20), (120, 450))]),  # diamond
    0xE004: ("bar", [rect(120, 380, 880, 560)]),                            # horizontal bar
    0xE005: ("hex", [poly((300, 850), (700, 850), (900, 450), (700, 50), (300, 50), (100, 450))]),  # hexagon
}

order = [".notdef"] + [name for _, (name, _) in sorted(GLYPHS.items())]

pens = {}
notdef = TTGlyphPen(None)  # empty .notdef (its own advance); the *fallback* tofu is the browser's, not this
notdef.moveTo((0, 0)); notdef.lineTo((0, 0)); notdef.closePath()
pens[".notdef"] = notdef.glyph()

cmap = {}
for cp, (name, contours) in GLYPHS.items():
    pen = TTGlyphPen(None)
    for contour in contours:
        pen.moveTo(contour[0])
        for pt in contour[1:]:
            pen.lineTo(pt)
        pen.closePath()
    pens[name] = pen.glyph()
    cmap[cp] = name

fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder(order)
fb.setupCharacterMap(cmap)
fb.setupGlyf(pens)
metrics = {g: (UPM, 0) for g in order}
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=900, descent=-100)
fb.setupNameTable({"familyName": "NHIcons", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=900, sTypoDescender=-100, usWinAscent=900, usWinDescent=100)
fb.setupPost()
fb.font.flavor = "woff2"
fb.save("iconfont.woff2")
print("wrote iconfont.woff2 with PUA glyphs U+E000..U+E005")
