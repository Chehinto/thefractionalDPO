-- AI-assisted vendor evidence and DPIA questionnaire pipeline.
--
-- This is the upstream evidence layer for §2 item 3: upload or paste vendor
-- privacy/T&C/cookie/DPA/security material, extract a first view, generate a
-- gap-driven questionnaire, ingest the returned answers, and prepare
-- reconciliation drafts for DPO review.
--
-- It deliberately does NOT write to the canonical `dpia` table. AI output and
-- vendor answers are evidence; the DPO's signed DPIA remains the canonical
-- assessment and is still approved through `approve_dpia`.

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------

create type public.vendor_document_type as enum (
  'privacy_policy',
  'terms',
  'cookie_policy',
  'dpa',
  'subprocessors',
  'security_page',
  'questionnaire_response',
  'other'
);

create type public.vendor_fact_subject as enum (
  'purposes',
  'data_categories',
  'data_subjects',
  'role',
  'subprocessors',
  'international_transfers',
  'retention',
  'security_measures',
  'cookies_tracking',
  'legal_basis',
  'risk_signal',
  'other'
);

create type public.question_answer_type as enum (
  'free_text',
  'yes_no',
  'document_upload'
);

create type public.ai_task as enum (
  'vendor_document_extraction',
  'vendor_questionnaire_generation',
  'vendor_response_reconciliation',
  'processing_activity_draft',
  'passage_indexing',
  'classification'
);

create type public.ai_tier as enum ('fast', 'capable');
create type public.ai_billed_to as enum ('platform', 'customer');

-- Composite FKs below need tenant-aware uniqueness on `dpia`, just as 0005
-- added it to `processing_activity`. This stops an upstream draft from being
-- attached to a signed assessment in another workspace even if a future policy
-- refactor gets the read side wrong.
alter table public.dpia
  add constraint dpia_id_tenant_key unique (id, tenant_id);

-- ---------------------------------------------------------------------------
-- Vendor source documents
-- ---------------------------------------------------------------------------

create table public.vendor_document (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  processing_activity_id uuid,

  vendor_name text not null check (length(btrim(vendor_name)) > 0),
  document_type public.vendor_document_type not null,
  title text,
  source_url text,
  content text not null check (length(btrim(content)) > 0),
  content_sha256 text,

  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,

  constraint vendor_document_activity_same_tenant
    foreign key (processing_activity_id, tenant_id)
    references public.processing_activity (id, tenant_id)
    on delete restrict,

  unique (id, tenant_id)
);

create index vendor_document_tenant_idx
  on public.vendor_document (tenant_id, vendor_name, document_type);

-- ---------------------------------------------------------------------------
-- AI-extracted vendor facts
-- ---------------------------------------------------------------------------

create table public.vendor_extracted_fact (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  vendor_document_id uuid not null,

  subject public.vendor_fact_subject not null,
  label text not null check (length(btrim(label)) > 0),
  value text,
  confidence public.confidence_tag not null,
  evidence text not null check (length(btrim(evidence)) > 0),
  -- AxioVendo lesson: citations must not imply precision we do not have.
  -- Pages and offsets are optional, but if recorded they must be real source
  -- positions captured at ingest/reconciliation time rather than invented later.
  source_pages integer[] not null default '{}',
  source_char_start integer check (source_char_start is null or source_char_start >= 0),
  source_char_end integer check (
    source_char_end is null
    or (source_char_start is not null and source_char_end >= source_char_start)
  ),

  status public.review_status not null default 'pending_dpo_review',
  model_name text,
  prompt_key text,
  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references public.people (id) on delete set null,

  constraint vendor_fact_document_same_tenant
    foreign key (vendor_document_id, tenant_id)
    references public.vendor_document (id, tenant_id)
    on delete restrict,

  constraint approved_vendor_facts_are_attributed check (
    (status = 'approved' and approved_at is not null and approved_by is not null)
    or (status = 'pending_dpo_review' and approved_at is null and approved_by is null)
  ),

  unique (id, tenant_id)
);

create index vendor_extracted_fact_tenant_idx
  on public.vendor_extracted_fact (tenant_id, vendor_document_id, status);

-- ---------------------------------------------------------------------------
-- Generated questionnaires
-- ---------------------------------------------------------------------------

