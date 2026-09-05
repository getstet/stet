/**
 * `stet scan` — the drift gate. Each case runs `runScan` over a temp project
 * whose config names the managed surfaces, then asserts the warnings, the
 * position-free baseline, the i18n skip, the never-open-outside-the-globs
 * guarantee (a `readFileSync` spy), and the severity gate.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { runEmailExtract } from '../cli/email-extract.js';
import { runScan } from '../cli/scan.js';
import { runCli, type CliIo } from '../cli/main.js';
import { cleanupEmailHosts, makeEmailHost } from './helpers/email-host.js';

afterAll(cleanupEmailHosts);

function project(config: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'stet-scan-'));
  write(
    dir,
    'stet.config.json',
    JSON.stringify({
      project: 't',
      managedSurfaces: ['app/**/*.tsx'],
      readPath: { file: 'lib/content.ts', import: '@/lib/content' },
      router: 'app',
      rootLayout: 'app/layout.tsx',
      scan: { severity: 'warn', baseline: '.stet/scan-baseline.json' },
      ...config,
    }),
  );
  return dir;
}

function write(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

interface Captured extends CliIo {
  out: string[];
  err: string[];
}
function io(dir: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { cwd: dir, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l), out, err };
}

const COMPONENT = (body: string): string => `export default function Page() {\n  return ${body};\n}\n`;

describe('runScan', () => {
  it('reports a managed-surface literal with a proposed key and position, exit 0', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', COMPONENT('<h1>Your week, sorted</h1>'));
    const cap = io(dir);
    const code = await runScan([], cap);
    expect(code).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('app/page.tsx:2');
    expect(findings).toContain('your_week_sorted');
  });

  it('still reports a literal whose proposed key collides with an existing descriptor key (P2-B)', async () => {
    const dir = project();
    write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys: { your_week_sorted: { shape: 'text', target: 'web' } } }));
    write(dir, 'app/page.tsx', COMPONENT('<h1>Your week, sorted</h1>'));
    const cap = io(dir);
    await runScan([], cap);
    expect(cap.err.join('\n')).toContain('your_week_sorted');
  });

  it('suppresses a baselined literal even after a line is inserted above it', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', COMPONENT('<h1>Steady copy here</h1>'));
    await runScan(['--baseline'], io(dir));
    expect(existsSync(join(dir, '.stet/scan-baseline.json'))).toBe(true);
    // Insert an unrelated line above the literal — the position moves, the entry does not.
    write(dir, 'app/page.tsx', `const x = 1;\n${COMPONENT('<h1>Steady copy here</h1>')}`);
    const cap = io(dir);
    const code = await runScan([], cap);
    expect(code).toBe(0);
    expect(cap.err.join('\n')).not.toContain('steady_copy_here');
  });

  it('reports a <Trans> string as i18n info, never a key', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', COMPONENT('<Trans>Hello there</Trans>'));
    const cap = io(dir);
    await runScan([], cap);
    expect(cap.out.join('\n')).toContain('i18n copy');
    expect(cap.err.join('\n')).not.toContain('hello_there');
  });

  it('does not scan a file outside the globs', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', COMPONENT('<h1>Managed copy</h1>'));
    write(dir, 'other/loose.tsx', COMPONENT('<h1>Unmanaged copy</h1>'));
    const cap = io(dir);
    await runScan([], cap);
    const findings = cap.err.join('\n');
    // scan reads only what the globs match, so the outside literal never surfaces.
    expect(findings).toContain('managed_copy');
    expect(findings).not.toContain('unmanaged_copy');
  });

  it('P3-17 — never enumerates node_modules/dist even under a **-prefixed glob', async () => {
    // A `**/*.tsx` glob has an empty static prefix, so the walk starts at the repo
    // root; without the skip set it would descend into vendored trees.
    const dir = project({ managedSurfaces: ['**/*.tsx'] });
    write(dir, 'app/page.tsx', COMPONENT('<h1>Managed here</h1>'));
    write(dir, 'node_modules/pkg/comp.tsx', COMPONENT('<h1>Vendored copy</h1>'));
    write(dir, 'dist/out.tsx', COMPONENT('<h1>Built copy</h1>'));
    const cap = io(dir);
    await runScan([], cap);
    const findings = cap.err.join('\n');
    expect(findings).toContain('managed_here');
    expect(findings).not.toContain('vendored_copy');
    expect(findings).not.toContain('built_copy');
  });

  it('reports a parse-error file as info, not scanned', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', 'export default function Page( {  return <h1>Broken</h1>;\n');
    const cap = io(dir);
    await runScan([], cap);
    expect(cap.out.join('\n')).toContain('could not be parsed cleanly');
    expect(cap.err.join('\n')).not.toContain('broken');
  });

  it('does not report an ignore-commented literal', async () => {
    const dir = project();
    // The JSX hatch suppresses the sibling copy child: comment immediately before the text.
    write(
      dir,
      'app/page.tsx',
      'export default function Page() {\n  return (\n    <h1>\n      {/* stet-ignore-next-line */}\n      Skip this copy\n    </h1>\n  );\n}\n',
    );
    const cap = io(dir);
    await runScan([], cap);
    expect(cap.err.join('\n')).not.toContain('skip_this_copy');
  });

  it('fail severity promotes warnings to exit 1', async () => {
    const dir = project({ scan: { severity: 'fail', baseline: '.stet/scan-baseline.json' } });
    write(dir, 'app/page.tsx', COMPONENT('<h1>Fail me</h1>'));
    const code = await runScan([], io(dir));
    expect(code).toBe(1);
  });

  it('names the matched file count on a run that scanned something', async () => {
    const dir = project();
    write(dir, 'app/page.tsx', COMPONENT('<h1>Counted copy</h1>'));
    write(dir, 'app/about.tsx', COMPONENT('<h1>About us</h1>'));
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.out.join('\n')).toContain('scan: 2 files, 2 unkeyed literals');
    expect(cap.err.join('\n')).not.toContain('matched no files');

    // `--json` carries what the human line states.
    const json = io(dir);
    expect(await runScan(['--json'], json)).toBe(0);
    expect(JSON.parse(json.out[json.out.length - 1] as string)).toMatchObject({
      scan: { files: 2, warned: 2 },
    });
  });

  it('warns by name for every declared glob that matched nothing', async () => {
    // The site's real shape: a `.tsx` glob on a host whose pages are `.astro`.
    // An aggregate-zero guard cannot see this — one glob is very much alive.
    const dir = project({ managedSurfaces: ['src/pages/**/*.tsx', 'app/**/*.tsx'] });
    write(dir, 'app/page.tsx', COMPONENT('<h1>Live glob copy</h1>'));
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('glob matched no files: src/pages/**/*.tsx');
    expect(findings).not.toContain('glob matched no files: app/**/*.tsx');
    // The live glob's findings are untouched, and nothing claims the run scanned nothing.
    expect(findings).toContain('live_glob_copy');
    expect(findings).not.toContain('nothing was scanned');
    expect(cap.out.join('\n')).toContain('scan: 1 file, 1 unkeyed literal');
  });

  it('a run whose globs ALL matched nothing can never read as a clean bill', async () => {
    const dir = project({ managedSurfaces: ['src/pages/**/*.tsx', 'src/**/*.astro'] });
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('glob matched no files: src/pages/**/*.tsx');
    expect(findings).toContain('glob matched no files: src/**/*.astro');
    // The aggregate line names the DECLARED globs rather than one list:
    // `managedSurfaces` would be false over a dead `copyModules` glob.
    expect(findings).toContain('the declared globs matched no files — nothing was scanned');
    expect(cap.out.join('\n')).toContain('scan: 0 files, 0 unkeyed literals');

    // The warns ride the ordinary severity contract, so a `fail` posture fails
    // the run — the vacuous green survived even `fail` before.
    const failing = project({
      managedSurfaces: ['src/pages/**/*.tsx'],
      scan: { severity: 'fail', baseline: '.stet/scan-baseline.json' },
    });
    expect(await runScan([], io(failing))).toBe(1);
  });

  it('a --baseline run over nothing warns too, rather than writing a clean baseline in silence', async () => {
    const dir = project({ managedSurfaces: ['src/pages/**/*.tsx'] });
    const cap = io(dir);
    expect(await runScan(['--baseline'], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain('the declared globs matched no files — nothing was scanned');
    expect(cap.out.join('\n')).toContain('wrote .stet/scan-baseline.json: 0 baselined');

    // …and it stays exit 0 even under a `fail` posture. Decided, not
    // incidental: `--baseline` is the run that ACCEPTS findings, so failing it
    // would block the only workflow that clears them. The warns still print.
    const failing = project({
      managedSurfaces: ['src/pages/**/*.tsx'],
      scan: { severity: 'fail', baseline: '.stet/scan-baseline.json' },
    });
    const failingCap = io(failing);
    expect(await runScan(['--baseline'], failingCap)).toBe(0);
    expect(failingCap.err.join('\n')).toContain('the declared globs matched no files — nothing was scanned');
  });

  it('a repo with NO declared surfaces stays silent, declared empty or not declared at all', async () => {
    // The bare-repo contract: nothing was declared, so there is nothing to
    // report — an empty declared set is not a dead glob.
    const dir = project({ managedSurfaces: [] });
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toBe('');
    expect(cap.out.join('\n')).toContain('scan: 0 files, 0 unkeyed literals');

    // And the shape the cli spec's bare-repo scenario actually describes: NO
    // config file, so the surfaces come from the default rather than a literal
    // `[]`. A guard reading the explicit list alone would pass the case above
    // and warn on this one.
    const bare = mkdtempSync(join(tmpdir(), 'stet-scan-bare-'));
    const bareCap = io(bare);
    expect(await runScan([], bareCap)).toBe(0);
    expect(bareCap.err.join('\n')).toBe('');
  });

  it('warns once for a glob declared twice', async () => {
    // The same dead glob twice is one dead glob. Two warns read as two
    // problems and send the reader looking for a second config entry to fix.
    const dir = project({ managedSurfaces: ['src/pages/**/*.tsx', 'src/pages/**/*.tsx'] });
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.filter((l) => l.includes('glob matched no files: src/pages/**/*.tsx'))).toHaveLength(1);
  });

  it('a run whose matched files were ALL refused by the parser is no clean bill either', async () => {
    // The second zero-shape: files matched, so neither zero-match warn fires —
    // and the parser refused every one, so nothing was scanned.
    const dir = project();
    write(dir, 'app/page.tsx', 'export default function Page( {  return <h1>Broken</h1>;\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('all 1 matched file(s) were refused by the parser — nothing was scanned');
    // The first shape's warns must NOT fire — the glob did match.
    expect(findings).not.toContain('glob matched no files');
    expect(findings).not.toContain('the declared globs matched no files');
    expect(cap.out.join('\n')).toContain('app/page.tsx: could not be parsed cleanly');

    // It rides the ordinary severity contract, so a `fail` posture fails it —
    // this host exited 0 under `fail` before.
    const failing = project({ scan: { severity: 'fail', baseline: '.stet/scan-baseline.json' } });
    write(failing, 'app/page.tsx', 'export default function Page( {  return <h1>Broken</h1>;\n');
    expect(await runScan([], io(failing))).toBe(1);

    // One parsed file among the refused is a scan that happened: no warn.
    const mixed = project({ managedSurfaces: ['app/**/*.tsx', 'other/**/*.tsx'] });
    write(mixed, 'other/broken.tsx', 'export default function Page( {  return <h1>Broken</h1>;\n');
    write(mixed, 'app/page.tsx', COMPONENT('<h1>Parsed fine</h1>'));
    const mixedCap = io(mixed);
    expect(await runScan([], mixedCap)).toBe(0);
    expect(mixedCap.err.join('\n')).not.toContain('refused by the parser');
    expect(mixedCap.err.join('\n')).toContain('parsed_fine');
  });
});

