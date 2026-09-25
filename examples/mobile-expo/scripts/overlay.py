"""Draws a capture record over its screenshot and measures how well the boxes sit.

  python3 scripts/overlay.py <record.json> <out dir>     (needs Pillow)

Writes <point>--<device>.png and .json into the out dir: component boxes in
blue, located keys in orange, an ambiguous key's candidates dashed in magenta.
A box the record marks covered (under a dialog) is drawn faint.
Two measurements: each filled component (a primary button) against its
painted fill, and each located key's text ink against its key box.
"""
import json, sys
from collections import Counter
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

record_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
rec = json.loads(record_path.read_text())
root = record_path.parent.parent
img = Image.open(root / rec['image']).convert('RGB')
s = rec['window']['pixelRatio']
W, H = img.size
px = img.load()
draw = ImageDraw.Draw(img, 'RGBA')
try:
    font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', int(9 * s))
except OSError:
    font = ImageFont.load_default()

def to_px(b):
    x, y, w, h = b
    return [x * s, y * s, (x + w) * s, (y + h) * s]

def clamp(r):
    return [max(0, int(r[0])), max(0, int(r[1])), min(W, int(r[2])), min(H, int(r[3]))]

def bbox_where(region, pred):
    x0, y0, x1, y1 = clamp(region)
    xs, ys = [], []
    for y in range(y0, y1):
        for x in range(x0, x1):
            if pred(px[x, y]):
                xs.append(x); ys.append(y)
    return [min(xs), min(ys), max(xs) + 1, max(ys) + 1] if xs else None

def near(c, ref, tol):
    return max(abs(c[i] - ref[i]) for i in range(3)) <= tol

def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) if len(h) == 6 else None

def dashed(r, color, width=4, dash=18):
    x0, y0, x1, y1 = r
    for a, b, horiz, fixed in ((x0, x1, True, y0), (x0, x1, True, y1), (y0, y1, False, x0), (y0, y1, False, x1)):
        t = a
        while t < b:
            e = min(t + dash, b)
            draw.line([(t, fixed), (e, fixed)] if horiz else [(fixed, t), (fixed, e)], fill=color, width=width)
            t += dash * 2

report = {'point': rec['point'], 'device': rec['device'], 'pixelRatio': s, 'screenshot': [W, H],
          'windowPx': [rec['window']['width'] * s, rec['window']['height'] * s], 'components': [], 'keys': []}

# Snapshot the pixels before drawing: measurements read the screenshot, not the overlay.
clean = img.copy()
px = clean.load()

for c in rec.get('components', []):
    if not c.get('box'):
        continue
    r = to_px(c['box'])
    fill_hex = (c.get('style') or {}).get('backgroundColor')
    fill_rgb = hex_rgb(fill_hex) if isinstance(fill_hex, str) and fill_hex.startswith('#') else None
    entry = {'name': c['name'], 'file': c.get('file'), 'boxPx': [round(v, 1) for v in r]}
    if fill_rgb and c['box'][2] < rec['window']['width'] - 1:
        fill = bbox_where([r[0] - 9, r[1] - 9, r[2] + 9, r[3] + 9], lambda p: near(p, fill_rgb, 6))
        entry['fillPx'] = fill
        if fill:
            entry['edgeErrorPx'] = {k: round(fill[i] - r[i], 1) for i, k in enumerate(['left', 'top', 'right', 'bottom'])}
    report['components'].append(entry)
    if c['box'][2] < rec['window']['width'] - 1:  # full-screen frames would hide the rest
        draw.rectangle(r, outline=(0, 140, 255, 220), width=3)

for k in rec.get('keys', []):
    if k['status'] == 'ambiguous':
        hidden = k.get('candidatesCovered') or []
        for i, b in enumerate(k.get('candidates') or []):
            if b:
                faint = i < len(hidden) and hidden[i]
                dashed(to_px(b), (220, 0, 220, 70 if faint else 255), width=2 if faint else 4)
        report['keys'].append({'key': k['key'], 'status': 'ambiguous', 'candidates': len(k.get('candidates') or []),
                               'candidatesCovered': hidden})
        continue
    if k['status'] != 'located' or not k.get('box'):
        report['keys'].append({'key': k['key'], 'status': k['status']})
        continue
    r = to_px(k['box'])
    if k.get('covered'):
        draw.rectangle(r, outline=(245, 140, 0, 70), width=2)
        report['keys'].append({'key': k['key'], 'status': 'located', 'covered': True, 'boxPx': [round(v, 1) for v in r]})
        continue
    entry = {'key': k['key'], 'status': 'located', 'boxPx': [round(v, 1) for v in r], 'lines': k.get('lines'), 'truncated': k.get('truncated')}
    if not k.get('element'):
        region = [r[0] - 3 * s, r[1] - 3 * s, r[2] + 3 * s, r[3] + 3 * s]  # 3pt around: little of a neighbour's ink
        x0, y0, x1, y1 = clamp(region)
        edge = [px[x, y0] for x in range(x0, x1)] + [px[x, y1 - 1] for x in range(x0, x1)]
        bg = Counter(edge).most_common(1)[0][0]
        ink = bbox_where(region, lambda p: not near(p, bg, 60))
        entry['inkPx'] = ink
        if ink:
            entry['inkOutsideBoxPx'] = {'left': round(max(0, r[0] - ink[0]), 1), 'top': round(max(0, r[1] - ink[1]), 1),
                                        'right': round(max(0, ink[2] - r[2]), 1), 'bottom': round(max(0, ink[3] - r[3]), 1)}
    report['keys'].append(entry)
    draw.rectangle(r, outline=(245, 140, 0, 255), width=3)
    draw.text((r[0], max(0, r[1] - 11 * s)), k['key'], fill=(200, 100, 0, 255), font=font)

out_dir.mkdir(parents=True, exist_ok=True)
name = f"{rec['point']}--{record_path.stem}"
img.save(out_dir / f'{name}.png')
(out_dir / f'{name}.json').write_text(json.dumps(report, indent=2))
worst_key = max((max(e['inkOutsideBoxPx'].values()) for e in report['keys'] if e.get('inkOutsideBoxPx')), default=None)
worst_fill = max((max(abs(v) for v in e['edgeErrorPx'].values()) for e in report['components'] if e.get('edgeErrorPx')), default=None)
print(json.dumps({'overlay': str(out_dir / f'{name}.png'), 'keys': len(report['keys']),
                  'worstInkOutsideKeyBoxPx': worst_key, 'worstFillEdgeErrorPx': worst_fill}))
