/**
 * The dashboard page over stubbed routes, and the preview agent played from the
 * frame's side. The conformance walk's `key-usage`, `preview-editing` and
 * `dashboard` sections drive the page's behaviour through here: the page is the
 * real one, booted in jsdom; every route it calls is answered from a table the
 * case can change, and the frame's agent is a voice the case speaks as.
 *
 * What the page posts to the frame is recorded on the frame's window, and the
 * agent's messages are dispatched from that window, carrying the channel the
 * preview route gave.
 */
import { paintPage, type PaintedPage } from './dashboard-page.js';
import { dashboardPage } from '../../cli/dev.js';

export const SITE_ID = 'aaaaaaaaaaaa';
export const CHANNEL = 'chan-1';
export const PROXY = 'http://127.0.0.1:45123';
export const DEV_PREVIEW = { url: `${PROXY}/`, dev: 'http://localhost:4321/', up: true, channel: CHANNEL, start: 'npx astro dev', source: 'astro' };

/** A descriptor and snapshot as the page's site reply carries them. */
export interface StubDescriptor {
  version: 1;
  keys: Record<string, Record<string, unknown>>;
  pages?: Record<string, { route: string; seo?: Record<string, string> }>;
  templates?: Record<string, unknown>;
}

/** The reply `GET /api/site` gives for a snapshot-only JavaScript checkout. */
export function siteBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const descriptor: StubDescriptor = {
    version: 1,
    keys: { hero_headline: { shape: 'text', target: 'web', limits: { max: 60, severity: 'advisory' }, pages: ['home'] } },
    pages: { home: { route: '/' } },
  };
  return {
    state: 'ready',
    name: 'mini',
    path: '/checkouts/mini',
    id: SITE_ID,
    mode: 'snapshot',
    host: 'js',
    keys: Object.keys(descriptor.keys).length,
    locales: ['default', 'de'],
    git: { head: 'abc1234', branch: 'main', dirty: true },
    descriptor,
    snapshot: { default: { hero_headline: 'Ship the copy' }, de: {} },
    config: {
      locales: { default: 'default', enabled: ['default', 'de'] },
      host: 'js',
      readPath: { file: 'src/stet.ts' },
      descriptorPath: 'stet/descriptor.json',
      snapshotPath: 'stet/defaults.json',
      managedSurfaces: ['src/**/*.tsx'],
      store: { adapter: 'snapshot' },
    },
    environments: [
      { name: 'default', adapter: 'snapshot', vars: [] },
      { name: 'staging', adapter: 'pg', vars: [{ name: 'DATABASE_URL', set: false }] },
    ],
    dev: { dev: 'http://localhost:4321', devCommand: 'npx astro dev', source: 'astro' },
    entry: { path: '/checkouts/mini', pushAfterCommit: false },
    pending: [],
    project: 'default',
    router: 'astro',
    ...over,
  };
}

