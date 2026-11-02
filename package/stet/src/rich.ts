/**
 * The renderer a sentence key is read through: a value with numbered
 * placeholder tags (`run <1>npx x init</1> and answer.`) handed to the host's
 * own markup, one renderer per element, each copied from the host's source.
 * The value carries only numbers in its tags and the words between reach the
 * page as strings the framework escapes, so an editor's words never become
 * markup, a URL or a handler. It imports only the tag reader.
 */

import { plainOf, tagTree, type TagNode } from './placeholder.js';

/** What a renderer receives: the element's one part as it is, or its parts as an array (empty for `<n/>`). */
export type RichChildren<R> = string | R | Array<string | R>;

/**
 * A rich value's parts, ready for a host's markup: each placeholder element
 * handed to its renderer with its children, and the text between as plain
 * strings, which the host's framework escapes. A value the tag-tree reader
 * refuses renders as its plain text: a malformed value never shows a tag. A
 * value that is not a string renders nothing, as a plain read of a removed key does.
 * `R` defaults to `any`, so a holder with no ReactNode context, such as a fragment, still typechecks.
 */
export function richParts<R = any>(value: string, render: ReadonlyArray<(children: RichChildren<R>, key: number) => R>): Array<string | R> {
  if (typeof value !== 'string') return [];
  const tree = tagTree(value, render.length);
  if ('fault' in tree) return [plainOf(value)];
  const parts = (nodes: TagNode[]): Array<string | R> =>
    nodes.map((node) => {
      if (typeof node === 'string') return node;
      const children = parts(node.children);
      // A lone child is handed as it is, so a component that takes one child (`Children.only`, a link) receives one.
      return (render[node.n - 1] as (children: RichChildren<R>, key: number) => R)(children.length === 1 ? (children[0] as string | R) : children, node.n);
    });
  return parts(tree);
}
