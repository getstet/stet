# Contacts

A site's own sign-up form posts to stet, and stet records who joined which
group, when, from which page and with which answers, in the site's own
Postgres. It serves the one-click unsubscribe every email you send links to.
stet sends no email: your `onJoin` sends the welcome through your own provider.

The list lives in migration 3's five tables. `stet contacts` reads it from the
terminal; the SQL below reads it from anywhere else.

```bash
npx stet upgrade                       # applies migration 3 to the store
npx stet contacts group add cloud-waitlist --name "stet Cloud" \
  --property tier=solo,team,business --required tier
npx stet contacts list --group cloud-waitlist
```

## The two routes

`createStetFormsHandler` on `@getstet/stet/server` returns `{ GET, POST, OPTIONS }`
request handlers. It routes on the last two segments of the path, so it answers
under any prefix; every recipe here mounts it at `/api/stet`.

**`POST /api/stet/join/<group>`** takes a JSON body from your form:

```json
{ "email": "ana@lightfield.co", "properties": { "tier": "team" }, "form": "waitlist-page", "page": "https://example.com/waitlist" }
```

It accepts JSON alone, from the site's own origin (the origin of
`unsubscribeBase`) or from an origin in `allowedOrigins`, up to 16 KiB. It
checks the address, the group and each answer against the questions the group
declares, records the membership, and answers `{"ok":true}`. The answer is the
same bytes for a new member, a returning one and a suppressed address, so the
route never tells a visitor who is on a list. A returning member's answers are
replaced; the first join's time, `form` and `page` are kept as the consent
evidence. `page` (or the `Referer` header when the body has none) is stored as
its origin and path alone, and only when it is an `http` or `https` URL whose
origin is the site's own or listed. Every refusal is `{"ok":false,"error":"<code>"}`, and your page turns
each code into its own sentence:

| Code | Status | When |
|---|---|---|
| `origin_refused` | 403 | the `Origin` is neither the site's own nor listed |
| `unsupported_media_type` | 415 | the body is not `application/json` |
| `body_too_large` | 413 | the body is over 16 KiB |
| `invalid_body` | 400 | the body is not one JSON object, or `properties` is not one |
| `guard_unavailable` | 503 | your guard threw |
| `invalid_email` | 400 | the address is not shaped like one, is over 254 characters, holds a control character, or is not well-formed text |
| `unknown_group` | 404 | no group of that key |
| `invalid_field` | 400 | `form` is not a short token (`field` names it) |
| `group_closed` | 409 | the group is closed to new joins |
| `invalid_property` | 400 | an answer the group does not ask, of the wrong type, outside an enum's values, over 500 characters, holding a control character or not well-formed text (`property` names it) |
| `missing_property` | 400 | a required answer is missing (`property` names it) |
| `not_supported` | 501 | the store has no contacts capability |
| `store_unavailable` | 503 | the store did not answer |
| `method_not_allowed` | 405 | a GET on a join path |
| `not_found` | 404 | a path neither route names |

Your guard's own refusal is answered with the status and code it returns.

**`/api/stet/unsubscribe?token=…`** is the link your emails carry. A GET shows a
page asking to confirm and writes nothing, because mail scanners fetch every link
in a footer. A POST writes one marketing suppression: with source `one-click`
when the body is RFC 8058's `List-Unsubscribe=One-Click` (form-encoded or
multipart, as a mail client sends it), and with source `page` when it is the
page's button. It answers the done page with 200 whether or not the address was
already suppressed. A link that does not verify answers a page saying so, with
400. The pages are stet's words unless you pass `renderPage`.

## The Next.js recipe

The handler and its store are built per request and the pool is closed after the
response through `after()`, which also carries the hooks. The handler is built
inside the `try`, so a constructor that throws on a missing secret still closes
the pool. `next build` imports the route modules and never runs the
constructor's checks, so the build needs no secret.

```ts
// lib/stet-forms.ts
import { after } from 'next/server';
import { createStetFormsHandler } from '@getstet/stet/server';
import { createPgStore } from '@getstet/stet/store-pg';

export async function stetForms(method: 'GET' | 'POST' | 'OPTIONS', req: Request): Promise<Response> {
  const store = createPgStore({ connectionString: process.env.DATABASE_URL ?? '', project: 'default' });
  try {
    const forms = createStetFormsHandler({
      store,
      secret: process.env.STET_FORMS_SECRET ?? '',
      unsubscribeBase: 'https://example.com/api/stet',
      guard: limitByAddress, // the recipe's limiter, or 'none' written knowingly
      honeypot: 'website',
      defer: (run) => after(run),
      onJoin: sendWelcome,
    });
    return await forms[method](req);
  } finally {
    after(() => store.end());
  }
}
```