/** Every route the page can reach, with a body shaped like the real one. */
export function routeTable(site: Record<string, unknown>): Array<[string, number, unknown]> {
  return [
    [
      '/api/workspace',
      200,
      {
        editor: 'dashboard:test',
        version: '0.5.0',
        sites: [
          { state: 'ready', name: 'mini', path: '/checkouts/mini', id: SITE_ID, mode: site['mode'], keys: 11, host: 'js', router: 'astro', project: 'default' },
          { state: 'ready', name: 'other', path: '/checkouts/other', id: 'dddddddddddd', mode: 'snapshot', keys: 4, host: 'html', router: 'app', project: 'other-site' },
          { state: 'not-adopted', name: 'blank', path: '/checkouts/blank', id: 'bbbbbbbbbbbb' },
          { state: 'broken', name: 'bent', path: '/checkouts/bent', id: 'cccccccccccc', message: 'stet.config.json: not JSON' },
        ],
      },
    ],
    ['/api/site/save', 409, { error: 'refused by the save gate', findings: [{ kind: 'limits', level: 'error', key: 'hero_headline', message: 'hero_headline: 71 characters over a 60 limit' }] }],
    ['/api/site/commit', 200, { sha: 'abc1234def', short: 'abc1234', subject: 'stet: 1 key updated — hero_headline', at: site['git'] }],
    ['/api/site/push', 200, { output: 'Everything up-to-date', at: site['git'] }],
    ['/api/site/history', 200, { commits: [{ sha: 'abc1234def', short: 'abc1234', author: 'dev', at: '2026-09-01T10:00:00Z', subject: 'stet: 1 key updated' }] }],
    [
      '/api/site/health',
      200,
      {
        at: { head: 'abc1234', branch: 'main', dirty: true },
        doctor: { code: 0, out: ['mode: snapshot-only', 'host: js'], err: [] },
        check: [{ kind: 'config', level: 'error', key: 'loose_key', message: 'loose_key: declared in the descriptor with no value in the snapshot' }],
        unseeded: [],
        drift: [],
        scan: { findings: [{ kind: 'scan', level: 'warn', slot: { template: 'welcome', name: 'subject' }, message: 'welcome__subject: no file renders this slot' }] },
        audit: {
          orphans: ['hero_tone'],
          unseeded: [],
          drift: [],
          findings: [{ kind: 'config', level: 'warn', key: 'hero_tone', message: 'hero_tone: in the store, not in the descriptor — an orphan, reported never deleted' }],
        },
      },
    ],
    [
      '/api/site/seo',
      200,
      {
        seo: { seo: [{ rule: 'description-missing', severity: 'error', page: 'home', key: 'seo_home_description', message: 'home declares no description key' }] },
        pages: {
          pages: [{ name: 'about', route: '/about', file: 'src/pages/about.astro' }],
          skips: [{ file: 'src/pages/[slug].astro', reason: 'dynamic-route', detail: 'a route parameter', remedy: 'declare this page by hand' }],
        },
      },
    ],
    ['/api/site/pages/declare', 200, { lines: ['declared about'], findings: [], touched: 'src/stet.ts', at: site['git'] }],
    ['/api/site/remove', 200, { applied: false, lines: ['remove hero_headline', '  1 value in the default locale'], findings: [] }],
    ['/api/site/setup', 200, { lines: ['this adapter has no stet_meta — nothing to migrate'], stderr: [], code: 0 }],
    ['/api/site/verify', 200, { templates: [{ template: 'welcome', state: 'PASS', detail: 'the renders match' }] }],
    ['/api/site/dev-log', 200, { running: false, state: 'none', lines: [] }],
    ['/api/site/dev-start', 200, { running: true, state: 'running', pid: 1234, command: 'npx astro dev', lines: [] }],
    ['/api/site/dev-stop', 200, { running: false, state: 'stopped', lines: [] }],
    ['/api/site/marks', 200, { documents: [], keys: {}, places: {} }],
    ['/api/site/carries', 200, { keys: [], files: ['stet/defaults.json'] }],
    [`/s/${SITE_ID}/api/stet/recent`, 200, { rows: [{ id: 3, key: 'hero_headline', locale: 'default', status: 'published', value: 'Ship the copy', publishedAt: '2026-09-01T10:00:00Z' }], nextBeforeId: null }],
    [`/s/${SITE_ID}/api/stet/keys`, 200, { descriptor: site['descriptor'], rows: [{ key: 'hero_headline', locale: 'default', status: 'draft', value: 'Later', publishAt: '2026-09-09T09:00:00Z' }] }],
    [`/s/${SITE_ID}/api/stet/changes`, 200, { changes: [{ id: 2, name: 'September prices', note: 'the whole page', status: 'scheduled', authorKind: 'human', publishAt: '2026-09-30T09:00:00Z', createdAt: '2026-09-01T09:00:00Z', revertedAt: null }], nextBeforeId: null }],
    [`/s/${SITE_ID}/api/stet/draft`, 200, { versionId: 4, status: 'draft' }],
    [`/s/${SITE_ID}/api/stet/publish`, 200, { versionId: 5 }],
    [`/s/${SITE_ID}/api/stet/discard`, 200, { discarded: 1 }],
    ['/api/workspace/update', 200, { sites: [] }],
    ['/api/workspace/add', 200, { added: true, path: '/checkouts/mini', sites: [] }],
    ['/api/workspace/remove', 200, { sites: [] }],
  ];
}

export interface Stubbed extends PaintedPage {
  /** The body `GET /api/workspace` answers. */
  workspace: { sites: Array<Record<string, unknown>> };
  /** Change what one route answers from here on: a body, or a function called per request; `delay` holds the reply back. */
  answer(path: string, status: number, body: unknown, delay?: number): void;
}

/** The real page, booted in jsdom over stubbed routes. */
export async function paintStub(
  opts: {
    site?: Record<string, unknown>;
    preview?: unknown;
    routes?: Array<[string, number, unknown, number?]>;
    storage?: Record<string, string>;
    session?: Record<string, string>;
    prepare?: (window: PaintedPage['dom']['window']) => void;
    /** Answers every request to the site's mount (`/s/<id>/api/stet/…`) in place of the table. */
    mount?: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  } = {},
): Promise<Stubbed> {
  const site = opts.site ?? siteBody();
  const table = new Map<string, [number, unknown, number?]>();
  for (const [path, status, body] of routeTable(site)) table.set(path, [status, body]);
  const workspace = (table.get('/api/workspace') as [number, { sites: Array<Record<string, unknown>> }])[1];
  table.set('/api/site', [200, site]);
  table.set('/api/site/preview', [200, opts.preview ?? { url: 'http://localhost:4321/', up: false, start: 'npx astro dev', source: 'astro' }]);
  for (const [path, status, body, delay] of opts.routes ?? []) table.set(path, [status, body, delay]);

  const page = await paintPage({
    ...(opts.storage === undefined ? {} : { storage: opts.storage }),
    ...(opts.session === undefined ? {} : { session: opts.session }),
    ...(opts.prepare === undefined ? {} : { prepare: opts.prepare }),
    html: dashboardPage().split('__STET_NONCE__').join('test-nonce'),
    serve: async (path, body) => {
      if (opts.mount !== undefined && path.startsWith(`/s/${SITE_ID}/api/stet/`)) return opts.mount(path, body);
      const found = table.get(path.split('?')[0] ?? '');
      if (found === undefined) return { status: 404, body: { error: 'not found' } };
      if (found[2] !== undefined) await new Promise((resolve) => setTimeout(resolve, found[2]));
      return { status: found[0], body: typeof found[1] === 'function' ? (found[1] as () => unknown)() : found[1] };
    },
  });
  return Object.assign(page, {
    workspace,
    answer(path: string, status: number, body: unknown, delay?: number): void {
      table.set(path, [status, body, delay]);
    },
  });
}

