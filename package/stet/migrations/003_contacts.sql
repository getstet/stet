-- stet migration 3 — contacts: groups, the people who join them, and who not
-- to mail.
--
-- Like 001 and 002, this file is copied as-is into every adopting project's
-- database, with no central place to fix a mistake in it. It is additive: 001
-- and 002 are frozen and never edited, and nothing here touches a table they
-- created except one added column on stet_meta.
--
-- The whole file is ONE transaction, with the version stamp as its last
-- statement: an apply that fails anywhere leaves schema_version 2 and no 003
-- schema. `psql -f` runs a file statement by statement with errors non-fatal
-- and would skip the failure and stamp anyway; inside a transaction that first
-- error aborts it and the closing commit rolls back instead.
--
-- Every name it creates — table, index, sequence, function — carries the
-- `stet_` prefix. This migration reaches every store-backed install, and a
-- host's own `contacts` or `email_suppressions` table (Mirra's database has the
-- second) would otherwise stop it at its first `create table`.
--
-- The rows are people. They never enter the committed snapshot or the git
-- mirror; a person is exported to a file with `stet contacts export`.
--
-- File order matters within it: the stet_meta column, the address's normal
-- form (the tables' checks call it), the tables and indexes, the functions (the
-- shared contact upsert first — join and import call it), the revokes, the
-- grant replay, row level security, and the stamp.

begin;

-- stet_meta is read by upgrade alone, so the rewrite this volatile default
-- causes is a one-row table's. The lock timeout keeps 002's posture anyway.
set local lock_timeout = '3s';

-- The salt for the erasure hashes: random per database, written once, never
-- read outside SQL. An erased address is recognised by an import without the
-- address itself staying in the database.
alter table stet_meta
  add column if not exists erasure_salt text not null default md5(random()::text || clock_timestamp()::text);

-- An address's normal form, the one every contacts table stores: trimmed of
-- the whitespace JavaScript's `trim()` removes, then lowercased — the same
-- string `normalEmail` in src/contacts.ts gives, so an address a host writes
-- through SQL and one the join route writes are one row. The class is spelled
-- out because Postgres's `\s` misses the no-break and ideographic spaces and
-- the BOM, which `trim()` removes.
create function stet_normal_email(p_email text)
returns text language sql immutable security invoker as $$
  select lower(regexp_replace(p_email,
    '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
    '', 'g'))
$$;

