-- stet migration 1 — the content store.
--
-- This file is copied as-is into every adopting project's database. There is no
-- central place to fix a mistake here, so the columns that cannot be retrofitted
-- (project, locale, publish_at, origin_env, origin_id, published_by,
-- reverted_from) ship now even where the first install does not use them.
--
-- The whole file is ONE transaction, with the version stamp as its last
-- statement: an apply that fails anywhere leaves nothing behind — no half
-- schema, no stamp claiming a migration that never finished. Position alone is
-- not enough, because `psql -f` runs a file statement by statement with errors
-- non-fatal and would skip the failure and stamp anyway; inside a transaction
-- that first error aborts it, every later statement fails with "current
-- transaction is aborted", and the closing commit rolls back instead.
--
-- Apply paths that send the file as a single query (node-pg, the Supabase SQL
-- editor and Management API) already run one implicit transaction, so the
-- explicit pair is redundant there and may log "there is already a transaction
-- in progress". Harmless, and the price of one file that is safe in every mode.
--
-- File order matters within it: tables and indexes, then the four functions,
-- then the revokes and row level security, then the stamp. Revoking EXECUTE on
-- a function that does not exist yet is an error.
--
-- After applying through a transport that caches the schema (PostgREST):
--   notify pgrst, 'reload schema';

begin;

create table content_versions (
  id           bigserial primary key,    -- identity AND sort order; gaps are normal
  project      text not null default 'default',  -- part of key identity
  key          text not null,            -- descriptor key; not FK'd — the descriptor is the key list
  locale       text not null default 'default',  -- part of key identity
  target       text not null,            -- 'web' | 'html-email' | 'telegram-md2'; shape lives in the descriptor
  value        jsonb not null,           -- text | list | slots record | richtext …
  state        text not null check (state in ('draft','published')),
  is_active    boolean not null default false,
  publish_at   timestamptz,              -- null = publish now; set = the scheduled stamp
  label        text,                     -- short human name
  note         text,                     -- copy reasoning — the operator's "why"
  editor       text,                     -- the draft author; publish never overwrites it
  origin_env   text,                     -- set by promote: where this value came from
  origin_id    bigint,                   -- set by promote: the source version id
  published_by text,                     -- stamped by publish: who made it live
  reverted_from bigint,                  -- set by revert: the version id this row restored
  created_at   timestamptz not null default now(),
  published_at timestamptz               -- stamped by publish; created_at is never overwritten
);

-- target carries no CHECK on purpose: a CHECK would turn every new target into
-- a migration, and the descriptor is authoritative for shape either way.

-- exactly one live version per key, per locale, per project
create unique index content_versions_one_active
  on content_versions (project, key, locale) where is_active;
-- exactly one working draft per key, per locale, per project
create unique index content_versions_one_draft
  on content_versions (project, key, locale) where state = 'draft';
-- history reads + the site-wide recent-publishes log (keyset-paged by id — never offset)
create index content_versions_history on content_versions (project, key, locale, id desc);
-- project-leading, so a quiet project's recent page reads its own rows rather
-- than walking every publish in the store
create index content_versions_recent
  on content_versions (project, id desc) where state = 'published';
-- the scheduler's only query
create index content_versions_due
  on content_versions (publish_at) where state = 'draft' and publish_at is not null;

-- rename audit: key is identity metadata a recorded rename may rewrite; values and ids never change
create table stet_renames (
  id          bigserial primary key,
  project     text not null default 'default',
  old_key     text not null,
  new_key     text not null,
  editor      text,
  renamed_at  timestamptz not null default now()
);

