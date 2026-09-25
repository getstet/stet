/**
 * `createStetFormsHandler` — the two public routes of the contacts model
 * (§13.1e): `POST …/join/<group>`, where a site's own form enrols a person in a
 * group, and `…/unsubscribe?token=`, the RFC 8058 one-click target and the
 * footer link's page. Framework-free `Request → Response` handlers, like the
 * mount's, that a Next route file re-exports and a Worker calls.
 *
 * A separate factory from `createStetHandler` on purpose: that one is a
 * Bearer-authenticated write surface, and no public route shares a dispatcher
 * with it. The consent-recording logic is here, in package code; what the host
 * wires is the mounting and the spam control (`guard`, `honeypot`).
 *
 * The join route answers codes — `{ok: true}` or `{ok: false, error}` — and the
 * host's page turns each into its own words. The unsubscribe route answers a
 * page a person reads, in stet's words unless the host renders its own.
 */

import { checkAnswers, FORM_KEY, GROUP_KEY, isEmail, normalEmail, PAGE_MAX } from '../src/contacts.js';
import type { StoreAdapter } from '../src/store.js';
import { webTarget } from '../src/targets/web.js';
import { contactsMarker, isNotSupported, isStoreError } from '../adapters/store-shared.js';
import { json, readCapped, readJsonBody } from './http.js';
import { unsubscribeBase, unsubscribeUrl, verifyUnsubscribeToken } from './unsubscribe-token.js';

/** What the guard answers: pass, or the status and code the page will map. */
export type GuardVerdict = true | { status: number; error: string };
export type FormsGuard = (req: Request, body: Record<string, unknown>) => GuardVerdict | Promise<GuardVerdict>;

/** Handed to `onJoin` after every join that wrote — a re-join included. */
export interface JoinEvent {
  group: string;
  email: string;
  /** false on a re-join: the answers were replaced and nothing else moved. */
  isNew: boolean;
  /** The address holds a marketing suppression; the welcome recipe sends nothing then. */
  suppressed: boolean;
  properties: Record<string, string>;
  /** The first join's time, form and page as stored: on a re-join, never this request's. */
  joinedAt: string;
  form: string | null;
  page: string | null;
  unsubscribeUrl: string;
}

export interface UnsubscribeEvent {
  email: string;
  source: 'one-click' | 'page';
  /** false when the address was already suppressed for marketing. */
  newlySuppressed: boolean;
}

/** The unsubscribe page's four states, for a host that renders its own. */
export interface UnsubscribePage {
  state: 'confirm' | 'done' | 'invalid' | 'failed';
  email: string | null;
}

export interface FormsHandlerOptions {
  store: StoreAdapter;
  /** The forms secret's VALUE: an edge runtime hands secrets over as bindings, not `process.env`. */
  secret: string;
  /**
   * The forms mount's public URL, `https://<site>/api/stet`: every unsubscribe
   * link is built on it, and its origin is the handler's own — the origin a
   * same-site form posts from. Required, and never read from the request: a
   * request's own URL follows its `Host` header behind some adapters (a
   * `localhost` one behind others), and a delivered link must answer for as
   * long as the mail exists.
   */
  unsubscribeBase: string;
  /** Required: a function, or the explicit `'none'` a host writes knowingly. */
  guard: FormsGuard | 'none';
  /** A body field a person never fills — a text input left empty; `true`, a non-zero number or non-blank text in it is answered `ok` and dropped. */
  honeypot?: string;
  /** Origins a browser may post from across origins; the preflight answers these alone. */
  allowedOrigins?: string[];
  onJoin?: (e: JoinEvent) => void | Promise<void>;
  onUnsubscribe?: (e: UnsubscribeEvent) => void | Promise<void>;
  /**
   * The platform's hold-open for work after the response — Next's `after(run)`,
   * a Worker's `ctx.waitUntil(Promise.resolve().then(run))`. The handler hands
   * over the hook's run function without starting it, so not even a hook's
   * synchronous first stretch runs before the response; the response's timing
   * says nothing about what the hook did. Absent, the hooks are awaited before
   * the response, and a host that sends mail from `onJoin` answers a new
   * address measurably slower than a returning one.
   */
  defer?: (run: () => Promise<void>) => void;
  /** Where a hook's, the guard's or the store's failure goes; absent, `console.error`. */
  onError?: (error: unknown, where: 'guard' | 'onJoin' | 'onUnsubscribe' | 'store') => void;
  renderPage?: (page: UnsubscribePage) => string;
}