```ts
// app/api/stet/join/[group]/route.ts
import { stetForms } from '@/lib/stet-forms';

export const POST = (req: Request) => stetForms('POST', req);
// Next answers OPTIONS itself unless the route exports it.
export const OPTIONS = (req: Request) => stetForms('OPTIONS', req);
```

```ts
// app/api/stet/unsubscribe/route.ts
import { stetForms } from '@/lib/stet-forms';

export const GET = (req: Request) => stetForms('GET', req);
export const POST = (req: Request) => stetForms('POST', req);
```

Both route folders sit beside a store-backed site's `app/api/stet/[...stet]/route.ts`.
Next matches a static segment before a catch-all, so `/api/stet/join/draft` is a
join to a group named `draft` and never reaches the Bearer mount.

## The Worker recipe

A static site with no server of its own runs the endpoint on a serverless
runtime. Secrets arrive on `env` per request, so the handler and its store are
built per request, and the handler is served under `/api/stet/` so every link
has the same path. The handler is built inside the `try`, so a constructor that
throws still closes the pool.

```ts
import { createStetFormsHandler } from '@getstet/stet/server';
import { createPgStore } from '@getstet/stet/store-pg';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Made per request: a pool made at module scope hangs the second request.
    const store = createPgStore({ connectionString: env.STET_CONTACTS_DATABASE_URL, project: 'default' });
    try {
      const forms = createStetFormsHandler({
        store,
        secret: env.STET_FORMS_SECRET,
        unsubscribeBase: 'https://forms.example.com/api/stet',
        allowedOrigins: ['https://example.com'],
        guard: (req, body) => turnstile(body['token'], env.TURNSTILE_SECRET),
        honeypot: 'website',
        defer: (run) => ctx.waitUntil(Promise.resolve().then(run)),
      });
      const route = forms[req.method as 'GET' | 'POST' | 'OPTIONS'];
      return route ? await route(req) : new Response(null, { status: 405 });
    } finally {
      ctx.waitUntil(store.end());
    }
  },
};
```

Its `wrangler.toml` pins the runtime:

```toml
# The forms handler signs and checks its links with node:crypto, so every
# Worker that runs it needs nodejs_compat. store-pg also needs a compatibility
# date of 2026-04-01 or later, the date it runs under here; under 2025-09-01 a
# pg connection hangs the request on `tid.unref`.
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat"]
```

`store-postgrest` is the alternative on a Worker: it reaches the database over
`fetch`, so the compatibility date does not bind it, and the forms handler still
needs `nodejs_compat`. `store-pg` has been run under `wrangler dev` against a
local database; TLS from a deployed Worker to a remote database has not been
run.

## Why the store is made inside the request

A `pg` pool made at module scope outlives the request that made it. On a Worker
the second request waits on the first request's connection and hangs. On Next
the same pool stays open between requests with nothing closing it. Made inside
the request and closed after the response, each request holds its own
connection for as long as it runs.

## `defer`, and what it keeps private

The hooks run after the response when you pass `defer`: the handler hands your
platform's hold-open (Next's `after`, a Worker's `ctx.waitUntil`) the hook's run
function without starting it, so no part of the hook runs before the response.
A welcome sent from `onJoin` therefore takes no time out of the answer, and the
answer's timing says nothing about whether the address was new.

Without `defer` the hooks are awaited before the response. A host that sends mail
from `onJoin` then answers a new address measurably slower than a returning one,
and that difference tells a visitor whether an address was already on the list.

Hook work should be asynchronous I/O: a send, a fetch, a queue write. Synchronous
work after the response still holds the process, so it delays the next request
the same process serves, and that delay says whether the previous join was new.

A hook that throws, or rejects, is reported through `onError` (by default
`console.error`) and never changes the response. A store that does not answer
is reported there too, as `'store'`, and the route answers `store_unavailable`
or the failed page.

## Security notes

- The honeypot runs before the guard, so a bot that fills it costs no guard call.
  It counts as filled when it holds `true`, a number other than 0, or text that
  is not blank, so make it a text input the page leaves empty. Its drop answers
  faster than a stored join. That tells a bot only that its own submission was dropped. It
  says nothing about who is on a list.
- A slow body is bounded by the platform's own request timeout. The handler's
  16 KiB cap bounds its size, with or without a declared length.
- The join route stores no control character in an address or an answer: a
  stranger types both, and `stet contacts` prints them. A text answer may hold a
  line feed.
