/**
 * The static-HTML locator, over the two fixture documents every later section
 * shares. These are the one place the suite reads the module directly rather
 * than through a CLI path: the tokenizer's answers are what every command's
 * output is built from, so they are pinned here as values rather than re-derived
 * per command.
 *
 * `index.html` is the reduced psyon shape and normalises on NO regeneration —
 * its entities are `&amp;` alone, no run inside a mark collapses, and no `<`
 * sits in prose — which is what makes the idempotence witnesses in the register,
 * pull and eject sections mean anything. `edges.html` carries the cases that DO
 * skip or normalise.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  checkDocuments,
  derivationOf,
  isHeadText,
  planDocuments,
  planHtmlRegister,
  proposeHtml,
  readDocument,
  stripMarks,
  valueOf,
} from '../cli/html-host.js';
import { Report } from '../cli/report.js';
import { proposeKey } from '../cli/source-scan.js';
import type { Snapshot } from '../src/snapshot.js';
import type { Descriptor } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/html-host/', import.meta.url));
const EMPTY_DESCRIPTOR: Descriptor = { version: 1, keys: {} };

const made: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-html-'));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** One ad-hoc document, read through the real entry point. */
function readSource(source: string) {
  const dir = tempDir();
  writeFileSync(join(dir, 'x.html'), source);
  return proposeHtml(dir, ['x.html']);
}

const fixture = (name: string) => proposeHtml(FIXTURES, [name]);

describe('cli/html-host.ts is a leaf', () => {
  it('imports nothing from artifacts, check, scan, pages or config', () => {
    const source = readFileSync(fileURLToPath(new URL('../cli/html-host.ts', import.meta.url)), 'utf8');
    const imports = source
      .split('\n')
      .filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line))
      .map((line) => line.trim());
    expect(imports.length).toBeGreaterThan(0);
    for (const forbidden of ['artifacts.js', 'check.js', 'scan.js', 'pages.js', 'config.js']) {
      expect(imports.join('\n')).not.toContain(forbidden);
    }
  });
});

describe('the fixture document — the pinned proposal list', () => {
  const set = fixture('index.html');
  /** `tag | meta-or-attr | tags | value` per proposal, in document order. */
  const rows = set.proposals.map(
    (p) => `${p.tag} | ${p.metaName ?? p.attr ?? ''} | ${p.tags} | ${p.value}`,
  );

  it('proposes every key element and copy attribute, and nothing else', () => {
    expect(rows).toEqual([
      'title |  | 0 | Psyon data partnerships for AI labs',
      'meta | description | 0 | Psyon connects hospitals, labs and research groups that hold real clinical data with the AI teams who need it, and handles every legal and technical step in between.',
      'meta | og:title | 0 | Psyon data partnerships',
      'meta | og:description | 0 | How a dataset becomes a partnership.',
      'nav | aria-label | 0 | Primary navigation',
      'a |  | 0 | How it works',
      'a |  | 0 | How it works',
      'h1 |  | 1 | You may already have the data<1> our AI lab partners need.</1>',
      'p |  | 0 | Research & development notes.',
      "p |  | 0 | We'll reply within a day.",
      'p |  | 1 | First line<1/>second line.',
      'p |  | 1 | An empty <1/> sits inside this sentence.',
      'p |  | 2 | Hello <1>big <2>world</2></1>!',
      'img | alt | 0 | A lab bench with sample trays',
      'h2 |  | 0 | How it works.',
      'h3 |  | 0 | Software, product and engineering histories',
      'li |  | 0 | Clinical trial records',
      'li |  | 0 | Imaging archives',
      'li |  | 0 | Longitudinal cohorts',
      'button |  | 0 | Play',
      'p |  | 0 | Send a short description of the dataset.',
      'p |  | 0 | We will reply with a scope and a price.',
      'a |  | 0 | A plain link',
      'a |  | 0 | Book now',
      'a | title | 0 | Book now',
      'button |  | 0 | How it works →',
      'textarea |  | 0 | Tell us about the dataset.',
      'p |  | 0 | A line of text on its own between the tags.',
    ]);
    expect(set.skips).toEqual([]);
    expect(set.claimed).toEqual([]);
  });

  it('proposes each key from the plain text the function itself yields', () => {
    for (const p of set.proposals) expect(p.proposedKey).toBe(proposeKey(p.plain));
    const h1 = set.proposals.find((p) => p.tag === 'h1');
    expect(h1?.plain).toBe('You may already have the data our AI lab partners need.');
    expect(h1?.proposedKey).toBe('you_may_already_have_the_data_our_ai');
    expect(set.proposals.find((p) => p.tag === 'h3')?.proposedKey).toBe(
      'software_product_and_engineering',
    );
  });

  it('reads the `<br>` paragraph as a self-closing tag whose plain text joins the lines', () => {
    const p = set.proposals.find((x) => x.value === 'First line<1/>second line.');
    expect(p?.plain).toBe('First line second line.');
  });

  it('hints the enclosing section, and leaves it undefined outside one', () => {
    expect(set.proposals.find((p) => p.tag === 'h3')?.section).toBe('qualify');
    expect(set.proposals.find((p) => p.tag === 'textarea')?.section).toBe('contact');
    expect(set.proposals.find((p) => p.tag === 'h1')?.section).toBeUndefined();
  });

  it('gives a link carrying both text and a copy title one insert offset for both marks', () => {
    const both = set.proposals.filter((p) => p.value === 'Book now');
    expect(both).toHaveLength(2);
    expect(both[0]?.insertAt).toBe(both[1]?.insertAt);
    expect(new Set(both.map((p) => p.kind))).toEqual(new Set(['element', 'attribute']));
  });

  it('says nothing about a repeated value — sharing is register’s to decide', () => {
    expect(set.proposals.filter((p) => p.value === 'How it works')).toHaveLength(2);
    // Three distinct values, one slug: the heading, the button and the links.
    const slugged = set.proposals.filter((p) => p.proposedKey === 'how_it_works');
    expect(slugged.map((p) => p.value)).toEqual([
      'How it works',
      'How it works',
      'How it works.',
      'How it works →',
    ]);
  });

  it('reads a structural container’s children on their own and never the container', () => {
    expect(set.proposals.filter((p) => p.tag === 'ul')).toEqual([]);
    expect(set.proposals.filter((p) => p.tag === 'li')).toHaveLength(3);
    // The pure `<div>` around two paragraphs is a container, not a key element.
    expect(set.proposals.filter((p) => p.tag === 'div')).toEqual([]);
  });

  it('never proposes a structural attribute, an unquoted one, or a URL-valued meta', () => {
    const attrs = set.proposals.filter((p) => p.kind === 'attribute');
    expect(attrs.map((p) => p.attr)).toEqual([
      'content',
      'content',
      'content',
      'aria-label',
      'alt',
      'title',
    ]);
    // `title=plain` is unquoted, `og:url` and `viewport` are not copy metas, and
    // `data-art-slot`, `href`, `src`, `type` and `http-equiv` are never copy.
    expect(attrs.map((p) => p.value)).not.toContain('plain');
    expect(set.proposals.map((p) => p.value).join(' ')).not.toContain('psyon.ai');
    expect(set.proposals.map((p) => p.value).join(' ')).not.toContain('device-width');
    expect(set.proposals.map((p) => p.value).join(' ')).not.toContain('IE=edge');
  });

  it('reads nothing out of a script, a style block or a comment', () => {
    const all = set.proposals.map((p) => p.value).join(' | ');
    expect(all).not.toContain('a script string');
    expect(all).not.toContain('color');
    expect(all).not.toContain('an editor might mistake');
  });
});

