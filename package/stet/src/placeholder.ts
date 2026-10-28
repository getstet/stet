/**
 * The numbered placeholder tags a tagged value carries (`<1>…</1>`, `<1/>`): the
 * one reader of them, which the save gate and the renderer both call. It
 * imports nothing, so a client bundle that renders a sentence key carries this
 * file and nothing of the gate.
 */

/**
 * A numbered placeholder tag: `<1>`, `</1>` or `<1/>`. These are the ONLY
 * `<`-shapes the tag rule reads — values are stored raw and the emitter escapes
 * them, so any other `<` in a value is prose and never a finding.
 */
export const PLACEHOLDER = /<(\/?)(\d+)(\/?)>/g;

/**
 * A tagged value's text as a reader sees it: the paired placeholders removed
 * and each self-closing one standing for the one space its element renders as,
 * so a `<br>` between two lines never fuses their words. It is the one
 * placeholder grammar — the length rule measures it, and the static-HTML host's
 * locator names its key from it.
 */
export function plainOf(text: string): string {
  return text.replace(PLACEHOLDER, (_match, closing: string, _number: string, selfClosing: string) =>
    closing === '' && selfClosing === '/' ? ' ' : '',
  );
}

/** A value read as its parts: the words as strings, each placeholder element with its number and its own parts (none for `<n/>`). */
export type TagNode = string | { n: number; children: TagNode[] };

/**
 * A value's parts, or the first way its tags break: a number is written
 * `[1-9][0-9]*` and lies in `1..max`, a tag carries one slash at most, each
 * number opens once, and every element closes in order. A number the value
 * never writes is no fault here: the gate adds that rule, and the renderer
 * renders nothing for it.
 */
export function tagTree(text: string, max: number): TagNode[] | { fault: string } {
  const root: TagNode[] = [];
  const open: Array<{ n: number; children: TagNode[] }> = [];
  const seen = new Set<number>();
  const into = (): TagNode[] => open[open.length - 1]?.children ?? root;
  let at = 0;
  for (const found of text.matchAll(PLACEHOLDER)) {
    if (found.index > at) into().push(text.slice(at, found.index));
    at = found.index + found[0].length;
    const closing = found[1] === '/';
    const written = found[2] as string;
    const selfClosing = found[3] === '/';
    if ((closing && selfClosing) || /^0\d/.test(written)) return { fault: `a malformed tag ${found[0]}` };
    const number = Number(written);
    if (number < 1 || number > max) return { fault: `tag ${number} beyond 1..${max}` };
    if (closing) {
      // A close whose number is nowhere open closes nothing; one that is open
      // but not innermost leaves the element above it hanging, which is the
      // fault worth naming.
      const top = open[open.length - 1];
      if (top?.n === number) open.pop();
      else if (open.some((el) => el.n === number)) return { fault: `<${top?.n}> never closed` };
      else return { fault: `</${number}> before <${number}>` };
      continue;
    }
    if (seen.has(number)) return { fault: `tag ${number} twice` };
    seen.add(number);
    const el = { n: number, children: [] as TagNode[] };
    into().push(el);
    if (!selfClosing) open.push(el);
  }
  const hanging = open[open.length - 1];
  if (hanging !== undefined) return { fault: `<${hanging.n}> never closed` };
  if (at < text.length) root.push(text.slice(at));
  return root;
}
