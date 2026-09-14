-- Tier 2: the one thing you push to one person (design resume §4).
--
-- §4 describes tier 2 as needing a single primitive, not a feature per content
-- type: "push one specific thing to one specific member, log the response.
-- Content type varies (question / document / training module); the primitive
-- doesn't." This is that primitive. `kind` says what was pushed; nothing else
-- in the table branches on it, and a third kind is a new enum value rather
-- than a new table.
--
-- The roster it pushes to already exists. `memberships` has held staff since
-- 0001, and `people` rows exist before anyone signs up precisely so that a
-- roster can be maintained rather than accumulated from whoever got pinged —
-- which is what makes "who has NOT acknowledged this" answerable at all. That
-- question is the reason the DPO screen lists every live member, including the
-- ones with nothing assigned.
--
-- What a tier-2 member can see stays exactly what §4 says: what was pushed to
-- them specifically, and nothing else. Not the register, not a DPIA, not
-- another member's assignments — enforced by the read policy below, not by
-- which page they happen to land on.

create type public.assignment_kind as enum (
  'scoped_question',        -- "what is the retention period on this vendor's data?"
  'policy_acknowledgment'   -- "read this and confirm you have"
);

create type public.assignment_status as enum ('pending', 'responded');

create table public.assignment (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,

  -- The person asked. `on delete restrict` for the same reason memberships are
  -- never deleted: the record that this was asked of this person is the audit
  -- value, and it has to outlive their access.
  assignee_id uuid not null references public.people (id) on delete restrict,

  kind public.assignment_kind not null,
  title text not null check (length(btrim(title)) > 0),
  body text not null check (length(btrim(body)) > 0),

  -- Plain English, for someone who did not ask for this job. §4's tier 2 is a
  -- Head of Ops who got the title, not a specialist; an assignment that does
  -- not say why it matters gets guessed at rather than answered.
  why_asked text,

  status public.assignment_status not null default 'pending',
  response text,
  responded_at timestamptz,
  due_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid not null references public.people (id) on delete restrict,

  constraint responded_assignments_are_attributed check (
    (status = 'responded' and responded_at is not null)
    or (status = 'pending' and responded_at is null and response is null)
  ),

  unique (id, tenant_id)
);

create index assignment_tenant_idx
  on public.assignment (tenant_id, status, created_at desc);
create index assignment_assignee_idx
  on public.assignment (assignee_id, status, created_at desc);

alter table public.assignment enable row level security;

-- The whole of tier 2's visibility rule, in one policy: your own, or the DPO's
-- view of the workspace they run. A staff member reading this table sees the
-- things addressed to them and cannot see that anyone else was asked anything.
create policy assignment_read on public.assignment
  for select to authenticated
  using (
    assignee_id = app.current_person_id()
    or app.has_tier(tenant_id, 'active_dpo')
  );

revoke all on public.assignment from anon, authenticated;
grant select on public.assignment to authenticated;

-- No insert or update policy. Both directions go through the functions below,
-- which is what keeps "only a DPO assigns" and "only the assignee answers" from
-- being two column grants that a later migration could widen by accident.

create or replace function public.assign_to_member(
  p_caller_person_id uuid,
  p_tenant_id uuid,
  p_assignee_person_id uuid,
  p_kind public.assignment_kind,
  p_title text,
  p_body text,
  p_why_asked text default null,
  p_due_at timestamptz default null
)
returns public.assignment
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.assignment;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  if app.has_tier(p_tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(p_tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  -- The assignee must hold a LIVE membership in this workspace. Without this a
  -- DPO could push a question to any person id in the database — including
  -- someone whose access was revoked, or a person who only exists on another
  -- company's roster.
  if not exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id
      and m.person_id = p_assignee_person_id
      and app.is_live(m.active_from, m.active_to)
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  insert into public.assignment (
    tenant_id, assignee_id, kind, title, body, why_asked, due_at, created_by
  )
  values (
    p_tenant_id, p_assignee_person_id, p_kind, p_title, p_body, p_why_asked,
    p_due_at, v_session_person
  )
  returning * into v_row;

  return v_row;
end
$$;

-- Answering. Only the assignee, and only their own.
--
-- A response is allowed to be revised: someone who answers "30 days" and then
-- checks the contract should be able to correct it, and a product that forces
-- a wrong first answer to stand collects worse evidence than one that does not.
-- `responded_at` moves with the answer, so the log says when the DPO's current
-- information actually arrived.
create or replace function public.respond_to_assignment(
  p_caller_person_id uuid,
  p_assignment_id uuid,
  p_response text
)
returns public.assignment
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.assignment;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.assignment where id = p_assignment_id;

  -- Not the assignee — including the DPO who created it — is 'not found', so a
  -- member cannot discover that an assignment exists by trying to answer it.
  if v_row.id is null or v_row.assignee_id is distinct from v_session_person then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_response, ''))) = 0 then
    raise exception 'a response is required' using errcode = '22023';
  end if;

  update public.assignment
     set response = btrim(p_response),
         status = 'responded',
         responded_at = now()
   where id = p_assignment_id
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function public.assign_to_member(uuid, uuid, uuid, public.assignment_kind, text, text, text, timestamptz) from public, anon;
grant execute on function public.assign_to_member(uuid, uuid, uuid, public.assignment_kind, text, text, text, timestamptz) to authenticated, service_role;

revoke all on function public.respond_to_assignment(uuid, uuid, text) from public, anon;
grant execute on function public.respond_to_assignment(uuid, uuid, text) to authenticated, service_role;
