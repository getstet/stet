/**
 * A fake `LighthouseRunner` for `stet audit lighthouse` cases: it answers a
 * saved result per page path, and records every run and the close. The saved
 * results under `tests/fixtures/lhr/` were measured with Lighthouse 13.5.0
 * over the html-host fixture's documents, their origin rewritten to
 * `https://127.0.0.1:1/`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FormFactor, LighthouseResult, LighthouseRunner } from '../../cli/lighthouse-run.js';

const LHR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'lhr');

/** A saved result (`index.html` or `edges.html`), a fresh copy each call. */
export function savedLhr(name: 'index.html' | 'edges.html'): LighthouseResult {
  return JSON.parse(readFileSync(join(LHR_DIR, `${name}.lhr.json`), 'utf8')) as LighthouseResult;
}

/** Every score 1 and every audit passing: a page with nothing to report. */
export function cleanLhr(base: LighthouseResult = savedLhr('index.html')): LighthouseResult {
  const lhr = structuredClone(base);
  for (const category of Object.values(lhr.categories)) category.score = 1;
  for (const audit of Object.values(lhr.audits)) if (typeof audit.score === 'number') audit.score = 1;
  return lhr;
}

export interface FakeLighthouse {
  /** What the command calls as `io.lighthouse`. */
  start: (insecure: boolean) => Promise<{ run: LighthouseRunner; close: () => Promise<void> }>;
  runs: Array<{ url: string; formFactor: FormFactor; applied: boolean }>;
  starts: boolean[];
  closed: number;
}

/**
 * Answers each run with the result for the URL's path (`/` and `/index.html`
 * are one), or a function of the run's index for that path, so a case can
 * vary scores across `--runs`.
 */
export function fakeLighthouse(byPath: Record<string, LighthouseResult | ((n: number) => LighthouseResult)>): FakeLighthouse {
  const fake: FakeLighthouse = {
    runs: [],
    starts: [],
    closed: 0,
    start: async (insecure) => {
      fake.starts.push(insecure);
      const seen = new Map<string, number>();
      return {
        run: async (url, options) => {
          fake.runs.push({ url, ...options });
          const path = new URL(url).pathname;
          const answer = byPath[path] ?? (path === '/' ? byPath['/index.html'] : undefined);
          if (answer === undefined) throw new Error(`fake lighthouse: no result for ${path}`);
          const n = seen.get(path) ?? 0;
          seen.set(path, n + 1);
          const lhr = typeof answer === 'function' ? answer(n) : structuredClone(answer);
          return { ...lhr, finalDisplayedUrl: url };
        },
        close: async () => {
          fake.closed += 1;
        },
      };
    },
  };
  return fake;
}
