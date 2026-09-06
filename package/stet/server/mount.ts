/**
 * `createStetHandler` — the package's one catch-all HTTP API surface, mounted by
 * a store-backed host so the dashboard, the digest proxy and agents read and
 * write content over HTTP. Framework-free `Request → Response` handlers a Next
 * `route.ts` re-exports; it ships here because the install's route scaffold (C2)
 * and digest proxy (C7) are its first clients, ahead of the dashboard.
 *
 * It is a Bearer-authenticated WRITE surface, so the auth is constant-time and
 * runs before any store call, writes delegate to the store RPCs (validation and
 * attribution stay the store's), and a key's `target` is bound from the
 * descriptor — never a literal, never widened to `string`.
 *
 * SURFACED canon deviations (logged in the proposal's conflicts): `descriptor`
 * and `sendTest` are ADDED to canon §13.5's options (the draft RPC's `target`
 * has no other source; test-send needs a send channel); `renderEmail` is
 * TEMPLATE-based; the `revert` body ADDS `key` (its RPC returns only a version
 * id, and `onPublish` needs the key to source the target); canon's "history
 * drafts included" is the outlier against the published-only store contract.
 */

import { timingSafeEqual } from 'node:crypto';

import { revertChange } from '../adapters/changesets.js';
import type { DraftRefusal, NotSupported, StoreAdapter, StoreError } from '../src/store.js';
import type { Descriptor, Target } from '../src/types.js';

/** Fired fire-and-forget after a publish or revert. `target` is the descriptor's, never widened to a string. */
export interface PublishEvent {
  key: string;
  target: Target;
  versionId: number;
}

export interface StetHandlerOptions {
  store: StoreAdapter;
  descriptor: Descriptor;
  /** Template-based render (`?template=&version=`); left unwired on a fresh install → render/test-send answer 501. */
  renderEmail?: (template: string, opts?: { version?: number; override?: Record<string, unknown> }) => Promise<string>;
  /** The host's send channel for test-send; unwired → 501. */
  sendTest?: (html: string, to: string) => Promise<void>;
  /** The NAME of the env var holding the Bearer token (the configured `apiTokenEnv`). */
  auth: string;
  onPublish?: (e: PublishEvent) => void;
  /**
   * Declared here, fired only on an AGENT publish — wired by add-mcp, which
   * carries the discriminator. When add-mcp adds the `onAgentPublish` invocation
   * it MUST fire it through the same fire-and-forget guard `firePublish` uses: an
   * un-awaited async-hook rejection crashes the host (Node 15+).
   */
  onAgentPublish?: (e: PublishEvent) => void;
}

