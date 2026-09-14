-- Harden signup_first_tenant's concurrency guard.
--
-- The advisory lock in 0002 is conceptually right, but the regression suite
-- caught a double-submit that still produced two workspaces under load. Take a
-- row lock on the caller's `people` row as the concrete serialization point:
-- every signup wrapper call for the same person now waits on the same tuple
-- before it checks whether an Active DPO workspace already exists.

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

  -- This is the load-bearing lock. It serializes double-submitted signup
  -- requests for one person without blocking unrelated signups, and it locks a
  -- real row rather than relying only on advisory-lock behaviour in the API
  -- pooler path.
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
    and app.is_live(m.active_from, m.active_to)
  order by m.active_from
  limit 1;

  if v_existing.id is not null then
    return v_existing;
  end if;

  return public.create_tenant(p_caller_person_id, p_tenant_name, p_legal_basis);
end
$$;