describe('the edge document', () => {
  const set = fixture('edges.html');

  it('reads RCDATA whole, so a `<` inside a title is a character, not a tag', () => {
    expect(set.proposals.find((p) => p.tag === 'title')?.value).toBe(
      'An edge case: read the <docs> section first',
    );
    expect(set.proposals.find((p) => p.tag === 'title')?.tags).toBe(0);
  });

  it('adopts nothing out of a template', () => {
    expect(set.proposals.map((p) => p.value).join(' | ')).not.toContain('inside a template');
  });

  it('decodes the widened named set and refuses a name it cannot read', () => {
    expect(set.proposals.find((p) => p.value.startsWith('Go'))?.value).toBe('Go → now');
    const unknown = set.skips.filter((s) => s.reason === 'unknown-entity');
    expect(unknown).toHaveLength(2); // the paragraph and the `alt`
    expect(unknown[0]?.detail).toBe('&nosuch; is not an entity stet can decode');
    expect(unknown[0]?.remedy).toBe('replace it with the character itself');
  });

  it('names an unmarked run that shares its element with a comment, and proposes nothing for it', () => {
    const beside = set.skips.filter((s) => s.reason === 'text-beside-code');
    expect(beside).toHaveLength(1);
    expect(beside[0]?.detail).toBe(
      'text in <p> sits beside a script, style, comment or declaration stet cannot regenerate whole',
    );
    expect(beside[0]?.remedy).toBe(
      'move the script, style, comment or declaration outside the element, or the text into one of its own',
    );
    // Adoption scope: the run is scan's to name and never stops a write.
    expect(beside[0]?.scope).toBe('adoption');
    expect(set.proposals.map((p) => p.value)).not.toContain('Hello world');
  });

  it('reads a marked element beside a comment as a mark fault instead, never both', () => {
    const marked = readSource('<html><body><p data-stet="k">Hello <!-- note --> world</p></body></html>');
    expect(marked.skips.map((s) => s.reason)).toEqual(['mark-on-non-key-element']);
    expect(marked.skips[0]?.detail).toBe(
      'data-stet="k" sits on <p>, whose content holds a script, style or comment stet does not manage',
    );
  });

  it('tests entities before decoding, so source spelling `&amp;nosuch;` is literal text', () => {
    const literal = set.proposals.find((p) => p.value.startsWith('Use'));
    expect(literal?.value).toBe('Use &nosuch; literally in this sentence.');
    // The paragraph is PROPOSED: only the source that really spells `&nosuch;` skips.
    const lines = set.skips.filter((s) => s.reason === 'unknown-entity').map((s) => s.line);
    expect(lines).toEqual([10, 13]);
  });

  it('claims a mark on a key element and reads what the document says now', () => {
    expect(set.claimed).toHaveLength(1);
    expect(set.claimed[0]).toMatchObject({
      key: 'edge_intro',
      kind: 'element',
      tag: 'p',
      value: 'An ordinary marked paragraph.',
    });
  });

  it('names every refused mark with its reason', () => {
    const named = set.skips.map((s) => `${s.reason} | ${s.detail}`);
    expect(named).toContain(
      'mark-on-non-key-element | data-stet="edge_list" sits on <ul>, which holds no text of its own',
    );
    expect(named).toContain(
      'mark-in-refused-context | data-stet-href names an attribute stet does not manage',
    );
    expect(named).toContain(
      'mark-in-refused-context | data-stet-content names an attribute stet does not manage',
    );
    expect(named).toContain('mark-in-refused-context | data-stet sits inside <noscript>');
    expect(named).toContain(
      'text-in-structure | text sits directly inside <ul>, which has no element to mark',
    );
  });

  it('names markup it cannot pair, once each, and reads the rest of the page', () => {
    const unpaired = set.skips.filter((s) => s.reason === 'unpaired-markup');
    expect(unpaired.map((s) => s.detail)).toEqual([
      '<p> at line 25 is never closed',
      '</span> at line 26 closes nothing',
    ]);
    expect(unpaired[0]?.remedy).toBe('close it, then run stet scan again');
    expect(unpaired[1]?.remedy).toBe('remove it, or open the element it closes');
    // The popped-past paragraph is never proposed — the tokenizer does not guess.
    expect(set.proposals.map((p) => p.value)).not.toContain('Popped past by the div’s close.');
    // Everything before the fault still reads.
    expect(set.proposals.map((p) => p.value)).toContain('An item that is a key element of its own.');
  });

  it('scopes a fault away from every mark to adoption, and one inside a mark to the mark', () => {
    for (const skip of set.skips.filter((s) => s.reason === 'unknown-entity')) {
      expect(skip.scope).toBe('adoption');
    }
    expect(set.skips.find((s) => s.reason === 'text-in-structure')?.scope).toBe('adoption');

    const marked = readSource('<html><body><p data-stet="k">An unknown &nosuch; entity.</p></body></html>');
    const unknown = marked.skips.filter((s) => s.reason === 'unknown-entity');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.scope).toBe('mark');
    expect(marked.claimed[0]?.value).toBeNull();
  });
});