create table public.vendor_questionnaire (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  processing_activity_id uuid,
  dpia_id uuid,

  vendor_name text not null check (length(btrim(vendor_name)) > 0),
  status public.review_status not null default 'pending_dpo_review',
  rationale text not null check (length(btrim(rationale)) > 0),

  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references public.people (id) on delete set null,

  constraint vendor_questionnaire_activity_same_tenant
    foreign key (processing_activity_id, tenant_id)
    references public.processing_activity (id, tenant_id)
    on delete restrict,

  constraint vendor_questionnaire_dpia_same_tenant
    foreign key (dpia_id, tenant_id)
    references public.dpia (id, tenant_id)
    on delete restrict,

  constraint approved_vendor_questionnaires_are_attributed check (
    (status = 'approved' and approved_at is not null and approved_by is not null)
    or (status = 'pending_dpo_review' and approved_at is null and approved_by is null)
  ),

  unique (id, tenant_id)
);

create index vendor_questionnaire_tenant_idx
  on public.vendor_questionnaire (tenant_id, processing_activity_id, status);

create table public.vendor_questionnaire_question (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  questionnaire_id uuid not null,

  position integer not null check (position > 0),
  question text not null check (length(btrim(question)) > 0),
  answer_type public.question_answer_type not null default 'free_text',
  why_needed text not null check (length(btrim(why_needed)) > 0),
  evidence_gap text,

  created_at timestamptz not null default now(),

  constraint vendor_question_same_tenant
    foreign key (questionnaire_id, tenant_id)
    references public.vendor_questionnaire (id, tenant_id)
    on delete restrict,

  unique (questionnaire_id, position),
  unique (id, questionnaire_id, tenant_id),
  unique (id, tenant_id)
);

create index vendor_questionnaire_question_tenant_idx
  on public.vendor_questionnaire_question (tenant_id, questionnaire_id, position);

-- ---------------------------------------------------------------------------
-- Returned questionnaire answers
-- ---------------------------------------------------------------------------

create table public.vendor_questionnaire_response (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  questionnaire_id uuid not null,
  question_id uuid not null,
  vendor_document_id uuid,

  respondent_email text,
  answer text not null check (length(btrim(answer)) > 0),
  evidence text,
  received_at timestamptz not null default now(),
  recorded_by uuid references public.people (id) on delete set null,

  constraint vendor_response_questionnaire_same_tenant
    foreign key (questionnaire_id, tenant_id)
    references public.vendor_questionnaire (id, tenant_id)
    on delete restrict,

  constraint vendor_response_question_same_questionnaire
    foreign key (question_id, questionnaire_id, tenant_id)
    references public.vendor_questionnaire_question (id, questionnaire_id, tenant_id)
    on delete restrict,

  constraint vendor_response_document_same_tenant
    foreign key (vendor_document_id, tenant_id)
    references public.vendor_document (id, tenant_id)
    on delete restrict,

  unique (id, tenant_id)
);

create index vendor_questionnaire_response_tenant_idx
  on public.vendor_questionnaire_response (tenant_id, questionnaire_id, question_id);

-- ---------------------------------------------------------------------------
-- Reconciliation drafts
-- ---------------------------------------------------------------------------

create table public.vendor_dpia_reconciliation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  dpia_id uuid not null,
  questionnaire_response_id uuid,
  source_fact_id uuid,

  target_field text not null check (length(btrim(target_field)) > 0),
  proposed_value text not null check (length(btrim(proposed_value)) > 0),
  confidence public.confidence_tag not null,
  evidence text not null check (length(btrim(evidence)) > 0),
  conflict_note text,

  status public.review_status not null default 'pending_dpo_review',
  model_name text,
  prompt_key text,
  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references public.people (id) on delete set null,

  constraint vendor_reconciliation_dpia_same_tenant
    foreign key (dpia_id, tenant_id)
    references public.dpia (id, tenant_id)
    on delete restrict,

  constraint vendor_reconciliation_response_same_tenant
    foreign key (questionnaire_response_id, tenant_id)
    references public.vendor_questionnaire_response (id, tenant_id)
    on delete restrict,

  constraint vendor_reconciliation_fact_same_tenant
    foreign key (source_fact_id, tenant_id)
    references public.vendor_extracted_fact (id, tenant_id)
    on delete restrict,

  constraint vendor_reconciliation_has_source
    check (questionnaire_response_id is not null or source_fact_id is not null),

  constraint approved_vendor_reconciliations_are_attributed check (
    (status = 'approved' and approved_at is not null and approved_by is not null)
    or (status = 'pending_dpo_review' and approved_at is null and approved_by is null)
  )
);

create index vendor_dpia_reconciliation_tenant_idx
  on public.vendor_dpia_reconciliation (tenant_id, dpia_id, status);

