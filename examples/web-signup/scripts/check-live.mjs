#!/usr/bin/env node
// Prove the live channel on the running development server: the app, framed
// the way the Flows map frames a live point, takes a `stet:draft` (a key's
// text changes), a `stet:draft-clear` (it changes back) and a `stet:tokens`
// (the primary colour changes). Screenshots go to .stet/evidence/.
//
//   npm run dev        # in another terminal
//   node scripts/check-live.mjs

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(ROOT, '.stet/evidence');
const base = (process.env.STET_APP_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
mkdirSync(EVIDENCE, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.setContent(`<body style="margin:0"><iframe id="app" style="border:0;width:1280px;height:800px" src="${base}/signup?stet-state=signup"></iframe></body>`);
const frame = await (await page.waitForSelector('#app')).contentFrame();
await frame.waitForFunction(() => window.__stet?.status().status === 'ready');
await frame.waitForSelector('h1');

const post = (message) => page.evaluate((m) => document.getElementById('app').contentWindow.postMessage(m, '*'), message);
const title = () => frame.locator('h1').innerText();
const primary = () => frame.locator('button[type=submit]').evaluate((el) => getComputedStyle(el).backgroundColor);
const results = [];
const check = (name, actual, expected) => {
  const ok = actual === expected;
  results.push(ok);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};

check('title before', await title(), 'Create your account');
check('primary before', await primary(), 'rgb(36, 81, 214)');
await page.screenshot({ path: join(EVIDENCE, 'live-1-before.png') });

await post({ type: 'stet:draft', key: 'signup_title', value: 'Start your free workspace' });
await frame.waitForFunction(() => document.querySelector('h1')?.textContent === 'Start your free workspace', null, { timeout: 3000 }).catch(() => {});
check('title after stet:draft', await title(), 'Start your free workspace');

await post({ type: 'stet:tokens', tokens: { 'color.primary': '#15803D' } });
await frame.waitForFunction(() => getComputedStyle(document.querySelector('button[type=submit]')).backgroundColor === 'rgb(21, 128, 61)', null, { timeout: 3000 }).catch(() => {});
check('primary after stet:tokens', await primary(), 'rgb(21, 128, 61)');
await page.screenshot({ path: join(EVIDENCE, 'live-2-draft-and-tokens.png') });

// A message from anything but the parent frame is ignored.
await frame.evaluate(() => window.postMessage({ type: 'stet:draft', key: 'signup_title', value: 'From the page itself' }, '*'));
await page.waitForTimeout(300);
check('title after a message not from the parent', await title(), 'Start your free workspace');

await post({ type: 'stet:draft-clear' });
await post({ type: 'stet:tokens', tokens: {} });
await frame.waitForFunction(() => document.querySelector('h1')?.textContent === 'Create your account', null, { timeout: 3000 }).catch(() => {});
check('title after stet:draft-clear', await title(), 'Create your account');
check('primary after empty stet:tokens', await primary(), 'rgb(36, 81, 214)');
await page.screenshot({ path: join(EVIDENCE, 'live-3-cleared.png') });

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed} of ${results.length} checks passed`);
process.exitCode = passed === results.length ? 0 : 1;
