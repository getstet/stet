/**
 * The renderer a rich value is read through (src/rich.ts, D16): each placeholder
 * element handed to its renderer, the words between as plain strings, and a
 * value the tag reader refuses rendered as its plain text.
 */
import { describe, expect, it } from 'vitest';

import { richParts, type RichChildren } from '../src/index.js';

/** A renderer that records what it was handed: its tag, its children as given, its key. */
const tag =
  (name: string) =>
  (children: RichChildren<unknown>, key: number): unknown => ({ [name]: children, key });

describe('richParts (T16.1)', () => {
  const b = tag('b');
  const a = tag('a');

  it('hands each element its words, a lone child unwrapped, the words between as strings', () => {
    expect(richParts('run <1>npx</1> and <2>go</2>', [b, a])).toEqual(['run ', b('npx', 1), ' and ', a('go', 2)]);
  });

  it('hands a nested element to its parent among its children', () => {
    expect(richParts('<1>a <2>b</2></1>', [b, a])).toEqual([b(['a ', a('b', 2)], 1)]);
  });

  it('renders each element with its own renderer, whatever the order', () => {
    expect(richParts('<2>x</2> <1>y</1>', [b, a])).toEqual([a('x', 2), ' ', b('y', 1)]);
  });

  it('calls an empty element with no children', () => {
    expect(richParts('Line<1/>break', [b])).toEqual(['Line', b([], 1), 'break']);
  });

  it('never calls the renderer of a number the value omits, and keeps its neighbours', () => {
    let called = 0;
    const counted = (children: RichChildren<unknown>, key: number): unknown => {
      called += 1;
      return a(children, key);
    };
    expect(richParts('run <1>npx</1> now', [b, counted])).toEqual(['run ', b('npx', 1), ' now']);
    expect(called).toBe(0);
  });

  it.each([
    ['unbalanced', 'run <1>npx now', 'run npx now'],
    ['duplicated', '<1>a</1> <1>b</1>', 'a b'],
    ['0', 'run <0>npx</0> now', 'run npx now'],
    ['beyond the renderers', 'run <3>npx</3> now', 'run npx now'],
    ['a leading zero', 'run <01>npx</1> now', 'run npx now'],
    ['two slashes', 'run </1/>npx now', 'run npx now'],
  ])('renders a value with a fault (%s) as its plain text', (_name, value, plain) => {
    expect(richParts(value, [b, a])).toEqual([plain]);
  });

  it('hands markup in the words to the renderer as a string', () => {
    expect(richParts('<1><script>x</script></1>', [b])).toEqual([b('<script>x</script>', 1)]);
  });

  it('renders nothing for a value that is not a string, as a read of a removed key does', () => {
    expect(richParts(undefined as never, [b])).toEqual([]);
    expect(richParts(null as never, [b])).toEqual([]);
  });
});
