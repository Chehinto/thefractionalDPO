-- Tier 3: external scoped access (design resume §4).
--
-- The third access tier has existed as a value in `membership_tier` since 0001
-- and as nothing else. This file gives it a mechanism, and deliberately not the
-- one the enum implies: a token holder never gets a `memberships` row.
--
-- 0006 wrote down the requirement while building the vendor pipeline — "the
-- vendor-facing round-trip will need hashed, expiring tokens rather than a
-- membership row or a broad anon policy" — and both halves of that matter.
--
--   No membership row, because membership is durable identity that accumulates
--   history (§4 tier 2). An auditor who reviewed one register for two weeks is
--   not a person this workspace knows; making them one would put them in the
--   roster, in the portfolio rollups, and in `people` forever.
--
--   No anon RLS policy, because a policy is a standing grant. `anon` currently
--   reaches nothing in this database, and the cheapest way to keep that true is
--   to never write a policy that could be widened by a later edit. Every door
--   in this file is a SECURITY DEFINER function that re-checks the token on the
--   way through, so revocation is always read from live state — never from a
--   session, a claim, or anything cached between requests, per CLAUDE.md.
--
-- The token plaintext never reaches Postgres. The application generates it,
-- hashes it, and sends only the hash; it cannot appear in a query log, a
-- `pg_stat_statements` row, or a backup.

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------

-- What a link is FOR. Purpose is not decoration: it decides which function will
-- accept the token at all, so a vendor questionnaire link cannot be replayed
-- against the auditor read path even though both are grants on the same tenant.
create type public.scoped_access_purpose as enum (
  'vendor_questionnaire',  -- a named vendor answering one approved questionnaire
  'auditor_review'         -- an auditor or customer reviewer reading the register
);

-- §4 requires a full view log for tier 3. 'refused' is recorded as well as the
-- successes, because "someone kept trying this link for a month after we
-- revoked it" is exactly the thing an audit wants to see and the thing a
-- success-only log cannot show.
create type public.scoped_access_event_kind as enum ('viewed', 'answered', 'refused');

-- ---------------------------------------------------------------------------
-- scoped_access_grant — one issued link
-- ---------------------------------------------------------------------------
create table public.scoped_access_grant (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  purpose public.scoped_access_purpose not null,

  -- sha256 of the token, never the token. Unique so that a redemption is a
  -- single indexed lookup rather than a scan comparing secrets row by row.
  token_hash bytea not null unique check (octet_length(token_hash) = 32),

  -- Who the DPO issued this to, in their own words ("Acme Ltd security team").
  -- Free text on purpose: this is a label for the audit log, not an identity
  -- the product will try to authenticate.
  label text not null check (length(btrim(label)) > 0),

  -- Set only for 'vendor_questionnaire'. Composite FK so a grant cannot point
  -- at another tenant's questionnaire even if the id is guessed correctly.
  vendor_questionnaire_id uuid,

  issued_by uuid not null references public.people (id) on delete restrict,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references public.people (id) on delete set null,

  constraint scoped_grant_questionnaire_same_tenant
    foreign key (vendor_questionnaire_id, tenant_id)
    references public.vendor_questionnaire (id, tenant_id)
    on delete restrict,

  -- A questionnaire grant names its questionnaire; an auditor grant must not,
  -- so a link issued for reading cannot later be pointed at a write path.
  constraint scoped_grant_target_matches_purpose check (
    (purpose = 'vendor_questionnaire' and vendor_questionnaire_id is not null)
    or (purpose = 'auditor_review' and vendor_questionnaire_id is null)
  ),

  constraint scoped_grant_expires_after_issue check (expires_at > issued_at),

  -- CLAUDE.md: short expirations by default. The default belongs in the
  -- application; the ceiling belongs here, where no caller can raise it. A year
  -- -long auditor link is indistinguishable from a permanent one.
  constraint scoped_grant_expiry_is_short check (expires_at <= issued_at + interval '90 days'),

  constraint scoped_grant_revocation_is_attributed check (
    (revoked_at is null and revoked_by is null)
    or (revoked_at is not null and revoked_by is not null)
  ),

  unique (id, tenant_id)
);

