"""Where the speaker is in each demo talk's produced video, over time: web/src/player/demoSpeakerCrops.json.

The talks' video is the conference's own feed: mostly a slide with the speaker in a picture-in-picture box at the
bottom right, sometimes the stage camera full frame, sometimes a slide full frame with no speaker at all. The camera
tile shows only the speaker, so it needs, per stretch of the talk, the speaker's rectangle in source pixels or none.

Sample each recording every 2 s, small, once (offline, numbers only; no frame is kept in the repo):

    ffmpeg -i https://<site>/archive/<talk>-recording/video.m3u8 -vf fps=1/2,scale=320:180         -f rawvideo -pix_fmt rgb24 <frames>/<talk>/small.rgb

then ``python web/scripts/speaker_crops.py <frames> web/src/player/demoSpeakerCrops.json``. Check the result by eye
(each span's middle frame with its rectangle drawn) and correct misreads in FIXES.
"""
import json, os, sys
import numpy as np

S = sys.argv[1] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__)) + "/frames"
W, H, K = 320, 180, 4
FW, FH = 1280, 720
STEP = 2000
# The picture-in-picture box in source pixels, measured on full-size frames (the inset's black gutter), 2 px inside.
PIP = {
    "virus": [992, 391, 278, 313],
    "rsa": [992, 391, 278, 313],
    "qrcode": [992, 391, 278, 313],
    "dataviz": [1003, 419, 257, 255],
}
CAMERA_NOISE = 0.12  # share of pixels changed between neighbouring samples, at least: a camera's picture
# Checked by eye on the verification sheets: samples (index = lecture s / 2) the measure got wrong. qrcode 306 s is
# the "1994" slide zooming in, not the stage; 310-314 s is the stage (a held camera frame, no noise).
FIXES = {"qrcode": {153: "S", 155: "C", 156: "C", 157: "C"}}
MIN_RUN = 2  # samples: a shorter stretch (a cut, a crossfade) joins its neighbours


def grey(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def classify(r):
    raw = np.fromfile(f"{S}/{r}/small.rgb", dtype=np.uint8)
    n = raw.size // (W * H * 3)
    g = grey(raw[: n * W * H * 3].reshape(n, H, W, 3).astype(np.float32))
    x, y, w, h = [v // K for v in PIP[r]]
    back = g[:, 144:175, 226 : x - 2]  # the backdrop left of the box, below the slide
    inner = g[:, y + 3 : y + h - 3, x + 3 : x + w - 3]
    pip = (back.mean((1, 2)) < 22) & (back.std((1, 2)) < 12) & (inner.mean((1, 2)) > 25)
    share = (np.abs(np.diff(g, axis=0)) > 10).mean((1, 2))
    noise = np.minimum(np.concatenate([[1.0], share]), np.concatenate([share, [1.0]]))
    cls = ["P" if pip[i] else "C" if noise[i] > CAMERA_NOISE else "S" for i in range(n)]
    for i, c in FIXES.get(r, {}).items():
        cls[i] = c
    return g, cls


def runs(cls):
    out, a = [], 0
    for i in range(1, len(cls) + 1):
        if i == len(cls) or cls[i] != cls[a]:
            out.append([cls[a], a, i])
            a = i
    return out


def smooth(cls):
    """A speaker stretch (P, C) shorter than MIN_RUN samples is a cut or a crossfade: no speaker. Then runs again."""
    cls = list(cls)
    for c, a, b in runs(cls):
        if c != "S" and b - a < MIN_RUN:
            cls[a:b] = ["S"] * (b - a)
    return runs(cls)


def rs_class(rs, i):
    for c, a, b in rs:
        if a <= i < b:
            return c
    return "S"


def camera_crop(g, a, b, aspect):
    """A full-height crop of the box's shape, centred on where the picture moves most across the run (the speaker)."""
    seg = g[a:b]
    if len(seg) > 1:
        energy = np.abs(np.diff(seg, axis=0)).sum((0, 1))
    else:
        energy = np.ones(W)
    energy = np.convolve(energy, np.ones(41) / 41, mode="same")
    cx = float(np.argmax(energy)) * K
    w = round(FH * aspect)
    x = int(min(max(cx - w / 2, 0), FW - w))
    return [x, 0, w, FH]


def main():
    talks = {}
    for r in ["virus", "dataviz", "rsa", "qrcode"]:
        g, cls = classify(r)
        n = len(cls)
        rs = smooth(cls)
        box = PIP[r]
        aspect = box[2] / box[3]
        spans = []
        for c, a, b in rs:
            # A speaker stretch holds from its first sample to its last (plus half a step when a speaker stretch is
            # next): the unsampled second either side of a cut to a slide is the slide's, so no slide shows cropped.
            def edge(i, inner):
                if i <= 0:
                    return 0
                if i >= n:
                    return n * STEP
                before, after = rs_class(rs, i - 1), rs_class(rs, i)
                if before != "S" and after != "S":
                    return i * STEP - STEP // 2
                return (i - 1) * STEP if before != "S" else i * STEP
            frm, to = edge(a, True), edge(b, False)
            rect = box if c == "P" else camera_crop(g, a, b, aspect) if c == "C" else None
            spans.append([frm, to, rect])
            print(r, c, frm / 1000, to / 1000, rect, file=sys.stderr)
        talks[r] = {"frame": [FW, FH], "spans": spans}
    doc = {
        "format": "talk-tracks-speaker-crops",
        "v": 1,
        "method": "web/scripts/speaker_crops.py: each recording's 1280x720 video sampled every 2 s; the picture-in-picture box "
        "where the backdrop beside it is dark, the whole frame (cropped to the box's shape around the motion) where "
        "a camera's noise fills it, no speaker on a still full-frame slide. Spans [from, to) in lecture ms; rect "
        "[x, y, w, h] in source pixels of `frame`; null: the speaker is off camera.",
        "talks": talks,
    }
    out = sys.argv[-1]
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write("{\n")
        f.write(f'  "format": {json.dumps(doc["format"])},\n  "v": 1,\n  "method": {json.dumps(doc["method"])},\n')
        f.write('  "talks": {\n')
        items = list(talks.items())
        for k, (r, t) in enumerate(items):
            f.write(f'    "{r}": {{\n      "frame": {json.dumps(t["frame"])},\n      "spans": [\n')
            lines = [f"        {json.dumps(s)}" for s in t["spans"]]
            f.write(",\n".join(lines) + "\n      ]\n    }" + ("," if k < len(items) - 1 else "") + "\n")
        f.write("  }\n}\n")


if __name__ == "__main__":
    main()