export function createStetHandler(opts: StetHandlerOptions): {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
} {
  // 401 unless the request Bearer equals the configured token, constant-time.
  const unauthorized = (req: Request): Response | null =>
    bearerMatches(req, process.env[opts.auth]) ? null : json({ error: 'unauthorized' }, 401);

  // A hook failure never fails the publish — fire-and-forget, never awaited. A
  // sync throw is caught here; an async `onPublish` that rejects is swallowed by
  // the `.catch` — its rejection would otherwise escape to `unhandledRejection`
  // and terminate the host on Node 15+ (the void-callback type permits async).
  // add-mcp's `onAgentPublish` invocation MUST route through this same guard.
  const firePublish = (event: PublishEvent): void => {
    try {
      void Promise.resolve(opts.onPublish?.(event)).catch(() => {});
    } catch {
      /* fire-and-forget */
    }
  };

  // Declared-key and declared-template lookups, own-property only. A bare
  // `descriptor.keys[key]` walks the prototype chain, so `constructor`,
  // `toString`, `valueOf`, `__proto__`, `hasOwnProperty` and `isPrototypeOf`
  // all resolve as though declared — turning the undeclared-key guard into a
  // door and handing `target` an inherited function. `in` has the same hole.
  // (Same guard shape as `src/targets/adapter.ts`'s registry lookup.) A key
  // legitimately NAMED `constructor` still resolves: it is an own property.
  const keyDef = (key: string): Descriptor['keys'][string] | undefined =>
    Object.hasOwn(opts.descriptor.keys, key) ? opts.descriptor.keys[key] : undefined;
  const declaredTemplate = (template: string): boolean =>
    Object.hasOwn(opts.descriptor.templates ?? {}, template);

  // One member's event, sourced from the descriptor like every other. A member
  // whose key has since LEFT the descriptor gets no event — there is no
  // `target` to build one from, and `PublishEvent.target` is never widened to a
  // string. The flip itself is unaffected: this is a stated orphan edge, not
  // machinery.
  const fireMember = (key: string, versionId: number): void => {
    const def = keyDef(key);
    if (def === undefined) return;
    firePublish({ key, target: def.target, versionId });
  };

  // test-send's override: the template's slot DRAFT rows, read preview-scoped and
  // narrowed to the template's slot keys (the handler has no snapshot, so it
  // cannot resolve). Un-drafted slots are left to the host's own defaults.
  const draftOverride = async (template: string): Promise<Record<string, unknown>> => {
    // Own-property only: `templates?.['constructor']` is a FUNCTION, and
    // `def.slots.map` on it throws a 500 out of the test-send route.
    if (!declaredTemplate(template)) return {};
    const def = opts.descriptor.templates?.[template];
    if (!def) return {};
    const keys = def.slots.map((slot) => `${template}__${slot}`);
    const rows = await opts.store.read({ keys, preview: true });
    if (isStoreError(rows)) return {};
    const override: Record<string, unknown> = {};
    for (const row of rows) if (row.status === 'draft') override[row.key] = row.value;
    return override;
  };

  const GET = async (req: Request): Promise<Response> => {
    const denied = unauthorized(req);
    if (denied) return denied;

    const url = new URL(req.url);
    switch (segment(url)) {
      case 'keys': {
        const rows = await opts.store.read({ preview: true });
        if (isStoreError(rows)) return storeErrorResponse(rows);
        return json({ descriptor: opts.descriptor, rows });
      }
      case 'history': {
        const key = url.searchParams.get('key');
        if (!key) return json({ error: 'history requires a key' }, 400);
        return rpcResult(
          await opts.store.history({
            key,
            locale: url.searchParams.get('locale') ?? undefined,
            beforeId: intParam(url, 'beforeId'),
            limit: intParam(url, 'limit'),
          }),
        );
      }
      case 'recent':
        return rpcResult(await opts.store.recent({ beforeId: intParam(url, 'beforeId'), limit: intParam(url, 'limit') }));
      case 'changes': {
        const status = url.searchParams.get('status');
        if (status !== null && status !== 'open' && status !== 'scheduled' && status !== 'published') {
          return json({ error: 'status must be open, scheduled or published' }, 400);
        }
        return rpcResult(
          await opts.store.changesets.list({
            ...(status === null ? {} : { status }),
            beforeId: intParam(url, 'beforeId'),
            limit: intParam(url, 'limit'),
          }),
        );
      }
      case 'render': {
        const template = url.searchParams.get('template');
        if (!template) return json({ error: 'render requires a template' }, 400);
        // Validate the template against the descriptor BEFORE handing it to the
        // host renderEmail — an unvalidated template is a traversal/SSRF vector,
        // and test-send already 400s an unknown template (P2-7).
        if (!declaredTemplate(template)) {
          return json({ error: `unknown template: ${template}` }, 400);
        }
        const versionRaw = url.searchParams.get('version');
        if (versionRaw !== null && !/^\d+$/.test(versionRaw)) return json({ error: 'version must be an integer' }, 400);
        if (!opts.renderEmail) return json({ error: 'render is not wired' }, 501);
        const html = await opts.renderEmail(template, { version: versionRaw === null ? undefined : Number(versionRaw) });
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      // Every other GET — including the signed-preview route (add-editor's) and media (phase-2).
      default:
        return json({ error: 'not found' }, 404);
    }
  };

  const POST = async (req: Request): Promise<Response> => {
    const denied = unauthorized(req);
    if (denied) return denied;

    const seg = segment(new URL(req.url));
    const body = await readJson(req);

    switch (seg) {
      case 'draft': {
        // Trim before the non-empty check AND before forwarding: a whitespace-only
        // editor must not reach the audit trail (P2-6).
        const editor = reqStr(body, 'editor').trim();
        if (!editor) return json({ error: 'editor is required' }, 400);
        const key = reqStr(body, 'key');
        const def = keyDef(key);
        if (def === undefined) return json({ error: `undeclared key: ${key}` }, 400);
        // The membership ref's three intents survive the wire: ABSENT leaves it
        // (spread as {}, so the param never appears), an explicit null detaches,
        // a number attaches. Anything else — a string "3" above all — is a 400
        // rather than a coercion, because a coerced id would attach a draft to
        // whatever change that number happened to name.
        const change = changeField(body);
        if (change === INVALID) return json({ error: 'change must be a number or null' }, 400);
        // The full canon body — dropping `force` locks a DraftRefusal to the incumbent forever.
        return rpcResult(
          await opts.store.saveDraft({
            key,
            value: body['value'],
            target: def.target,
            editor,
            locale: optStr(body, 'locale'),
            label: optStr(body, 'label'),
            note: optStr(body, 'note'),
            publishAt: optStr(body, 'publishAt'),
            force: body['force'] === true,
            ...change,
          }),
        );
      }

      case 'publish': {
        const editor = reqStr(body, 'editor').trim();
        if (!editor) return json({ error: 'editor is required' }, 400);
        const key = reqStr(body, 'key');
        const def = keyDef(key);
        if (def === undefined) return json({ error: `undeclared key: ${key}` }, 400);
        const res = await opts.store.publish({ key, editor, locale: optStr(body, 'locale') });
        if (isStoreError(res)) return storeErrorResponse(res);
        if (isNotSupported(res)) return notSupportedResponse(res);
        firePublish({ key, target: def.target, versionId: res.versionId });
        return json(res);
      }

      case 'revert': {
        const editor = reqStr(body, 'editor').trim();
        if (!editor) return json({ error: 'editor is required' }, 400);
        // `key` is a surfaced addition beyond canon's {versionId, editor}: the RPC
        // returns only a version id, so onPublish needs the key to source `target`.
        const key = reqStr(body, 'key');
        const def = keyDef(key);
        if (def === undefined) return json({ error: `undeclared key: ${key}` }, 400);
        const versionId = numField(body, 'versionId');
        if (versionId === undefined) return json({ error: 'versionId is required' }, 400);
        const res = await opts.store.revert({ versionId, editor });
        if (isStoreError(res)) return storeErrorResponse(res);
        if (isNotSupported(res)) return notSupportedResponse(res);
        firePublish({ key, target: def.target, versionId: res.versionId });
        return json(res);
      }

      case 'test-send': {
        const template = reqStr(body, 'template');
        if (!template) return json({ error: 'test-send requires a template' }, 400);
        // Unknown template → 400 BEFORE any render or send: no silent-sending a typo.
        if (!declaredTemplate(template)) {
          return json({ error: `unknown template: ${template}` }, 400);
        }
        const to = reqStr(body, 'to');
        if (!to) return json({ error: 'test-send requires a recipient' }, 400);
        // A CR/LF in the recipient is a header-injection vector into a host that
        // builds SMTP directly — reject before any send (P2-8).
        if (/[\r\n]/.test(to)) return json({ error: 'recipient must not contain a newline' }, 400);
        if (!opts.renderEmail || !opts.sendTest) return json({ error: 'test-send is not wired' }, 501);
        const html = await opts.renderEmail(template, { override: await draftOverride(template) });
        await opts.sendTest(html, to);
        return json({ sent: true });
      }

      case 'changes': {
        // The changeset routes keep the uniform write posture: an editor is
        // required even where the store records no author column, because
        // attribution rides the member drafts and `published_by`.
        const editor = reqStr(body, 'editor').trim();
        if (!editor) return json({ error: 'editor is required' }, 400);
        const name = reqStr(body, 'name').trim();
        if (!name) return json({ error: 'name is required' }, 400);
        const authorKind = body['authorKind'];
        if (authorKind !== undefined && authorKind !== 'human' && authorKind !== 'agent') {
          return json({ error: "authorKind must be 'human' or 'agent'" }, 400);
        }
        return rpcResult(
          await opts.store.changesets.open({
            name,
            note: optStr(body, 'note'),
            // The discriminator that SETS 'agent' is add-mcp's; the route only
            // accepts it.
            authorKind: authorKind ?? 'human',
          }),
        );
      }

      case 'schedule-change': {
        const editor = reqStr(body, 'editor').trim();
        if (!editor) return json({ error: 'editor is required' }, 400);
        const changeId = numField(body, 'change');
        if (changeId === undefined) return json({ error: 'change is required' }, 400);
        // ABSENCE must never read as cancel: an omitted field is a malformed
        // request, while an explicit null is the operator cancelling.
        if (!('publishAt' in body)) return json({ error: 'publishAt is required' }, 400);
        const raw = body['publishAt'];
        let publishAt: string | null = null;
        if (raw !== null) {
          if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
            return json({ error: 'publishAt must be an ISO timestamp or null' }, 400);
          }
          // NORMALIZED, not passed through. `Date.parse` accepts far more than
          // ISO — `"1"` parses as the year 2001, so a typo would schedule the
          // group in the past and the clock would publish it on its next run —
          // and `"03/04/2026"` is month-first here but reads differently to
          // Postgres under another DateStyle. The stored instant is the one
          // every reader agrees on. (`cli/write.ts`'s `stamp()` does the same.)
          publishAt = new Date(Date.parse(raw)).toISOString();
        }
        return rpcResult(await opts.store.changesets.schedule({ changeId, publishAt }));
      }

      case 'publish-change': {
        const editor = reqStr(body, 'editor').trim();
        if (!editor) return json({ error: 'editor is required' }, 400);
        const changeId = numField(body, 'change');
        if (changeId === undefined) return json({ error: 'change is required' }, 400);
        const res = await opts.store.changesets.publishChange({ changeId, editor });
        if (isStoreError(res)) return storeErrorResponse(res);
        if (isNotSupported(res)) return notSupportedResponse(res);
        // The event stays PER KEY: one transaction in the store does not
        // coalesce it (§7). Every call goes through the same fire-and-forget
        // guard — never a second hand-rolled one.
        for (const member of res.published) fireMember(member.key, member.versionId);
        return json(res);
      }

      case 'revert-change': {
        const editor = reqStr(body, 'editor').trim();
        if (!editor) return json({ error: 'editor is required' }, 400);
        const changeId = numField(body, 'change');
        if (changeId === undefined) return json({ error: 'change is required' }, 400);
        // The ONE shared enumeration, not a second walk written here.
        const res = await revertChange(opts.store, { changeId, editor });
        if (isStoreError(res)) return storeErrorResponse(res);
        if (isNotSupported(res)) return notSupportedResponse(res);
        // Only the RESTORED members changed the live copy; a skipped member's
        // active row never moved, so firing for it would be a lie.
        for (const member of res.reverted) fireMember(member.key, member.versionId);
        return json(res);
      }

      case 'discard': {
        const editor = reqStr(body, 'editor').trim();
        if (!editor) return json({ error: 'editor is required' }, 400);
        const key = reqStr(body, 'key').trim();
        if (!key) return json({ error: 'key is required' }, 400);
        // A present-but-non-string locale must not be DROPPED to undefined the
        // way an optional read field can be: this is a DELETE, and silently
        // falling back to the default locale would discard a draft the caller
        // never named.
        if ('locale' in body && typeof body['locale'] !== 'string') {
          return json({ error: 'locale must be a string' }, 400);
        }
        // NO declared-key 400 here, unlike draft/publish/revert: cleanup must
        // reach a draft whose key has left the descriptor, and discard needs no
        // `target` source — it deletes a row rather than writing one.
        return rpcResult(
          await opts.store.changesets.discardDraft({ key, locale: optStr(body, 'locale') }),
        );
      }

      case 'abandon-change': {
        const editor = reqStr(body, 'editor').trim();
        if (!editor) return json({ error: 'editor is required' }, 400);
        const changeId = numField(body, 'change');
        if (changeId === undefined) return json({ error: 'change is required' }, 400);
        return rpcResult(await opts.store.changesets.abandon({ changeId }));
      }

      // Every other POST — including rename (no route; phase-2 CLI) and the preview route.
      default:
        return json({ error: 'not found' }, 404);
    }
  };

  return { GET, POST };
}