describe('the tokenizer’s own rules', () => {
  it('stops at the outermost element with a bare run — the descendants are absorbed', () => {
    const set = readSource('<html><body><h1>Data<span> partners need.</span></h1></body></html>');
    expect(set.proposals).toHaveLength(1);
    expect(set.proposals[0]?.tag).toBe('h1');
    expect(set.proposals[0]?.value).toBe('Data<1> partners need.</1>');
  });

  it('numbers descendants depth-first across the whole element', () => {
    const doc = readDocument('x.html', '<p>Hello <b>big <i>world</i></b>!</p>');
    const p = doc.roots[0];
    expect(p?.descendants.map((d) => d.tag)).toEqual(['b', 'i']);
    expect(valueOf(p!).value).toBe('Hello <1>big <2>world</2></1>!');
  });

  it('reports an element that never closes and keeps reading what came before it', () => {
    const set = readSource(
      '<html><body><p>Read before the fault.</p><div><p>After</p></body></html>',
    );
    const unpaired = set.skips.filter((s) => s.reason === 'unpaired-markup');
    expect(unpaired).toHaveLength(1);
    expect(unpaired[0]?.detail).toContain('is never closed');
    expect(set.proposals.map((p) => p.value)).toContain('Read before the fault.');
  });

  it('reads an open tag it cannot parse as text, and its close as an unpaired fault', () => {
    // Attributes with no whitespace between them: a stated limit, reported.
    const set = readSource('<html><body><p class="a"id="b">Text here.</p></body></html>');
    expect(set.skips.some((s) => s.reason === 'unpaired-markup')).toBe(true);
  });

  it('refuses an element whose content holds a script, style or comment', () => {
    const set = readSource(
      '<html><body><p data-stet="k">Text <script>var a = 1;</script> more.</p></body></html>',
    );
    const skip = set.skips.find((s) => s.reason === 'mark-on-non-key-element');
    expect(skip?.detail).toBe(
      'data-stet="k" sits on <p>, whose content holds a script, style or comment stet does not manage',
    );
    expect(skip?.remedy).toBe('move the mark onto an element that holds text alone');
    expect(set.claimed).toEqual([]);
  });

  it('inserts a mark before the closing bracket, or before the space that precedes a self-closing slash', () => {
    const set = readSource('<html><body><img src="/a.jpg" alt="A lab bench" /></body></html>');
    const at = set.proposals[0]?.insertAt as number;
    const source = readFileSync(join(made[made.length - 1] as string, 'x.html'), 'utf8');
    // The insert point steps BACK over the whitespace already before `/>`, so
    // the written tag reads ` data-stet-alt="…" />` — one space each side —
    // rather than a doubled space before the mark and none after it.
    expect(source.slice(at, at + 3)).toBe(' />');
    const written = `${source.slice(0, at)} data-stet-alt="a_lab_bench"${source.slice(at)}`;
    expect(written).toContain('alt="A lab bench" data-stet-alt="a_lab_bench" />');
    expect(written).not.toContain('  data-stet-alt');
  });

  it('inserts a mark before the closing bracket of an ordinary open tag', () => {
    const set = readSource('<html><body><p>An ordinary paragraph here.</p></body></html>');
    const at = set.proposals[0]?.insertAt as number;
    const source = readFileSync(join(made[made.length - 1] as string, 'x.html'), 'utf8');
    expect(source.charAt(at)).toBe('>');
  });
});