/** A join body larger than this is refused unread: 16 KiB holds any honest form. */
export const JOIN_BODY_MAX = 16 * 1024;
/** The one-click body is `List-Unsubscribe=One-Click`; 1 KiB is generous. */
const UNSUBSCRIBE_BODY_MAX = 1024;

export function createStetFormsHandler(opts: FormsHandlerOptions): {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
  OPTIONS: (req: Request) => Promise<Response>;
} {
  // Host bugs, caught at construction rather than on the first stranger's
  // request: an unset secret would mint no link and verify nothing, a missing
  // guard is an open mail amplifier the day `onJoin` sends a welcome, and a
  // missing or malformed base would put a guessed origin into delivered mail.
  if (typeof opts.secret !== 'string' || opts.secret.trim() === '') {
    throw new Error('createStetFormsHandler: `secret` is empty — set the forms secret (stet.config.json formsSecretEnv)');
  }
  if (opts.guard !== 'none' && typeof opts.guard !== 'function') {
    throw new Error("createStetFormsHandler: `guard` is required — a function, or 'none' written knowingly");
  }
  const self = unsubscribeBase(opts.unsubscribeBase, 'createStetFormsHandler').origin;
  const allowed = new Set(opts.allowedOrigins ?? []);
  const report = opts.onError ?? ((error, where) => console.error(`stet forms: ${where} failed`, error));

  /**
   * A hook, run so its failure never reaches the response: its run function
   * handed to `defer` unstarted where the host gave one, else awaited.
   */
  async function fire<E>(where: 'onJoin' | 'onUnsubscribe', hook: ((e: E) => void | Promise<void>) | undefined, e: E): Promise<void> {
    if (hook === undefined) return;
    const run = async (): Promise<void> => {
      try {
        await hook(e);
      } catch (error) {
        report(error, where);
      }
    };
    if (opts.defer) opts.defer(run);
    else await run();
  }

  /** Whether an origin may post here: the handler's own, or a listed one. */
  function trusted(origin: string): boolean {
    return origin === self || allowed.has(origin);
  }

  /** The request's Origin verdict and the headers a cross-origin answer carries. */
  function originOf(req: Request): { ok: boolean; headers: Record<string, string> } {
    const origin = req.headers.get('origin');
    if (origin === null) return { ok: true, headers: {} };
    if (!trusted(origin)) return { ok: false, headers: {} };
    return { ok: true, headers: origin === self ? {} : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } };
  }

  /**
   * The page a join came from, as its origin and path alone — no credentials,
   * query or fragment, which carry a visitor's tokens and campaign tags — and
   * only where that origin is one this route trusts: a URL from anywhere else
   * is a claim the form's host never made. Only an `http:` or `https:` URL is
   * a page: a `blob:` URL's origin is the page that made it, while its path is
   * a whole second URL.
   */
  function pageOf(raw: unknown, req: Request): string | null {
    const candidate = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : req.headers.get('referer');
    if (candidate === null) return null;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      const page = url.origin + url.pathname;
      return trusted(url.origin) && page.length <= PAGE_MAX ? page : null;
    } catch {
      return null;
    }
  }

  async function join(req: Request, group: string): Promise<Response> {
    const origin = originOf(req);
    const answer = (status: number, body: Record<string, unknown>): Response => json(body, status, origin.headers);
    const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response =>
      answer(status, { ok: false, error, ...extra });

    if (!origin.ok) return fail(403, 'origin_refused');
    const read = await readJsonBody(req, { cap: JOIN_BODY_MAX, requireType: true });
    if (!read.ok) return fail(read.status, read.error);
    const body = read.body;

    // A bot fills the field no person sees: it is told it succeeded, and
    // nothing is written, so it learns nothing to adapt to. Text, `true` and a
    // non-zero number fill it; an empty field, and an unchecked box a form
    // library sends as `false` or `0`, do not.
    if (opts.honeypot !== undefined) {
      const trap = Object.hasOwn(body, opts.honeypot) ? body[opts.honeypot] : undefined;
      const filled =
        trap === true || (typeof trap === 'number' && trap !== 0) || (typeof trap === 'string' && trap.trim() !== '');
      if (filled) return answer(200, { ok: true });
    }

    if (opts.guard !== 'none') {
      let verdict: GuardVerdict;
      try {
        verdict = await opts.guard(req, body);
      } catch (error) {
        report(error, 'guard');
        return fail(503, 'guard_unavailable');
      }
      if (verdict !== true) return fail(verdict.status, verdict.error);
    }

    const email = normalEmail(typeof body['email'] === 'string' ? body['email'] : '');
    if (!isEmail(email)) return fail(400, 'invalid_email');
    // An ill-shaped key names no group; it is answered as an unknown one.
    if (!GROUP_KEY.test(group)) return fail(404, 'unknown_group');

    const rawForm = Object.hasOwn(body, 'form') ? body['form'] : undefined;
    if (rawForm !== undefined && rawForm !== null && (typeof rawForm !== 'string' || !FORM_KEY.test(rawForm))) {
      return fail(400, 'invalid_field', { field: 'form' });
    }
    const form = typeof rawForm === 'string' ? rawForm : null;
    const page = pageOf(Object.hasOwn(body, 'page') ? body['page'] : undefined, req);

    const found = await opts.store.contacts.group({ key: group });
    if (isNotSupported(found)) return fail(501, 'not_supported');
    if (isStoreError(found)) {
      report(found, 'store');
      return fail(503, 'store_unavailable');
    }
    const def = found.group;
    if (def === null) return fail(404, 'unknown_group');
    if (def.state !== 'open') return fail(409, 'group_closed');

    const checked = checkAnswers(def.properties, body['properties']);
    if (!checked.ok) {
      if (checked.property === null) return fail(400, 'invalid_body');
      return fail(400, checked.missing ? 'missing_property' : 'invalid_property', { property: checked.property });
    }

    const joined = await opts.store.contacts.join({ group, email, properties: checked.properties, form, page });
    if (isNotSupported(joined)) return fail(501, 'not_supported');
    if (isStoreError(joined)) {
      // A close or a delete landing between the read above and the write is
      // the one conflict the write can raise.
      const marker = contactsMarker(joined);
      if (marker === 'group_closed') return fail(409, 'group_closed');
      if (marker === 'unknown_group') return fail(404, 'unknown_group');
      report(joined, 'store');
      return fail(503, 'store_unavailable');
    }

    await fire('onJoin', opts.onJoin, {
      group,
      email,
      isNew: joined.isNew,
      suppressed: joined.suppressed,
      properties: checked.properties,
      joinedAt: joined.joinedAt,
      form: joined.form,
      page: joined.page,
      unsubscribeUrl: unsubscribeUrl(email, { secret: opts.secret, base: opts.unsubscribeBase }),
    });
    // One answer for a new member, a returning one and a suppressed address:
    // the route never tells a visitor who is on a list.
    return answer(200, { ok: true });
  }

  function page(state: UnsubscribePage['state'], email: string | null, status: number): Response {
    const html = opts.renderPage ? opts.renderPage({ state, email }) : defaultPage(state, email);
    return new Response(html, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
        // The token is in this page's URL: never send it on.
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      },
    });
  }

  /**
   * Which kind of unsubscribe a POST is. RFC 8058's one-click body arrives as
   * `application/x-www-form-urlencoded` or `multipart/form-data`; any other
   * body is not read, and the POST counts as the page's button.
   */
  async function sourceOf(req: Request): Promise<UnsubscribeEvent['source']> {
    // Lowercased for the prefix test alone: a multipart boundary is
    // case-sensitive, so the parse takes the header as sent.
    const header = req.headers.get('content-type') ?? '';
    const type = header.toLowerCase();
    const urlencoded = type.startsWith('application/x-www-form-urlencoded');
    if (!urlencoded && !type.startsWith('multipart/form-data')) return 'page';
    const text = await readCapped(req, UNSUBSCRIBE_BODY_MAX);
    if (text === null) return 'page';
    try {
      const fields = urlencoded
        ? new URLSearchParams(text)
        : await new Response(text, { headers: { 'content-type': header } }).formData();
      return fields.get('List-Unsubscribe') === 'One-Click' ? 'one-click' : 'page';
    } catch {
      return 'page';
    }
  }

  async function unsubscribe(req: Request, method: 'GET' | 'POST'): Promise<Response> {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    const email = verifyUnsubscribeToken(token, opts.secret);
    if (email === null) return page('invalid', null, 400);
    // A mail scanner fetches every footer link: GET shows the button and
    // changes nothing.
    if (method === 'GET') return page('confirm', email, 200);

    const source = await sourceOf(req);
    const done = await opts.store.contacts.suppress({ email, scope: 'marketing', source });
    if (isNotSupported(done)) return page('failed', email, 503);
    if (isStoreError(done)) {
      report(done, 'store');
      return page('failed', email, 503);
    }
    await fire('onUnsubscribe', opts.onUnsubscribe, { email, source, newlySuppressed: done.suppressed });
    // 200 whether or not the row was new: a mail client treats anything else
    // as a failed unsubscribe and may retry a state that cannot change.
    return page('done', email, 200);
  }

  return {
    async GET(req) {
      const route = routeOf(req.url);
      if (route?.kind === 'unsubscribe') return unsubscribe(req, 'GET');
      if (route?.kind === 'join') return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST, OPTIONS' });
      return json({ ok: false, error: 'not_found' }, 404);
    },
    async POST(req) {
      const route = routeOf(req.url);
      if (route?.kind === 'join') return join(req, route.group);
      if (route?.kind === 'unsubscribe') return unsubscribe(req, 'POST');
      return json({ ok: false, error: 'not_found' }, 404);
    },
    async OPTIONS(req) {
      const route = routeOf(req.url);
      if (route?.kind !== 'join') return new Response(null, { status: 404 });
      const origin = req.headers.get('origin');
      if (origin === null || !allowed.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'content-type',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        },
      });
    },
  };
}

