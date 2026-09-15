-- Staff training: content and a quiz (design resume §2.5, §3).
--
-- §3 records the competitor gap precisely: "their 'staff training' is a record
-- of who was trained, not training content itself". So this stores the module a
-- person reads and the questions they answer, and the attendance record falls
-- out of that rather than being the whole product.
--
-- WHY THE ANSWER KEY IS ITS OWN TABLE.
--
-- The obvious shape is `training_question(question, options, correct_index)`
-- with a column grant withholding `correct_index` from trainees. That does not
-- work here, and the reason is worth writing down: a staff member and an Active
-- DPO are the SAME Postgres role, `authenticated`. Column grants are per-role,
-- so there is no grant that shows the key to one and hides it from the other.
-- A trainee could read the answers straight from the API and the quiz would
-- measure nothing.
--
-- Row level security IS per-row, so the key moves to its own table with a
-- DPO-only policy. Grading then happens in a SECURITY DEFINER function, which
-- is the only thing that reads both sides.

create table public.training_module (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,

  title text not null check (length(btrim(title)) > 0),
  -- The actual teaching. §3's differentiator lives in this column.
  body text not null check (length(btrim(body)) > 0),

  pass_mark integer not null default 80 check (pass_mark between 1 and 100),

  -- Assigning an unfinished module would waste the one pass of attention a
  -- staff member gives this.
  published boolean not null default false,

  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,

  unique (id, tenant_id)
);

create table public.training_question (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  module_id uuid not null,

  position integer not null check (position > 0),
  question text not null check (length(btrim(question)) > 0),
  options text[] not null check (array_length(options, 1) >= 2),

  constraint training_question_module_same_tenant
    foreign key (module_id, tenant_id)
    references public.training_module (id, tenant_id)
    on delete restrict,

  unique (module_id, position),
  unique (id, tenant_id)
);

-- Split from the question for the reason at the top of this file.
create table public.training_answer_key (
  question_id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  correct_index integer not null check (correct_index >= 0),
  -- Shown after the attempt. Training that says "wrong" and stops teaches the
  -- person only that they were wrong.
  explanation text,

  constraint training_key_question_same_tenant
    foreign key (question_id, tenant_id)
    references public.training_question (id, tenant_id)
    on delete cascade
);

create table public.training_attempt (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  module_id uuid not null,
  -- `on delete restrict`: an attempt is the evidence that this person was
  -- trained on this date, and §4 tier 2 wants that history to accumulate.
  person_id uuid not null references public.people (id) on delete restrict,

  answers integer[] not null,
  score integer not null check (score between 0 and 100),
  passed boolean not null,
  completed_at timestamptz not null default now(),

  constraint training_attempt_module_same_tenant
    foreign key (module_id, tenant_id)
    references public.training_module (id, tenant_id)
    on delete restrict
);

create index training_attempt_person_idx
  on public.training_attempt (tenant_id, person_id, completed_at desc);
create index training_question_module_idx on public.training_question (module_id, position);

-- Training is a kind of thing pushed to one member, so it reuses §4's
-- primitive rather than growing a parallel one.
alter type public.assignment_kind add value if not exists 'training_module';

alter table public.assignment
  add column if not exists training_module_id uuid;

alter table public.assignment
  add constraint assignment_training_module_same_tenant
    foreign key (training_module_id, tenant_id)
    references public.training_module (id, tenant_id)
    on delete restrict;

alter table public.training_module enable row level security;
alter table public.training_question enable row level security;
alter table public.training_answer_key enable row level security;
alter table public.training_attempt enable row level security;

-- A member may read a PUBLISHED module. Unpublished ones are the DPO's drafts.
create policy training_module_read on public.training_module
  for select to authenticated
  using (
    app.has_tier(tenant_id, 'active_dpo')
    or (published and app.is_member_of(tenant_id))
  );

create policy training_module_write on public.training_module
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy training_module_update on public.training_module
  for update to authenticated
  using (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id))
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

