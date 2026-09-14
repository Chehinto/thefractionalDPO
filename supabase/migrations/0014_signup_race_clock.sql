-- Fix the signup double-submit race properly.
--
-- 0007 added a row lock because "the regression suite caught a double-submit
-- that still produced two workspaces under load". The lock was sound and the
-- race survived it, because serialization was never the broken part.
--
-- `now()` is transaction START time, frozen for the whole transaction.
-- `create_tenant` stamps the new membership `active_from = now()`, and
-- `app.is_live` asks `active_from <= now()`. For two concurrent signups:
--
--   B's transaction begins first, at T_B. A's begins slightly later, at T_A.
--   A wins the lock, finds nothing, creates the workspace with
--   active_from = T_A, and commits.
--   B then acquires the lock and re-reads. It SEES A's membership row — the
--   lock did its job — but evaluates T_A <= now(), where B's now() is still
--   T_B. T_B < T_A, so the row A just committed reads as not yet live.
--   B concludes there is no workspace and creates a second one.
--
-- The membership is not "not yet started"; B is simply reading it with a clock
-- older than the row. So the clock is what has to change, not the rule.
--
-- 0001 is explicit that a second copy of the liveness rule is how the database
-- and the application come to disagree about whether a revoked DPO still has
-- access. So the rule is not copied: it is parameterized by the instant it is
-- evaluated at, and `app.is_live` becomes that same rule asked about now().
-- Every existing caller keeps identical behaviour.

create or replace function app.is_live_at(
  p_from timestamptz,
  p_to timestamptz,
  p_at timestamptz
)
returns boolean
language sql
immutable
as $$
  select coalesce(p_from <= p_at and (p_to is null or p_to > p_at), false)
$$;

create or replace function app.is_live(p_from timestamptz, p_to timestamptz)
returns boolean
language sql
stable
as $$
  select app.is_live_at(p_from, p_to, now())
$$;

-- Only this function changes clocks, and only for this one question: "did a
-- concurrent request already make this person a workspace?" Reading that with
-- `clock_timestamp()` — real wall-clock, re-read per call — means a row
-- committed a moment ago is visible as what it is, rather than as a membership
-- from B's future.
--
-- Deliberately NOT changed globally. `now()` is right everywhere else: a policy
-- that re-evaluated its clock mid-statement could admit a row halfway through a
-- query it had already excluded, and transaction-stable time is what makes an
-- RLS decision reproducible.
create or replace function public.signup_first_tenant(
  p_caller_person_id uuid,
  p_tenant_name text,
  p_legal_basis public.dpo_legal_basis
)
returns public.tenants
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_existing public.tenants;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null
     or p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_session_person::text, 0));

  -- Still load-bearing: it is what guarantees the loser of the race reads
  -- AFTER the winner has committed. Without it there is nothing to read.
  perform 1
    from public.people p
   where p.id = v_session_person
   for update;

  select t.*
  into v_existing
  from public.memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.person_id = v_session_person
    and m.tier = 'active_dpo'
    and app.is_live_at(m.active_from, m.active_to, clock_timestamp())
  order by m.active_from
  limit 1;

  if v_existing.id is not null then
    return v_existing;
  end if;

  return public.create_tenant(p_caller_person_id, p_tenant_name, p_legal_basis);
end
$$;
