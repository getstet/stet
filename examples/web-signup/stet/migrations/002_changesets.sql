-- stet migration 2 — changesets: the opt-in grouping of drafts.
--
-- Like 001, this file is copied as-is into every adopting project's database,
-- with no central place to fix a mistake in it. It is additive: 001 is frozen
-- and never edited, and everything here either creates something new or
-- re-ships a function 001 already defined.
--
-- The whole file is ONE transaction, with the version stamp as its last
-- statement: an apply that fails anywhere leaves schema_version 1 and no 002
-- schema. `psql -f` runs a file statement by statement with errors non-fatal
-- and would skip the failure and stamp anyway; inside a transaction that first
-- error aborts it and the closing commit rolls back instead.
--
-- Two functions change signature, and a signature change must DROP before it
-- creates. `create or replace` with a new trailing parameter does not replace —
-- it mints an overload beside the old function, and every legacy call omitting
-- the new argument then matches both, failing with "function is not unique".
-- DROP+CREATE resets the function's ACL, so everything dropped here has its
-- revokes re-run below; `publish_content_version` keeps its 001 signature, is
-- re-shipped by `create or replace`, retains its 001 ACL, and therefore appears
-- in no revoke list — as does 001's untouched `rename_content_key`.
--
-- File order matters within it: the table, column and indexes, then the
-- functions (the shared flip core first — the two publish paths call it), then
-- the grant capture, the DROPs and CREATEs, the revokes, the grant replay, row
-- level security, and the stamp. Revoking EXECUTE on a function that does not
-- exist yet is an error, and a grant can only be captured before the drop that
-- erases it.

begin;

-- 002 is the first migration to ALTER a table carrying live traffic. The ADD
-- COLUMN needs ACCESS EXCLUSIVE, and while that request queues behind an open
-- transaction, every later reader queues behind IT — a slow apply takes the
-- site's reads down with it. Fail the apply fast instead, into the documented
-- failure mode above: schema_version stays 1 and no 002 schema exists, so the
-- operator re-runs it when the table is quiet.
set local lock_timeout = '3s';

create table changesets (
  id          bigserial primary key,
  project     text not null default 'default',  -- an empty change cannot derive it from members
  name        text not null,
  note        text,
  status      text not null default 'open',     -- 'open' | 'scheduled' | 'published'; no CHECK — publish_change guards transitions
  author_kind text not null default 'human',    -- 'human' | 'agent'; no CHECK — policy surfaces may grow kinds
  publish_at  timestamptz,                      -- the change's shared schedule stamp
  created_at  timestamptz not null default now(),
  reverted_at timestamptz                       -- the group-revert event stamp
);

