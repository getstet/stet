/**
 * The HTTP pieces every server surface shares — the mount, the dashboard's
 * routes and the forms handler: the JSON reply, the capped body read, the
 * public route's JSON-object body with its three refusals, and the lenient
 * reader the Bearer routes keep. The consumers' own suites prove them unchanged
 * over it (mount.test.ts, dev.test.ts, forms.test.ts).
 */
import { describe, expect, it } from 'vitest';

import { json, MAX_BODY_BYTES, readJson, readJsonBody } from '../server/http.js';

const CAP = 16 * 1024;
const BIG = 'x'.repeat(17 * 1024);

function posted(body: BodyInit, headers: Record<string, string> = { 'content-type': 'application/json' }): Request {
  return new Request('https://site.test/api/stet/join/g', { method: 'POST', headers, body });
}

/** A body with no declared length, arriving in chunks. */
function streamed(text: string, headers: Record<string, string> = { 'content-type': 'application/json' }): Request {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 4096) controller.enqueue(bytes.slice(at, at + 4096));
      controller.close();
    },
  });
  return new Request('https://site.test/api/stet/join/g', {
    method: 'POST',
    headers,
    body: stream,
    duplex: 'half',
  } as RequestInit);
}

describe('readJsonBody', () => {
  it('refuses anything but JSON where the type is required, and reads it where not', async () => {
    const text = { 'content-type': 'text/plain' };
    expect(await readJsonBody(posted('{"a":1}', text), { cap: CAP, requireType: true })).toEqual({
      ok: false,
      status: 415,
      error: 'unsupported_media_type',
    });
    expect(await readJsonBody(posted('{"a":1}', text), { cap: CAP })).toEqual({ ok: true, body: { a: 1 } });
  });

  it('refuses a body past the cap, declared or streamed', async () => {
    const refusal = { ok: false, status: 413, error: 'body_too_large' };
    const declared = posted(BIG, { 'content-type': 'application/json', 'content-length': String(BIG.length) });
    expect(await readJsonBody(declared, { cap: CAP })).toEqual(refusal);
    expect(await readJsonBody(streamed(BIG), { cap: CAP })).toEqual(refusal);
  });

  it('refuses a body that is not one JSON object', async () => {
    for (const body of ['[1]', '"x"', 'null', '{']) {
      expect(await readJsonBody(posted(body), { cap: CAP })).toEqual({ ok: false, status: 400, error: 'invalid_body' });
    }
  });
});

describe('readJson', () => {
  it('reads what is not an object as {}, and an object as itself', async () => {
    for (const body of ['[1]', '"x"', 'null', '{']) expect(await readJson(posted(body))).toEqual({});
    expect(await readJson(posted('{"key":"hero_headline"}'))).toEqual({ key: 'hero_headline' });
  });

  it('takes the request alone and caps at the mount’s own limit', async () => {
    expect(readJson.length).toBe(1);
    expect(MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
    const over = `{"v":"${'x'.repeat(MAX_BODY_BYTES)}"}`;
    expect(await readJson(streamed(over))).toEqual({});
  });
});

describe('json', () => {
  it('is never cached, and takes headers of its own', async () => {
    const res = json({ ok: true }, 201, { Vary: 'Origin' });
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('vary')).toBe('Origin');
    expect(await res.json()).toEqual({ ok: true });
  });
});
