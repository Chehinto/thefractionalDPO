-- Data protection impact assessments.
--
-- §2 item 3 lists what a DPIA needs beyond the (not yet built) vendor
-- questionnaire: a risk-scoring method against a stated scale, necessity and
-- proportionality reasoning, mitigations and residual risk, the Art. 36 prior
-- consultation trigger when residual risk stays high, and sign-off with a
-- review date. Each of those is a column below.
--
-- The scoring scale is fixed in the database rather than left to the interface.
-- A DPIA whose risk rating depends on which screen computed it is not evidence
-- of anything, and "we scored it high" is a claim a regulator will ask to see
-- the working for.

-- ---------------------------------------------------------------------------
-- The status enum now covers two record types, so it is named for what it is
-- rather than for the first table that used it.
-- ---------------------------------------------------------------------------
alter type public.activity_status rename to review_status;

create type public.risk_level as enum ('low', 'medium', 'high');

-- ---------------------------------------------------------------------------
-- The risk matrix, stated once.
--
-- Defined as a function rather than inline in each generated column because it
-- is used three times — initial risk, residual risk, and the Art. 36 trigger —
-- and three copies of a scoring table is three chances for one of them to drift.
-- If the matrix ever changes, it changes here and every column follows on the
-- next write.
--
-- IMMUTABLE is required: a generated column may only call immutable functions.
-- It is genuinely immutable — the same two inputs always give the same rating,
-- with no clock and no lookup.
--
-- The matrix is symmetric (severity=low/likelihood=high rates the same as
-- severity=high/likelihood=low), but the arguments are still ordered
-- severity-then-likelihood to match how it was specified, so a future
-- asymmetric revision does not silently invert.
-- ---------------------------------------------------------------------------
create or replace function app.risk_matrix(
  p_severity public.risk_level,
  p_likelihood public.risk_level
)
returns public.risk_level
language sql
immutable
as $$
  select case
    when p_severity = 'low'    and p_likelihood = 'low'    then 'low'
    when p_severity = 'low'    and p_likelihood = 'medium' then 'low'
    when p_severity = 'low'    and p_likelihood = 'high'   then 'medium'
    when p_severity = 'medium' and p_likelihood = 'low'    then 'low'
    when p_severity = 'medium' and p_likelihood = 'medium' then 'medium'
    when p_severity = 'medium' and p_likelihood = 'high'   then 'high'
    when p_severity = 'high'   and p_likelihood = 'low'    then 'medium'
    when p_severity = 'high'   and p_likelihood = 'medium' then 'high'
    when p_severity = 'high'   and p_likelihood = 'high'   then 'high'
  end::public.risk_level
$$;

revoke all on function app.risk_matrix(public.risk_level, public.risk_level) from public;
grant execute on function app.risk_matrix(public.risk_level, public.risk_level)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A DPIA cannot be attached to another tenant's processing activity.
--
-- The FK below is composite — (processing_activity_id, tenant_id) — which needs
-- this. RLS would already stop the DPO reading such a row, but a dangling
-- cross-tenant reference should not be constructible in the first place: it is
-- the kind of thing that survives a later refactor of the policies.
-- ---------------------------------------------------------------------------
alter table public.processing_activity
  add constraint processing_activity_id_tenant_key unique (id, tenant_id);

create table public.dpia (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  processing_activity_id uuid not null,

  status public.review_status not null default 'pending_dpo_review',

  -- Initial assessment. Both required: a DPIA that has not scored the risk it
  -- is assessing has not started.
  likelihood public.risk_level not null,
  severity public.risk_level not null,
  initial_risk public.risk_level not null generated always as (
    app.risk_matrix(severity, likelihood)
  ) stored,

  -- §2 item 3. Required, because the necessity and proportionality reasoning is
  -- the part of an Art. 35 assessment that cannot be inferred from scores — it
  -- is the argument, and a DPIA without it is a risk register entry.
  necessity_proportionality text not null
    check (length(btrim(necessity_proportionality)) > 0),

  mitigations text,

  -- Residual assessment, nullable: it does not exist until the mitigations have
  -- been decided, and a half-finished DPIA is a real state rather than an error.
  residual_likelihood public.risk_level,
  residual_severity public.risk_level,
  residual_risk public.risk_level generated always as (
    app.risk_matrix(residual_severity, residual_likelihood)
  ) stored,

  -- The Art. 36 trigger.
  --
  -- NULL, not false, while the residual assessment is outstanding. A boolean
  -- here would have to choose between claiming consultation is not required
  -- (under-flagging a duty that carries a fine) and claiming it is (crying wolf
  -- on every unfinished draft). "Not yet determined" is the truth, and the
  -- approve function below refuses to sign off while it is still the answer.
  --
  -- Computed from the residual inputs rather than from `residual_risk`, because
  -- Postgres does not permit a generated column to reference another one. Same
  -- matrix function, so the two cannot disagree.
  requires_prior_consultation boolean generated always as (
    case
      when residual_severity is null or residual_likelihood is null then null
      else app.risk_matrix(residual_severity, residual_likelihood) = 'high'
    end
  ) stored,

  -- §2 item 3: "sign-off with a review date". A DPIA with no review date is a
  -- snapshot presented as a standing conclusion.
  review_due date,

  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references public.people (id) on delete set null,

  -- The activity and the DPIA must belong to the same workspace. See the unique
  -- constraint added above.
  constraint dpia_activity_same_tenant
    foreign key (processing_activity_id, tenant_id)
    references public.processing_activity (id, tenant_id)
    on delete restrict,

  constraint approved_dpias_are_attributed check (
    (status = 'approved' and approved_at is not null and approved_by is not null)
    or (status = 'pending_dpo_review' and approved_at is null and approved_by is null)
  )
);