/**
 * The declared COPY MODULES — files whose string literals are the host's copy,
 * which the JSX locator has nothing to say about. The specimen mirrors the real
 * `site/src/copy.ts` at HEAD: a flat object literal under `as const`, non-ASCII
 * values (the middle dot U+00B7 and the em dash U+2014), and values written on
 * the line BELOW their property names — 17 of that file's 77 wrap that way.
 * The multi-line and apostrophe values are defensive extras: the real file has
 * zero of either.
 */
const SPECIMEN = `export const copy = {
  site_name: "stet",
  hero_eyebrow: "Open source · Apache-2.0",
  hero_headline: "Change the content across your sites in seconds.",
  hero_sub:
    "Every sentence your products say — typed, versioned, editable without a rebuild.",
  footer_note: "stet is a working name.",
  legal_line: \`First line
second line\`,
  possessive: "your team's copy",
} as const;

export type CopyKey = keyof typeof copy;
`;

/** The specimen's property names, in source order. */
const SPECIMEN_KEYS = [
  'site_name',
  'hero_eyebrow',
  'hero_headline',
  'hero_sub',
  'footer_note',
  'legal_line',
  'possessive',
];

function moduleProject(config: Record<string, unknown> = {}): string {
  return project({ managedSurfaces: [], copyModules: ['src/copy.ts'], ...config });
}

/** A host whose descriptor and snapshot exist — what an adoption verdict is read from. */
function adopted(dir: string, keys: Record<string, string>): void {
  write(
    dir,
    'content/descriptor.json',
    JSON.stringify({
      version: 1,
      keys: Object.fromEntries(Object.keys(keys).map((k) => [k, { shape: 'text', target: 'web' }])),
    }),
  );
  write(dir, 'content/defaults.json', JSON.stringify({ default: keys }));
}