describe('the documents as generated forms', () => {
  /**
   * A host adopted the way `register --write` adopts it: the page marked, the
   * descriptor and snapshot filled, everything on disk.
   */
  function adopted(source = readFileSync(join(FIXTURES, 'index.html'), 'utf8')) {
    const dir = tempDir();
    writeFileSync(join(dir, 'index.html'), source, 'utf8');
    const descriptor: Descriptor = { version: 1, keys: {} };
    const snapshot: Snapshot = { default: {} };
    const plan = planHtmlRegister({
      cwd: dir,
      files: ['index.html'],
      descriptor,
      snapshot,
      report: new Report(),
    });
    for (const document of plan.edited) writeFileSync(document.abs, document.text, 'utf8');
    return { dir, descriptor, snapshot, page: readFileSync(join(dir, 'index.html'), 'utf8') };
  }

  const plan = (host: { dir: string; descriptor: Descriptor; snapshot: Snapshot }) =>
    planDocuments(host.dir, ['index.html'], host.descriptor, host.snapshot, new Report());

  /** The key whose default is exactly `value`. */
  function keyFor(snapshot: Snapshot, value: string): string {
    const found = Object.entries(snapshot['default'] ?? {}).find(([, v]) => v === value);
    if (found === undefined) throw new Error(`no key holds ${JSON.stringify(value)}`);
    return found[0];
  }

  it('plans no write when every mark already equals its value', () => {
    const host = adopted();
    expect(plan(host)).toEqual({ writes: [], skips: [] });
  });

  it('rewrites one element’s content and no byte outside it', () => {
    const host = adopted();
    const key = keyFor(host.snapshot, 'Software, product and engineering histories');
    host.snapshot['default']![key] = 'Engineering and product histories';
    const { writes, skips } = plan(host);
    expect(skips).toEqual([]);
    expect(writes).toHaveLength(1);
    // One contiguous region changed: putting the old text back reproduces the
    // page byte for byte.
    expect(
      (writes[0] as { text: string }).text.replace(
        'Engineering and product histories',
        'Software, product and engineering histories',
      ),
    ).toBe(host.page);
  });

  it('escapes three characters in a body and leaves prose punctuation alone', () => {
    const host = adopted();
    const key = keyFor(host.snapshot, 'Clinical trial records');
    host.snapshot['default']![key] = "Trials & records <under> review, it's ready";
    const text = (plan(host).writes[0] as { text: string }).text;
    expect(text).toContain("Trials &amp; records &lt;under&gt; review, it's ready");
  });

  it('escapes an attribute value through the web target’s own escaper', () => {
    const host = adopted();
    const key = keyFor(host.snapshot, 'A lab bench with sample trays');
    host.snapshot['default']![key] = 'A bench they call "the rig"';
    const text = (plan(host).writes[0] as { text: string }).text;
    expect(text).toContain('alt="A bench they call &quot;the rig&quot;"');
  });

  it('moves a placeholder’s element with its text, attributes verbatim', () => {
    const host = adopted();
    const key = keyFor(host.snapshot, 'You may already have the data<1> our AI lab partners need.</1>');
    host.snapshot['default']![key] = '<1> partners need</1> you may have the data';
    const text = (plan(host).writes[0] as { text: string }).text;
    expect(text).toContain('<span class="tail"> partners need</span> you may have the data');
  });

  it('reaches a nested descendant by its own number, not its parent’s child index', () => {
    const host = adopted();
    const key = keyFor(host.snapshot, 'Hello <1>big <2>world</2></1>!');
    host.snapshot['default']![key] = 'Hello <1>big <2>planet</2></1>!';
    const text = (plan(host).writes[0] as { text: string }).text;
    expect(text).toContain('Hello <b>big <i>planet</i></b>!');
  });

  it('reproduces a self-closing placeholder’s WHOLE span, so the document stays balanced', () => {
    const host = adopted();
    host.snapshot['default']![keyFor(host.snapshot, 'First line<1/>second line.')] =
      'One line<1/>another line.';
    host.snapshot['default']![keyFor(host.snapshot, 'An empty <1/> sits inside this sentence.')] =
      'Another empty <1/> sits here.';
    const text = (plan(host).writes[0] as { text: string }).text;
    expect(text).toContain('One line<br>another line.');
    expect(text).toContain('Another empty <span></span> sits here.');
    // And the output still reads as a well-formed document.
    expect(readDocument('index.html', text).faults).toEqual([]);
  });

  it('keeps the indentation around a multi-line element and collapses only inside it', () => {
    const host = adopted();
    const key = keyFor(host.snapshot, 'A line of text on its own between the tags.');
    host.snapshot['default']![key] = 'A shorter line.';
    const text = (plan(host).writes[0] as { text: string }).text;
    expect(text).toContain('      <p data-stet="' + key + '">\n        A shorter line.\n      </p>');
  });

  it('skips a value whose placeholders no longer match the element', () => {
    const host = adopted();
    const key = keyFor(host.snapshot, 'You may already have the data<1> our AI lab partners need.</1>');
    host.snapshot['default']![key] = 'You may already have the data our AI lab partners need.';
    const { writes, skips } = plan(host);
    expect(writes).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ reason: 'tag-count-mismatch', scope: 'mark' });
    expect(skips[0]?.detail).toBe(
      'the value carries 0 placeholder tag(s), the element has 1 descendant element(s)',
    );
    expect(skips[0]?.remedy).toBe('edit one side');
  });

  it('strips a mark whose key the descriptor no longer declares, keeping its text', () => {
    const host = adopted();
    const key = keyFor(host.snapshot, 'Imaging archives');
    delete host.descriptor.keys[key];
    const report = new Report();
    const { writes } = planDocuments(host.dir, ['index.html'], host.descriptor, host.snapshot, report);
    const text = (writes[0] as { text: string }).text;
    expect(text).toContain('<li>Imaging archives</li>');
    expect(text).not.toContain(key);
    // The line is on the report's human channel, so it is read through `emit`.
    const out: string[] = [];
    report.emit({ stdout: (l) => out.push(l), stderr: () => {} });
    expect(out.join('\n')).toContain(
      `data-stet="${key}" names no key — the mark is removed and the text stays`,
    );
  });

  it('normalises an entity the source spelled by name, on the first write', () => {
    const host = adopted('<html><body><p>An em&mdash;dash sits here.</p></body></html>');
    expect(host.snapshot['default']).toMatchObject({});
    const { writes } = plan(host);
    // The value decoded to the character, so the first regeneration writes it.
    expect(host.page).toContain('&mdash;');
    expect((writes[0] as { text: string }).text).toContain('An em—dash sits here.');
  });

  it('never stops a write for a fault away from every mark', () => {
    // One mark, plus two ADOPTION-scope faults: an unknown entity and a bare run
    // in a `<ul>`. Neither is stet's red, so neither reaches the regenerator.
    const quiet = [
      '<html>',
      '<body>',
      '  <p data-stet="edge_intro">An ordinary marked paragraph.</p>',
      '  <p>An unknown &nosuch; entity sits here.</p>',
      '  <ul>',
      '    A bare run sits directly inside this list.',
      '    <li>An item that is a key element of its own.</li>',
      '  </ul>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
    const dir = tempDir();
    writeFileSync(join(dir, 'page.html'), quiet, 'utf8');
    const descriptor: Descriptor = { version: 1, keys: { edge_intro: { shape: 'text', target: 'web' } } };
    const snapshot: Snapshot = { default: { edge_intro: 'A rewritten marked paragraph.' } };

    const first = planDocuments(dir, ['page.html'], descriptor, snapshot, new Report());
    expect(first.skips).toEqual([]);
    expect(first.writes).toHaveLength(1);
    expect((first.writes[0] as { text: string }).text).toContain('A rewritten marked paragraph.');

    // Marked, the same entity is the mark's own fault and stops the write.
    writeFileSync(
      join(dir, 'page.html'),
      quiet.replace('<p>An unknown &nosuch;', '<p data-stet="edge_broken">An unknown &nosuch;'),
      'utf8',
    );
    descriptor.keys['edge_broken'] = { shape: 'text', target: 'web' };
    snapshot['default']!['edge_broken'] = 'x';
    const second = planDocuments(dir, ['page.html'], descriptor, snapshot, new Report());
    expect(second.skips.map((k) => `${k.reason}/${k.scope}`)).toEqual(['unknown-entity/mark']);
  });

  it('strips every mark and keeps every text', () => {
    const host = adopted();
    const bare = stripMarks(host.page);
    expect(bare).not.toContain('data-stet');
    expect(Buffer.from(bare, 'utf8')).toEqual(
      Buffer.from(readFileSync(join(FIXTURES, 'index.html'), 'utf8'), 'utf8'),
    );
  });
});