- The unsubscribe pages are never cached, never indexed, send no referrer (the
  token is in their URL), and cannot be framed.
- An erased address is kept as a salted SHA-256 hash in `stet_erasures`, and the
  salt sits in `stet_meta` in the same database. The hash stops an import from
  adding the address back. It is not secret from anyone holding the service
  credential, who can hash a candidate address and look for it.

## The guard

`guard` is required. It is a function of the request and the parsed body that
answers `true` or the `{ status, error }` your page will map, or the explicit
`'none'`. stet ships no limiter: an in-memory limiter does nothing across the
instances of a serverless runtime.

A limiter of 5 joins per address per 10 minutes, keyed on the rightmost
`x-forwarded-for` entry on Next (the one your own proxy appended). It holds per
instance only:

```ts
// lib/limit.ts
import type { GuardVerdict } from '@getstet/stet/server';

const WINDOW_MS = 10 * 60 * 1000;
const seen = new Map<string, number[]>();

export function limitByAddress(req: Request): GuardVerdict {
  const address = req.headers.get('x-forwarded-for')?.split(',').pop()?.trim() ?? 'unknown';
  const now = Date.now();
  const recent = (seen.get(address) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= 5) return { status: 429, error: 'rate_limited' };
  seen.set(address, [...recent, now]);
  return true;
}
```

On a Worker, key it on `req.headers.get('CF-Connecting-IP')`.

A Turnstile check, posting the widget's token as `response` beside your secret:

```ts
import type { GuardVerdict } from '@getstet/stet/server';

export async function turnstile(token: unknown, secret: string): Promise<GuardVerdict> {
  if (typeof token !== 'string' || token === '') return { status: 403, error: 'challenge_failed' };
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret, response: token }),
  });
  const outcome = (await res.json()) as { success?: boolean };
  return outcome.success === true ? true : { status: 403, error: 'challenge_failed' };
}
```

A guard that throws (the verification service is down) answers
`guard_unavailable` with 503.

## The welcome email

`onJoin` receives the group, the address, `isNew`, `suppressed`, the stored
answers, the first join's `joinedAt`, `form` and `page`, and the address's
`unsubscribeUrl`. Send only when `isNew && !suppressed`, put `unsubscribeUrl` in
the body and in the `List-Unsubscribe` header with
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and name where the person
joined by the page's host alone:

```ts
import type { JoinEvent } from '@getstet/stet/server';

export async function sendWelcome(e: JoinEvent): Promise<void> {
  if (!e.isNew || e.suppressed) return;
  const where = e.page === null ? 'our site' : new URL(e.page).host;
  const when = e.joinedAt.slice(0, 10);
  await provider.send({
    to: e.email,
    subject: 'You’re on the list',
    text: `You joined this list from ${where} on ${when}.\n\nUnsubscribe: ${e.unsubscribeUrl}`,
    headers: {
      'List-Unsubscribe': `<${e.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}
```

The subject and the headers are your own text: no answer a visitor submitted is
written into a header. `provider` stands for your email provider's client.

`unsubscribeUrl` is also exported from `@getstet/stet/server`, for the marketing
sends your own code makes:

```ts
import { unsubscribeUrl } from '@getstet/stet/server';

const link = unsubscribeUrl('ana@lightfield.co', {
  secret: process.env.STET_FORMS_SECRET ?? '',
  base: 'https://example.com/api/stet',
});
```

## `onUnsubscribe`

`onUnsubscribe` receives the address, the source (`one-click` or `page`) and
whether the suppression was new. It is where a confirmation goes: the core
pack's `list_unsubscribe_confirm` template is the one it will send once the core
pack ships it.

## `unsubscribeBase`

`unsubscribeBase` is the forms mount's public URL, `https://<site>/api/stet`.
Every unsubscribe link is built on it, and its origin is the handler's own: the
origin your same-site form posts from. It is required and never read from the
request, because a request's own URL follows its `Host` header behind some
adapters, and a delivered link has to answer for as long as the email exists.
It must be `https:` (or `http:` on `localhost` or `127.0.0.1` for local
development) with no query, fragment or credentials; the constructor throws on
anything else.

## The forms secret

The unsubscribe token is signed with the forms secret alone. Generate it with
`openssl rand -base64 32` and keep it in its own variable: never the mount's
Bearer token or the preview token's secret. `stet.config.json`'s
`formsSecretEnv` names the variable (default `STET_FORMS_SECRET`) and
`stet doctor` says whether your shell sets it. A token never expires, because
delivered email keeps it; rotating the secret therefore breaks every link
already delivered.

## The service role