create index scoped_access_grant_tenant_idx
  on public.scoped_access_grant (tenant_id, issued_at desc);
create index scoped_access_grant_questionnaire_idx
  on public.scoped_access_grant (tenant_id, vendor_questionnaire_id)
  where vendor_questionnaire_id is not null;

-- ---------------------------------------------------------------------------
-- scoped_access_event — the view log
-- ---------------------------------------------------------------------------
create table public.scoped_access_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  grant_id uuid not null,
  kind public.scoped_access_event_kind not null,

  -- Why a refusal was refused ("expired", "revoked"). Null for successes.
  detail text,

  occurred_at timestamptz not null default now(),

  constraint scoped_event_grant_same_tenant
    foreign key (grant_id, tenant_id)
    references public.scoped_access_grant (id, tenant_id)
    on delete restrict
);

create index scoped_access_event_grant_idx
  on public.scoped_access_event (tenant_id, grant_id, occurred_at desc);

-- Provenance for an answer that arrived through a link rather than being typed
-- in by the DPO. Nullable because `recorded_by` remains the other legitimate
-- source, and a response predating this file has neither.
alter table public.vendor_questionnaire_response
  add column scoped_access_grant_id uuid;

alter table public.vendor_questionnaire_response
  add constraint vendor_response_grant_same_tenant
    foreign key (scoped_access_grant_id, tenant_id)
    references public.scoped_access_grant (id, tenant_id)
    on delete restrict;

-- 0006 granted INSERT on this table at table level, which silently extends to
-- every column added later — including the one above. Provenance has to be
-- unforgeable to be worth recording, so the column is taken back out: only the
-- definer function below, running as the owner, can stamp an answer as having
-- arrived through a link.
revoke insert (scoped_access_grant_id) on public.vendor_questionnaire_response from authenticated;
revoke update (scoped_access_grant_id) on public.vendor_questionnaire_response from authenticated;

-- One answer per question per link. A vendor correcting an answer updates their
-- own row rather than appending a second one the DPO has to reconcile by hand.
create unique index vendor_response_one_per_question_per_grant
  on public.vendor_questionnaire_response (question_id, scoped_access_grant_id)
  where scoped_access_grant_id is not null;

-- ---------------------------------------------------------------------------
-- RLS
--
-- Note what is absent: there is no policy mentioning `anon` anywhere in this
-- file. A token holder is not a database role and never becomes one. Everything
-- they can do goes through the definer functions below, which is why the grants
-- here cover only the Active DPO's own view of what they have issued.
--
-- `token_hash` is deliberately NOT in the select grant. The DPO does not need
-- it — they were given the plaintext once, at issue time — and a hash that
-- reaches a client is a hash that can be replayed straight into the redeem
-- function, which is the one input that path trusts.
-- ---------------------------------------------------------------------------

alter table public.scoped_access_grant enable row level security;
alter table public.scoped_access_event enable row level security;

create policy scoped_access_grant_read on public.scoped_access_grant
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy scoped_access_event_read on public.scoped_access_event
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

revoke all on public.scoped_access_grant from anon, authenticated;
revoke all on public.scoped_access_event from anon, authenticated;

grant select (
  id, tenant_id, purpose, label, vendor_questionnaire_id,
  issued_by, issued_at, expires_at, revoked_at, revoked_by
) on public.scoped_access_grant to authenticated;

grant select on public.scoped_access_event to authenticated;

-- The public functions take the hash as lowercase hex rather than bytea: a
-- bytea argument arriving over PostgREST depends on an implicit text cast and a
-- `\x` prefix the caller has to get right, and "the encoding was wrong" is not
-- a failure mode worth having on the one path that authenticates a stranger.
--
-- A malformed hash is refused as not-found rather than raising a decode error,
-- so a bad token and a truncated one are indistinguishable from an unknown one.
create or replace function app.decode_token_hash(p_hex text)
returns bytea
language sql
immutable
as $$
  select case
    when p_hex ~ '^[0-9a-f]{64}$' then decode(p_hex, 'hex')
    else null
  end