describe('the stage-5 fold — a mark is the declaration', () => {
  /** One page, adopted by hand: the mark written, the key declared, the value set. */
  function marked(page: string, key: string, value: string, def: Record<string, unknown> = {}) {
    const dir = tempDir();
    writeFileSync(join(dir, 'x.html'), page, 'utf8');
    const descriptor: Descriptor = {
      version: 1,
      keys: { [key]: { shape: 'text', target: 'web', ...def } },
    } as Descriptor;
    const snapshot: Snapshot = { default: { [key]: value } };
    return { dir, descriptor, snapshot };
  }

  for (const value of ['', '19', '€19', '→', 'A', '1 2 3']) {
    it(`honours a mark whose value is ${JSON.stringify(value)} — the bar is the proposal path's alone`, () => {
      const { dir, descriptor, snapshot } = marked(
        '<html><body><h3 data-stet="heading">Software product engineering</h3></body></html>\n',
        'heading',
        value,
      );
      const plan = planDocuments(dir, ['x.html'], descriptor, snapshot, new Report());
      // No skip at all: the mark declares the element, whatever it now says.
      expect(plan.skips).toEqual([]);
      expect(plan.writes[0]?.text).toContain(`<h3 data-stet="heading">${value}</h3>`);

      // And the written page reads back the same way, so the next run is current.
      writeFileSync(join(dir, 'x.html'), plan.writes[0]?.text as string, 'utf8');
      const second = planDocuments(dir, ['x.html'], descriptor, snapshot, new Report());
      expect(second.writes).toEqual([]);
      expect(second.skips).toEqual([]);
    });
  }

  it('honours a marked <title> whose value is blank', () => {
    const { dir, descriptor, snapshot } = marked(
      '<html><head><title data-stet="t">A page title</title></head><body><p>Body.</p></body></html>\n',
      't',
      '',
    );
    const plan = planDocuments(dir, ['x.html'], descriptor, snapshot, new Report());
    expect(plan.skips).toEqual([]);
    expect(plan.writes[0]?.text).toContain('<title data-stet="t"></title>');
  });

  it('names two marks on one element and honours neither', () => {
    const set = readSource('<html><body><p data-stet="a_key" data-stet="b_key">Some text here.</p></body></html>');
    expect(set.claimed).toEqual([]);
    expect(set.skips.map((s) => `${s.reason} | ${s.detail} | ${s.remedy}`)).toEqual([
      'mark-on-non-key-element | <p> carries two data-stet marks | keep one',
    ]);
  });

  it('gives a marked element inside unpaired markup the accurate reason, and only that one', () => {
    // The fault sits INSIDE the marked element: the unclosed <b> is popped past
    // by </p>, so the p itself is the element the tokenizer could not pair.
    const set = readSource('<html><body><p data-stet="k">Hello <b>there friend</p></body></html>');
    // Not `mark-on-non-key-element`, whose remedy ("move the mark onto the
    // element that holds the text") would be wrong: the p does hold the text.
    expect(set.skips.filter((s) => s.reason === 'mark-on-non-key-element')).toEqual([]);
    const unpaired = set.skips.filter((s) => s.reason === 'unpaired-markup');
    expect(unpaired.length).toBeGreaterThan(0);
    // Mark scope, so `check` and the regenerator both see it.
    expect(unpaired.some((s) => s.scope === 'mark')).toBe(true);
  });

  it('still refuses a mark on a structural element and on one holding a blanked span', () => {
    const structural = readSource('<html><body><ul data-stet="k">A bare run in a list.<li>An item here.</li></ul></body></html>');
    expect(structural.skips.map((s) => s.detail)).toContain(
      'data-stet="k" sits on <ul>, which holds no text of its own',
    );
    const blanked = readSource('<html><body><p data-stet="k">Hello <!-- note --> world</p></body></html>');
    expect(blanked.skips.map((s) => s.detail)).toContain(
      'data-stet="k" sits on <p>, whose content holds a script, style or comment stet does not manage',
    );
  });
});

describe('the stage-5 fold — the declaration decides the placeholder grammar', () => {
  function host(page: string, value: string, tags?: number) {
    const dir = tempDir();
    writeFileSync(join(dir, 'x.html'), page, 'utf8');
    const descriptor = {
      version: 1,
      keys: { k: { shape: 'text', target: 'web', ...(tags === undefined ? {} : { tags }) } },
    } as unknown as Descriptor;
    return { dir, descriptor, snapshot: { default: { k: value } } as Snapshot };
  }

  it('writes a literal `<1>` as prose when the key declares no tags', () => {
    const { dir, descriptor, snapshot } = host(
      '<html><body><p data-stet="k">See footnote <1> for the details.</p></body></html>\n',
      'See footnote <1> for the details.',
    );
    const plan = planDocuments(dir, ['x.html'], descriptor, snapshot, new Report());
    expect(plan.skips).toEqual([]);
    expect(plan.writes[0]?.text).toContain('See footnote &lt;1&gt; for the details.');
  });

  it('refuses an untagged key on an element that has descendants, and says so once', () => {
    const { dir, descriptor, snapshot } = host(
      '<html><body><p data-stet="k">Hello <b>big</b> world</p></body></html>\n',
      'Hello big world',
    );
    const plan = planDocuments(dir, ['x.html'], descriptor, snapshot, new Report());
    expect(plan.writes).toEqual([]);
    expect(plan.skips.map((s) => s.reason)).toEqual(['tag-count-mismatch']);
    // The key declares no tags at all, which is the real cause: naming the
    // value's placeholder count would describe a symptom.
    expect(plan.skips[0]?.detail).toBe('the key declares no tags, the element has 1 descendant element(s)');
    expect(plan.skips[0]?.remedy).toBe(
      'declare tags: 1 on the key and give the value its placeholders, or mark the elements inside it instead',
    );
  });

  it('walks the placeholders when the key declares tags', () => {
    const { dir, descriptor, snapshot } = host(
      '<html><body><p data-stet="k">Hello <b>big</b> world</p></body></html>\n',
      'Goodbye <1>small</1> world',
      1,
    );
    const plan = planDocuments(dir, ['x.html'], descriptor, snapshot, new Report());
    expect(plan.skips).toEqual([]);
    expect(plan.writes[0]?.text).toContain('Goodbye <b>small</b> world');
  });
});

