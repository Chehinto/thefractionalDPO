-- Generated training, reviewed before anyone sees it.
--
-- Three product rules move into the schema here, because each is the kind of
-- thing a page can forget and a constraint cannot:
--
--   Pass at 90%. Below that the module is retaken, not partially credited.
--   Under 10 minutes. A module nobody finishes teaches nobody anything.
--   A DPO reviews generated content before it is published.
--
-- That last one is CLAUDE.md's standing rule — "AI-drafted output never writes
-- to a canonical record directly" — applied to the one place in this product
-- where a model's words are read by staff as their employer's instruction. A
-- register draft that is wrong wastes a DPO's afternoon. A published training
-- module that is wrong teaches thirty people the wrong thing and produces a
-- signed record saying they were trained correctly.

create type public.training_source as enum ('authored', 'ai_generated');

alter table public.training_module
  add column if not exists source public.training_source not null default 'authored',
  add column if not exists estimated_minutes integer not null default 5,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.people (id) on delete set null,
  add column if not exists model_name text,
  add column if not exists prompt_key text;

-- Ten minutes is the ceiling, not a suggestion. Compliance training competes
-- with the actual job; a module that runs long is one people click through.
alter table public.training_module
  add constraint training_module_fits_in_a_break
    check (estimated_minutes between 1 and 10);

-- 90% is the pass mark. Left adjustable upward but not below, because the rule
-- exists to stop "most of it" counting as knowing it.
alter table public.training_module
  alter column pass_mark set default 90;

alter table public.training_module
  add constraint training_module_pass_mark_is_demanding
    check (pass_mark >= 90);

-- Generated content cannot reach staff without a named human behind it.
-- Authored content is already the DPO's own words, so it needs no second pass.
alter table public.training_module
  add constraint generated_training_is_reviewed_before_publishing
    check (
      not published
      or source = 'authored'
      or (reviewed_at is not null and reviewed_by is not null)
    );

-- `published` leaves the update grant: publishing IS the review act, and it has
-- to be attributed. The function below is the only door.
revoke update on public.training_module from authenticated;
grant update (title, body, pass_mark, estimated_minutes) on public.training_module to authenticated;
grant insert (
  tenant_id, title, body, pass_mark, estimated_minutes,
  source, model_name, prompt_key, created_by
) on public.training_module to authenticated;

/**
 * Publish a module, recording who stood behind it.
 *
 * For generated content this is the approval gate. The reviewer's id is stamped
 * on the row, so "who signed off on what staff were told" is answerable from
 * the record rather than from memory.
 */
create or replace function public.publish_training_module(
  p_caller_person_id uuid,
  p_module_id uuid
)
returns public.training_module
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.training_module;
  v_questions integer;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null or p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.training_module where id = p_module_id;

  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  -- Every question needs an answer key, or the quiz silently marks it wrong for
  -- everyone. Checked here rather than trusted, because generated questions
  -- arrive as a batch and one missing key is invisible on screen.
  select count(*) into v_questions
  from public.training_question q
  left join public.training_answer_key k on k.question_id = q.id
  where q.module_id = p_module_id and k.question_id is null;

  if v_questions > 0 then
    raise exception 'every question needs an answer before this can be published'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.training_question q where q.module_id = p_module_id) then
    raise exception 'a module with no questions cannot be published' using errcode = '22023';
  end if;

  update public.training_module
     set published = true,
         reviewed_at = now(),
         reviewed_by = v_session_person
   where id = p_module_id
  returning * into v_row;

  return v_row;
end
$$;

/**
 * Assign a module to every live member of the workspace.
 *
 * "Send it to everyone" is the common case and doing it one person at a time
 * invites missing someone — which is the failure that matters, because the
 * value of a training record is being able to say who has NOT done it.
 *
 * Skips anyone who already has an open assignment for this module, so pressing
 * it twice does not give people two copies of the same task.
 */
create or replace function public.assign_training_to_everyone(
  p_caller_person_id uuid,
  p_tenant_id uuid,
  p_module_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_module public.training_module;
  v_assigned integer;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null or p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  if app.has_tier(p_tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(p_tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  select * into v_module from public.training_module
  where id = p_module_id and tenant_id = p_tenant_id;

  if v_module.id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  -- An unpublished module is a draft. Sending a draft to the whole company is
  -- the mistake this refuses to let a DPO make.
  if v_module.published is not true then
    raise exception 'publish this module before sending it to anyone'
      using errcode = '22023';
  end if;

  with recipients as (
    select m.person_id
    from public.memberships m
    where m.tenant_id = p_tenant_id
      and app.is_live(m.active_from, m.active_to)
      and not exists (
        select 1 from public.assignment a
        where a.tenant_id = p_tenant_id
          and a.assignee_id = m.person_id
          and a.training_module_id = p_module_id
          and a.status = 'pending'
      )
  )
  insert into public.assignment (
    tenant_id, assignee_id, kind, title, body, why_asked, training_module_id, created_by
  )
  select
    p_tenant_id,
    r.person_id,
    'training_module',
    v_module.title,
    'Training assigned to everyone with access to this workspace.',
    'Everyone here handles personal data at some point. This is the shared baseline.',
    p_module_id,
    v_session_person
  from recipients r;

  get diagnostics v_assigned = row_count;
  return v_assigned;
end
$$;

revoke all on function public.publish_training_module(uuid, uuid) from public, anon;
grant execute on function public.publish_training_module(uuid, uuid) to authenticated, service_role;

revoke all on function public.assign_training_to_everyone(uuid, uuid, uuid) from public, anon;
grant execute on function public.assign_training_to_everyone(uuid, uuid, uuid) to authenticated, service_role;