create policy training_question_read on public.training_question
  for select to authenticated
  using (
    app.has_tier(tenant_id, 'active_dpo')
    or app.is_member_of(tenant_id)
  );

create policy training_question_write on public.training_question
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

-- The whole point: only the DPO. A trainee reading this table would be reading
-- the answers.
create policy training_answer_key_read on public.training_answer_key
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy training_answer_key_write on public.training_answer_key
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

-- Your own attempts, or the DPO's view of the workspace they run. A staff
-- member must not see who else failed.
create policy training_attempt_read on public.training_attempt
  for select to authenticated
  using (
    person_id = app.current_person_id()
    or app.has_tier(tenant_id, 'active_dpo')
  );

revoke all on public.training_module from anon, authenticated;
revoke all on public.training_question from anon, authenticated;
revoke all on public.training_answer_key from anon, authenticated;
revoke all on public.training_attempt from anon, authenticated;

grant select on public.training_module to authenticated;
grant insert (tenant_id, title, body, pass_mark, created_by) on public.training_module to authenticated;
grant update (title, body, pass_mark, published) on public.training_module to authenticated;

grant select on public.training_question to authenticated;
grant insert (tenant_id, module_id, position, question, options) on public.training_question to authenticated;

grant select on public.training_answer_key to authenticated;
grant insert (question_id, tenant_id, correct_index, explanation) on public.training_answer_key to authenticated;

-- No insert on attempts. Grading is the function below; a client that could
-- write its own score would be writing its own certificate.
grant select on public.training_attempt to authenticated;

/**
 * Take a module: grade the answers and record the attempt.
 *
 * Runs as the owner so it can read the answer key the caller cannot. It returns
 * the score, whether it passed, and — per question — what the right answer was
 * and why, because that is where the teaching happens. The key is revealed only
 * AFTER the answers are committed, so it cannot be used to fish for them.
 */
create or replace function public.submit_training_attempt(
  p_caller_person_id uuid,
  p_module_id uuid,
  p_answers integer[]
)
returns table (
  attempt_id uuid,
  score integer,
  passed boolean,
  question_id uuid,
  question_position integer,
  was_correct boolean,
  correct_index integer,
  explanation text
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_module public.training_module;
  v_total integer;
  v_right integer;
  v_score integer;
  v_passed boolean;
  v_attempt uuid;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null or p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_module from public.training_module m where m.id = p_module_id;

  -- Not a member, or the module is still a draft: both read as missing.
  if v_module.id is null
     or app.is_member_of(v_module.tenant_id) is not true
     or v_module.published is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  select count(*) into v_total from public.training_question q where q.module_id = p_module_id;

  if v_total = 0 then
    raise exception 'this module has no questions' using errcode = '22023';
  end if;

  if coalesce(array_length(p_answers, 1), 0) <> v_total then
    raise exception 'answer every question before submitting' using errcode = '22023';
  end if;

  select count(*) into v_right
  from public.training_question q
  join public.training_answer_key k on k.question_id = q.id
  where q.module_id = p_module_id
    and p_answers[q.position] = k.correct_index;

  v_score := floor((v_right::numeric / v_total) * 100);
  v_passed := v_score >= v_module.pass_mark;

  insert into public.training_attempt (
    tenant_id, module_id, person_id, answers, score, passed
  )
  values (v_module.tenant_id, p_module_id, v_session_person, p_answers, v_score, v_passed)
  returning id into v_attempt;

  return query
    select
      v_attempt,
      v_score,
      v_passed,
      q.id,
      q.position,
      p_answers[q.position] = k.correct_index,
      k.correct_index,
      k.explanation
    from public.training_question q
    join public.training_answer_key k on k.question_id = q.id
    where q.module_id = p_module_id
    order by q.position;
end
$$;

revoke all on function public.submit_training_attempt(uuid, uuid, integer[]) from public, anon;
grant execute on function public.submit_training_attempt(uuid, uuid, integer[]) to authenticated, service_role;