describe('the stage-5 fold — whitespace, marks and unknown keys', () => {
  it('keeps a literal non-breaking space through read and write', () => {
    const page = `<html><body><p data-stet="k">1 000 members</p></body></html>\n`;
    const dir = tempDir();
    writeFileSync(join(dir, 'x.html'), page, 'utf8');
    const set = proposeHtml(dir, ['x.html']);
    expect(set.claimed[0]?.value).toBe('1 000 members');

    const descriptor = { version: 1, keys: { k: { shape: 'text', target: 'web' } } } as unknown as Descriptor;
    const plan = planDocuments(dir, ['x.html'], descriptor, { default: { k: '1 000 members' } }, new Report());
    // A fixed point already: nothing to write, and the character survives.
    expect(plan.writes).toEqual([]);
  });

  it('still decodes the entity form to the same character', () => {
    const set = readSource('<html><body><p>1&nbsp;000 members here</p></body></html>');
    expect(set.proposals[0]?.value).toBe('1 000 members here');
  });

  it('lands a padded value as the page renders it, so the next write is current', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'x.html'), '<html><body><p data-stet="k">Padded text here</p></body></html>\n', 'utf8');
    const descriptor = { version: 1, keys: { k: { shape: 'text', target: 'web' } } } as unknown as Descriptor;
    const snapshot = { default: { k: 'Padded  text   here  ' } } as Snapshot;
    const first = planDocuments(dir, ['x.html'], descriptor, snapshot, new Report());
    // The page already holds the value's read-back form, so there is nothing to
    // write at all — the padding never reaches the document and cannot accrete.
    expect(first.writes).toEqual([]);

    // From a page that really differs, the write lands the rendered form once
    // and every run after it is current.
    writeFileSync(join(dir, 'x.html'), '<html><body><p data-stet="k">Old text</p></body></html>\n', 'utf8');
    const wrote = planDocuments(dir, ['x.html'], descriptor, snapshot, new Report());
    expect(wrote.writes[0]?.text).toContain('<p data-stet="k">Padded text here</p>');
    let page = wrote.writes[0]?.text as string;
    const sizes: number[] = [];
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, 'x.html'), page, 'utf8');
      sizes.push(Buffer.byteLength(page, 'utf8'));
      const again = planDocuments(dir, ['x.html'], descriptor, snapshot, new Report());
      page = (again.writes[0]?.text as string | undefined) ?? page;
    }
    // The old splice re-appended the trailing run every time: 199, 201, 203 …
    expect(new Set(sizes).size).toBe(1);
  });

  it('strips a prototype-named mark and keeps its text, on both maps', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'x.html'),
      '<html><body><p data-stet="constructor">First run of text.</p>' +
        '<p data-stet="toString">Second run of text.</p></body></html>\n',
      'utf8',
    );
    const report = new Report();
    const plan = planDocuments(dir, ['x.html'], EMPTY_DESCRIPTOR, {}, report);
    const out = plan.writes[0]?.text as string;
    expect(out).not.toContain('data-stet=');
    expect(out).toContain('First run of text.');
    expect(out).toContain('Second run of text.');
    let stdout = '';
    report.emit({ stdout: (line) => (stdout += `${line}\n`), stderr: () => {} });
    expect(stdout).toContain('data-stet="constructor" names no key');
    expect(stdout).toContain('data-stet="toString" names no key');
  });

  it('strips marks by attribute span, so prose that quotes one is untouched', () => {
    const page =
      '<html><body>\n' +
      '<p data-stet="real">The attribute form is <code>data-stet-alt="image_caption"</code> instead.</p>\n' +
      '<p>Write data-stet="unclosed and then keep going</p>\n' +
      '<p>Second para with a "quote" here</p>\n' +
      '</body></html>\n';
    const out = stripMarks(page);
    expect(out).not.toContain('data-stet="real"');
    // Every literal in prose survives, byte for byte.
    expect(out).toContain('<code>data-stet-alt="image_caption"</code>');
    expect(out).toContain('Write data-stet="unclosed and then keep going');
    expect(out).toContain('<p>Second para with a "quote" here</p>');
    expect(out.split('</p>')).toHaveLength(4);
  });

  it('names the fault when a marked attribute is absent or unquoted', () => {
    const absent = readSource('<html><body><img src="/a.jpg" data-stet-alt="k"></body></html>');
    expect(absent.skips.map((s) => `${s.detail} | ${s.remedy}`)).toContain(
      'data-stet-alt names an attribute this element does not carry quoted | ' +
        'add the attribute with a quoted value, or remove the mark',
    );
    const refused = readSource('<html><body><a href="/x" data-stet-href="k">A link here.</a></body></html>');
    expect(refused.skips.map((s) => `${s.detail} | ${s.remedy}`)).toContain(
      'data-stet-href names an attribute stet does not manage | remove the mark',
    );
  });

  it('reads a 2 MB page with 5,000 marks in linear time', () => {
    const filler = 'with enough words in it to qualify as ordinary page copy '.repeat(6);
    const body = Array.from(
      { length: 5000 },
      (_, i) => `  <p data-stet="k_${i}">Paragraph number ${i} ${filler}ends here.</p>`,
    ).join('\n');
    const dir = tempDir();
    writeFileSync(join(dir, 'x.html'), `<html><body>\n${body}\n</body></html>\n`, 'utf8');
    const started = Date.now();
    const set = proposeHtml(dir, ['x.html']);
    const elapsed = Date.now() - started;
    expect(set.claimed).toHaveLength(5000);
    expect(readFileSync(join(dir, 'x.html')).byteLength).toBeGreaterThan(2_000_000);
    // Quadratic line lookup put a 1 MB page at 13 s and a 5 MB page at 4.6
    // minutes; the bound is generous so a slow machine does not flake it.
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe('the delta fold — marks with nowhere to put text', () => {
  it('refuses an element mark on a void element and never grows the page', () => {
    const set = readSource('<html><body><img src="a.png" data-stet="k"></body></html>');
    expect(set.claimed).toEqual([]);
    expect(set.skips.map((s) => `${s.reason} | ${s.detail} | ${s.remedy}`)).toEqual([
      'mark-on-non-key-element | data-stet="k" sits on <img>, which has no content to hold text | ' +
        'mark a copy attribute with data-stet-<attr> instead',
    ]);

    // And the regenerator refuses rather than splicing outside the element: the
    // content span is zero-width, so a write would append a copy every pull.
    const dir = tempDir();
    const page = '<html><body><img src="a.png" data-stet="k"></body></html>\n';
    writeFileSync(join(dir, 'x.html'), page, 'utf8');
    const descriptor = { version: 1, keys: { k: { shape: 'text', target: 'web' } } } as unknown as Descriptor;
    const snapshot = { default: { k: 'A lab bench' } } as Snapshot;
    for (let i = 0; i < 3; i++) {
      const plan = planDocuments(dir, ['x.html'], descriptor, snapshot, new Report());
      expect(plan.writes).toEqual([]);
      expect(plan.skips.map((s) => s.reason)).toEqual(['mark-on-non-key-element']);
      expect(readFileSync(join(dir, 'x.html'), 'utf8')).toBe(page);
    }
  });

  it('refuses one on a <br> too, and still binds the attribute form', () => {
    // Outside any key element, so the void branch is the one that answers: a
    // <br> inside a marked paragraph is already "inside another key element".
    const br = readSource('<html><body><div><br data-stet="k"></div></body></html>');
    expect(br.skips.map((s) => s.detail)).toContain(
      'data-stet="k" sits on <br>, which has no content to hold text',
    );
    const attr = readSource('<html><body><img src="a.png" alt="A lab bench here" data-stet-alt="k"></body></html>');
    expect(attr.skips).toEqual([]);
    expect(attr.claimed[0]).toMatchObject({ kind: 'attribute', attr: 'alt', key: 'k' });
  });
});

describe('the delta fold — <pre> keeps its own whitespace', () => {
  const THREE_LINE = '<html><body><pre data-stet="k">line one\nline two\nline three</pre></body></html>\n';

  it('refuses a mark on a <pre> and leaves the block untouched', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'x.html'), THREE_LINE, 'utf8');
    const set = proposeHtml(dir, ['x.html']);
    expect(set.claimed).toEqual([]);
    expect(set.skips.map((s) => `${s.detail} | ${s.remedy}`)).toContain(
      'data-stet="k" sits on <pre>, whose whitespace stet does not manage | mark the elements around it instead',
    );
    const descriptor = { version: 1, keys: { k: { shape: 'text', target: 'web' } } } as unknown as Descriptor;
    const plan = planDocuments(dir, ['x.html'], descriptor, { default: { k: 'line one line two line three' } }, new Report());
    // Nothing written: the three lines cannot be folded onto one.
    expect(plan.writes).toEqual([]);
    expect(readFileSync(join(dir, 'x.html'), 'utf8')).toBe(THREE_LINE);
  });

  it('reproduces an unmarked <pre> inside a marked element verbatim', () => {
    const page = '<html><body><div data-stet="k">Read this first:<pre>  a\n  b</pre></div></body></html>\n';
    const dir = tempDir();
    writeFileSync(join(dir, 'x.html'), page, 'utf8');
    const set = proposeHtml(dir, ['x.html']);
    expect(set.claimed[0]?.value).toBe('Read this first:<1/>');
    const descriptor = { version: 1, keys: { k: { shape: 'text', target: 'web', tags: 1 } } } as unknown as Descriptor;
    const plan = planDocuments(dir, ['x.html'], descriptor, { default: { k: 'Read this first:<1/>' } }, new Report());
    expect(plan.skips).toEqual([]);
    expect(plan.writes).toEqual([]); // already a fixed point, byte for byte
  });

  it('proposes nothing for a <pre> of prose alone', () => {
    const set = readSource('<html><body><pre>Ordinary prose sitting in a pre block.</pre></body></html>');
    expect(set.proposals).toEqual([]);
    expect(set.skips).toEqual([]);
  });
});