-- Membership IS this column: no member table, no join rows. Nullable and un-FK'd
-- (001's posture) — a published change's row is never deleted, and abandon
-- deletes the member drafts before the row.
alter table content_versions add column changeset_id bigint;  -- nullable; no FK (001's posture)

create index content_versions_change
  on content_versions (changeset_id) where changeset_id is not null;
create index changesets_project on changesets (project, id desc);

-- ---------------------------------------------------------------------------
-- The clear+flip core both publish paths share. They differ in exactly one
-- thing, deliberately: a solo publish CLEARS changeset_id (a published row must
-- never stay tagged to a change that never published), while the group flip
-- KEEPS it — the minted row is the group's marker, and it is what the
-- before-state derivation, the group revert's guard and the grouped history all
-- read. Unifying the two flips would silently break group revert.
-- ---------------------------------------------------------------------------

create or replace function stet_publish_flip(p_project text, p_key text, p_locale text,
    p_editor text, p_keep_change boolean)
returns bigint language plpgsql security invoker as $$
declare v_id bigint;
begin
  update content_versions set is_active = false
   where project = p_project and key = p_key and locale = p_locale and is_active;
  update content_versions
     set state = 'published', is_active = true, published_by = p_editor,
         publish_at = null, published_at = now(),
         changeset_id = case when p_keep_change then changeset_id else null end
   where project = p_project and key = p_key and locale = p_locale and state = 'draft'
   returning id into v_id;
  if v_id is null then raise exception 'no_draft:% (%)', p_key, p_locale; end if;
  return v_id;
end $$;

-- Same signature as 001's, so this is a true replace: the ACL survives and the
-- revokes below do not name it. The unique_violation catch stays here rather
-- than in the shared core, so each caller names the key it was flipping.
create or replace function publish_content_version(p_key text, p_editor text,
    p_locale text default 'default', p_project text default 'default')
returns bigint language plpgsql security invoker as $$
begin
  return stet_publish_flip(p_project, p_key, p_locale, p_editor, false);
exception when unique_violation then
  raise exception 'publish_conflict:%', p_key;
end $$;

-- The atomic group flip. All-or-nothing: a half-published group is as
-- unobservable as the zero-active state a single publish forbids.
create or replace function publish_change(p_change bigint, p_editor text,
    p_project text default 'default')
returns table (o_key text, o_locale text, o_version_id bigint)
language plpgsql security invoker as $$
declare
  v_change changesets%rowtype;
  m record;
  v_flipped int := 0;
begin
  select * into v_change from changesets where id = p_change for update;
  if not found then raise exception 'no_change:%', p_change; end if;
  if v_change.project is distinct from p_project then
    raise exception 'wrong_project:% (change % belongs to project %)',
      p_project, p_change, v_change.project;
  end if;
  if v_change.status not in ('open', 'scheduled') then
    raise exception 'change_closed:%', p_change;
  end if;
  -- Decided before any flip: publishing a change requires at least one member,
  -- even though an open change may hold zero.
  if not exists (select 1 from content_versions
                  where changeset_id = p_change and state = 'draft' and project = p_project) then
    raise exception 'no_members:%', p_change;
  end if;
  for m in
    select key, locale from content_versions
     where changeset_id = p_change and state = 'draft' and project = p_project
     order by id
     for update
  loop
    begin
      o_key := m.key; o_locale := m.locale;
      o_version_id := stet_publish_flip(p_project, m.key, m.locale, p_editor, true);
      v_flipped := v_flipped + 1;
      return next;
    exception when unique_violation then
      raise exception 'publish_conflict:%', m.key;
    end;
  end loop;
  -- The exists pre-check is the fast path; this count is the truth under
  -- concurrency: if every member was solo-published between the check and the
  -- loop (the FOR UPDATE re-evaluation drops them — they left the group), the
  -- change must not read published having flipped nothing.
  if v_flipped = 0 then
    raise exception 'no_members:%', p_change;
  end if;
  update changesets set status = 'published', publish_at = null where id = p_change;
end $$;

-- Captured BEFORE any drop, because DROP resets a function's ACL: an EXECUTE
-- grant a deployment made BY NAME — 001's own idiom for a self-hosted role —
-- would otherwise vanish silently and the role's writes would start failing
-- with a bare permission error. `publish_content_version` is captured too even
-- though its own ACL survives: its body now calls stet_publish_flip, and a
-- `security invoker` caller needs EXECUTE on the callee as well, so its
-- grantees need the helper. Replayed after the revoke block, which would
-- otherwise undo it. A deployment that granted nothing captures nothing and
-- replays nothing.
create temp table stet_002_grants on commit drop as
  select distinct routine_name, grantee
    from information_schema.routine_privileges
   where specific_schema = current_schema()
     and routine_name in ('save_content_draft', 'revert_content_version', 'publish_content_version')
     and privilege_type = 'EXECUTE'
     and grantee not in ('PUBLIC', current_user);

-- Signature change: p_expect_active is new, so the 001 form is dropped by its
-- exact argument list before the new one is created.
drop function if exists revert_content_version(bigint, text, text);

create or replace function revert_content_version(p_version_id bigint, p_editor text,
    p_project text default 'default', p_expect_active bigint default null)
returns bigint language plpgsql security invoker as $$
declare
  v_src content_versions%rowtype;
  v_id bigint;
  v_cleared int;
begin
  select * into v_src from content_versions where id = p_version_id;
  if not found then raise exception 'no_version:%', p_version_id; end if;
  if v_src.project is distinct from p_project then
    raise exception 'wrong_project:% (version % belongs to project %)',
      p_project, p_version_id, v_src.project;
  end if;
  if v_src.state is distinct from 'published' then
    raise exception 'not_published:%', p_version_id;
  end if;

  -- The group revert's fail-safe guard, enforced inside the write: the expected
  -- id is the deactivating update's OWN predicate, and zero affected rows means
  -- the active row has moved. A separate check-then-update still races under
  -- READ COMMITTED, so the skip rides in the write, never in the caller.
  update content_versions set is_active = false
   where project = v_src.project and key = v_src.key and locale = v_src.locale and is_active
     and (p_expect_active is null or id = p_expect_active);
  get diagnostics v_cleared = row_count;
  if p_expect_active is not null and v_cleared = 0 then
    raise exception 'stale_active:% (expected active %, it has moved)', v_src.key, p_expect_active;
  end if;

  -- A revert row belongs to no group: changeset_id, publish_at, origin_*, label
  -- and note are not copied. reverted_from and the change's own reverted_at
  -- carry the provenance.
  insert into content_versions (project, key, locale, target, value, state, is_active,
                                editor, published_by, published_at, reverted_from)
  values (v_src.project, v_src.key, v_src.locale, v_src.target, v_src.value, 'published', true,
          p_editor, p_editor, now(), p_version_id)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'publish_conflict:%', v_src.key;
end $$;

-- Signature change: p_change is new, so the 001 form goes first, by its exact
-- argument list.
drop function if exists save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean);

create or replace function save_content_draft(p_key text, p_value jsonb, p_target text, p_editor text,
    p_locale text default 'default', p_project text default 'default',
    p_label text default null, p_note text default null,
    p_publish_at timestamptz default null, p_force boolean default false,
    p_change bigint default -1)
returns bigint language plpgsql security invoker as $$
declare
  v_id         bigint;
  v_editor     text;
  v_created    timestamptz;
  v_member     bigint;
  v_change_row changesets%rowtype;
  v_effective  bigint;
  v_publish_at timestamptz;
  v_constraint text;
begin
  -- p_change: -1 (the default) leaves membership unchanged; null detaches; ANY
  -- other value is an attach and is validated below — 0 and negatives fall
  -- through to the no_change raise (ids start at 1), so no unvalidated value
  -- can ever reach changeset_id. SQL cannot tell an omitted argument from an
  -- explicit null, so the sentinel carries "absent".
  if p_change is not null and p_change <> -1 then
    select * into v_change_row from changesets where id = p_change for update;
    if not found then raise exception 'no_change:%', p_change; end if;
    if v_change_row.project is distinct from p_project then
      raise exception 'wrong_project:% (change % belongs to project %)',
        p_project, p_change, v_change_row.project;
    end if;
    if v_change_row.status not in ('open', 'scheduled') then
      raise exception 'change_closed:%', p_change;
    end if;
  end if;

  select id, editor, created_at, changeset_id into v_id, v_editor, v_created, v_member
    from content_versions
   where project = p_project and key = p_key and locale = p_locale and state = 'draft'
     for update;

  v_effective := case when p_change = -1 then v_member else p_change end;

  -- The inherited path re-reads the change; a vanished row (an interleaved
  -- abandon deleted it after this draft attached) is a stale pointer, not a
  -- caller error — detach and fall through, or every later autosave raises
  -- no_change against a change that no longer exists, and the draft's stale
  -- stamp feeds the clock a phantom retry. The explicit-attach path was
  -- validated above under for update and needs no re-read.
  if v_effective is not null and p_change = -1 then
    select * into v_change_row from changesets where id = v_effective;
    if not found then
      v_effective := null;
    end if;
  end if;

  -- A grouped draft's schedule is the change's alone. A personally-stamped
  -- member would be due outside its change — the exact state the clock's
  -- demotion sweep exists to clean — so the refusal is loud.
  if v_effective is not null then
    if p_publish_at is not null then
      raise exception 'grouped_schedule:%', p_key;
    end if;
    v_publish_at := v_change_row.publish_at;
  else
    v_publish_at := p_publish_at;
  end if;

  if v_id is not null then
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
    -- The ungrouped/grouped move is this same update.
    update content_versions
       set value = p_value, target = p_target, editor = p_editor,
           label = p_label, note = p_note, publish_at = v_publish_at,
           changeset_id = v_effective
     where id = v_id;
    return v_id;
  end if;

  begin
    insert into content_versions (project, key, locale, target, value, state,
                                  editor, label, note, publish_at, changeset_id)
    values (p_project, p_key, p_locale, p_target, p_value, 'draft',
            p_editor, p_label, p_note, v_publish_at, v_effective)
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

-- The explicit draft drop. No p_editor: a DELETE leaves no row to attribute,
-- and a parameter nothing can ever read back is a write-only value. No
-- incumbent refusal either — discarding is an explicit act by contract, and the
-- review queue's Reject path drops another author's proposal by design.
-- Deleting the row drops its group membership with it; no version history is
-- lost, because drafts are not versions.
create or replace function discard_content_draft(p_key text,
    p_locale text default 'default', p_project text default 'default')
returns bigint language plpgsql security invoker as $$
declare v_id bigint;
begin
  delete from content_versions
   where project = p_project and key = p_key and locale = p_locale and state = 'draft'
   returning id into v_id;
  if v_id is null then raise exception 'no_draft:% (%)', p_key, p_locale; end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Grants, as 001 writes them: no end-user access, service credentials only, the
-- Supabase roles guarded because a vanilla Postgres has neither and REVOKE from
-- a missing role is a hard error. Every function is named with its full
-- argument list. The two dropped-and-recreated functions are here because
-- DROP+CREATE resets ACLs — their 001 revokes went with the old signature.
-- ---------------------------------------------------------------------------

revoke execute on function
  stet_publish_flip(text, text, text, text, boolean),
  publish_change(bigint, text, text),
  save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean, bigint),
  revert_content_version(bigint, text, text, bigint),
  discard_content_draft(text, text, text)
