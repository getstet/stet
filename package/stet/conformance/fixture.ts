import { readFileSync } from 'node:fs';

import {
  loadDescriptor,
  loadSnapshot,
  readBundle,
  type Bundle,
  type Descriptor,
  type Snapshot,
  type StoreRow,
} from '../src/index.js';

const dir = new URL('./fixtures/mini-project/', import.meta.url);

/** The fixture is inert data. Reading it is the test harness's I/O, never the core's. */
export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
}

export function miniDescriptor(): Descriptor {
  return loadDescriptor(readFixture('descriptor.json'));
}

export function miniSnapshot(): Snapshot {
  return loadSnapshot(readFixture('defaults.json'));
}

export function miniRows(): StoreRow[] {
  return readFixture('rows.json') as StoreRow[];
}

export function miniBundle(): Bundle {
  return readBundle(readFixture('bundle.json'));
}

/** A deep copy a test can break without leaking into the next test. */
export function mutable<T>(value: T): T {
  return structuredClone(value);
}