describe('the delta fold — the trim matches the collapse', () => {
  it('round-trips a value padded with non-breaking spaces byte-identically', () => {
    const value = ' Lead and trail ';
    const dir = tempDir();
    writeFileSync(join(dir, 'x.html'), `<html><body><p data-stet="k">${value}</p></body></html>\n`, 'utf8');
    const descriptor = { version: 1, keys: { k: { shape: 'text', target: 'web' } } } as unknown as Descriptor;
    const set = proposeHtml(dir, ['x.html']);
    expect(set.claimed[0]?.value).toBe(value);
    // `.trim()` strips U+00A0, which would lose at the edge exactly what the
    // collapse is careful to keep in the middle.
    const plan = planDocuments(dir, ['x.html'], descriptor, { default: { k: value } }, new Report());
    expect(plan.writes).toEqual([]);
  });
});

describe('the delta fold — a page too deep for the argument limit', () => {
  it('flattens 60,000 siblings and 50,000 children without overflowing', () => {
    const items = Array.from({ length: 60_000 }, (_, i) => `<li>Item number ${i} here.</li>`).join('');
    const spans = Array.from({ length: 50_000 }, (_, i) => `<span>${i}</span>`).join('');
    const dir = tempDir();
    writeFileSync(
      join(dir, 'x.html'),
      `<html><body><ul>${items}</ul><div data-stet="k">Lead text here.${spans}</div></body></html>\n`,
      'utf8',
    );
    const started = Date.now();
    const set = proposeHtml(dir, ['x.html']);
    const elapsed = Date.now() - started;
    // The spread form threw `RangeError: Maximum call stack size exceeded`
    // (too many arguments) near 40,000 under one parent.
    expect(set.proposals.length).toBeGreaterThan(59_000);
    expect(set.claimed[0]?.tags).toBe(50_000);
    expect(elapsed).toBeLessThan(30_000);
  });
});

describe('derived marks', () => {
  const HEAD = 'You may already have the data our AI lab partners need. No raw data is needed to start.';
  const PAGE =
    '<!DOCTYPE html>\n<html><head>\n' +
    `<meta property="og:description" content="${HEAD}" data-stet-content="share">\n` +
    '</head><body>\n' +
    '<h1 data-stet="hero">You may already have the data<span class="tail"> our AI lab partners need.</span></h1>\n' +
    '</body></html>\n';
  /** A marked page whose share description derives from its tagged headline. */
  function derivedHost(value = 'You may already have the data<1> our AI lab partners need.</1>') {
    const dir = tempDir();
    writeFileSync(join(dir, 'index.html'), PAGE, 'utf8');
    const descriptor: Descriptor = {
      version: 1,
      keys: {
        hero: { shape: 'text', target: 'web', tags: 1 },
        share: { shape: 'text', target: 'web', derivesFrom: 'hero', tmpl: '{v} No raw data is needed to start.' },
      },
    };
    const snapshot: Snapshot = { default: { hero: value } };
    return { dir, descriptor, snapshot };
  }
  const check = (host: ReturnType<typeof derivedHost>): string[] => {
    const report = new Report();
    checkDocuments(host.dir, ['index.html'], host.descriptor, host.snapshot, report);
    return report.findings.map((f) => `${f.level} ${f.message}`);
  };
  const plan = (host: ReturnType<typeof derivedHost>) =>
    planDocuments(host.dir, ['index.html'], host.descriptor, host.snapshot, new Report());

  it('checks and regenerates a derived attribute from its source’s edit', () => {
    const host = derivedHost();
    expect(check(host)).toEqual([]);
    expect(plan(host).writes).toEqual([]);

    host.snapshot['default']!['hero'] = 'You may already have data<1> our AI lab partners need.</1>';
    const findings = check(host);
    expect(findings.filter((f) => f.includes('differs from the snapshot')).sort()).toEqual([
      expect.stringContaining('index.html:3 share differs from the snapshot'),
      expect.stringContaining('index.html:5 hero differs from the snapshot'),
    ]);
    const { writes, skips } = plan(host);
    expect(skips).toEqual([]);
    const text = (writes[0] as { text: string }).text;
    expect(text).toContain(
      'content="You may already have data our AI lab partners need. No raw data is needed to start."',
    );
    expect(text).toContain('<h1 data-stet="hero">You may already have data<span class="tail"> our AI lab partners need.</span></h1>');
    writeFileSync(join(host.dir, 'index.html'), text, 'utf8');
    expect(plan(host).writes).toEqual([]);
    expect(check(host)).toEqual([]);
  });

  it('escapes a source’s quote and ampersand where the derivation lands in an attribute', () => {
    const host = derivedHost('Say "hi" & go<1> our AI lab partners need.</1>');
    const text = (plan(host).writes[0] as { text: string }).text;
    expect(text).toContain('content="Say &quot;hi&quot; &amp; go our AI lab partners need. No raw data is needed to start."');
  });

  it('warns about a derived key marked in no document, since it renders nowhere', () => {
    const host = derivedHost();
    host.descriptor.keys['orphan'] = { shape: 'text', target: 'web', derivesFrom: 'hero', tmpl: '{v}!' };
    expect(check(host)).toEqual(['warn orphan: marked in no document']);
  });
});