-- ---------------------------------------------------------------------------
-- AI call accounting
--
-- Reused from AxioVendo in spirit: task -> tier decisions are only defensible
-- if failed cheap attempts, escalations and token counts are recorded. This is
-- server-written only; app users can read their own tenant's usage, never write
-- it, because a client-side caller could under-report cost.
-- ---------------------------------------------------------------------------

create table public.ai_call (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  task public.ai_task not null,
  model text not null check (length(btrim(model)) > 0),
  tier public.ai_tier not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  escalated boolean not null default false,
  ok boolean not null default true,
  billed_to public.ai_billed_to not null default 'platform',

  vendor_document_id uuid,
  questionnaire_id uuid,
  dpia_id uuid,
  created_at timestamptz not null default now(),

  constraint ai_call_vendor_document_same_tenant
    foreign key (vendor_document_id, tenant_id)
    references public.vendor_document (id, tenant_id)
    on delete restrict,

  constraint ai_call_questionnaire_same_tenant
    foreign key (questionnaire_id, tenant_id)
    references public.vendor_questionnaire (id, tenant_id)
    on delete restrict,

  constraint ai_call_dpia_same_tenant
    foreign key (dpia_id, tenant_id)
    references public.dpia (id, tenant_id)
    on delete restrict
);

create index ai_call_tenant_idx
  on public.ai_call (tenant_id, created_at desc);
create index ai_call_task_idx
  on public.ai_call (tenant_id, task);

-- ---------------------------------------------------------------------------
-- RLS
--
-- Active DPO only. Vendor documents and generated DPIA material are the DPO's
-- working evidence. There is deliberately no tier-2 staff read path and no
-- public vendor link yet; the vendor-facing round-trip will need hashed,
-- expiring tokens rather than a membership row or a broad anon policy.
-- ---------------------------------------------------------------------------

alter table public.vendor_document enable row level security;
alter table public.vendor_extracted_fact enable row level security;
alter table public.vendor_questionnaire enable row level security;
alter table public.vendor_questionnaire_question enable row level security;
alter table public.vendor_questionnaire_response enable row level security;
alter table public.vendor_dpia_reconciliation enable row level security;
alter table public.ai_call enable row level security;

create policy vendor_document_read on public.vendor_document
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy vendor_document_insert on public.vendor_document
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy vendor_extracted_fact_read on public.vendor_extracted_fact
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy vendor_extracted_fact_insert on public.vendor_extracted_fact
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy vendor_extracted_fact_update on public.vendor_extracted_fact
  for update to authenticated
  using (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id))
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy vendor_questionnaire_read on public.vendor_questionnaire
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy vendor_questionnaire_insert on public.vendor_questionnaire
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy vendor_questionnaire_update on public.vendor_questionnaire
  for update to authenticated
  using (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id))
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy vendor_questionnaire_question_read on public.vendor_questionnaire_question
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy vendor_questionnaire_question_insert on public.vendor_questionnaire_question
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy vendor_questionnaire_response_read on public.vendor_questionnaire_response
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy vendor_questionnaire_response_insert on public.vendor_questionnaire_response
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy vendor_dpia_reconciliation_read on public.vendor_dpia_reconciliation
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy vendor_dpia_reconciliation_insert on public.vendor_dpia_reconciliation
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy vendor_dpia_reconciliation_update on public.vendor_dpia_reconciliation
  for update to authenticated
  using (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id))
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy ai_call_read on public.ai_call
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

-- ---------------------------------------------------------------------------
-- Grants. Status and approval stamps are never client-writable.
-- ---------------------------------------------------------------------------

revoke all on public.vendor_document from anon, authenticated;
revoke all on public.vendor_extracted_fact from anon, authenticated;
revoke all on public.vendor_questionnaire from anon, authenticated;
revoke all on public.vendor_questionnaire_question from anon, authenticated;
revoke all on public.vendor_questionnaire_response from anon, authenticated;
revoke all on public.vendor_dpia_reconciliation from anon, authenticated;
revoke all on public.ai_call from anon, authenticated;

grant select, insert on public.vendor_document to authenticated;

grant select on public.vendor_extracted_fact to authenticated;
grant insert (
  tenant_id, vendor_document_id,
  subject, label, value, confidence, evidence,
  source_pages, source_char_start, source_char_end,
  model_name, prompt_key, created_by
) on public.vendor_extracted_fact to authenticated;
grant update (
  subject, label, value, confidence, evidence,
  source_pages, source_char_start, source_char_end,
  model_name, prompt_key
) on public.vendor_extracted_fact to authenticated;

