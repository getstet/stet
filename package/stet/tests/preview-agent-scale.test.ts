/**
 * The census at scale (D7): the shipped agent, run over a stand-in DOM of plain
 * objects (`helpers/census-scale.ts`), answers a census of 1,000 keys over a
 * page of 32,000 elements three times in a row.
 *
 * Wall-clock time under a loaded machine is what the other test files in the
 * run make it: this case once took 121 ms in a full run, and a run under
 * twelve busy processes takes 94 ms for its cold pass where a quiet one takes
 * 55. So the bound is read three ways. The work is counted, which load cannot
 * change: the stand-in counts every read of the page, and a matcher that
 * scanned every key against every element would read thousands of times more
 * than one that looks a text up by its first word. The fastest pass keeps the
 * spec's 100 ms, since a pass the machine descheduled says nothing about the
 * matcher. And no pass reaches the ceiling, which the earlier matcher's 3.3 s
 * stall passed by a factor of ten.
 */
import { expect, it } from 'vitest';

import { ELEMENTS, KEYS, censusPasses, expectCensusScale, page } from './helpers/census-scale.js';

it('answers a census of 1,000 keys over 32,000 elements three times in a row, in bounded work and time', () => {
  expect(page().body.querySelectorAll('*')).toHaveLength(ELEMENTS + 1);
  const passes = censusPasses();
  const found = passes[0]?.reply['found'] as Record<string, number>;
  // Whole cells, cells holding a key's text inside more text, and the {{name}} key, each counted once per element.
  const rows = Array.from({ length: ELEMENTS / 4 }, (_, i) => i);
  expect(found['k_1']).toBe(rows.filter((i) => (i % 97 === 0 || i % 50 === 0) && ((i % KEYS) | 1) === 1).length);
  expect(found['k_10']).toBe(1);
  expect(Object.keys(found).length).toBeGreaterThan(80);
  console.info(`census scale: ${passes.map((p) => p.ms.toFixed(1)).join(' / ')} ms, ${passes.map((p) => p.reads).join(' / ')} reads (${KEYS} keys, ${ELEMENTS} elements)`);
  expectCensusScale(passes);
});