-- what version of stet wrote this database
create table stet_meta (
  id                 int primary key default 1 check (id = 1),
  schema_version     int not null,       -- the package migration counter (numbered migrations)
  descriptor_version text not null,      -- versioned independently of the package
  installed_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The four write paths. Each is one transaction, because the reference
-- transport wraps every request in its own — two writes would leave a key with
-- zero live versions and the site silently serving the snapshot while the
-- operator sees success. Security invoker by design, never definer.
--
-- `create or replace`, so re-applying this file over a partial apply is a
-- repair rather than a pile of "already exists" errors.
-- ---------------------------------------------------------------------------

create or replace function publish_content_version(p_key text, p_editor text,
    p_locale text default 'default', p_project text default 'default')
returns bigint language plpgsql security invoker as $$
declare v_id bigint;
begin
  update content_versions set is_active = false
   where project = p_project and key = p_key and locale = p_locale and is_active;
  -- editor is never touched: it stays the draft's author, and published_by
  -- records who made it live, so history answers both questions separately.
  update content_versions
     set state = 'published', is_active = true, published_by = p_editor,
         publish_at = null, published_at = now()
   where project = p_project and key = p_key and locale = p_locale and state = 'draft'
   returning id into v_id;
  if v_id is null then raise exception 'no_draft:% (%)', p_key, p_locale; end if;
  return v_id;
exception when unique_violation then
  -- A concurrent revert or publish minted this key's active row between the
  -- clear and the flip. The draft was not consumed, so a caller may retry.
  raise exception 'publish_conflict:%', p_key;
end $$;

-- The upsert lives in SQL because a partial unique index cannot ride
-- PostgREST's on_conflict: Postgres will not infer a partial index without its
-- predicate, so the reference install's very first save would error.
create or replace function save_content_draft(p_key text, p_value jsonb, p_target text, p_editor text,
    p_locale text default 'default', p_project text default 'default',
    p_label text default null, p_note text default null,
    p_publish_at timestamptz default null, p_force boolean default false)
returns bigint language plpgsql security invoker as $$
declare
  v_id         bigint;
  v_editor     text;
  v_created    timestamptz;
  v_constraint text;
begin
  select id, editor, created_at into v_id, v_editor, v_created
    from content_versions
   where project = p_project and key = p_key and locale = p_locale and state = 'draft'
     for update;

  if found then
    -- The draft is someone's work in progress. An agent proposal never sets
    -- p_force, so it is refused and reported rather than silently swallowing
    -- a human's unpublished wording.
    if v_editor is distinct from p_editor and not p_force then
      raise exception 'draft_held:%', json_build_object(
        'editor', coalesce(v_editor, ''),
        'heldSince', to_char(v_created at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )::text;
    end if;
    -- The draft row is the full draft state, not a patch: an omitted label or
    -- note clears a previously set one. created_at stays the row's birth time.
    update content_versions
       set value = p_value, target = p_target, editor = p_editor,
           label = p_label, note = p_note, publish_at = p_publish_at
     where id = v_id;
    return v_id;
  end if;

  begin
    insert into content_versions (project, key, locale, target, value, state,
                                  editor, label, note, publish_at)
    values (p_project, p_key, p_locale, p_target, p_value, 'draft',
            p_editor, p_label, p_note, p_publish_at)
    returning id into v_id;
  exception when unique_violation then
    -- Only the draft index is a race between two first-saves. Surfaced, never
    -- retried: a retried write that actually landed would duplicate the row.
    -- Any other constraint is a different failure and travels unmasked.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'content_versions_one_draft' then
      raise exception 'concurrent_save:%', p_key;
    end if;
    raise;
  end;
  return v_id;
end $$;

-- Revert never touches the draft row. Copying the old value into the draft and
-- publishing it would destroy an in-progress draft, and a failed publish leg
-- would lose the operator's unpublished wording with nothing recording it.
create or replace function revert_content_version(p_version_id bigint, p_editor text,
    p_project text default 'default')
returns bigint language plpgsql security invoker as $$
declare
  v_src content_versions%rowtype;
  v_id  bigint;
begin
  select * into v_src from content_versions where id = p_version_id;
  if not found then raise exception 'no_version:%', p_version_id; end if;
  -- Version ids are global across projects; this is the one write that would
  -- otherwise reach across them.
  if v_src.project is distinct from p_project then
    raise exception 'wrong_project:% (version % belongs to project %)',
      p_project, p_version_id, v_src.project;
  end if;
  if v_src.state is distinct from 'published' then
    raise exception 'not_published:%', p_version_id;
  end if;

  update content_versions set is_active = false
   where project = v_src.project and key = v_src.key and locale = v_src.locale and is_active;

  -- reverted_from is revert's provenance the way origin_* is promote's: without
  -- it a revert row is indistinguishable from a coincidental re-entry of an
  -- old value. published_by is stamped here as it is at publish — every row
  -- made live records who made it live.
  insert into content_versions (project, key, locale, target, value, state, is_active,
                                editor, published_by, published_at, reverted_from)
  values (v_src.project, v_src.key, v_src.locale, v_src.target, v_src.value, 'published', true,
          p_editor, p_editor, now(), p_version_id)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  -- A concurrent publish minted the active row first. Nothing was consumed.
  raise exception 'publish_conflict:%', v_src.key;
end $$;

-- A key renames whole — across every locale at once, since the descriptor
-- declares keys locale-neutrally. Values and ids never change.
create or replace function rename_content_key(p_old_key text, p_new_key text, p_editor text,
    p_project text default 'default')
returns void language plpgsql security invoker as $$
begin
  -- Renames serialize per project×target. A row lock cannot serialize a target
  -- that has no rows yet, and the partial unique indexes never fire when the
  -- two sources contribute different row classes (one draft-only, one
  -- published-only), so two concurrent renames onto one key would both pass an
  -- unlocked guard and merge two histories. The lock is transaction-scoped and
  -- releases itself at commit or rollback.
  perform pg_advisory_xact_lock(hashtext(p_project), hashtext(p_new_key));
  -- Merging histories is not a thing rename does.
  if exists (select 1 from content_versions where project = p_project and key = p_new_key) then
    raise exception 'target_occupied:%', p_new_key;
  end if;
  update content_versions set key = p_new_key
   where project = p_project and key = p_old_key;
  -- A p_old_key with zero rows is a no-op that still writes the record:
  -- snapshot-only keys have no rows, and the audit is what keeps them linked.
  insert into stet_renames (project, old_key, new_key, editor)
  values (p_project, p_old_key, p_new_key, p_editor);
end $$;

-- ---------------------------------------------------------------------------
-- Grants are written, not argued: this migration is copied into databases whose
-- defaults are not ours. Supabase grants to anon AND authenticated; Postgres
-- grants EXECUTE on new functions to PUBLIC. No end-user access; service
-- credentials only. The Supabase roles are guarded — a vanilla Postgres (Neon,
-- RDS, a local container) has neither, and REVOKE from a missing role is a hard
-- error, not a notice. Every function is named with its full argument list, so
-- the day an overload lands the revoke still names the function it meant.
-- ---------------------------------------------------------------------------

revoke execute on function
  publish_content_version(text, text, text, text),
  save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean),
  revert_content_version(bigint, text, text),
  rename_content_key(text, text, text, text)
from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on content_versions, stet_renames, stet_meta from anon';
    execute 'revoke execute on function publish_content_version(text, text, text, text), save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean), revert_content_version(bigint, text, text), rename_content_key(text, text, text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on content_versions, stet_renames, stet_meta from authenticated';
    execute 'revoke execute on function publish_content_version(text, text, text, text), save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean), revert_content_version(bigint, text, text), rename_content_key(text, text, text, text) from authenticated';
  end if;
end $$;

-- deny-by-default regardless of role NAME: the guarded revokes above only know
-- Supabase's names, and a self-hosted PostgREST's anonymous role (the tutorial's
-- web_anon) would otherwise keep default-granted access with nothing behind it.
-- Bypassed by the table owner and BYPASSRLS roles (Supabase's service_role), so
-- service writes are unaffected; a self-hosted service role that is neither
-- fails loudly at install — loud beats silently exposed.
alter table content_versions enable row level security;
alter table stet_renames enable row level security;
alter table stet_meta enable row level security;

-- The version stamp is the transaction's last statement, and nothing above it
-- survives a failed apply: what a failure leaves behind is an unversioned
-- database, never one claiming migration 1.
-- A static file copied into a stranger's repo cannot know the project's
-- descriptor version: '' means not yet stamped, and `stet upgrade`/`seed` stamp it.
insert into stet_meta (id, schema_version, descriptor_version)
values (1, 1, '')
on conflict (id) do nothing;

commit;