The handler writes with the store's service credential, and that role must
bypass row level security or own the tables: every table carries row level
security with no policies, as migration 1's do. On a self-hosted Postgres:

```sql
create role stet_service nologin bypassrls;
```

Supabase's `service_role` already bypasses it.

The role also needs migration 3's grants. Migration 3 gives them to every role
that already held EXECUTE on `save_content_draft` by name when it was applied.
A role granted after that needs the four lines `stet upgrade` prints:

```sql
grant select, insert, update, delete on stet_groups, stet_contacts, stet_group_memberships, stet_suppressions, stet_erasures to <your service role>;
grant usage, select on sequence stet_contacts_id_seq, stet_group_memberships_id_seq to <your service role>;
grant execute on function stet_normal_email(text), stet_erasure_hash(text), stet_contact_id(text, text), stet_join_group(text, text, text, jsonb, text, text), stet_import_member(text, text, text, jsonb, text, timestamptz), stet_erase_contact(text, text), stet_group_add(text, text, text, jsonb), stet_group_state(text, text, text), stet_group_get(text, text), stet_group_list(text), stet_group_members(text, text, bigint, int), stet_contact_record(text, text), stet_suppression_counts() to <your service role>;
grant select on stet_meta to <your service role>;
```

## Importing an existing list

```bash
npx stet contacts import --group cloud-waitlist --file waitlist.csv --joined-at created_at
npx stet contacts import --group cloud-waitlist --file waitlist.csv --joined-at created_at --write
```

`import` reads a JSON array of objects or a CSV with a header row, checks each
row the way the join route does, names each invalid row by number, and plans
before it writes. `--joined-at` names the column holding each person's join
time, and the value must carry its zone (`Z` or an offset such as `+02:00`); a
value without one is refused for its row rather than read as this machine's
local time. A D1 export's `datetime()` column reads `2026-09-01 10:00:00` and
needs a `Z` appended. A date that does not exist (30 February) or a time still
to come is refused for its row too. Each membership records the file as its
form, `import:<file name>`, so a file name is at most 93 characters of letters,
digits and `. _ @ : -`; any other name is refused before a row is read. Addresses already in the group, erased or suppressed are
skipped when written, so a second run adds nothing.

## The tables and three queries

| Table | Holds |
|---|---|
| `stet_groups` | one row per group per project: key, name, `open` or `closed`, the ordered questions |
| `stet_contacts` | one row per address per project |
| `stet_group_memberships` | one row per person per group: the first join's `joined_at`, `form` and `page`, the latest answers |
| `stet_suppressions` | who not to mail, keyed `(email, scope)`, scope `marketing` or `transactional`, for every project in the store |
| `stet_erasures` | a salted one-way hash of each erased address |

Whether a person is subscribed is never stored: a marketing row in
`stet_suppressions` is the unsubscribe.

### A group's members

The members a marketing send may go to, in join order:

```sql
select c.email, m.joined_at, m.form, m.page, m.properties
  from stet_group_memberships m
  join stet_contacts c on c.id = m.contact_id
 where m.project = 'default' and m.group_key = 'cloud-waitlist'
   and not exists (select 1 from stet_suppressions s where s.email = c.email and s.scope = 'marketing')
 order by m.id;
```

### The suppressed addresses

```sql
select email, scope, source, created_at from stet_suppressions order by created_at;
```

### One person

Everything held about one address, as the one object `stet contacts export`
prints:

```sql
select stet_contact_record('default', 'ana@lightfield.co');
```

## An address's normal form in raw SQL

Every table stores an address trimmed and lowercased: JavaScript's `trim()`, then
`toLowerCase()`. The tables' CHECKs hold them to it through
`stet_normal_email()`, which gives the same string for every ASCII address and
leaves an address already in that form unchanged, so stet's own writes (which
normalise in JavaScript first) always pass.

Postgres lowercases one character at a time, so for raw non-ASCII input the two
differ. `ΟΔΟΣ@x.gr` becomes `οδος@x.gr` in JavaScript and `οδοσ@x.gr` in
Postgres (the final sigma), and `İ@x.tr` becomes `i̇@x.tr`, an `i` and a
combining dot, in JavaScript and `i@x.tr` in Postgres. A host writing raw SQL
therefore normalises the address in JavaScript with `trim().toLowerCase()`
before it reaches the database, and never uses its own `lower()` or
`stet_normal_email()` as the normaliser for raw input; `stet_normal_email()` then
leaves the address unchanged.

## What eject leaves

`stet eject` drops no table. The contacts tables stay in your database with the
people your form recorded, and the plan says so. To hand one person their
record before the dependency goes, run `stet contacts export <email>` first.