describe('runScan — declared copy modules', () => {
  it('warns every property with ITS OWN name as the proposed key, values excerpted', async () => {
    const dir = moduleProject();
    write(dir, 'src/copy.ts', SPECIMEN);
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    for (const key of SPECIMEN_KEYS) expect(findings).toContain(`propose key ${key}`);
    // The values ride through intact, non-ASCII included.
    expect(findings).toContain('"Open source · Apache-2.0"');
    expect(findings).toContain('Every sentence your products say —');
    expect(findings).toContain('"your team\'s copy"');
    // A value written on the line BELOW its property name reports the LITERAL's
    // position, which is where an editor has to go to change it.
    expect(findings).toContain('src/copy.ts:6:5');
    // A multi-line value collapses to one line in the excerpt, as every quoted
    // value does — a finding is one line.
    expect(findings).toContain('"First line second line"');
  });

  it('says nothing about a property already adopted with a byte-equal default', async () => {
    const dir = moduleProject();
    write(dir, 'src/copy.ts', SPECIMEN);
    adopted(dir, { hero_headline: 'Change the content across your sites in seconds.' });
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).not.toContain('hero_headline');
    // …and the module's other properties still warn, so silence is the verdict
    // rather than the file being skipped.
    expect(findings).toContain('propose key site_name');
  });

  it('warns a diverged property naming both values, and --baseline cannot switch the gate off', async () => {
    const dir = moduleProject();
    write(dir, 'src/copy.ts', SPECIMEN);
    adopted(dir, { hero_headline: 'Change the content across your sites in a second.' });
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('hero_headline diverged from the snapshot default');
    expect(findings).toContain('module "Change the content across your sites in seconds."');
    expect(findings).toContain('snapshot "Change the content across your sites in a second."');
    // It recommends neither side: which one wins is the operator's.
    expect(findings).not.toContain('propose key hero_headline');

    // A divergence is never a baseline entry — the run that ACCEPTS findings
    // warns about it too, and the next run still does.
    const baselining = io(dir);
    expect(await runScan(['--baseline'], baselining)).toBe(0);
    expect(baselining.err.join('\n')).toContain('hero_headline diverged from the snapshot default');
    const after = io(dir);
    expect(await runScan([], after)).toBe(0);
    expect(after.err.join('\n')).toContain('hero_headline diverged from the snapshot default');
    // The rest of the module IS baselined, so the gate is the only thing left.
    expect(after.err.join('\n')).not.toContain('propose key site_name');
  });

  it('names a template literal with substitutions, and proposes no key for it', async () => {
    const dir = moduleProject();
    write(dir, 'src/copy.ts', 'export const mail = {\n  greeting: `Welcome, ${name} — your week starts here`,\n};\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    // A default has to be a literal value, so a slotted template is named and
    // never proposed — the email extract path owns that shape.
    expect(findings).toContain('possible copy "Welcome, — your week starts here"');
    expect(findings).not.toContain('propose key');
  });

  it('stays silent on the pure-markup shell `email extract --apply` leaves behind', async () => {
    // The qualifying text is the literal SPANS concatenated, substitutions
    // excluded — so this shell strips to tags and nothing else. Reading the raw
    // source slice instead would keep `props` and warn forever on every adopted
    // template.
    const dir = moduleProject();
    write(
      dir,
      'src/copy.ts',
      'export function welcome(props: { welcome__headline: string }): string {\n' +
        '  return baseTemplate(`<html><body><h1>${props.welcome__headline}</h1></body></html>`);\n' +
        '}\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toBe('');
  });

  it('names the file, the comment and the count where one ignore silences a whole module', async () => {
    const dir = moduleProject();
    write(
      dir,
      'src/copy.ts',
      '// stet-ignore-next-line\n' +
        'export const copy = {\n' +
        "  hero_headline: 'Change the content across your sites in seconds.',\n" +
        "  site_name: 'stet',\n" +
        "  footer_note: 'stet is a working name.',\n" +
        '};\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const summaries = cap.out.filter((l) => l.includes('stet-ignore comment silenced'));
    expect(summaries).toEqual(['src/copy.ts:1: one stet-ignore comment silenced 3 literals']);
    // A summary is not a finding: nothing is warned and the count line reads zero.
    expect(cap.err.join('\n')).toBe('');
    expect(cap.out.join('\n')).toContain('scan: 1 file, 0 unkeyed literals');
  });

  it('leaves the exit at 0 under a fail posture — the sanctioned opt-out never gates', async () => {
    // The channel is the whole point. On `report.warn` the promotion at a `fail`
    // posture would turn this line into an error, and a repo using the opt-out
    // scan itself sanctions would be permanently red with no baseline path back
    // to green.
    const dir = moduleProject({ scan: { severity: 'fail', baseline: '.stet/scan-baseline.json' } });
    write(
      dir,
      'src/copy.ts',
      '// stet-ignore-next-line\n' +
        'export const copy = {\n' +
        "  hero_headline: 'Change the content across your sites in seconds.',\n" +
        "  site_name: 'stet',\n" +
        "  footer_note: 'stet is a working name.',\n" +
        '};\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.out.join('\n')).toContain('src/copy.ts:1: one stet-ignore comment silenced 3 literals');
  });

  it('prints no summary where one comment covers a single property', async () => {
    const dir = moduleProject();
    write(
      dir,
      'src/copy.ts',
      'export const copy = {\n' +
        '  // stet-ignore-next-line\n' +
        "  hero_headline: 'Change the content across your sites in seconds.',\n" +
        "  site_name: 'stet',\n" +
        '};\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.out.join('\n')).not.toContain('stet-ignore comment silenced');
    // The unsuppressed property still warns, so the walk did run.
    expect(cap.err.join('\n')).toContain('propose key site_name');
  });

  it('keeps a finding whose text carries a bare < before a real tag', async () => {
    // The qualifying bar strips tags with the module's own `TAG`, whose body
    // cannot hold a second `<`. The looser inline strip this replaced matched
    // `<ab <cd>` whole, took the `ab` with it, and left no letter pair — the
    // finding vanished silently. Both regexes were run against this specimen
    // before the assertion was written: the old one is silent, `TAG` warns.
    const dir = moduleProject();
    write(dir, 'src/copy.ts', "export const notes = ['1 <ab <cd> 2'];\n");
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain('unkeyed copy "1 <ab <cd> 2"');
  });

  it('falls a grammar-failing property name back to the derived key, in ONE line', async () => {
    // The real shape is a kebab-case quoted name, not an underscored one.
    const dir = moduleProject();
    write(dir, 'src/copy.ts', 'export const glyphs = {\n  "copy-scan": "Copy scan",\n};\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('property name copy-scan fails the key grammar — propose key copy_scan');
    // One line per finding: the grammar line carries the proposal rather than
    // arriving beside a second unkeyed one.
    expect(findings).not.toContain('unkeyed copy');
  });

  it('proposes a repeated property name once, and names the collision on the rest', async () => {
    // The site's features-data.ts shape: 260 findings over 8 distinct names. A
    // name-keyed registry over repeats is order-dependent, and its
    // adopted-suppression could only ever match one occurrence.
    const dir = moduleProject();
    write(
      dir,
      'src/copy.ts',
      'export const cards = [\n' +
        '  { title: "First card", body: "One line" },\n' +
        '  { title: "Second card", body: "Two lines" },\n' +
        '];\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('propose key title');
    expect(findings).toContain('propose key body');
    expect(findings).toContain('title repeats in this module — only the first occurrence proposes it as a key');
    expect(findings).toContain('body repeats in this module');
    // The later occurrence gets the collision line INSTEAD of an unkeyed one.
    expect(findings).not.toContain('propose key second_card');
    expect(findings).not.toContain('propose key two_lines');
  });

  it('finds nothing in a directive, a module specifier, a type or a JSX attribute', async () => {
    const dir = moduleProject({ copyModules: ['src/ui.tsx'] });
    write(
      dir,
      'src/ui.tsx',
      "'use client';\n" +
        "import { thing } from './thing';\n" +
        "type Variant = 'primary';\n" +
        'const label = "Sign in here";\n' +
        'export function Btn() {\n' +
        '  return <a className="btn" href="/x">Learn more</a>;\n' +
        '}\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    // The walk ran…
    expect(findings).toContain('propose key sign_in_here');
    // …and every enumerated non-copy position stayed out of it. The JSX walk
    // owns the attributes of a `.tsx` module, structural ones included.
    expect(findings).not.toContain('use_client');
    expect(findings).not.toContain('thing');
    expect(findings).not.toContain('primary');
    expect(findings).not.toContain('btn');
  });

  it('honours the ignore comment above a property', async () => {
    const dir = moduleProject();
    write(
      dir,
      'src/copy.ts',
      'export const copy = {\n' +
        '  // stet-ignore-next-line\n' +
        '  internal_note: "Do not translate this",\n' +
        '  shown: "Shown copy",\n' +
        '};\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).not.toContain('internal_note');
    expect(findings).toContain('propose key shown');
  });

  it('reports a copy module\'s i18n string as outside v1 scope, never a key', async () => {
    const dir = moduleProject();
    write(dir, 'src/copy.ts', 'export const copy = {\n  greeting: t("Hello there"),\n};\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.out.join('\n')).toContain("i18n copy — outside stet's v1 scope, not a key");
    expect(cap.err.join('\n')).not.toContain('hello_there');
    expect(cap.err.join('\n')).not.toContain('propose key greeting');
  });

  it('reports a too-wide declaration as findings — the declarer owns the noise', async () => {
    // A `property` finding takes no qualifying bar: the declared list IS the
    // contract, so SVG path data under a grammar-valid name is warned like any
    // other property. Declaring a glyph module is the cost of declaring it.
    const dir = moduleProject();
    write(dir, 'src/copy.ts', 'export const glyphs = {\n  arrow_right: "M4 12h16m-6-6l6 6-6 6",\n};\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain('propose key arrow_right');
  });

  it('classifies a property named `constructor` by OWN keys, never the prototype', async () => {
    // `constructor` passes the key grammar and is an ordinary property name. A
    // bare `in` or a plain lookup answers it from the prototype chain and reads
    // a key the descriptor never declared.
    const dir = moduleProject();
    write(dir, 'src/copy.ts', 'export const copy = {\n  constructor: "Built by hand",\n};\n');
    adopted(dir, {});
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('propose key constructor');
    expect(findings).not.toContain('diverged');
  });

  it('keys a per-value cast by its property name, exactly as the whole-object form is', async () => {
    // `{ hero: 'Hero copy' as const }` names its key as plainly as a whole
    // object under `as const` does. Reading the literal's immediate parent
    // alone made this one a derived key — a registry/module fork through a
    // side door, on a shape TypeScript codebases write constantly.
    const dir = moduleProject();
    write(
      dir,
      'src/copy.ts',
      'export const copy = {\n' +
        '  hero_headline: "Change the content" as const,\n' +
        '  hero_sub: ("Ship without a deploy"),\n' +
        '  footer_note: "A working name" satisfies string,\n' +
        '};\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    for (const key of ['hero_headline', 'hero_sub', 'footer_note']) {
      expect(findings).toContain(`propose key ${key}`);
    }
    // …and none of them fell through to a key derived from the text.
    expect(findings).not.toContain('propose key change_the_content');
    expect(findings).not.toContain('propose key ship_without_a_deploy');
  });

  it('does not tell an unparseable copy module to declare itself a managed surface', async () => {
    // The remedy would have refused the file in exactly the same way, so the
    // dark-warn sits BELOW the parse gate: one honest line, not two.
    const dir = moduleProject({ copyModules: ['src/ui.tsx'] });
    write(dir, 'src/ui.tsx', 'export function Btn( {  return <a>Broken</a>;\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.out.join('\n')).toContain('src/ui.tsx: could not be parsed cleanly');
    expect(cap.err.join('\n')).not.toContain('JSX not scanned');
  });

  it('reads a namespace body — only a STRING-named module declaration is a specifier', async () => {
    // `declare module 'x'` names a specifier with a string; `namespace Copy`
    // names itself with an identifier and holds ordinary runtime code. Skipping
    // both made every namespaced module report nothing at all.
    const dir = moduleProject();
    write(dir, 'src/copy.ts', 'export namespace Copy {\n  export const hero = "Namespaced headline";\n}\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain('propose key namespaced_headline');
  });

  it('prints an absent snapshot default as absent, never the prototype value', async () => {
    // The `constructor` key again, on the other side of the classifier: the
    // descriptor declares it and the snapshot does not, so the value is read by
    // OWN property. A bare index answers with `function Object() { … }` and
    // prints it as though the host had written that copy.
    const dir = moduleProject();
    write(dir, 'src/copy.ts', 'export const copy = {\n  constructor: "Built by hand",\n};\n');
    write(
      dir,
      'content/descriptor.json',
      JSON.stringify({ version: 1, keys: { constructor: { shape: 'text', target: 'web' } } }),
    );
    write(dir, 'content/defaults.json', JSON.stringify({ default: {} }));
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('constructor diverged from the snapshot default — module "Built by hand", snapshot has no default');
    expect(findings).not.toContain('native code');

    // …and a diverged finding carries no `key` on the wire: it must never read
    // as adoptable to whatever consumes --json next.
    const json = io(dir);
    await runScan(['--json'], json);
    const payload = JSON.parse(json.out[json.out.length - 1] as string) as {
      findings: { message: string; key?: string }[];
    };
    const diverged = payload.findings.find((f) => f.message.includes('diverged from the snapshot default'));
    expect(diverged).toBeDefined();
    expect(diverged?.key).toBeUndefined();
  });

  it('never reads a module specifier as copy, in any of the four forms it is written', async () => {
    const dir = moduleProject();
    write(
      dir,
      'src/copy.ts',
      "const dyn = import('./lazy-module');\n" +
        "const req = require('./legacy-module');\n" +
        "export { helper } from './helper-module';\n" +
        "declare module 'some-package' {\n  export const x: string;\n}\n" +
        'export const shown = "Findable copy here";\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('propose key findable_copy_here');
    for (const derived of ['lazy_module', 'legacy_module', 'helper_module', 'some_package']) {
      expect(findings).not.toContain(derived);
    }
  });

  it('names a dead copyModules glob, and both lists dead reads as nothing scanned', async () => {
    const live = project({ managedSurfaces: ['app/**/*.tsx'], copyModules: ['src/copy.ts'] });
    write(live, 'app/page.tsx', COMPONENT('<h1>Live surface copy</h1>'));
    const liveCap = io(live);
    expect(await runScan([], liveCap)).toBe(0);
    expect(liveCap.err.join('\n')).toContain('glob matched no files: src/copy.ts');
    expect(liveCap.err.join('\n')).toContain('live_surface_copy');
    expect(liveCap.err.join('\n')).not.toContain('nothing was scanned');

    // Both lists dead: the aggregate line, which names the DECLARED globs
    // rather than one list — `managedSurfaces` would be false over this run.
    const dead = project({ managedSurfaces: ['app/**/*.tsx'], copyModules: ['src/copy.ts'] });
    const deadCap = io(dead);
    expect(await runScan([], deadCap)).toBe(0);
    const findings = deadCap.err.join('\n');
    expect(findings).toContain('glob matched no files: app/**/*.tsx');
    expect(findings).toContain('glob matched no files: src/copy.ts');
    expect(findings).toContain('the declared globs matched no files — nothing was scanned');
  });
});

/**
 * A file BOTH declarations match. It is parsed once and walked by both
 * classifications, and every literal belongs to exactly one of them: the JSX
 * walk owns every position it CLASSIFIED — reported or silently decided — and
 * the module walk covers what is left. The three states are here: dual, the
 * module-only non-JSX file (nothing claimed, the module walk sees everything),
 * and the module-only `.tsx`, whose JSX side is dark and says so.
 */
describe('runScan — a file both declarations match', () => {
  const countIn = (lines: string[], needle: string): number => lines.filter((l) => l.includes(needle)).length;

  it('reports a send() argument ONCE, as the send walk classified it', async () => {
    const dir = project({ managedSurfaces: ['lib/mail.ts'], copyModules: ['lib/mail.ts'] });
    write(
      dir,
      'lib/mail.ts',
      'export function notify(send) {\n' +
        '  send({ subject: "Your week is ready", from: "noreply@example.com" });\n' +
        '}\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    // Exactly one finding for the subject — not one from each walk.
    expect(countIn(cap.err, 'Your week is ready')).toBe(1);
    // And it is the send walk's proposal, not the module walk's property name.
    expect(cap.err.join('\n')).toContain('propose key your_week_is_ready');
    expect(cap.err.join('\n')).not.toContain('propose key subject');
    // A field the send walk DENIED stays denied: the decision was its own, and
    // the module walk does not reopen it.
    expect(cap.err.join('\n')).not.toContain('noreply@example.com');

    // The baseline entry keeps the send walk's context, unchanged.
    expect(await runScan(['--baseline'], io(dir))).toBe(0);
    const entries = JSON.parse(readFileSync(join(dir, '.stet/scan-baseline.json'), 'utf8')) as {
      context: string;
      text: string;
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.context).toBe('send-arg');
  });

  it('prints the i18n line ONCE, not once per walk', async () => {
    const dir = project({ managedSurfaces: ['lib/mail.ts'], copyModules: ['lib/mail.ts'] });
    write(dir, 'lib/mail.ts', 'export function greet() {\n  return t("Hello there");\n}\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(countIn(cap.out, 'i18n copy')).toBe(1);
    expect(cap.err.join('\n')).not.toContain('hello_there');
  });

  it('says nothing about an accessor call it has already adopted', async () => {
    // The regression that would fire FOREVER: `copy('hero_headline')` is
    // classified by the JSX walk as an accessor call and never reported, so a
    // module walk that reopened the position would warn about the very key the
    // file correctly reads — and no re-run could ever clear it, because an
    // accessor argument is not a property and never classifies as adopted.
    const dir = project({ managedSurfaces: ['lib/page.ts'], copyModules: ['lib/page.ts'] });
    write(
      dir,
      'lib/page.ts',
      "import { copy } from '@/lib/content';\n" +
        'export const heading = () => copy(\'hero_headline\');\n' +
        'export const other = "Still findable copy";\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).not.toContain('hero_headline');
    // Non-vacuous: the module walk did run over the rest of the file.
    expect(findings).toContain('propose key still_findable_copy');
  });

  it('keeps every JSX finding on a dual-declared .tsx, once each', async () => {
    // Absences alone cannot tell "the JSX walk owns this" from "nobody scanned
    // it at all", so these are POSITIVE: the text and the COPY attribute are
    // both still reported, exactly once, with the JSX walk's own keys.
    const dir = project({ managedSurfaces: ['app/**/*.tsx'], copyModules: ['app/**/*.tsx'] });
    write(
      dir,
      'app/page.tsx',
      'export default function Page() {\n' +
        '  return <a className="btn" title="Read the docs">Learn more</a>;\n' +
        '}\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(countIn(cap.err, 'propose key learn_more')).toBe(1);
    expect(countIn(cap.err, 'propose key read_the_docs')).toBe(1);
    // A structural attribute is the JSX walk's decision, and it stays made.
    expect(cap.err.join('\n')).not.toContain('propose key btn');
    // The file IS a managed surface, so nothing says its JSX went unread.
    expect(cap.err.join('\n')).not.toContain('JSX not scanned');
  });

  it('sees everything in a module-only .ts, including what a send walk would have denied', async () => {
    // The deliberate asymmetry with the dual case above: no JSX walk ran, so
    // nothing was claimed and nothing was decided. A host that wants the send
    // gate's judgement on this file declares it a managed surface.
    const dir = project({ managedSurfaces: [], copyModules: ['lib/mail.ts'] });
    write(
      dir,
      'lib/mail.ts',
      'export function notify(send) {\n' +
        '  send({ subject: "Your week is ready", body: "Here is the digest" });\n' +
        '}\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    // Ordinary module properties, proposed by their own names.
    expect(findings).toContain('propose key subject');
    expect(findings).toContain('propose key body');
  });

  it('says so out loud where a .tsx is a copy module and nothing else', async () => {
    // The JSX side is dark — no walk ran, and structural attributes must never
    // become module findings — so the darkness is stated rather than passed off
    // as a clean read of the file.
    const dir = project({ managedSurfaces: [], copyModules: ['src/ui.tsx'] });
    write(
      dir,
      'src/ui.tsx',
      'const label = "Sign in here";\n' +
        'export function Btn() {\n' +
        '  return <a className="btn" title="Read the docs">Learn more</a>;\n' +
        '}\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('src/ui.tsx: JSX not scanned — the file is a copy module only; add it to managedSurfaces');
    // The module-level literal is still found — the file is half-read, not unread.
    expect(findings).toContain('propose key sign_in_here');
    // …and the JSX side really is dark, structural attributes included.
    expect(findings).not.toContain('learn_more');
    expect(findings).not.toContain('read_the_docs');
    expect(findings).not.toContain('propose key btn');

    // It rides the ordinary severity contract, so a `fail` posture fails on it.
    const failing = project({
      managedSurfaces: [],
      copyModules: ['src/ui.tsx'],
      scan: { severity: 'fail', baseline: '.stet/scan-baseline.json' },
    });
    write(failing, 'src/ui.tsx', 'export const nothing = 1;\n');
    expect(await runScan([], io(failing))).toBe(1);
  });
});

/**
 * The template-dialect detector. Pure text, no compiler on its path, and no
 * proposed keys: nothing text-level can tell an attribute from content or an
 * expression from prose, and a guessed key would poison a registry `register`
 * then trusts.
 *
 * The `.astro` specimen is the SiteNav shape at HEAD — the executed oracle the
 * design was written against — with its frontmatter, `<style>` and `<script>`
 * blocks abridged. Everything trimmed lives inside a block the detector strips
 * whole, so the behaviour is identical: the real 73-line file gives the same 11
 * findings over the same 6 distinct texts, at its own lines 13–31.
 */
const SITE_NAV = `---
// The ruled v1 header (operator, 2026-08-22): product-led — Features · Docs ·
// Pricing · Changelog, a GitHub link, primary CTA Get started (the free
// package, installable now; the waitlist CTA lives on pricing). Custody sits
// in the footer with the other trust links. The GitHub URL is a placeholder
// until the repo is public. The Changelog item follows the site flag.
import { flags } from "../../site-config";
---
<nav>
  <div class="wrap">
    <a href="/" class="mark">stet</a>
    <a class="i" href="/features">Features</a>
    <a class="i" href="/docs">Docs</a>
    <a class="i" href="/pricing">Pricing</a>
    {flags.changelog && <a class="i" href="/changelog">Changelog</a>}
    <span class="sp"></span>
    <a class="i" href="https://github.com">GitHub</a>
    <a class="btn" href="/docs">Get started</a>
    <button class="burger" aria-expanded="false" aria-label="Toggle navigation">
      <span class="bars"><span></span><span></span><span></span></span>
    </button>
  </div>
  <div class="panel">
    <a href="/features">Features</a>
    <a href="/docs">Docs</a>
    <a href="/pricing">Pricing</a>
    {flags.changelog && <a href="/changelog">Changelog</a>}
    <a href="https://github.com">GitHub</a>
    <a class="btn cta" href="/docs">Get started</a>
  </div>
</nav>
<style>
  nav { border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.86); }
  a.i { color: var(--dim); font-size: 13.5px; font-weight: 500; }
  .panel { display: none; }
</style>
<script>
  const nav = document.querySelector("nav")!;
  const burger = nav.querySelector(".burger")!;
  burger.addEventListener("click", () => nav.classList.toggle("open"));
</script>
`;

describe('runScan — template dialects', () => {
  it('reads the real SiteNav shape: 11 labels at their own lines, nothing else', async () => {
    const dir = project({ managedSurfaces: ['src/**/*.astro'] });
    write(dir, 'src/components/SiteNav.astro', SITE_NAV);
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.filter((l) => l.includes('possible copy'));
    expect(findings).toHaveLength(11);
    // The labels, at the lines they are actually written on.
    expect(cap.err.join('\n')).toContain('src/components/SiteNav.astro:11 possible copy "stet"');
    expect(cap.err.join('\n')).toContain('src/components/SiteNav.astro:12 possible copy "Features"');
    expect(cap.err.join('\n')).toContain('src/components/SiteNav.astro:18 possible copy "Get started"');
    // No proposed keys, ever: the compiler never parsed this file.
    expect(cap.err.join('\n')).not.toContain('propose key');

    // Zero false positives. The frontmatter and its import, the class lists and
    // hrefs inside tags, the CSS and the client script are all silent.
    for (const absent of ['site-config', 'border-bottom', 'querySelector', 'font-weight', 'burger', '/features']) {
      expect(cap.err.join('\n')).not.toContain(absent);
    }
    // The two documented misses, stated rather than discovered later: an
    // attribute value dies with the tag strip, and a label inside a braced
    // expression dies with the expression.
    expect(cap.err.join('\n')).not.toContain('Toggle navigation');
    expect(cap.err.join('\n')).not.toContain('Changelog');

    // The baseline is position-free, so the repeated labels collapse: 11 warns
    // are 6 entries — stet, Features, Docs, Pricing, GitHub, Get started.
    expect(await runScan(['--baseline'], io(dir))).toBe(0);
    const entries = JSON.parse(readFileSync(join(dir, '.stet/scan-baseline.json'), 'utf8')) as {
      context: string;
    }[];
    expect(entries).toHaveLength(6);
    expect(entries.every((e) => e.context === 'dialect')).toBe(true);
    // And a re-run is silent, so the detector's own findings are acceptable.
    const after = io(dir);
    expect(await runScan([], after)).toBe(0);
    expect(after.err.join('\n')).not.toContain('possible copy');
  });

  it('keeps a sentence containing a bare < whole', async () => {
    // A tag body cannot contain another `<`. Under the looser `<[^>]*>` the
    // bare `<` opened a tag that ran to the real element's closing bracket and
    // took the rest of the sentence with it, silently — and backtracked
    // quadratically doing it.
    const dir = project({ managedSurfaces: ['src/**/*.astro'] });
    write(
      dir,
      'src/pages/index.astro',
      '---\nconst t = 1;\n---\n<p>Latency is a < b for every request</p>\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain('possible copy "Latency is a < b for every request"');
  });

  it('strips comments BEFORE tags, so commented-out markup never leaks its prose', async () => {
    // The strip ORDER is the whole point here, and only a comment containing a
    // TAG can prove it: tags stripped first would eat `<!--` and `-->` as
    // though they were tags, leaving the prose between them to be reported as
    // live copy. A comment with no tag in it is swallowed under either order
    // and proves nothing.
    const dir = project({ managedSurfaces: ['src/**/*.astro'] });
    write(
      dir,
      'src/pages/index.astro',
      '---\nconst t = 1;\n---\n' +
        '<!-- <span>Hidden prose in a comment</span> -->\n' +
        '<h1>Your week, sorted</h1>\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('possible copy "Your week, sorted"');
    expect(findings).not.toContain('Hidden prose in a comment');
  });

  it('strips a Vue script block whole and the moustache with it', async () => {
    const dir = project({ managedSurfaces: ['src/**/*.vue'] });
    write(
      dir,
      'src/App.vue',
      '<script setup lang="ts">\n' +
        'const greeting = "hidden from a text detector";\n' +
        '</script>\n' +
        '<template>\n' +
        '  <h1>Your week, sorted</h1>\n' +
        '  <p>{{ greeting }}</p>\n' +
        '  <span>Sign in</span>\n' +
        '</template>\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.filter((l) => l.includes('possible copy'))).toHaveLength(2);
    expect(cap.err.join('\n')).toContain('possible copy "Your week, sorted"');
    expect(cap.err.join('\n')).toContain('possible copy "Sign in"');
    // The script block is stripped whole — a stated limit, not a silent gap.
    expect(cap.err.join('\n')).not.toContain('hidden from a text detector');
    // The moustache went with the braced-expression strip.
    expect(cap.err.join('\n')).not.toContain('greeting');
  });

  it('reads MDX prose while its fences and ESM lines stay out of it', async () => {
    const dir = project({ managedSurfaces: ['src/**/*.mdx'] });
    write(
      dir,
      'src/guide.mdx',
      '---\ntitle: Docs\n---\n' +
        "import { Note } from './note';\n\n" +
        'Welcome to the guide.\n\n' +
        '```ts\nconst secret = "never copy";\n```\n\n' +
        '<Note>Read this first</Note>\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('possible copy "Welcome to the guide."');
    expect(findings).toContain('possible copy "Read this first"');
    // A code fence is code, and an ESM line is a module specifier.
    expect(findings).not.toContain('never copy');
    expect(findings).not.toContain('./note');
  });

  it('strips script and style blocks in MDX too, not only in the component dialects', async () => {
    // A `<script>` body is code wherever it is written, and MDX admits raw HTML
    // blocks as readily as a `.vue` does. Scoping the strip to the component
    // dialects reported script bodies and CSS selectors as somebody's copy.
    const dir = project({ managedSurfaces: ['src/**/*.mdx'] });
    write(
      dir,
      'src/guide.mdx',
      '---\ntitle: Guide\n---\n\n' +
        'Real prose here.\n\n' +
        '<script>\n  const secret = "internal note not for editors";\n  console.log("debug only");\n</script>\n\n' +
        '<style>\n  .heading { font-family: Georgia; }\n</style>\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('possible copy "Real prose here."');
    expect(findings).not.toContain('internal note not for editors');
    expect(findings).not.toContain('debug only');
    expect(findings).not.toContain('font-family');
    expect(findings).not.toContain('.heading');
  });

  it('misses an MDX line that OPENS with a lowercase import/export — the stated limit', async () => {
    // The ESM-line strip is line-wise, so a paragraph whose first line opens
    // with lowercase `import`/`export` goes with it. Left as it is on purpose:
    // block-initial prose of that shape is invalid MDX anyway — MDX parses a
    // block-level line like that as real ESM — so the live miss is a wrapped
    // paragraph's continuation line, and tightening the strip would trade it
    // for false positives on genuine import lines, which is the worse deal.
    // Executable rather than merely written down: the capitalized twin warns.
    const dir = project({ managedSurfaces: ['src/**/*.mdx'] });
    write(
      dir,
      'src/limits.mdx',
      '---\ntitle: X\n---\n\n' +
        'export your data anytime, we never lock you in.\n\n' +
        'Export your data anytime, we never lock you in.\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.filter((l) => l.includes('possible copy'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"Export your data anytime, we never lock you in."');
  });

  it('finds nothing in an MDX that is all code fences', async () => {
    const dir = project({ managedSurfaces: ['src/**/*.mdx'] });
    write(
      dir,
      'src/api.mdx',
      '---\ntitle: x\n---\n\n```ts\nconst a = "one";\n```\n\n~~~js\nconst b = "two";\n~~~\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).not.toContain('possible copy');
  });

  it('COUNTS as scanned — the all-refused warn keys on parser refusals alone', async () => {
    // The inverse of the parser-refusal case: the site's own shape, an `.astro`
    // host whose only matched file is text-scanned rather than handed to a
    // compiler that would refuse it. Nothing was refused, so nothing claims
    // nothing was scanned.
    const dir = project({ managedSurfaces: ['src/**/*.astro'] });
    write(dir, 'src/pages/index.astro', '---\nconst title = "Home";\n---\n<h1>{title}</h1>\n<p>Your week, sorted</p>\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('src/pages/index.astro:5 possible copy "Your week, sorted"');
    expect(findings).not.toContain('refused by the parser');
    expect(cap.out.join('\n')).not.toContain('could not be parsed cleanly');
  });

  it('drops both halves of an unbalanced conditional, keeping the prose beside them', async () => {
    // DocsPager's real shape at HEAD: a two-branch conditional per line, which
    // the one-level-flat braced strip cannot balance. What survives is an
    // opening `{prev ?` fragment and — where the next line begins with the
    // first expression's closing brace — a `}`-opening one. Both are code, and
    // the site's redo counted 43 findings of this shape.
    const dir = project({ managedSurfaces: ['src/**/*.astro'] });
    write(
      dir,
      'src/components/DocsPager.astro',
      '---\ninterface Props { prev?: { title: string; href: string }; }\nconst { prev, next } = Astro.props;\n---\n' +
        '<nav class="pager" aria-label="Chapters">\n' +
        '  {prev ? <a href={prev.href}><span>Previous</span><b>{prev.title}</b></a> : <span class="hold" />}\n' +
        '  {next ? <a class="fwd" href={next.href}><span>Next</span><b>{next.title}</b></a> : <span class="hold" />}\n' +
        '</nav>\n' +
        '<p>Browse the chapters in order</p>\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.filter((l) => l.includes('possible copy'));
    expect(findings).toHaveLength(3);
    const all = cap.err.join('\n');
    expect(all).toContain('possible copy "Browse the chapters in order"');
    expect(all).toContain('possible copy "Previous"');
    expect(all).toContain('possible copy "Next"');
    // Neither half of the conditional is anybody's copy.
    expect(all).not.toContain('prev ?');
    expect(all).not.toContain('next ?');
  });

  it('drops a map opener and the nested one inside it', async () => {
    // SiteFooter's real shape: two `{…map(` openers, one nested in the other's
    // body, neither closable at one level of braces.
    const dir = project({ managedSurfaces: ['src/**/*.astro'] });
    write(
      dir,
      'src/components/SiteFooter.astro',
      '---\nconst groups = [];\n---\n' +
        '<footer>\n  <div class="cols">\n' +
        '    {groups.map((g) => (\n' +
        '      <div class="col">\n' +
        '        <p class="colhead">{g.h}</p>\n' +
        '        {g.links.map(([label, href]) => <a href={href}>{label}</a>)}\n' +
        '      </div>\n' +
        '    ))}\n' +
        '  </div>\n' +
        '  <span>One copy layer for all your sites</span>\n' +
        '</footer>\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.filter((l) => l.includes('possible copy'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('possible copy "One copy layer for all your sites"');
    expect(cap.err.join('\n')).not.toContain('.map(');
  });

  it('keeps a brace-opening run that carries a quoted string — the guard is toward reporting', async () => {
    // The quote guard's witness, and it is real copy: the site's changelog page
    // builds its `<title>` from a template literal, and the run the strips leave
    // is the page-title text. A blanket brace-opening drop would swallow it.
    // The run text below is the site's own, executed rather than predicted.
    const dir = project({ managedSurfaces: ['src/**/*.astro'] });
    write(
      dir,
      'src/pages/changelog.astro',
      '---\nconst entry = { data: { title: "x" } };\n---\n' +
        '<html>\n  <head>\n    <title>{`stet changelog — ${entry.data.title}`}</title>\n  </head>\n</html>\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain('possible copy "{`stet changelog — $"');
  });

  it('keeps a brace-opening run quoted with double quotes too — the guard is not backtick-only', async () => {
    // The gallery page's real shape, and the second live arm of the guard: the
    // changelog witness above carries a backtick, this one carries `"`. Both
    // arms are fixtured so neither can be dropped without a red test.
    const dir = project({ managedSurfaces: ['src/**/*.astro'] });
    write(
      dir,
      'src/pages/gallery.astro',
      '---\nconst variants = 1;\n---\n' +
        '<section>\n' +
        '  <h2 class="comp">FeatureCard — excitement variations</h2>\n' +
        '  {["glyph", "proof", "hover"].map((v) => (\n' +
        '    <div class="cell"><p class="cellname">{v} variant — set by an ancestor</p>\n' +
        '    </div>\n' +
        '  ))}\n' +
        '</section>\n',
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain('possible copy "{[\\"glyph\\", \\"proof\\", \\"hover\\"].map((v) => ("');
  });

  it('still splits a sentence at an inline tag — the stated limit, not a filtered shape', async () => {
    // Rejoining runs across a stripped tag needs an adjacency heuristic, and an
    // adjacency heuristic joins unrelated text — two labels either side of a
    // stripped element are two findings by design. The split stays; it is
    // written down here so it is a known limit rather than a later discovery.
    const dir = project({ managedSurfaces: ['src/**/*.astro'] });
    write(dir, 'src/pages/index.astro', '---\nconst t = 1;\n---\n<p>Managed <em>sending</em></p>\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.filter((l) => l.includes('possible copy'));
    expect(findings).toHaveLength(2);
    expect(cap.err.join('\n')).toContain('possible copy "Managed"');
    expect(cap.err.join('\n')).toContain('possible copy "sending"');
  });

  it('rides the severity contract — a fail posture fails on dialect warns', async () => {
    const dir = project({
      managedSurfaces: ['src/**/*.astro'],
      scan: { severity: 'fail', baseline: '.stet/scan-baseline.json' },
    });
    write(dir, 'src/pages/index.astro', '---\nconst t = 1;\n---\n<h1>Your week, sorted</h1>\n');
    expect(await runScan([], io(dir))).toBe(1);
  });
});

/**
 * The declared-but-unrendered slot. A developer who deletes the line that reads
 * a slot has disconnected a field the dashboard still offers an editor, and the
 * dashboard never looks at the repo — so the warn rides the pre-commit hook and
 * lands at the commit that breaks it.
 */
describe('runScan — a declared slot that the render file no longer reads', () => {
  const SURFACES = ['lib/email/**/*.ts'];

  function withTemplate(
    body: string,
    entry: Record<string, unknown> = {},
    slots: string[] = ['headline'],
  ): string {
    const dir = project({ managedSurfaces: SURFACES, emailSurfaces: SURFACES });
    write(
      dir,
      'content/descriptor.json',
      JSON.stringify({
        version: 1,
        keys: {},
        templates: {
          welcome: {
            class: 'transactional',
            trigger: 'manual',
            slots,
            render: { file: 'lib/email/welcome.ts', export: 'welcome', sampleProps: {} },
            ...entry,
          },
        },
      }),
    );
    write(dir, 'lib/email/welcome.ts', body);
    return dir;
  }

  it('warns on a shell extract itself wrote, once the render line goes', async () => {
    // Driven over a REAL apply rather than a hand-built fixture: the shape that
    // matters is the one extract emits, where the widened props type carries
    // every slot name whatever the body does. A fixture without those type
    // members proves the warn against a file stet never produces.
    const host = makeEmailHost();
    host.put('stet.config.json', `${JSON.stringify({ project: 't', managedSurfaces: [], emailSurfaces: [] })}\n`);
    host.put('content/descriptor.json', `${JSON.stringify({ version: 1, keys: {}, templates: {} })}\n`);
    host.put('content/defaults.json', '{"default":{}}\n');
    host.put(
      'lib/email/welcome.ts',
      'export function welcome(props: { name: string }): string {\n' +
        '  return `<h1>Good to see you, ${props.name}</h1><p>Your week, sorted.</p>`;\n' +
        '}\n',
    );

    const applied = io(host.dir);
    expect(await runEmailExtract(['lib/email/*.ts', '--apply'], applied)).toBe(0);
    const shell = readFileSync(join(host.dir, 'lib/email/welcome.ts'), 'utf8');
    expect(shell).toContain('welcome__headline: string;'); // the widened type
    expect(shell).toContain('${props.welcome__headline}'); // and the render

    // While the shell renders it, nothing is said.
    const clean = io(host.dir);
    expect(await runScan([], clean)).toBe(0);
    expect(clean.err.join('\n')).not.toContain('welcome__headline is declared');

    // The render line deleted, the type member left exactly as extract wrote it
    // — which is what a developer removing a line actually leaves behind.
    writeFileSync(
      join(host.dir, 'lib/email/welcome.ts'),
      shell.replace('${props.welcome__headline}', 'Good to see you'),
      'utf8',
    );
    const cap = io(host.dir);
    const code = await runScan([], cap);
    const findings = cap.err.join('\n');
    expect(findings).toContain('welcome__headline is declared as a slot of welcome');
    expect(findings).toContain('lib/email/welcome.ts');
    // The slot the shell still reads is not reported.
    expect(findings).not.toContain('welcome__body is declared');
    // A warn, so an adopter's commit is not failed by it on day one.
    expect(code).toBe(0);
  });

  it('warns on the DESTRUCTURED twin, where the binding outlives the read', async () => {
    // The other shell shape extract writes. Here the slot name survives the
    // deletion twice over — in the props type AND in the parameter's binding
    // pattern — so a check that counts either one can never see the render go.
    const host = makeEmailHost();
    host.put('stet.config.json', `${JSON.stringify({ project: 't', managedSurfaces: ['lib/email/**/*.tsx'], emailSurfaces: ['lib/email/**/*.tsx'] })}\n`);
    host.put('content/descriptor.json', `${JSON.stringify({ version: 1, keys: {}, templates: {} })}\n`);
    host.put('content/defaults.json', '{"default":{}}\n');
    host.put(
      'lib/email/dest.tsx',
      'export interface DestProps {\n  name: string;\n}\n' +
        'export function Dest({ name }: DestProps) {\n' +
        '  return (\n' +
        '    <div>\n' +
        '      <h1>Destructured headline</h1>\n' +
        '      <p>Hello {name}, welcome.</p>\n' +
        '    </div>\n' +
        '  );\n' +
        '}\n',
    );

    const applied = io(host.dir);
    expect(await runEmailExtract(['lib/email/*.tsx', '--apply'], applied)).toBe(0);
    const shell = readFileSync(join(host.dir, 'lib/email/dest.tsx'), 'utf8');
    expect(shell).toContain('dest__headline'); // bound into the pattern
    expect(shell).toContain('{dest__headline}'); // and read in the markup

    const clean = io(host.dir);
    expect(await runScan([], clean)).toBe(0);
    expect(clean.err.join('\n')).not.toContain('dest__headline is declared');

    // The read deleted, the binding left exactly where extract put it.
    writeFileSync(
      join(host.dir, 'lib/email/dest.tsx'),
      shell.replace('{dest__headline}', 'Hardcoded'),
      'utf8',
    );
    const cap = io(host.dir);
    expect(await runScan([], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('dest__headline is declared as a slot of dest');
    expect(findings).toContain('lib/email/dest.tsx');
    // The slot still read is not reported.
    expect(findings).not.toContain('dest__body is declared');
  });

  it('warns naming every slot the file never names at all', async () => {
    const dir = withTemplate(
      'export function welcome(props: { welcome__headline: string }): string {\n' +
        '  return `<h1>${props.welcome__headline}</h1>`;\n' +
        '}\n',
      {},
      ['headline', 'body', 'cta_label'],
    );
    const cap = io(dir);
    const code = await runScan([], cap);
    const findings = cap.err.join('\n');

    expect(findings).toContain('welcome__body');
    expect(findings).toContain('welcome__cta_label');
    expect(findings).toContain('lib/email/welcome.ts');
    // The slot the file still reads is not reported.
    expect(findings).not.toContain('welcome__headline is declared');
    // A warn, so an adopter's commit is not failed by it on day one.
    expect(code).toBe(0);
  });

  it('stays clean where a slot rides a pass-through prop', async () => {
    // The flattened name is still named in the pointer's own file, which is
    // the whole rule — no import chasing, and none needed.
    const dir = withTemplate(
      "import { Footer } from './footer';\n" +
        'export function welcome(props: { welcome__headline: string }): string {\n' +
        '  return Footer({ text: props.welcome__headline });\n' +
        '}\n',
    );
    const cap = io(dir);
    await runScan([], cap);
    expect(cap.err.join('\n')).not.toContain('welcome__headline');
  });

  it('exempts a template with no render pointer', async () => {
    const dir = withTemplate('export const nothing = 1;\n', { render: undefined });
    const cap = io(dir);
    await runScan([], cap);
    expect(cap.err.join('\n')).not.toContain('welcome__headline');
  });

  it('rides the severity contract — fail flips the exit', async () => {
    const dir = project({
      managedSurfaces: SURFACES,
      emailSurfaces: SURFACES,
      scan: { severity: 'fail', baseline: '.stet/scan-baseline.json' },
    });
    write(
      dir,
      'content/descriptor.json',
      JSON.stringify({
        version: 1,
        keys: {},
        templates: {
          welcome: {
            class: 'transactional',
            trigger: 'manual',
            slots: ['headline'],
            render: { file: 'lib/email/welcome.ts', export: 'welcome', sampleProps: {} },
          },
        },
      }),
    );
    write(dir, 'lib/email/welcome.ts', 'export function welcome(): string {\n  return `<h1>hard-coded</h1>`;\n}\n');
    expect(await runScan([], io(dir))).toBe(1);
  });

  it('survives a slot name carrying regex metacharacters', async () => {
    // The descriptor rules call an odd slot name a WARNING, not an error, so a
    // project can carry one and reach scan — on the pre-commit path, where an
    // unescaped `cta(label` in a constructed RegExp would crash the commit
    // rather than warn about it. Driven through the dispatch, because that is
    // what the hook runs.
    const dir = withTemplate(
      'export function welcome(props: { welcome__headline: string }): string {\n' +
        '  return `<h1>${props.welcome__headline}</h1>`;\n' +
        '}\n',
      {},
      ['headline', 'cta(label', 'body[2'],
    );
    const cap = io(dir);
    expect(await runCli(['scan'], cap)).toBe(0);
    const findings = cap.err.join('\n');
    expect(findings).toContain('welcome__cta(label');
    expect(findings).toContain('welcome__body[2');
  });
});

/**
 * The uncovered static route. Once a host has declared pages at all, a route
 * file the descriptor does not claim is drift — and it rides scan for the same
 * reason the unrendered slot does: the hook runs scan, so the warn lands at the
 * commit that adds the file.
 */
describe('runScan — a static route with no page record', () => {
  /** A host with a routing tree, and whatever `pages` member the case is about. */
  function withPages(
    pages: unknown,
    files: string[],
    config: Record<string, unknown> = {},
    keys: Record<string, unknown> = {},
  ): string {
    const dir = project(config);
    write(dir, 'content/descriptor.json', JSON.stringify({ version: 1, keys, pages }));
    for (const file of files) write(dir, `src/pages/${file}`, '<h1>x</h1>\n');
    return dir;
  }

  const DECLARED_HOME = { home: { route: '/' } };

  it('warns once, naming the route and the file, with the command as the remedy', async () => {
    const dir = withPages(DECLARED_HOME, ['index.astro', 'team.astro']);
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain(
      'route /team (src/pages/team.astro) has no page record — run stet pages scan',
    );
    expect(cap.err.filter((line) => line.includes('has no page record'))).toHaveLength(1);
  });

  it('rides the ordinary severity contract, so a fail posture fails the run', async () => {
    // Deliberate, and the unrendered-slot warn's own accepted contract: under
    // `fail` a new route file is a red commit until it is declared.
    const dir = withPages(DECLARED_HOME, ['index.astro', 'team.astro'], {
      scan: { severity: 'fail', baseline: '.stet/scan-baseline.json' },
    });
    expect(await runScan([], io(dir))).toBe(1);
  });

  it('says nothing on a host that never declared a page', async () => {
    // Unopted is not drifting. The zero case belongs to `seo check`'s
    // zero-pages warn, which is the one that names what to run.
    const dir = withPages({}, ['index.astro', 'team.astro']);
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).not.toContain('has no page record');
  });

  it('reads a malformed pages member as no pages at all, never as four of them', async () => {
    // `Object.keys("todo")` is `['0','1','2','3']`. Unvalidated input reaches
    // this gate, and a command that never fails by default must neither crash
    // on it nor invent pages out of a string.
    const dir = withPages('todo', ['index.astro', 'team.astro']);
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).not.toContain('has no page record');
  });

  it('reads an entry whose route is not a string as no page at all', async () => {
    // The INNER half of the narrowing: the outer `isRecord` passes here and
    // only the per-entry filter keeps the gate shut. Without it a number
    // reaches the trailing-slash trim inside a command that must never fail by
    // default, and the host reads as having declared a page it has not.
    const dir = withPages({ home: { route: 5 } }, ['index.astro', 'team.astro']);
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).not.toContain('has no page record');
  });

  it('never warns a route the skip taxonomy owns', async () => {
    const dir = withPages(DECLARED_HOME, ['index.astro', '[slug].astro']);
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).not.toContain('has no page record');
  });

  it('still warns a route whose scaffold key is already taken', async () => {
    // `pages scan` refuses to scaffold over `seo_team_title` — but the route is
    // a real page carrying no record, and that is drift. Only the automatic
    // scaffold is refused; silencing the warn would be the silent green this
    // check exists to break. Route-SHAPED skips are the ones that never warn.
    const dir = withPages(DECLARED_HOME, ['index.astro', 'team.astro'], {}, {
      seo_team_title: { shape: 'text', target: 'web' },
    });
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).toContain('route /team (src/pages/team.astro) has no page record');
    expect(cap.err.filter((line) => line.includes('has no page record'))).toHaveLength(1);
  });

  it('leaves a bare host with no descriptor exactly as it was', async () => {
    const dir = project();
    write(dir, 'src/pages/team.astro', '<h1>x</h1>\n');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    expect(cap.err.join('\n')).not.toContain('has no page record');
  });

  it('warns a markdown route without reading the file', async () => {
    // `pages scan` seeds from a markdown page's frontmatter; scan calls the
    // same detector with no seed option, so its warn is names only. The file is
    // made UNREADABLE, which is the only way to prove a read did not happen:
    // if scan opened it the run would throw rather than warn.
    const dir = withPages(DECLARED_HOME, ['index.astro']);
    const path = join(dir, 'src/pages/x.md');
    write(dir, 'src/pages/x.md', '---\ntitle: Secret\n---\n');
    // Windows has no mode bits to clear and root reads through them anyway.
    const enforced = process.platform !== 'win32' && process.getuid?.() !== 0;
    if (enforced) chmodSync(path, 0o000);
    try {
      const cap = io(dir);
      expect(await runScan([], cap)).toBe(0);
      expect(cap.err.join('\n')).toContain('route /x (src/pages/x.md) has no page record');
    } finally {
      if (enforced) chmodSync(path, 0o644);
    }
  });
});

describe('runScan — the static-HTML host', () => {
  const PAGE = readFileSync(
    fileURLToPath(new URL('./fixtures/html-host/index.html', import.meta.url)),
    'utf8',
  );

  /** An html host carrying the shared fixture page. */
  function htmlProject(config: Record<string, unknown> = {}): string {
    const dir = project({ host: 'html', managedSurfaces: ['**/*.html'], ...config });
    write(dir, 'index.html', PAGE);
    return dir;
  }

  it('locates the element behind every run and proposes its key', async () => {
    const dir = htmlProject();
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const found = cap.err.join('\n');
    expect(found).toContain(
      'index.html:34 possible copy "Software, product and engineering histories" — propose key software_product_and_engineering',
    );
    // A tagged value prints with its tags.
    expect(found).toContain('possible copy "You may already have the data<1> our AI lab partners need...');
    // An attribute names itself; a meta names which meta it is.
    expect(found).toContain('"A lab bench with sample trays" (alt) — propose key a_lab_bench_with_sample_trays');
    expect(found).toContain('(meta description) — propose key psyon_connects_hospitals_labs_and');
  });

  it('counts the page as one file and every proposal as an unkeyed literal', async () => {
    const cap = io(htmlProject());
    await runScan([], cap);
    expect(cap.out.join('\n')).toContain('scan: 1 file, 28 unkeyed literals');
  });

  it('carries the located records in --json', async () => {
    const json = io(htmlProject());
    expect(await runScan(['--json'], json)).toBe(0);
    const payload = JSON.parse(json.out[json.out.length - 1] as string) as {
      html: { proposals: Array<Record<string, unknown>>; skips: unknown[] };
    };
    expect(payload.html.skips).toEqual([]);
    expect(payload.html.proposals).toHaveLength(28);
    const heading = payload.html.proposals.find((p) => p['tag'] === 'h3');
    expect(heading).toMatchObject({ section: 'qualify', tag: 'h3', kind: 'element' });
    expect(payload.html.proposals.find((p) => p['tag'] === 'h1')).toMatchObject({ tags: 1 });
    // The insert offset is the mark edit's business, not a record consumer's.
    expect(heading).not.toHaveProperty('insertAt');
  });

  it('suppresses what --baseline accepted', async () => {
    const dir = htmlProject();
    expect(await runScan(['--baseline'], io(dir))).toBe(0);
    const second = io(dir);
    expect(await runScan([], second)).toBe(0);
    expect(second.err.join('\n')).not.toContain('possible copy');
    expect(second.out.join('\n')).toContain('scan: 1 file, 0 unkeyed literals');
  });

  it('says nothing about an element already claimed by a mark', async () => {
    const dir = htmlProject();
    write(dir, 'index.html', PAGE.replace('<h3>', '<h3 data-stet="already_keyed">'));
    const cap = io(dir);
    await runScan([], cap);
    expect(cap.err.join('\n')).not.toContain('Software, product and engineering histories');
    expect(cap.out.join('\n')).toContain('scan: 1 file, 27 unkeyed literals');
  });

  it('names a skip and counts it as text it could not adopt', async () => {
    const dir = project({ host: 'html', managedSurfaces: ['**/*.html'] });
    write(
      dir,
      'index.html',
      readFileSync(fileURLToPath(new URL('./fixtures/html-host/edges.html', import.meta.url)), 'utf8'),
    );
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const found = cap.err.join('\n');
    expect(found).toContain('skipped (unknown-entity) — &nosuch; is not an entity stet can decode; replace it with the character itself');
    expect(found).toContain('skipped (text-in-structure) — text sits directly inside <ul>, which has no element to mark; wrap it in a p, span or li');
    expect(found).toContain(
      'skipped (text-beside-code) — text in <p> sits beside a script, style, comment or declaration stet cannot ' +
        'regenerate whole; move the script, style, comment or declaration outside the element, or the text into one of its own',
    );
    // 5 proposals + 10 skips, every one an unkeyed literal.
    expect(cap.out.join('\n')).toContain('scan: 1 file, 15 unkeyed literals');
  });

  it('text-warns an .html on a JavaScript host, with no key — the fifth dialect', async () => {
    const dir = project({ router: 'astro', managedSurfaces: ['src/**/*.html'] });
    write(dir, 'src/legacy.html', '<html><body><h1>A legacy label</h1></body></html>');
    const cap = io(dir);
    expect(await runScan([], cap)).toBe(0);
    const found = cap.err.join('\n');
    expect(found).toContain('possible copy "A legacy label"');
    expect(found).not.toContain('propose key');
    expect(cap.out.join('\n')).toContain('scan: 1 file, 1 unkeyed literal');
  });
});
