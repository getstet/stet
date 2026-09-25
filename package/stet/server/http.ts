/**
 * The HTTP pieces every server surface shares — the Bearer mount, the local
 * dashboard's routes and the public forms routes: the JSON reply, the capped
 * body read, the JSON-object body with its refusals, and the credential
 * compare. One copy each, so a posture fixed here (the cap, arrays refused,
 * replies never cached) holds on every route.
 *
 * The signer's and the compare's home is `src/preview-token.ts`: `src/` may
 * name `node:crypto` in two modules only and cannot import from `server/`, so
 * the preview token keeps both and this module re-exports them for everyone
 * else.
 */

export { hmac, sameSignature } from '../src/preview-token.js';

/** The body cap of the mount and the dashboard's routes. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** A JSON reply, never cached: every answer here is about one moment's state. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * The body as text, or null past `cap` bytes. Streamed, so an oversized body
 * is refused after `cap` bytes rather than read whole first; a declared
 * `content-length` over the cap is refused before reading at all.
 */
export async function readCapped(req: Request, cap: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > cap) return null;
  if (req.body === null) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export type JsonBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 413 | 415; error: 'invalid_body' | 'body_too_large' | 'unsupported_media_type' };

/**
 * A JSON object body, or the refusal a public route answers: 415 where
 * `requireType` is set and the request is not `application/json`, 413 past
 * `cap`, 400 when the text is not a JSON object (an array included).
 */
export async function readJsonBody(req: Request, opts: { cap: number; requireType?: boolean }): Promise<JsonBody> {
  if (opts.requireType === true && !/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) {
    return { ok: false, status: 415, error: 'unsupported_media_type' };
  }
  const text = await readCapped(req, opts.cap);
  if (text === null) return { ok: false, status: 413, error: 'body_too_large' };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, body: parsed as Record<string, unknown> };
    }
  } catch {
    // falls through to the refusal
  }
  return { ok: false, status: 400, error: 'invalid_body' };
}

/**
 * The lenient form the mount and the dashboard's routes keep: the object, or
 * `{}` when the body is absent, malformed, an array or past the cap — each
 * route then refuses the fields it is missing, by name.
 */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const read = await readJsonBody(req, { cap: MAX_BODY_BYTES });
  return read.ok ? read.body : {};
}