grant select on public.vendor_questionnaire to authenticated;
grant insert (
  tenant_id, processing_activity_id, dpia_id,
  vendor_name, rationale, created_by
) on public.vendor_questionnaire to authenticated;
grant update (
  vendor_name, rationale
) on public.vendor_questionnaire to authenticated;

grant select, insert on public.vendor_questionnaire_question to authenticated;
grant select, insert on public.vendor_questionnaire_response to authenticated;

grant select on public.vendor_dpia_reconciliation to authenticated;
grant insert (
  tenant_id, dpia_id, questionnaire_response_id, source_fact_id,
  target_field, proposed_value, confidence, evidence,
  conflict_note, model_name, prompt_key, created_by
) on public.vendor_dpia_reconciliation to authenticated;
grant update (
  target_field, proposed_value, confidence, evidence,
  conflict_note, model_name, prompt_key
) on public.vendor_dpia_reconciliation to authenticated;

grant select on public.ai_call to authenticated;

-- ---------------------------------------------------------------------------
-- Draft discipline
-- ---------------------------------------------------------------------------

create or replace function app.force_vendor_fact_pending_on_insert()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from 'pending_dpo_review' then
    raise exception 'an extracted vendor fact cannot be created already approved'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger vendor_fact_starts_pending
  before insert on public.vendor_extracted_fact
  for each row execute function app.force_vendor_fact_pending_on_insert();

create or replace function app.force_vendor_questionnaire_pending_on_insert()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from 'pending_dpo_review' then
    raise exception 'a generated questionnaire cannot be created already approved'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger vendor_questionnaire_starts_pending
  before insert on public.vendor_questionnaire
  for each row execute function app.force_vendor_questionnaire_pending_on_insert();

create or replace function app.force_vendor_reconciliation_pending_on_insert()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from 'pending_dpo_review' then
    raise exception 'a reconciliation draft cannot be created already approved'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger vendor_reconciliation_starts_pending
  before insert on public.vendor_dpia_reconciliation
  for each row execute function app.force_vendor_reconciliation_pending_on_insert();

-- ---------------------------------------------------------------------------
-- Approval functions
--
-- These approve the evidence/draft object only. They do not mutate canonical
-- `dpia` content; a DPO still has to decide what to write into the signed
-- assessment.
-- ---------------------------------------------------------------------------

create or replace function public.approve_vendor_extracted_fact(
  p_caller_person_id uuid,
  p_fact_id uuid
)
returns public.vendor_extracted_fact
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.vendor_extracted_fact;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.vendor_extracted_fact where id = p_fact_id;

  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  if v_row.status = 'approved' then
    return v_row;
  end if;

  update public.vendor_extracted_fact
     set status = 'approved',
         approved_at = now(),
         approved_by = v_session_person
   where id = p_fact_id
  returning * into v_row;

  return v_row;
end
$$;

create or replace function public.approve_vendor_questionnaire(
  p_caller_person_id uuid,
  p_questionnaire_id uuid
)
returns public.vendor_questionnaire
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.vendor_questionnaire;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.vendor_questionnaire where id = p_questionnaire_id;

  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.vendor_questionnaire_question q
    where q.questionnaire_id = p_questionnaire_id
  ) then
    raise exception 'a questionnaire needs at least one question before approval'
      using errcode = '22023';
  end if;

  if v_row.status = 'approved' then
    return v_row;
  end if;

  update public.vendor_questionnaire
     set status = 'approved',
         approved_at = now(),
         approved_by = v_session_person
   where id = p_questionnaire_id
  returning * into v_row;

  return v_row;
end
$$;

create or replace function public.approve_vendor_dpia_reconciliation(
  p_caller_person_id uuid,
  p_reconciliation_id uuid
)
returns public.vendor_dpia_reconciliation
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.vendor_dpia_reconciliation;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.vendor_dpia_reconciliation where id = p_reconciliation_id;

  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  if v_row.status = 'approved' then
    return v_row;
  end if;

  update public.vendor_dpia_reconciliation
     set status = 'approved',
         approved_at = now(),
         approved_by = v_session_person
   where id = p_reconciliation_id
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function
  public.approve_vendor_extracted_fact(uuid, uuid),
  public.approve_vendor_questionnaire(uuid, uuid),
  public.approve_vendor_dpia_reconciliation(uuid, uuid)
from public, anon;

grant execute on function
  public.approve_vendor_extracted_fact(uuid, uuid),
  public.approve_vendor_questionnaire(uuid, uuid),
  public.approve_vendor_dpia_reconciliation(uuid, uuid)
to authenticated, service_role;