export const docOf = (page: PaintedPage): Document => page.dom.window.document;
export const byId = (page: PaintedPage, id: string): HTMLElement => docOf(page).getElementById(id) as HTMLElement;
export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What the agent says once it has located a key, with `over` laid on. */
export const LOCATED = (over: Record<string, unknown>): Record<string, unknown> => ({
  stet: 'located', key: 'hero_headline', found: 1, by: 'text', draft: null, route: '/', channel: CHANNEL, ...over,
});

type Post = { message: Record<string, unknown>; target: string };

/** The frame's side: what the page posted to it, and a voice to answer as its agent with. */
export function agentOf(page: PaintedPage, auto?: (message: Record<string, unknown>) => Record<string, unknown> | null) {
  const doc = docOf(page);
  const frame = (): HTMLIFrameElement => doc.querySelector('#devwrap iframe') as HTMLIFrameElement;
  const posts: Post[] = [];
  const say = (data: unknown, source: unknown = frame().contentWindow): void => {
    page.dom.window.dispatchEvent(new page.dom.window.MessageEvent('message', { data, source: source as Window }));
  };
  const spy = (): void => {
    const win = frame().contentWindow as unknown as { __spied?: boolean; postMessage: unknown };
    if (win.__spied === true) return;
    win.__spied = true;
    win.postMessage = (message: Record<string, unknown>, target: string): void => {
      posts.push({ message: JSON.parse(JSON.stringify(message)) as Record<string, unknown>, target });
      const reply = auto?.(message) ?? null;
      if (reply !== null) setTimeout(() => say(reply), 0);
    };
  };
  spy();
  /** One message from the frame's agent, carrying the channel, then the page settled. */
  const tell = async (message: Record<string, unknown>): Promise<void> => {
    say({ channel: CHANNEL, ...message });
    await page.settle();
  };
  return {
    posts,
    say,
    spy,
    frame,
    tell,
    /** The messages of one kind the page posted to the frame. */
    sent: (stet: string): Array<Record<string, unknown>> => posts.map((p) => p.message).filter((m) => m['stet'] === stet),
    pick: (keys: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Promise<void> =>
      tell({ stet: 'pick', keys: keys.map((k) => ({ attr: null, by: 'whole', inplace: true, ...k })), tag: 'h1', rect: { left: 100, top: 50, width: 200, height: 20 }, again: false, ...over }),
    typed: (key: string, value: unknown, over: Record<string, unknown> = {}): Promise<void> =>
      tell({ stet: 'typed', key, locale: 'default', value, ...over }),
    edited: (key: string, how: string, over: Record<string, unknown> = {}): Promise<void> =>
      tell({ stet: 'edited', key, locale: 'default', how, proposed: true, ...over }),
    census: (over: Record<string, unknown> = {}): Promise<void> =>
      tell({ stet: 'census', found: {}, entries: {}, ambiguous: [], weak: [], head: [], route: '/', ...over }),
    moved: (route: string): Promise<void> => tell({ stet: 'moved', how: 'pushState', route }),
    key: (which: string): Promise<void> => tell({ stet: 'key', which }),
    /** The frame's `load`, as a navigation ends. */
    load: async (): Promise<void> => {
      spy();
      frame().dispatchEvent(new page.dom.window.Event('load'));
      await page.settle();
    },
    ready: async (route = '/'): Promise<void> => {
      say({ stet: 'ready', route, channel: CHANNEL });
      await page.settle();
    },
    locates: (): Array<Record<string, unknown>> => posts.map((p) => p.message).filter((m) => m['stet'] === 'locate'),
  };
}

/** The page with a running dev server framed, its agent announced and its first load done. */
export async function bridged(over: Parameters<typeof paintStub>[0] = {}) {
  const page = await paintStub({ preview: DEV_PREVIEW, ...over });
  const agent = agentOf(page);
  await agent.load();
  await agent.ready();
  return { page, agent };
}
