-- The Art. 30 register: one row per processing activity.
--
-- Built to the canonical schema in §9 of the design resume. Five of the seven
-- fields carry {value, confidence, evidence}; `role` and `dpia_risk_flag` do
-- not, per that section.
--
-- Two rules shape everything below, and neither is enforced only in the
-- application:
--
--   Nothing arrives approved. Every row starts `pending_dpo_review` (§4's
--   approval discipline, reaffirmed "explicitly and unconditionally"), and the
--   status column cannot be written by a client at all — the only path to
--   approved is `approve_processing_activity`, which checks who is calling.
--
--   A staff member has no general read access to the register. §4 tier 2 is
--   explicit: staff never see the register, only what has been specifically
--   pushed to them. That is the single most important policy in this file.

-- ---------------------------------------------------------------------------
-- Vocabulary (§9)
-- ---------------------------------------------------------------------------

-- How a value came to be recorded. Shared with Prompt A, Prompt B and the
-- day-to-day elicitation prompt when those exist.
create type public.confidence_tag as enum ('stated', 'inferred', 'unknown');

create type public.processing_role as enum ('controller', 'processor');

create type public.ordinary_category as enum (
  'contact_details',
  'employment_data',
  'financial_data',
  'technical_usage_data',
  'customer_commercial_data',
  'education_qualification_data',
  'communications_data',
  'location_data',
  'image_video_data'
);

-- Art. 9's closed statutory list, PLUS `criminal_offence_data`, which is
-- technically Art. 10 rather than Art. 9.
--
-- It sits here deliberately. §9 lists it under "treated with the same weight in
-- practice", and the whole reason for splitting ordinary from special is that
-- the DPIA flag becomes one check — "is this array non-empty" — rather than a
-- per-value lookup. Putting Art. 10 data in a third place would reintroduce
-- exactly the per-value lookup the split exists to avoid, and would make it
-- possible to record criminal-offence data without raising the flag.
--
-- The legal distinction still matters when citing a basis: Art. 9(2) conditions
-- do not apply to criminal-offence data, Art. 10 does. Anything that renders a
-- legal basis must not assume every value in this enum is an Art. 9 category.
create type public.special_category as enum (
  'health_data',
  'biometric_data',
  'genetic_data',
  'racial_ethnic_origin',
  'religious_philosophical_beliefs',
  'political_opinions',
  'trade_union_membership',
  'sex_life_or_orientation',
  'criminal_offence_data'
);

create type public.data_subject as enum (
  'customers',
  'employees',
  'job_applicants',
  'website_visitors',
  'other'
);

-- §4: every draft lands here. 'approved' is reachable only through the
-- approve function below.
create type public.activity_status as enum ('pending_dpo_review', 'approved');