$$;

-- ---------------------------------------------------------------------------
-- app.live_scoped_grant — the single definition of "this link still works"
--
-- Every door below calls this and nothing else, so there is one answer to
-- "is this token good right now" rather than one per entry point. Deliberately
-- NOT granted to anon: it is the predicate, not a door.
--
-- Returns the grant whether or not it is live, plus why it isn't, because the
-- callers need that distinction for two different reasons — they must refuse
-- identically, and they must log differently.
-- ---------------------------------------------------------------------------
create or replace function app.live_scoped_grant(p_token_hash bytea)
returns table (
  grant_id uuid,
  tenant_id uuid,
  purpose public.scoped_access_purpose,
  vendor_questionnaire_id uuid,
  label text,
  expires_at timestamptz,
  tenant_status public.tenant_status,
  refusal text
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    g.id,
    g.tenant_id,
    g.purpose,
    g.vendor_questionnaire_id,
    g.label,
    g.expires_at,
    t.status,
    case
      when g.revoked_at is not null then 'revoked'
      when g.expires_at <= now() then 'expired'
      -- §5: a suspended workspace is past the read-only window. An outstanding
      -- auditor link must not outlive the tenant's own access.
      when t.status = 'suspended' then 'suspended'
      else null
    end
  from public.scoped_access_grant g
  join public.tenants t on t.id = g.tenant_id
  where g.token_hash = p_token_hash
$$;

-- ---------------------------------------------------------------------------
-- Issuing and revoking. Active DPO only, and both re-check the session the way
-- `approve_vendor_request` does rather than trusting the id they are handed.
-- ---------------------------------------------------------------------------
create or replace function public.issue_scoped_access(
  p_caller_person_id uuid,
  p_tenant_id uuid,
  p_purpose public.scoped_access_purpose,
  p_token_hash text,
  p_label text,
  p_expires_at timestamptz,
  p_vendor_questionnaire_id uuid default null
)
returns public.scoped_access_grant
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.scoped_access_grant;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  -- Not found, not forbidden: a caller who is not the Active DPO here must not
  -- learn whether the tenant exists.
  if app.has_tier(p_tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(p_tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  -- A vendor may only be sent a questionnaire the DPO has already approved.
  -- Without this, a link created alongside a draft would expose wording that
  -- has not been signed off — the approval gate would be in the UI only.
  if p_purpose = 'vendor_questionnaire' then
    if not exists (
      select 1 from public.vendor_questionnaire q
      where q.id = p_vendor_questionnaire_id
        and q.tenant_id = p_tenant_id
        and q.status = 'approved'
    ) then
      raise exception 'questionnaire is not approved for sending' using errcode = '42501';
    end if;
  end if;

  insert into public.scoped_access_grant (
    tenant_id, purpose, token_hash, label, vendor_questionnaire_id,
    issued_by, expires_at
  )
  values (
    p_tenant_id, p_purpose, app.decode_token_hash(p_token_hash), p_label, p_vendor_questionnaire_id,
    v_session_person, p_expires_at
  )
  returning * into v_row;

  return v_row;
end
$$;

create or replace function public.revoke_scoped_access(
  p_caller_person_id uuid,
  p_grant_id uuid
)
returns public.scoped_access_grant
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.scoped_access_grant;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.scoped_access_grant where id = p_grant_id;

  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  -- Revocation is allowed on a read-only workspace on purpose. §5 blocks new
  -- work when a card lapses; it must never block taking access away, or a
  -- billing lapse would pin an auditor link open until the tenant is purged.
  if v_row.revoked_at is not null then
    return v_row;
  end if;

  update public.scoped_access_grant
     set revoked_at = now(),
         revoked_by = v_session_person
   where id = p_grant_id
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function public.issue_scoped_access(uuid, uuid, public.scoped_access_purpose, text, text, timestamptz, uuid) from public, anon;
grant execute on function public.issue_scoped_access(uuid, uuid, public.scoped_access_purpose, text, text, timestamptz, uuid) to authenticated, service_role;

revoke all on function public.revoke_scoped_access(uuid, uuid) from public, anon;
grant execute on function public.revoke_scoped_access(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The doors an unauthenticated token holder may knock on.
--
-- Three rules hold across all of them:
--
--  1. The token is re-checked on EVERY call. Nothing is carried in a session,
--     a cookie or a claim, so revoking a link takes effect on the next request
--     rather than whenever some cached copy happens to expire.
--  2. A refusal is identical whatever the cause. A caller cannot tell an
--     unknown token from a revoked one from an expired one from a suspended
--     tenant — otherwise the link becomes an oracle for whether a given
--     workspace exists.
--  3. A refusal against a KNOWN grant is logged. An unknown hash is not: it
--     corresponds to no tenant, so there is nothing to attach it to, and
--     writing a row per guess would make the log itself the attack.
--
-- A refusal returns NO ROWS rather than raising. That is not a style choice.
-- `raise` aborts the transaction, which would roll back the very audit row the
-- refusal had just written — so the log would have recorded every successful
-- view and silently lost every rejected one, which is backwards from what §4
-- asks for. Returning empty also makes "refused identically" structural rather
-- than a property of keeping several exception messages in sync.
-- ---------------------------------------------------------------------------

create or replace function app.record_scoped_event(
  p_grant_id uuid,
  p_tenant_id uuid,
  p_kind public.scoped_access_event_kind,
  p_detail text default null
)
returns void
language sql
security definer
set search_path = public, pg_catalog
as $$
  insert into public.scoped_access_event (tenant_id, grant_id, kind, detail)
  values (p_tenant_id, p_grant_id, p_kind, p_detail)
$$;

-- What a link says about itself before anything is shown. The vendor/auditor
-- page calls this first, and it is also what makes the view log a view log.
create or replace function public.redeem_scoped_access(p_token_hash text)
returns table (
  purpose public.scoped_access_purpose,
  label text,
  tenant_name text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  g record;
begin
  select * into g from app.live_scoped_grant(app.decode_token_hash(p_token_hash));

  if g.grant_id is null then
    return;
  end if;

  if g.refusal is not null then
    perform app.record_scoped_event(g.grant_id, g.tenant_id, 'refused', g.refusal);
    return;
  end if;

  perform app.record_scoped_event(g.grant_id, g.tenant_id, 'viewed', null);

  return query
    select g.purpose, g.label, t.name, g.expires_at
    from public.tenants t
    where t.id = g.tenant_id;
end
$$;

-- The questionnaire behind a vendor link.
--
-- Returns questions only — never the tenant's register, never the DPIA, never
-- the extracted facts that prompted the questions. A vendor answering "what is
-- your retention period" has no business reading what this company already
-- believes about them.
create or replace function public.scoped_questionnaire(p_token_hash text)
returns table (
  question_id uuid,
  -- `position` is reserved in a RETURNS TABLE column list, though it is legal
  -- as an ordinary column name on the table itself.
  question_position integer,
  question text,
  answer_type public.question_answer_type,
  why_needed text,
  existing_answer text
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  g record;
begin
  select * into g from app.live_scoped_grant(app.decode_token_hash(p_token_hash));

  -- Purpose is checked as strictly as liveness. An auditor link presented here
  -- is refused exactly as an unknown token would be.
  if g.grant_id is null or g.purpose is distinct from 'vendor_questionnaire' then
    return;
  end if;

  if g.refusal is not null then
    perform app.record_scoped_event(g.grant_id, g.tenant_id, 'refused', g.refusal);
    return;
  end if;

  return query
    select
      q.id,
      q.position,
      q.question,
      q.answer_type,
      q.why_needed,
      r.answer
    from public.vendor_questionnaire_question q
    left join public.vendor_questionnaire_response r
      on r.question_id = q.id
     and r.scoped_access_grant_id = g.grant_id
    where q.questionnaire_id = g.vendor_questionnaire_id
      and q.tenant_id = g.tenant_id
    order by q.position;
end
$$;

-- A vendor answering one question.
--
-- This writes to `vendor_questionnaire_response`, which is raw returned
-- evidence and not a canonical record: reaching the register still requires the
-- DPO to approve a `vendor_dpia_reconciliation`. That is the approval
-- discipline of §4 holding at the one point where text from outside the company
-- enters the database.
create or replace function public.submit_scoped_questionnaire_response(
  p_token_hash text,
  p_question_id uuid,
  p_answer text,
  p_evidence text default null,
  p_respondent_email text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  g record;
  v_questionnaire uuid;
  v_id uuid;
begin
  select * into g from app.live_scoped_grant(app.decode_token_hash(p_token_hash));

  if g.grant_id is null or g.purpose is distinct from 'vendor_questionnaire' then
    return null;
  end if;

  if g.refusal is not null then
    perform app.record_scoped_event(g.grant_id, g.tenant_id, 'refused', g.refusal);
    return null;
  end if;

  -- Writability is checked on the tenant's own status, NOT via
  -- `app.tenant_is_writable`, which additionally requires the caller to be a
  -- member — and a token holder deliberately never is. A read-only workspace
  -- still shows the questionnaire; it just cannot take new answers.
  --
  -- This one raises rather than returning empty, and is not logged as a
  -- refusal. The caller has already proved they hold a live link by reading the
  -- questionnaire, so telling them the answer was not accepted reveals nothing
  -- they did not know — and a billing state is not link abuse, which is what
  -- the refusal log is for.
  if g.tenant_status <> 'active' then
    raise exception 'this workspace cannot accept answers' using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_answer, ''))) = 0 then
    raise exception 'an answer is required' using errcode = '22023';
  end if;

  -- The question must belong to THIS grant's questionnaire. Without this a
  -- vendor could answer any question id in the database; the composite foreign
  -- keys would accept it because it is still the same tenant.
  select q.questionnaire_id into v_questionnaire
  from public.vendor_questionnaire_question q
  where q.id = p_question_id
    and q.tenant_id = g.tenant_id
    and q.questionnaire_id = g.vendor_questionnaire_id;

  if v_questionnaire is null then
    return null;
  end if;

  insert into public.vendor_questionnaire_response (
    tenant_id, questionnaire_id, question_id, answer, evidence,
    respondent_email, scoped_access_grant_id
  )
  values (
    g.tenant_id, v_questionnaire, p_question_id, btrim(p_answer), p_evidence,
    p_respondent_email, g.grant_id
  )
  on conflict (question_id, scoped_access_grant_id)
    where scoped_access_grant_id is not null
  do update set
    answer = excluded.answer,
    evidence = excluded.evidence,
    respondent_email = excluded.respondent_email,
    received_at = now()
  returning id into v_id;

  perform app.record_scoped_event(g.grant_id, g.tenant_id, 'answered', null);

  return v_id;
end
$$;

-- `anon` reaches exactly these three functions and nothing else in the schema.
revoke all on function public.redeem_scoped_access(text) from public;
grant execute on function public.redeem_scoped_access(text) to anon, authenticated, service_role;

revoke all on function public.scoped_questionnaire(text) from public;
grant execute on function public.scoped_questionnaire(text) to anon, authenticated, service_role;

revoke all on function public.submit_scoped_questionnaire_response(text, uuid, text, text, text) from public;
grant execute on function public.submit_scoped_questionnaire_response(text, uuid, text, text, text) to anon, authenticated, service_role;

-- The predicate is not a door.
revoke all on function app.live_scoped_grant(bytea) from public, anon, authenticated;
revoke all on function app.decode_token_hash(text) from public, anon, authenticated;
revoke all on function app.record_scoped_event(uuid, uuid, public.scoped_access_event_kind, text) from public, anon, authenticated;