-- A group is enrolment: people join it through its form. `key` is URL-shaped
-- because it is the join route's last path segment. `properties` is the
-- ordered list of questions the form asks — an array, because JSONB does not
-- keep object key order and the declaration decides the form's order.
-- `state` carries no CHECK (002's posture): the join function refuses every
-- state but 'open', so an unknown state fails safe.
create table stet_groups (
  project     text not null default 'default',
  key         text not null check (key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name        text not null,
  state       text not null default 'open',          -- open | closed
  properties  jsonb not null default '[]'::jsonb check (jsonb_typeof(properties) = 'array'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (project, key)
);

-- The two id sequences are created by name rather than through `bigserial`:
-- a serial column picks a free name on a collision (`…_seq1`), and the revokes
-- and the grant replay below would then act on a host's sequence. Created by
-- name, a host sequence of that name stops the apply like any other object.
create sequence stet_contacts_id_seq;
create sequence stet_group_memberships_id_seq;

-- One row per person per project. The address is stored in its normal form,
-- and the CHECK makes that a property of the table rather than of every
-- writer. `updated_at` moves on every join and re-join.
create table stet_contacts (
  id          bigint primary key default nextval('stet_contacts_id_seq'),
  project     text not null default 'default',
  email       text not null check (email = stet_normal_email(email) and length(email) between 3 and 254
                                   and position('@' in email) > 1),
  properties  jsonb not null default '{}'::jsonb check (jsonb_typeof(properties) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project, email)
);

-- One row per person per group: the consent evidence. `joined_at`, `form` and
-- `page` record the first join and never move; `properties` holds the latest
-- answers, which a re-join replaces. `id` orders a group's members in join
-- order and is the members read's keyset cursor.
create table stet_group_memberships (
  id          bigint primary key default nextval('stet_group_memberships_id_seq'),
  contact_id  bigint not null references stet_contacts (id) on delete cascade,
  project     text not null,
  group_key   text not null,
  joined_at   timestamptz not null default now(),
  form        text check (form is null or length(form) <= 100),
  page        text check (page is null or length(page) <= 2000),
  properties  jsonb not null default '{}'::jsonb check (jsonb_typeof(properties) = 'object'),
  updated_at  timestamptz not null default now(),
  unique (contact_id, group_key),
  foreign key (project, group_key) references stet_groups (project, key) on delete restrict
);
-- Owned by their columns, as a serial's sequence is: dropping the table drops it.
alter sequence stet_contacts_id_seq owned by stet_contacts.id;
alter sequence stet_group_memberships_id_seq owned by stet_group_memberships.id;

-- Postgres indexes the referenced side of a foreign key and never the
-- referencing side: without this every members read and every group delete
-- check is a sequential scan.
create index stet_group_memberships_group_idx on stet_group_memberships (project, group_key, id);

-- Who not to mail, keyed (email, scope) and store-wide: an unsubscribe from one
-- app in a shared store suppresses the address for every app in it. Leaving a
-- newsletter (marketing) never blocks a password reset (transactional).
create table stet_suppressions (
  email       text not null check (email = stet_normal_email(email) and length(email) between 3 and 254),
  scope       text not null check (scope in ('transactional', 'marketing')),
  source      text not null,                        -- one-click | page | operator | …
  created_at  timestamptz not null default now(),
  primary key (email, scope)
);

-- An erased person, as a salted one-way hash of the address: an import skips
-- it, and the address itself is gone.
create table stet_erasures (
  project     text not null,
  email_hash  text not null,
  erased_at   timestamptz not null default now(),
  primary key (project, email_hash)
);

-- ---------------------------------------------------------------------------
-- The functions. Every write of more than one row is one of these, because
-- PostgREST gives each request its own transaction and a join is two writes; a
-- suppression is one row, which both adapters upsert directly into
-- stet_suppressions. The reads are functions too, so the pg and PostgREST
-- adapters call one implementation. All are security invoker, like 001's, so
-- none needs a grant a table write would not. Each is a plain `create
-- function`: a host function of the same name and arguments stops the apply
-- by name, and is never replaced.
-- ---------------------------------------------------------------------------

-- The erasure hash, in one place: import and erase both compute it.
create function stet_erasure_hash(p_email text)
returns text language sql stable security invoker as $$
  select encode(sha256(convert_to((select erasure_salt from stet_meta where id = 1) || stet_normal_email(p_email), 'UTF8')), 'hex')
$$;

-- The contact row for an address, created on first sight. Insert-then-select
-- is race-safe under READ COMMITTED: a concurrent first insert of the same
-- address makes this insert wait, then do nothing, and the select's fresh
-- snapshot sees the committed row. An erase committing between the two finds
-- the select empty: the loop tries once more, and a second miss raises
-- `contact_vanished:`, which the join route answers as a store failure.
create function stet_contact_id(p_project text, p_email text)
returns bigint language plpgsql security invoker as $$
declare
  v_email text := stet_normal_email(p_email);
  v_id    bigint;
begin
  for attempt in 1..2 loop
    insert into stet_contacts (project, email) values (p_project, v_email)
    on conflict (project, email) do nothing
    returning id into v_id;
    if v_id is null then
      update stet_contacts set updated_at = now()
       where project = p_project and email = v_email
      returning id into v_id;
    end if;
    if v_id is not null then return v_id; end if;
  end loop;
  raise exception 'contact_vanished:%', v_email;
end $$;

-- A join. The group is locked FOR SHARE, so a close cannot interleave with the
-- insert; an unknown group and a closed one raise their markers. A re-join
-- replaces the answers and keeps the first join's time, form and page, which
-- the answer carries, so `onJoin` reports the stored consent evidence. A join
-- never lifts a suppression.
create function stet_join_group(p_project text, p_group text, p_email text,
    p_properties jsonb default '{}'::jsonb, p_form text default null, p_page text default null)
returns jsonb language plpgsql security invoker as $$
declare
  v_state   text;
  v_contact bigint;
  v_joined  timestamptz;
  v_form    text;
  v_page    text;
  v_new     boolean;
begin
  select state into v_state from stet_groups where project = p_project and key = p_group for share;
  if v_state is null then raise exception 'unknown_group:%', p_group; end if;
  if v_state <> 'open' then raise exception 'group_closed:%', p_group; end if;

  v_contact := stet_contact_id(p_project, p_email);

  -- One upsert: `xmax = 0` holds only for a row this statement inserted, so a
  -- re-join reads false. The conflict branch moves the answers and nothing
  -- else; joined_at, form and page stay the first join's.
  insert into stet_group_memberships (contact_id, project, group_key, form, page, properties)
  values (v_contact, p_project, p_group, p_form, p_page, coalesce(p_properties, '{}'::jsonb))
  on conflict (contact_id, group_key) do update
     set properties = excluded.properties, updated_at = now()
  returning joined_at, form, page, (xmax = 0) into v_joined, v_form, v_page, v_new;

  return jsonb_build_object(
    'contact_id', v_contact,
    'is_new', v_new,
    'suppressed', exists (select 1 from stet_suppressions
                           where email = stet_normal_email(p_email) and scope = 'marketing'),
    'joined_at', v_joined,
    'form', v_form,
    'page', v_page);
end $$;

-- An imported member. An address already in the group, erased, or suppressed
-- for marketing is skipped and counted; a closed group still takes an import
-- (the operator's own act). The outcome is one word.
create function stet_import_member(p_project text, p_group text, p_email text,
    p_properties jsonb, p_form text, p_joined_at timestamptz default null)
returns text language plpgsql security invoker as $$
declare
  v_contact bigint;
  v_done    boolean;
begin
  perform 1 from stet_groups where project = p_project and key = p_group for share;
  if not found then raise exception 'unknown_group:%', p_group; end if;
  if exists (select 1 from stet_erasures
              where project = p_project and email_hash = stet_erasure_hash(p_email)) then
    return 'erased';
  end if;
  if exists (select 1 from stet_suppressions
              where email = stet_normal_email(p_email) and scope = 'marketing') then
    return 'suppressed';
  end if;
  v_contact := stet_contact_id(p_project, p_email);
  insert into stet_group_memberships (contact_id, project, group_key, joined_at, form, properties)
  values (v_contact, p_project, p_group, coalesce(p_joined_at, now()), p_form, coalesce(p_properties, '{}'::jsonb))
  on conflict (contact_id, group_key) do nothing
  returning true into v_done;
  return case when v_done then 'joined' else 'present' end;
end $$;

-- A suppression. True when this call wrote it; false when the address was
-- already suppressed in this scope, which a second one-click POST reaches.
-- An erasure: the contact and its memberships go, the hash stays, and any
-- suppression row stays — it is the record of their objection and keeps them
-- unmailed. The hash is written whether or not a contact existed, so an import
-- skips an address erased before it was ever imported.
create function stet_erase_contact(p_project text, p_email text)
returns jsonb language plpgsql security invoker as $$
declare
  v_id    bigint;
  v_count int := 0;
begin
  select id into v_id from stet_contacts where project = p_project and email = stet_normal_email(p_email);
  if v_id is not null then
    select count(*) into v_count from stet_group_memberships where contact_id = v_id;
    delete from stet_contacts where id = v_id;  -- memberships cascade
  end if;
  insert into stet_erasures (project, email_hash) values (p_project, stet_erasure_hash(p_email))
  on conflict (project, email_hash) do nothing;
  return jsonb_build_object('existed', v_id is not null, 'memberships', v_count);
end $$;

create function stet_group_add(p_project text, p_key text, p_name text,
    p_properties jsonb default '[]'::jsonb)
returns void language plpgsql security invoker as $$
begin
  insert into stet_groups (project, key, name, properties)
  values (p_project, p_key, p_name, coalesce(p_properties, '[]'::jsonb));
exception when unique_violation then
  raise exception 'group_exists:%', p_key;
end $$;

create function stet_group_state(p_project text, p_key text, p_state text)
returns void language plpgsql security invoker as $$
begin
  if p_state not in ('open', 'closed') then raise exception 'group state must be open or closed: %', p_state; end if;
  update stet_groups set state = p_state, updated_at = now() where project = p_project and key = p_key;
  if not found then raise exception 'unknown_group:%', p_key; end if;
end $$;

-- ── Reads ──────────────────────────────────────────────────────────────────

-- One group by key, and no member count: the join route reads this on every
-- submission, and a count would scan the group's memberships each time. No
-- row for a key the project does not have.
create function stet_group_get(p_project text, p_key text)
returns table (key text, name text, state text, properties jsonb, created_at timestamptz)
language sql stable security invoker as $$
  select g.key, g.name, g.state, g.properties, g.created_at
    from stet_groups g
   where g.project = p_project and g.key = p_key
$$;

create function stet_group_list(p_project text)
returns table (key text, name text, state text, properties jsonb, created_at timestamptz, members bigint)
language sql stable security invoker as $$
  select g.key, g.name, g.state, g.properties, g.created_at,
         (select count(*) from stet_group_memberships m where m.project = g.project and m.group_key = g.key)
    from stet_groups g
   where g.project = p_project
   order by g.created_at, g.key
$$;

-- One group's members in join order, keyset-paged by the membership id
-- (`p_after_id` exclusive), never by offset. `suppressed` is computed here, so
-- no stored status can disagree with the suppression table.
create function stet_group_members(p_project text, p_group text,
    p_after_id bigint default 0, p_limit int default 50)
returns table (id bigint, contact_id bigint, email text, joined_at timestamptz, form text, page text,
               properties jsonb, updated_at timestamptz, suppressed boolean)
language plpgsql stable security invoker as $$
#variable_conflict use_column
begin
  if not exists (select 1 from stet_groups g where g.project = p_project and g.key = p_group) then
    raise exception 'unknown_group:%', p_group;
  end if;
  return query
  select m.id, c.id, c.email, m.joined_at, m.form, m.page, m.properties, m.updated_at,
         exists (select 1 from stet_suppressions s where s.email = c.email and s.scope = 'marketing')
    from stet_group_memberships m
    join stet_contacts c on c.id = m.contact_id
   where m.project = p_project and m.group_key = p_group and m.id > coalesce(p_after_id, 0)
   order by m.id
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
end
$$;

-- Everything held about one address, or null when nothing is: the contact row,
-- its memberships, and its suppressions (which exist without a contact row).
create function stet_contact_record(p_project text, p_email text)
returns jsonb language sql stable security invoker as $$
  with c as (select * from stet_contacts where project = p_project and email = stet_normal_email(p_email)),
       s as (select * from stet_suppressions where email = stet_normal_email(p_email))
  select case when not exists (select 1 from c) and not exists (select 1 from s) then null else
    jsonb_build_object(
      'email', stet_normal_email(p_email),
      'contact', (select jsonb_build_object('id', id, 'properties', properties,
                                            'created_at', created_at, 'updated_at', updated_at) from c),
      'memberships', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', m.id, 'group', m.group_key, 'joined_at', m.joined_at, 'form', m.form,
                         'page', m.page, 'properties', m.properties, 'updated_at', m.updated_at) order by m.id)
                       from stet_group_memberships m join c on c.id = m.contact_id), '[]'::jsonb),
      'suppressions', coalesce((select jsonb_agg(jsonb_build_object(
                         'scope', scope, 'source', source, 'created_at', created_at) order by scope) from s),
                       '[]'::jsonb))
  end
