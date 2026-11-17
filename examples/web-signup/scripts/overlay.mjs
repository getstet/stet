#!/usr/bin/env node
// Draw a capture record's boxes over its screenshot, to check them by eye:
// located keys solid amber, ambiguous candidates dashed amber, components
// thin blue.
//
//   node scripts/overlay.mjs <pointId> <deviceId> [out.png]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [pointId, deviceId, out = join(ROOT, `.stet/evidence/overlay-${pointId}-${deviceId}.png`)] = process.argv.slice(2);
if (!pointId || !deviceId) {
  console.error('usage: node scripts/overlay.mjs <pointId> <deviceId> [out.png]');
  process.exit(1);
}
const captures = join(ROOT, '.stet/captures');
const record = JSON.parse(readFileSync(join(captures, pointId, `${deviceId}.json`), 'utf8'));
const png = readFileSync(join(captures, record.image)).toString('base64');
const { width, height } = record.document;

const rect = ([x, y, w, h], style, label) =>
  `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;${style}">` +
  (label ? `<span style="position:absolute;left:0;top:-13px;font:10px/12px monospace;background:#fff8;color:#000;white-space:nowrap">${label}</span>` : '') +
  '</div>';
const boxes = [
  ...record.components.map((c) => rect(c.box, 'outline:1px solid #2563eb99', '')),
  ...record.keys.flatMap((k) =>
    k.status === 'located'
      ? (k.boxes ?? [k.box]).map((box, i) => rect(box, 'outline:2px solid hsl(38 92% 50%)', k.count ? `${k.key} ${i + 1}/${k.count}` : k.key))
      : (k.candidates ?? []).map((box) => rect(box, 'outline:2px dashed hsl(38 92% 50%)', `${k.key}?`)),
  ),
];
const html = `<body style="margin:0;overflow:hidden"><div style="position:relative;width:${width}px;height:${height}px;overflow:hidden">
<img src="data:image/png;base64,${png}" style="position:absolute;left:0;top:0;width:${width}px;height:${height}px">
${boxes.join('\n')}</div></body>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: record.window.pixelRatio });
await page.setContent(html);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width, height } });
await browser.close();
console.log(out);