/**
 * Whether a request's Bearer equals the expected token, in constant time.
 *
 * An absent or empty expected token authenticates NOTHING (an empty === empty
 * would otherwise pass), and the compare guards on BYTE length so a multibyte
 * length mismatch is a clean false rather than a throw out of
 * `timingSafeEqual`. The expected value is TRIMMED: a `.env`/secret-file token
 * carries a trailing newline the HTTP layer strips from the request header, so
 * an untrimmed compare could never match (P2-5).
 *
 * Exported for `cli/dev.ts`'s local server, which authenticates its own routes
 * against a per-run token with exactly this rule — one compare, so the
 * dashboard's API and the mounted API cannot drift apart on what a valid Bearer
 * is. It is package-internal: `server/index.ts` does not re-export it.
 */
export function bearerMatches(req: Request, expected: string | undefined): boolean {
  const want = expected?.trim();
  if (want === undefined || want === '') return false;
  const provided = bearer(req);
  if (provided === undefined) return false;
  const a = Buffer.from(want, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

/** JSON response with the right content type. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The Bearer token, or undefined — an empty `Bearer ` yields undefined (no match). */
function bearer(req: Request): string | undefined {
  const header = req.headers.get('authorization');
  if (header === null) return undefined;
  // The auth scheme is case-insensitive per RFC 7235.
  const match = /^Bearer (.+)$/i.exec(header);
  return match ? match[1] : undefined;
}

/**
 * The catch-all segment — the last non-empty path part (search excluded).
 * Matching the last segment is mount-agnostic (the host may mount the catch-all
 * at any base) and safe: auth gates every route and each route is single-segment.
 */
function segment(url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** A non-negative integer query param, or undefined when absent or non-numeric. */
function intParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** A required string body field — '' when absent or not a string (rejected by the caller). */
function reqStr(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

/** An optional string body field — undefined when absent or not a string. */
function optStr(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * An INTEGER id body field, or undefined. Finite is not enough: `1.5` and
 * `1e20` are finite and reach the store, where they diverge by adapter — the
 * memory reference refuses them as a missing id while the SQL adapters fail in
 * the driver. Ids are integers within the safe range or they are not ids.
 * `0` and negatives stay admitted deliberately: their `no_change` refusal is
 * the design (Decision 5), and `-1` is refused at the SQL adapters' boundary.
 */
function numField(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  return isId(value) ? value : undefined;
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

/** A `change` field that is present but neither a number nor null. */
const INVALID = Symbol('invalid change');

/**
 * The save's membership ref, as the three intents the store distinguishes:
 * `{}` (absent — spread into the params, the key never appears, membership is
 * left alone), `{ change: null }` (detach), `{ change: n }` (attach). A present
 * value of any other type is INVALID and the caller 400s it: a string `"3"` is
 * never coerced, because coercion would silently attach a draft to change 3.
 */
function changeField(
  body: Record<string, unknown>,
): { change?: number | null } | typeof INVALID {
  if (!('change' in body)) return {};
  const value = body['change'];
  if (value === null) return { change: null };
  if (isId(value)) return { change: value };
  return INVALID;
}

/** A JSON object body, or {} when the body is absent, malformed, or not an object. */
async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isStoreError(value: unknown): value is StoreError {
  return typeof value === 'object' && value !== null && 'storeError' in value;
}
function isNotSupported(value: unknown): value is NotSupported {
  return typeof value === 'object' && value !== null && 'notSupported' in value;
}
function isRefusal(value: unknown): value is DraftRefusal {
  return typeof value === 'object' && value !== null && 'refused' in value;
}

function storeErrorResponse(error: StoreError): Response {
  const status = error.code === 'conflict' ? 409 : error.code === 'unreachable' ? 503 : 502;
  return json({ error: error.message, code: error.code }, status);
}
function notSupportedResponse(result: NotSupported): Response {
  return json({ error: `not supported: ${result.method}` }, 501);
}

/** Map an RPC result to a response — a store error / not-supported / draft refusal to its status, else the result at 200. */
function rpcResult(result: unknown): Response {
  if (isStoreError(result)) return storeErrorResponse(result);
  if (isNotSupported(result)) return notSupportedResponse(result);
  if (isRefusal(result)) return json(result, 409);
  return json(result);
}