create index dpia_tenant_idx on public.dpia (tenant_id, status);
create index dpia_activity_idx on public.dpia (processing_activity_id);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Active DPO only, for both reading and writing. There is deliberately no
-- tier-2 path: no sharing mechanism for DPIAs has been specified, and inventing
-- one would mean guessing what a staff member should be shown of an assessment
-- that exists to record the DPO's own judgment. §4 tier 2's default — staff see
-- nothing they have not been specifically given — is the correct behaviour
-- until somebody designs the giving.
-- ---------------------------------------------------------------------------
alter table public.dpia enable row level security;

create policy dpia_read on public.dpia
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy dpia_insert on public.dpia
  for insert to authenticated
  with check (
    app.has_tier(tenant_id, 'active_dpo')
    and app.tenant_is_writable(tenant_id)
  );

create policy dpia_update on public.dpia
  for update to authenticated
  using (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id))
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

-- No DELETE policy: an assessment that was made is a thing that happened.

-- ---------------------------------------------------------------------------
-- Grants: status and the approval stamps are not columns a client may write.
-- ---------------------------------------------------------------------------
revoke all on public.dpia from anon, authenticated;

grant select on public.dpia to authenticated;
grant insert (
  tenant_id, processing_activity_id,
  likelihood, severity,
  necessity_proportionality, mitigations,
  residual_likelihood, residual_severity,
  review_due, created_by
) on public.dpia to authenticated;
grant update (
  likelihood, severity,
  necessity_proportionality, mitigations,
  residual_likelihood, residual_severity,
  review_due
) on public.dpia to authenticated;

-- The service role bypasses both RLS and the column grants, so this is what
-- stands between a future import and a register of assessments nobody signed.
create or replace function app.force_dpia_pending_on_insert()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from 'pending_dpo_review' then
    raise exception 'a DPIA cannot be created already approved; use approve_dpia'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger dpia_starts_pending
  before insert on public.dpia
  for each row execute function app.force_dpia_pending_on_insert();

-- ---------------------------------------------------------------------------
-- Approval
--
-- Same shape as approve_processing_activity and create_tenant: the caller
-- asserts who they are acting as, the session decides, and a DPIA in a tenant
-- the caller does not run is reported as missing rather than forbidden.
--
-- Two extra preconditions, which are specific to what a DPIA is. Both are
-- refusals rather than warnings because signing off is the moment the DPO's
-- name goes on the assessment:
--
--   The residual risk must be assessed. Approving while
--   `requires_prior_consultation` is still NULL would record a completed
--   assessment that has not answered the one question Art. 36 turns on.
--
--   A review date must be set (§2 item 3). Without one the sign-off has no end,
--   and a DPIA is a statement about a system as it was on the day.
-- ---------------------------------------------------------------------------
create or replace function public.approve_dpia(
  p_caller_person_id uuid,
  p_dpia_id uuid
)
returns public.dpia
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.dpia;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.dpia where id = p_dpia_id;

  if v_row.id is null
     or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  if v_row.status = 'approved' then
    return v_row;
  end if;

  if v_row.residual_likelihood is null or v_row.residual_severity is null then
    raise exception 'the residual risk must be assessed before this DPIA can be signed off'
      using errcode = '22023';
  end if;

  if v_row.review_due is null then
    raise exception 'a review date is required before this DPIA can be signed off'
      using errcode = '22023';
  end if;

  update public.dpia
     set status = 'approved',
         approved_at = now(),
         approved_by = v_session_person
   where id = p_dpia_id
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function public.approve_dpia(uuid, uuid) from public, anon;
grant execute on function public.approve_dpia(uuid, uuid) to authenticated, service_role;