from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on changesets from anon';
    execute 'revoke execute on function stet_publish_flip(text, text, text, text, boolean), publish_change(bigint, text, text), save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean, bigint), revert_content_version(bigint, text, text, bigint), discard_content_draft(text, text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on changesets from authenticated';
    execute 'revoke execute on function stet_publish_flip(text, text, text, text, boolean), publish_change(bigint, text, text), save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean, bigint), revert_content_version(bigint, text, text, bigint), discard_content_draft(text, text, text) from authenticated';
  end if;
end $$;

-- The replay, after the revokes so they cannot undo it: every EXECUTE grant
-- captured above is re-issued onto the signature that replaced it, and
-- publish_content_version's grantees additionally get the helper its body now
-- calls. Nothing captured means nothing replayed — the loops simply do not run.
do $$
declare g record;
begin
  for g in select grantee from stet_002_grants where routine_name = 'save_content_draft' loop
    execute format('grant execute on function save_content_draft(text, jsonb, text, text, text, text, text, text, timestamptz, boolean, bigint) to %I', g.grantee);
  end loop;
  for g in select grantee from stet_002_grants where routine_name = 'revert_content_version' loop
    execute format('grant execute on function revert_content_version(bigint, text, text, bigint) to %I', g.grantee);
  end loop;
  for g in select grantee from stet_002_grants where routine_name = 'publish_content_version' loop
    execute format('grant execute on function stet_publish_flip(text, text, text, text, boolean) to %I', g.grantee);
  end loop;
end $$;

-- deny-by-default regardless of role NAME, exactly as 001's tables carry it.
alter table changesets enable row level security;

-- The version stamp is the transaction's last statement, and nothing above it
-- survives a failed apply: what a failure leaves behind is a database still
-- reading schema_version 1, never one claiming migration 2. An UPDATE, not an
-- upsert — 002 cannot reach this line without 001's tables existing, so the row
-- is already there.
update stet_meta set schema_version = 2, updated_at = now() where id = 1;

commit;

-- After applying through a transport that caches the schema (PostgREST):
--   notify pgrst, 'reload schema';
