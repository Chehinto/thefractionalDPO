-- Tenant creation, as one function with two entry points.
--
-- Creating a workspace carries a guarantee: the creator becomes Active DPO of
-- the new tenant and of nothing else. That guarantee is stated exactly once, in
-- `public.create_tenant`. The signup path does not reimplement it — it calls
-- the same function. Two functions that each insert into `tenants` would be two
-- places that could independently get the membership wrong, and the failure
-- would be silent: a workspace that looks fine but grants its creator access
-- somewhere they should not have it.

-- ---------------------------------------------------------------------------
-- Why this company has a DPO (§6)
--
-- Not a cosmetic field. It decides how urgently the product treats an empty
-- Active DPO seat: 'mandatory' means an Art. 37 obligation is being breached
-- right now; 'contractual' means a representation made to a customer has become
-- false; 'voluntary' is a governance lapse that still carries Art. 37(4)
-- independence duties once the company has designated someone. Those are three
-- different alarms, and the product cannot tell them apart after the fact.
-- ---------------------------------------------------------------------------
create type public.dpo_legal_basis as enum ('mandatory', 'contractual', 'voluntary');

alter table public.tenants add column legal_basis public.dpo_legal_basis;

-- No default and no backfill, deliberately. There is no safe value to guess:
-- writing 'voluntary' into a company that is actually under a mandatory Art. 37
-- obligation records a false legal position in a compliance system. If this
-- migration ever meets a tenant row without an answer it must fail and have a
-- human answer it, which is what leaving the column NOT NULL with no default
-- achieves.
alter table public.tenants alter column legal_basis set not null;

-- ---------------------------------------------------------------------------
-- The old signature is removed, not left alongside the new one.
--
-- An overload taking only a name would be a second, legal-basis-free way to
-- create a workspace — exactly the thing §6 says must always be captured. Two
-- overloads also make "which one did that route call" a question nobody should
-- have to ask.
-- ---------------------------------------------------------------------------
drop function if exists public.create_tenant(text);

-- ---------------------------------------------------------------------------
-- create_tenant — the only path that can insert into `tenants`
--
-- `tenants` has no RLS INSERT policy by design, so this SECURITY DEFINER
-- function is the single door, and it validates before it writes. That mirrors
-- how `add_member` is the only door into `people`.
-- ---------------------------------------------------------------------------
create or replace function public.create_tenant(
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
  v_name text;
  v_tenant public.tenants;
begin
  -- The person always comes from the session. `p_caller_person_id` is the
  -- caller's ASSERTION about who it is acting as, never the source of truth.
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session'
      using errcode = '42501';
  end if;

  -- A mismatch is refused rather than silently corrected to the session's
  -- person. Quietly ignoring the argument would hide the bug from whoever
  -- wrote the caller, and hide an attempt to create a workspace in someone
  -- else's name from everyone.
  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session'
      using errcode = '42501';
  end if;

  v_name := btrim(coalesce(p_tenant_name, ''));
  if v_name = '' then
    raise exception 'a workspace name is required' using errcode = '22023';
  end if;

  -- The column is NOT NULL so this would fail at the insert anyway; checked
  -- here so the error names the field instead of a constraint.
  if p_legal_basis is null then
    raise exception 'legal_basis is required: mandatory, contractual or voluntary'
      using errcode = '22023';
  end if;

  -- Both inserts run in the caller's transaction. If the membership insert
  -- fails for any reason — the exclusion constraint, a tier typo, anything —
  -- the tenant insert rolls back with it. A workspace with no Active DPO must
  -- never exist as the RESULT of creating one; §5's zero-DPO state is something
  -- a tenant arrives at later, by revocation, not something creation produces.
  insert into public.tenants (name, legal_basis)
  values (v_name, p_legal_basis)
  returning * into v_tenant;

  -- Exactly one membership, naming the tenant just created and no other.
  insert into public.memberships (tenant_id, person_id, tier)
  values (v_tenant.id, v_session_person, 'active_dpo');

  return v_tenant;
end
$$;

-- ---------------------------------------------------------------------------
-- signup_first_tenant — entry point 2's wrapper, NOT a second creation path
--
-- It adds exactly one thing to `create_tenant`: at most one workspace per
-- brand-new signup. Everything about what a workspace is and who it grants
-- access to still comes from `create_tenant`, which this calls.
--
-- The lock is what makes that safe. Without it, two concurrent signup requests
-- from the same person — a double-submitted form, a retried fetch — would both
-- find no existing workspace and both create one, leaving the person as Active
-- DPO of two identical tenants with no way to tell which is real. The check and
-- the create have to happen as one atomic step, and a transaction-scoped
-- advisory lock on the person is the cheapest way to get that without
-- serialising unrelated signups against each other.
-- ---------------------------------------------------------------------------
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

  -- Already runs their own workspace? Then this is a repeat of a signup that
  -- already succeeded. Return what they have rather than erroring: the caller's
  -- intent ("I should end up with a workspace") is satisfied, and a
  -- duplicate-submit error at the end of signup is a confusing way to say "it
  -- worked".
  --
  -- The tier filter is the important part. Testing for ANY live membership
  -- would refuse a workspace to the one person most likely to want one: a
  -- colleague who was rostered as staff in someone else's tenant (§4 tier 2)
  -- before they ever signed up. They hold a membership already, and it is not
  -- theirs. Only an active_dpo membership means "this person has been through
  -- signup and come out the other side with their own workspace".
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

-- ---------------------------------------------------------------------------
-- Person resolution on sign-up
--
-- Replaces the 0001 version with two fixes that matter for entry point 2.
--
-- This stays a trigger on auth.users rather than a step in the signup route,
-- deliberately: it then runs for EVERY auth account — the admin API, a future
-- OAuth provider, a magic link — and cannot be skipped by a code path that
-- forgot to call it. The route gets to assume the person already exists.
-- ---------------------------------------------------------------------------
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_person uuid;
begin
  -- Serialise on the address. Without this, two auth accounts being created for
  -- the same email at the same moment could both read "no person row yet" and
  -- both insert, and one would fail on the unique index at a point where the
  -- auth account already exists — a signed-in user with no person row, which
  -- resolves to no access at all and looks like a broken account.
  perform pg_advisory_xact_lock(hashtextextended(lower(new.email), 0));

  select id into v_person
  from public.people
  where lower(email) = lower(new.email);

  if v_person is null then
    insert into public.people (auth_user_id, email, full_name)
    values (new.id, new.email, nullif(new.raw_user_meta_data ->> 'full_name', ''));
    return new;
  end if;

  -- The row exists and is unclaimed: this is the staff member who was added to
  -- a tenant's roster (§4 tier 2) before they ever signed up. Claiming it is
  -- what keeps their acknowledgment and training history continuous across the
  -- moment they first sign in. A second person row here would split one human's
  -- audit trail in two, and the roster exists precisely to prevent that.
  update public.people
     set auth_user_id = new.id,
         full_name = coalesce(full_name, nullif(new.raw_user_meta_data ->> 'full_name', ''))
   where id = v_person
     and (auth_user_id is null or auth_user_id = new.id);

  if not found then
    raise exception 'this email is already linked to another account'
      using errcode = '23505';
  end if;

  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.create_tenant(uuid, text, public.dpo_legal_basis),
  public.signup_first_tenant(uuid, text, public.dpo_legal_basis)
from public, anon;

grant execute on function
  public.create_tenant(uuid, text, public.dpo_legal_basis),
  public.signup_first_tenant(uuid, text, public.dpo_legal_basis)
to authenticated, service_role;