/**
 * The route a path names, read from its last two segments so the host may
 * mount it under any prefix: `…/join/<group>` or `…/unsubscribe`. `join` is
 * read first, so a group named `unsubscribe` is a join.
 */
export function routeOf(url: string): { kind: 'join'; group: string } | { kind: 'unsubscribe' } | null {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  if (prev === 'join' && last !== undefined) {
    try {
      return { kind: 'join', group: decodeURIComponent(last) };
    } catch {
      return null;
    }
  }
  if (last === 'unsubscribe') return { kind: 'unsubscribe' };
  return null;
}

/** The page stet serves when the host renders none. Every string is PROPOSED copy. */
function defaultPage(state: UnsubscribePage['state'], email: string | null): string {
  const who = email === null ? '' : webTarget.escape(email);
  const body =
    state === 'confirm'
      ? `<p>Unsubscribe ${who} from marketing email?</p><form method="post" action=""><input type="hidden" name="confirm" value="yes"><button type="submit">Unsubscribe</button></form>`
      : state === 'done'
        ? `<p>${who} is unsubscribed from marketing email.</p>`
        : state === 'invalid'
          ? '<p>This unsubscribe link is not valid.</p>'
          : '<p>Unsubscribing did not go through. Try the link again later.</p>';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe</title>' +
    '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>' +
    `</head><body>${body}</body></html>`
  );
}