-- ---------------------------------------------------------------------------
-- processing_activity
--
-- The {value, confidence, evidence} triple is three real columns per field
-- rather than one jsonb blob. jsonb would accept 'probably' as a confidence tag
-- and 'helth_data' as a category and only fail later, in a report, in front of
-- a regulator. Columns typed against the enums mean the database refuses both
-- at write time, which is where a compliance record has to be refused.
--
-- `evidence` is free text for now: a page reference, a document name, a
-- sentence a person typed. Once Prompt A exists it becomes the passage
-- attribution from extraction, which is why it is nullable and unstructured
-- rather than a foreign key to something that does not exist yet.
-- ---------------------------------------------------------------------------
create table public.processing_activity (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,

  -- §4: nothing writes to the register automatically. The default and the
  -- column grant below make this the only state a client can produce.
  status public.activity_status not null default 'pending_dpo_review',

  -- purpose — the one field an activity cannot exist without. An entry with no
  -- stated purpose is not an Art. 30 record of anything.
  purpose text not null check (length(btrim(purpose)) > 0),
  purpose_confidence public.confidence_tag not null,
  purpose_evidence text,

  -- recipient_vendor — nullable: a first-party activity has no recipient, and
  -- that is a fact about the activity rather than a gap in the record.
  recipient_vendor text,
  recipient_vendor_confidence public.confidence_tag not null,
  recipient_vendor_evidence text,

  -- role carries no confidence tag, per §9. See the note in the README: the
  -- resume's own worked example of an `inferred` value is a role determination,
  -- so this is the field most likely to need revisiting.
  role public.processing_role not null,

  data_categories_ordinary public.ordinary_category[] not null default '{}',
  data_categories_special public.special_category[] not null default '{}',
  data_categories_confidence public.confidence_tag not null,
  data_categories_evidence text,

  data_subjects public.data_subject[] not null default '{}',
  data_subjects_confidence public.confidence_tag not null,
  data_subjects_evidence text,

  -- retention as text: real retention rules are prose ("7 years from end of
  -- contract, per the Companies Act"), and flattening that to a number loses
  -- the basis, which is the half a regulator asks about.
  retention text,
  retention_confidence public.confidence_tag not null,
  retention_evidence text,

  -- Derived, never written. A generated column means no code path — not an
  -- import, not a future prompt, not a careless update — can record
  -- special-category data without the flag following it.
  --
  -- Named for what it actually tests. Special-category presence is ONE Art. 35
  -- trigger; large-scale processing, systematic monitoring, vulnerable subjects
  -- and automated decision-making are others this does not see. Treat it as a
  -- screen that says "definitely look", never as one that says "no DPIA needed".
  dpia_risk_flag boolean not null generated always as (
    array_length(data_categories_special, 1) is not null
  ) stored,

  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references public.people (id) on delete set null,

  -- An approved row must carry who approved it and when. This is the audit
  -- trail a register is FOR; a row that says 'approved' with nobody's name
  -- against it is worse than a draft.
  constraint approved_rows_are_attributed check (
    (status = 'approved' and approved_at is not null and approved_by is not null)
    or (status = 'pending_dpo_review' and approved_at is null and approved_by is null)
  )
);

create index processing_activity_tenant_idx
  on public.processing_activity (tenant_id, status);

-- ---------------------------------------------------------------------------
-- Sharing one activity with one staff member (§4 tier 2)
--
-- The tier-2 primitive: push one specific thing to one specific person. §4
-- describes this as a single mechanism whose content type varies — a question,
-- a policy, a training module — so this table is deliberately about ONE content
-- type rather than a generic assignment engine. The generic version can be
-- built when the second content type exists, not before.
-- ---------------------------------------------------------------------------
create table public.processing_activity_share (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.processing_activity (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete restrict,
  shared_by uuid references public.people (id) on delete set null,
  shared_at timestamptz not null default now(),
  -- One live share per person per activity. Re-sharing is not a second row.
  unique (activity_id, person_id)
);

create index processing_activity_share_person_idx
  on public.processing_activity_share (person_id);

-- ---------------------------------------------------------------------------
-- Access predicates
-- ---------------------------------------------------------------------------

-- Whether this activity has been specifically shared with the caller.
--
-- SECURITY DEFINER for the same reason every predicate in 0001 is: it is called
-- from the policy ON `processing_activity`, and a policy that subqueries a
-- table whose own policy reads back is how the recursion in AxioVendo's
-- migration 003 happened.
create or replace function app.activity_shared_with_caller(p_activity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
    from public.processing_activity_share s
    where s.activity_id = p_activity_id
      and s.person_id = app.current_person_id()
  )
$$;

revoke all on function app.activity_shared_with_caller(uuid) from public;
grant execute on function app.activity_shared_with_caller(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.processing_activity enable row level security;
alter table public.processing_activity_share enable row level security;

-- THE policy that matters most (§4 tier 2).
--
-- An Active DPO sees the register. Everybody else sees only the individual
-- activities pushed to them by name — not the tenant's register filtered, not
-- the approved subset, not a count. A staff member with no shares sees nothing
-- at all, which is the correct answer to "what is in this company's register".
create policy processing_activity_read on public.processing_activity
  for select to authenticated
  using (
    app.has_tier(tenant_id, 'active_dpo')
    or app.activity_shared_with_caller(id)
  );

create policy processing_activity_insert on public.processing_activity
  for insert to authenticated
  with check (
    app.has_tier(tenant_id, 'active_dpo')
    and app.tenant_is_writable(tenant_id)
  );

create policy processing_activity_update on public.processing_activity
  for update to authenticated
  using (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id))
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

-- No DELETE policy. A register entry that turns out to be wrong is corrected or
-- superseded; removing the evidence that it was ever recorded is not something
-- this layer should make easy, and no feature needs it yet.

-- Shares: an Active DPO manages them; a staff member can see the ones naming
-- them, so a future screen can say "this was shared with you on <date>".
create policy processing_activity_share_read on public.processing_activity_share
  for select to authenticated
  using (
    person_id = app.current_person_id()
    or exists (
      select 1 from public.processing_activity a
      where a.id = activity_id and app.has_tier(a.tenant_id, 'active_dpo')
    )
  );

create policy processing_activity_share_write on public.processing_activity_share
  for insert to authenticated
  with check (
    exists (
      select 1 from public.processing_activity a
      where a.id = activity_id
        and app.has_tier(a.tenant_id, 'active_dpo')
        and app.tenant_is_writable(a.tenant_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Status is not a field a client may write
--
-- The column grants below exclude `status`, `approved_at` and `approved_by`
-- entirely. RLS decides WHICH rows a caller may update; this decides which
-- COLUMNS, and together they mean the only route from draft to approved is the
-- function below, which records who did it.
--
-- Restated in full because a column-level grant list replaces rather than adds.
-- ---------------------------------------------------------------------------
revoke all on public.processing_activity from anon, authenticated;
revoke all on public.processing_activity_share from anon, authenticated;

grant select on public.processing_activity to authenticated;
grant insert (
  tenant_id, purpose, purpose_confidence, purpose_evidence,
  recipient_vendor, recipient_vendor_confidence, recipient_vendor_evidence,
  role,
  data_categories_ordinary, data_categories_special,
  data_categories_confidence, data_categories_evidence,
  data_subjects, data_subjects_confidence, data_subjects_evidence,
  retention, retention_confidence, retention_evidence,
  created_by
) on public.processing_activity to authenticated;
grant update (
  purpose, purpose_confidence, purpose_evidence,
  recipient_vendor, recipient_vendor_confidence, recipient_vendor_evidence,
  role,
  data_categories_ordinary, data_categories_special,
  data_categories_confidence, data_categories_evidence,
  data_subjects, data_subjects_confidence, data_subjects_evidence,
  retention, retention_confidence, retention_evidence
) on public.processing_activity to authenticated;

grant select, insert on public.processing_activity_share to authenticated;

-- Belt and braces against the one thing that must never happen: an insert that
-- arrives already approved. The grant above makes `status` unwritable, so this
-- can only fire for the service role or a future definer function — which is
-- exactly who needs stopping, since they bypass the grant.
create or replace function app.force_pending_on_insert()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from 'pending_dpo_review' then
    raise exception 'a processing activity cannot be created already approved; use approve_processing_activity'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger processing_activity_starts_pending
  before insert on public.processing_activity
  for each row execute function app.force_pending_on_insert();

-- ---------------------------------------------------------------------------
-- Approval (§4)
--
-- Same authorization shape as `create_tenant`: the caller asserts who they are
-- acting as, the session decides, and a mismatch is refused rather than
-- silently corrected. An activity in a tenant the caller does not run is
-- reported as missing, never as forbidden.
-- ---------------------------------------------------------------------------
create or replace function public.approve_processing_activity(
  p_caller_person_id uuid,
  p_activity_id uuid
)
returns public.processing_activity
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.processing_activity;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  -- Definer bypasses RLS, so the caller's right to approve is checked here in
  -- full. `is not true` treats a NULL predicate as a refusal — see app.has_tier.
  select * into v_row from public.processing_activity where id = p_activity_id;

  if v_row.id is null
     or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  -- Idempotent: approving twice satisfies the same intent, and the original
  -- approver's name stays on the row rather than being overwritten by whoever
  -- clicked last.
  if v_row.status = 'approved' then
    return v_row;
  end if;

  update public.processing_activity
     set status = 'approved',
         approved_at = now(),
         approved_by = v_session_person
   where id = p_activity_id
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function public.approve_processing_activity(uuid, uuid) from public, anon;
grant execute on function public.approve_processing_activity(uuid, uuid) to authenticated, service_role;