$$;

create function stet_suppression_counts()
returns table (scope text, source text, n bigint)
language sql stable security invoker as $$
  select scope, source, count(*) from stet_suppressions group by scope, source order by scope, source
$$;

-- ---------------------------------------------------------------------------
-- Grants, as 001 writes them: no end-user access, service credentials only,
-- the Supabase roles guarded because a vanilla Postgres has neither and REVOKE
-- from a missing role is a hard error. Every function named once, with its
-- full argument list: the revokes and the replay both read `fns`.
--
-- The replay, 002's idiom: a service role 001's comment tells a self-hosted
-- deployment to grant BY NAME holds EXECUTE on save_content_draft, and nothing
-- 003 creates reaches it by default. Every such role gets what a join, an
-- import, an erase and the reads need — the functions, the five tables, the
-- two sequences, and SELECT on stet_meta, whose salt the erasure hash reads —
-- so a working install keeps working after the upgrade. A role that bypasses
-- row level security or owns the tables is what the service credential must be
-- (001's RLS comment); the replay grants privileges, never that. Supabase's
-- service_role holds its grants by default privileges, and a deployment that
-- granted nothing replays nothing.
-- ---------------------------------------------------------------------------

do $$
declare
  g      record;
  fns    text := 'stet_normal_email(text), stet_erasure_hash(text), stet_contact_id(text, text), '
    || 'stet_join_group(text, text, text, jsonb, text, text), '
    || 'stet_import_member(text, text, text, jsonb, text, timestamptz), '
    || 'stet_erase_contact(text, text), stet_group_add(text, text, text, jsonb), '
    || 'stet_group_state(text, text, text), stet_group_get(text, text), stet_group_list(text), '
    || 'stet_group_members(text, text, bigint, int), stet_contact_record(text, text), stet_suppression_counts()';
  tables text := 'stet_groups, stet_contacts, stet_group_memberships, stet_suppressions, stet_erasures';
  seqs   text := 'stet_contacts_id_seq, stet_group_memberships_id_seq';
begin
  execute 'revoke execute on function ' || fns || ' from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on ' || tables || ' from anon';
    execute 'revoke all on sequence ' || seqs || ' from anon';
    execute 'revoke execute on function ' || fns || ' from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on ' || tables || ' from authenticated';
    execute 'revoke all on sequence ' || seqs || ' from authenticated';
    execute 'revoke execute on function ' || fns || ' from authenticated';
  end if;

  for g in
    select distinct grantee
      from information_schema.routine_privileges
     where specific_schema = current_schema()
       and routine_name = 'save_content_draft'
       and privilege_type = 'EXECUTE'
       and grantee not in ('PUBLIC', current_user)
  loop
    execute format('grant execute on function %s to %I', fns, g.grantee);
    execute format('grant select, insert, update, delete on %s to %I', tables, g.grantee);
    execute format('grant usage, select on sequence %s to %I', seqs, g.grantee);
    execute format('grant select on stet_meta to %I', g.grantee);
  end loop;
end $$;

-- deny-by-default regardless of role NAME, exactly as 001's tables carry it.
alter table stet_groups enable row level security;
alter table stet_contacts enable row level security;
alter table stet_group_memberships enable row level security;
alter table stet_suppressions enable row level security;
alter table stet_erasures enable row level security;

-- The version stamp is the transaction's last statement: a failed apply leaves
-- a database still reading schema_version 2, never one claiming migration 3.
update stet_meta set schema_version = 3, updated_at = now() where id = 1;

commit;

-- After applying through a transport that caches the schema (PostgREST):
--   notify pgrst, 'reload schema';