describe('head texts', () => {
  /** `derive.html`, registered and written, so every proposal is now a claimed mark. */
  function registered(source: string) {
    const dir = tempDir();
    writeFileSync(join(dir, 'index.html'), source, 'utf8');
    const descriptor: Descriptor = { version: 1, keys: {} };
    const snapshot: Snapshot = { default: {} };
    const plan = planHtmlRegister({ cwd: dir, files: ['index.html'], descriptor, snapshot, report: new Report() });
    for (const document of plan.edited) writeFileSync(document.abs, document.text, 'utf8');
    return proposeHtml(dir, ['index.html']);
  }

  it('carries a claimed meta mark’s name, and tells the head texts from the rest', () => {
    const proposals = fixture('derive.html').proposals;
    const set = registered(readFileSync(join(FIXTURES, 'derive.html'), 'utf8'));
    expect(set.claimed.filter((m) => m.tag === 'meta').map((m) => m.metaName)).toEqual(
      proposals.filter((p) => p.tag === 'meta').map((p) => p.metaName),
    );
    expect(set.claimed.filter((m) => m.tag === 'meta').map((m) => m.metaName)).toEqual([
      'description',
      'og:title',
      'og:description',
      'twitter:description',
    ]);
    const heads = set.claimed.filter(isHeadText).map((m) => `${m.tag} ${m.metaName ?? m.attr ?? ''}`.trim());
    expect(heads).toEqual(['title', 'meta description', 'meta og:title', 'meta og:description', 'meta twitter:description']);
    const rest = set.claimed.filter((m) => !isHeadText(m)).map((m) => `${m.tag} ${m.attr ?? ''}`.trim());
    expect(rest).toEqual(['a', 'h1', 'p', 'button', 'h2', 'h3', 'nav aria-label']);
    for (const p of proposals) expect(isHeadText(p)).toBe(p.tag === 'title' || p.tag === 'meta');
  });

  it('reads a `<title>` inside an `<svg>` as the graphic’s, not the page’s', () => {
    const page =
      '<!DOCTYPE html>\n<html><head><title>Acme</title></head><body>\n' +
      '<button><svg viewBox="0 0 1 1"><title>Close the menu</title></svg><span>Close the menu</span></button>\n' +
      '</body></html>\n';
    const svgTitle = readSource(page).proposals.find((p) => p.tag === 'title' && p.value === 'Close the menu');
    expect(svgTitle?.inSvg).toBe(true);
    expect(isHeadText(svgTitle!)).toBe(false);
    const marks = registered(page).claimed.filter((m) => m.tag === 'title');
    expect(marks.map((m) => [m.inSvg ?? null, isHeadText(m)])).toEqual([
      [null, true],
      [true, false],
    ]);
  });
});

describe('derivationOf', () => {
  const plain: Descriptor = { version: 1, keys: { a: { shape: 'text', target: 'web' }, b: { shape: 'text', target: 'web' } } };
  const one = (value: string, key = 'a') => [{ key, value }];

  it('derives an equal text as `{v}`', () => {
    expect(derivationOf(plain, 'Ship the catalogue', one('Ship the catalogue'))).toEqual({ source: 'a', tmpl: '{v}' });
  });

  it('derives a word-bounded text of at least half the head text', () => {
    const inner = 'ship the whole catalogue';
    const head = 'We ship the whole catalogue every day.';
    expect([inner.length, head.length]).toEqual([24, 38]);
    expect(derivationOf(plain, head, one(inner))).toEqual({ source: 'a', tmpl: 'We {v} every day.' });
  });

  it('refuses a text directly after letters', () => {
    expect(derivationOf(plain, 'We reship the whole catalogue every day', one('ship the whole catalogue'))).toBeNull();
    expect(derivationOf(plain, 'Reship the whole catalogue', one('ship the whole catalogue'))).toBeNull();
  });

  it('refuses a text under half the head text', () => {
    const head = 'Start a trial today and see the whole catalogue for yourself.';
    expect(head.length).toBe(61);
    expect(derivationOf(plain, head, one('Start a trial'))).toBeNull();
  });

  it('derives a short text equal to the whole head text', () => {
    expect(derivationOf(plain, 'Book a call', one('Book a call'))).toEqual({ source: 'a', tmpl: '{v}' });
  });

  it('never lowers a capital', () => {
    expect(derivationOf(plain, 'Psyon — data acquisition for labs', one('Data acquisition for labs'))).toBeNull();
    expect(derivationOf(plain, 'data acquisition', one('Data acquisition'))).toBeNull();
  });

  it('takes the longest source, then the first by name', () => {
    const head = 'Ship the whole catalogue in a day, today.';
    expect(
      derivationOf(plain, head, [
        { key: 'a', value: 'Ship the whole catalogue' },
        { key: 'b', value: 'Ship the whole catalogue in a day' },
      ]),
    ).toEqual({ source: 'b', tmpl: '{v}, today.' });
    expect(
      derivationOf(plain, 'Widgets for everyone', [
        { key: 'b', value: 'Widgets for everyone' },
        { key: 'a', value: 'Widgets for everyone' },
      ]),
    ).toEqual({ source: 'a', tmpl: '{v}' });
  });

  it('compares a tagged source without its tags', () => {
    const tagged: Descriptor = { version: 1, keys: { a: { shape: 'text', target: 'web', tags: 1 } } };
    expect(
      derivationOf(
        tagged,
        'You may already have the data our AI lab partners need. No raw data is needed to start.',
        one('You may already have the data<1> our AI lab partners need.</1>'),
      ),
    ).toEqual({ source: 'a', tmpl: '{v} No raw data is needed to start.' });
  });

  it('never templates a head text holding `{v}` after the source text', () => {
    expect(derivationOf(plain, 'Ship the whole catalogue {v}', one('Ship the whole catalogue'))).toBeNull();
  });

  it('never templates a head text holding `{v}` before the source text', () => {
    expect(derivationOf(plain, '{v} Ship the whole catalogue', one('Ship the whole catalogue'))).toBeNull();
  });
});
