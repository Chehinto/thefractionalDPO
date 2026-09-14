-- AI confidence scoring and cautious document-generation drafts.
--
-- AxioVendo rule carried forward: every AI answer or decision must sit next to
-- the source text it relied on and a confidence score. The enum confidence tag
-- answers "what kind of evidence is this?"; the numeric score answers "how
-- strongly did the model think this output follows from that evidence?".
--
-- Document generation is stricter than extraction: generated text is not a
-- canonical policy, privacy notice or cookie notice. It is a sectioned draft
-- with cited source excerpts and confidence scores, and approval only records
-- DPO review of the draft. Publishing/export is a separate future path.

-- ---------------------------------------------------------------------------
-- Confidence scores for existing AI-produced objects
-- ---------------------------------------------------------------------------

alter table public.vendor_extracted_fact
  add column if not exists confidence_score integer not null default 0
    check (confidence_score between 0 and 100);

alter table public.vendor_questionnaire_question
  add column if not exists confidence_score integer not null default 0
    check (confidence_score between 0 and 100),
  add column if not exists source_excerpt text;

alter table public.vendor_dpia_reconciliation
  add column if not exists confidence_score integer not null default 0
    check (confidence_score between 0 and 100),
  add column if not exists source_excerpt text;

-- New AI rows must carry the score/source discipline. Existing rows keep the
-- default score because this migration cannot honestly reconstruct a model's
-- past certainty.
alter table public.vendor_extracted_fact
  add constraint vendor_fact_ai_score_required
    check (status = 'approved' or confidence_score > 0) not valid;

alter table public.vendor_questionnaire_question
  add constraint vendor_question_ai_source_required
    check (confidence_score > 0 and length(btrim(coalesce(source_excerpt, evidence_gap, why_needed))) > 0) not valid;

alter table public.vendor_dpia_reconciliation
  add constraint vendor_reconciliation_ai_source_required
    check (confidence_score > 0 and length(btrim(coalesce(source_excerpt, evidence))) > 0) not valid;

-- Restate grants in full because column grant lists replace rather than add.
grant insert (
  tenant_id, vendor_document_id,
  subject, label, value, confidence, confidence_score, evidence,
  source_pages, source_char_start, source_char_end,
  model_name, prompt_key, created_by
) on public.vendor_extracted_fact to authenticated;
grant update (
  subject, label, value, confidence, confidence_score, evidence,
  source_pages, source_char_start, source_char_end,
  model_name, prompt_key
) on public.vendor_extracted_fact to authenticated;

grant select, insert (
  tenant_id, questionnaire_id,
  position, question, answer_type, why_needed, evidence_gap,
  confidence_score, source_excerpt
) on public.vendor_questionnaire_question to authenticated;

grant insert (
  tenant_id, dpia_id, questionnaire_response_id, source_fact_id,
  target_field, proposed_value, confidence, confidence_score, evidence,
  source_excerpt, conflict_note, model_name, prompt_key, created_by
) on public.vendor_dpia_reconciliation to authenticated;
grant update (
  target_field, proposed_value, confidence, confidence_score, evidence,
  source_excerpt, conflict_note, model_name, prompt_key
) on public.vendor_dpia_reconciliation to authenticated;

-- ---------------------------------------------------------------------------
-- Generated document drafts
-- ---------------------------------------------------------------------------

create type public.generated_document_type as enum (
  'privacy_notice',
  'internal_policy',
  'cookie_notice',
  'retention_notice',
  'other'
);

create table public.generated_document_draft (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  processing_activity_id uuid,
  dpia_id uuid,

  document_type public.generated_document_type not null,
  title text not null check (length(btrim(title)) > 0),
  status public.review_status not null default 'pending_dpo_review',
  generation_rationale text not null check (length(btrim(generation_rationale)) > 0),
  model_name text,
  prompt_key text,

  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references public.people (id) on delete set null,

  constraint generated_document_activity_same_tenant
    foreign key (processing_activity_id, tenant_id)
    references public.processing_activity (id, tenant_id)
    on delete restrict,

  constraint generated_document_dpia_same_tenant
    foreign key (dpia_id, tenant_id)
    references public.dpia (id, tenant_id)
    on delete restrict,

  constraint approved_generated_documents_are_attributed check (
    (status = 'approved' and approved_at is not null and approved_by is not null)
    or (status = 'pending_dpo_review' and approved_at is null and approved_by is null)
  ),

  unique (id, tenant_id)
);

create table public.generated_document_section (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  draft_id uuid not null,

  position integer not null check (position > 0),
  heading text not null check (length(btrim(heading)) > 0),
  body text not null check (length(btrim(body)) > 0),

  -- Required. A generated clause without the source text beside it is just
  -- polished prose; a DPO cannot review it without redoing the model's work.
  source_excerpt text not null check (length(btrim(source_excerpt)) > 0),
  source_label text,
  confidence public.confidence_tag not null,
  confidence_score integer not null check (confidence_score between 1 and 100),
  model_name text,
  prompt_key text,
  created_at timestamptz not null default now(),

  constraint generated_section_draft_same_tenant
    foreign key (draft_id, tenant_id)
    references public.generated_document_draft (id, tenant_id)
    on delete restrict,

  unique (draft_id, position),
  unique (id, tenant_id)
);

create index generated_document_draft_tenant_idx
  on public.generated_document_draft (tenant_id, document_type, status);
create index generated_document_section_tenant_idx
  on public.generated_document_section (tenant_id, draft_id, position);

alter table public.generated_document_draft enable row level security;
alter table public.generated_document_section enable row level security;

create policy generated_document_draft_read on public.generated_document_draft
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy generated_document_draft_insert on public.generated_document_draft
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy generated_document_draft_update on public.generated_document_draft
  for update to authenticated
  using (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id))
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy generated_document_section_read on public.generated_document_section
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy generated_document_section_insert on public.generated_document_section
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

revoke all on public.generated_document_draft from anon, authenticated;
revoke all on public.generated_document_section from anon, authenticated;

grant select on public.generated_document_draft to authenticated;
grant insert (
  tenant_id, processing_activity_id, dpia_id,
  document_type, title, generation_rationale,
  model_name, prompt_key, created_by
) on public.generated_document_draft to authenticated;
grant update (
  document_type, title, generation_rationale,
  model_name, prompt_key
) on public.generated_document_draft to authenticated;

grant select, insert on public.generated_document_section to authenticated;

create or replace function app.force_generated_document_pending_on_insert()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from 'pending_dpo_review' then
    raise exception 'a generated document cannot be created already approved'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger generated_document_starts_pending
  before insert on public.generated_document_draft
  for each row execute function app.force_generated_document_pending_on_insert();

create or replace function public.approve_generated_document_draft(
  p_caller_person_id uuid,
  p_draft_id uuid
)
returns public.generated_document_draft
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.generated_document_draft;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.generated_document_draft where id = p_draft_id;

  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  if v_row.status = 'approved' then
    return v_row;
  end if;

  -- Approval means "this cited draft has been reviewed", not "publish this".
  -- Requiring section evidence here keeps a generated shell document from
  -- becoming reviewed just because its title looked right.
  if not exists (
    select 1 from public.generated_document_section s
    where s.draft_id = p_draft_id
  ) then
    raise exception 'a generated document needs at least one cited section before approval'
      using errcode = '22023';
  end if;

  update public.generated_document_draft
     set status = 'approved',
         approved_at = now(),
         approved_by = v_session_person
   where id = p_draft_id
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function public.approve_generated_document_draft(uuid, uuid) from public, anon;
grant execute on function public.approve_generated_document_draft(uuid, uuid)
to authenticated, service_role;
