-- Cross-product AI suggestion review rail.
--
-- This is the shared place for AI help that does not already have a more
-- specific draft table. It lets the product add AI to register intake,
-- DPIA drafting, vendor review, document drafting and governance nudges
-- without giving the model a write path into canonical compliance records.
--
-- AxioVendo rule: every AI response or decision is stored beside the source
-- text it relied on, a confidence tag and a numeric confidence score.

create type public.ai_suggestion_kind as enum (
  'register_intake',
  'register_reconciliation',
  'dpia_risk_summary',
  'dpia_mitigation',
  'vendor_first_view',
  'vendor_questionnaire_follow_up',
  'vendor_response_reconciliation',
  'privacy_notice_section',
  'cookie_notice_section',
  'retention_policy_section',
  'governance_next_action'
);

create table public.ai_suggestion (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,

  kind public.ai_suggestion_kind not null,
  title text not null check (length(btrim(title)) > 0),
  response_text text not null check (length(btrim(response_text)) > 0),

  -- Required. A suggestion without its source beside it is not reviewable, and
  -- a DPO should not have to reconstruct the prompt context from logs.
  source_excerpt text not null check (length(btrim(source_excerpt)) > 0),
  source_label text,
  confidence public.confidence_tag not null,
  confidence_score integer not null check (confidence_score between 1 and 100),

  processing_activity_id uuid,
  dpia_id uuid,
  vendor_document_id uuid,
  vendor_questionnaire_id uuid,
  vendor_questionnaire_response_id uuid,
  generated_document_draft_id uuid,

  status public.review_status not null default 'pending_dpo_review',
  model_name text,
  prompt_key text,
  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references public.people (id) on delete set null,

  constraint ai_suggestion_activity_same_tenant
    foreign key (processing_activity_id, tenant_id)
    references public.processing_activity (id, tenant_id)
    on delete restrict,

  constraint ai_suggestion_dpia_same_tenant
    foreign key (dpia_id, tenant_id)
    references public.dpia (id, tenant_id)
    on delete restrict,

  constraint ai_suggestion_vendor_document_same_tenant
    foreign key (vendor_document_id, tenant_id)
    references public.vendor_document (id, tenant_id)
    on delete restrict,

  constraint ai_suggestion_vendor_questionnaire_same_tenant
    foreign key (vendor_questionnaire_id, tenant_id)
    references public.vendor_questionnaire (id, tenant_id)
    on delete restrict,

  constraint ai_suggestion_vendor_response_same_tenant
    foreign key (vendor_questionnaire_response_id, tenant_id)
    references public.vendor_questionnaire_response (id, tenant_id)
    on delete restrict,

  constraint ai_suggestion_generated_document_same_tenant
    foreign key (generated_document_draft_id, tenant_id)
    references public.generated_document_draft (id, tenant_id)
    on delete restrict,

  constraint approved_ai_suggestions_are_attributed check (
    (status = 'approved' and approved_at is not null and approved_by is not null)
    or (status = 'pending_dpo_review' and approved_at is null and approved_by is null)
  ),

  unique (id, tenant_id)
);

create index ai_suggestion_tenant_idx
  on public.ai_suggestion (tenant_id, status, kind, created_at desc);
create index ai_suggestion_activity_idx
  on public.ai_suggestion (tenant_id, processing_activity_id)
  where processing_activity_id is not null;
create index ai_suggestion_dpia_idx
  on public.ai_suggestion (tenant_id, dpia_id)
  where dpia_id is not null;

alter table public.ai_suggestion enable row level security;

create policy ai_suggestion_read on public.ai_suggestion
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy ai_suggestion_insert on public.ai_suggestion
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy ai_suggestion_update on public.ai_suggestion
  for update to authenticated
  using (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id))
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

revoke all on public.ai_suggestion from anon, authenticated;
grant select on public.ai_suggestion to authenticated;
grant insert (
  tenant_id, kind, title, response_text,
  source_excerpt, source_label, confidence, confidence_score,
  processing_activity_id, dpia_id, vendor_document_id,
  vendor_questionnaire_id, vendor_questionnaire_response_id,
  generated_document_draft_id,
  model_name, prompt_key, created_by
) on public.ai_suggestion to authenticated;
grant update (
  kind, title, response_text,
  source_excerpt, source_label, confidence, confidence_score,
  processing_activity_id, dpia_id, vendor_document_id,
  vendor_questionnaire_id, vendor_questionnaire_response_id,
  generated_document_draft_id,
  model_name, prompt_key
) on public.ai_suggestion to authenticated;

create or replace function app.force_ai_suggestion_pending_on_insert()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from 'pending_dpo_review' then
    raise exception 'an AI suggestion cannot be created already approved'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger ai_suggestion_starts_pending
  before insert on public.ai_suggestion
  for each row execute function app.force_ai_suggestion_pending_on_insert();

create or replace function public.approve_ai_suggestion(
  p_caller_person_id uuid,
  p_suggestion_id uuid
)
returns public.ai_suggestion
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.ai_suggestion;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.ai_suggestion where id = p_suggestion_id;

  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  if v_row.status = 'approved' then
    return v_row;
  end if;

  -- This is a review stamp only. Applying the suggestion to a register row,
  -- DPIA, vendor record or generated document remains a separate explicit
  -- product path so AI output cannot become canonical by approval side effect.
  update public.ai_suggestion
     set status = 'approved',
         approved_at = now(),
         approved_by = v_session_person
   where id = p_suggestion_id
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function public.approve_ai_suggestion(uuid, uuid) from public, anon;
grant execute on function public.approve_ai_suggestion(uuid, uuid)
to authenticated, service_role;
