-- Foundational tenancy layer.
--
-- The workspace is the client company, not the DPO's app (design resume §4).
-- One person can hold live memberships in many tenants at once — that is what a
-- fractional DPO's portfolio IS — so membership is a table, never a column on
-- the person. AxioVendo's `users.org_id` single column cannot represent this,
-- and every RLS policy there descends from a `current_org_id()` helper that
-- returns exactly one tenant. None of that is portable; this file replaces it.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------

-- The three access tiers of design resume §4. A tier is a trust level inside
-- one tenant, NOT a job title — AxioVendo's `functional_role` enum (ciso, dpo,
-- engineering…) is a different axis entirely and is deliberately not carried
-- over. In particular 'dpo' there means "the privacy specialist on a sales
-- team"; 'active_dpo' here means "professional of record for this workspace".
create type public.membership_tier as enum (
  'active_dpo',       -- full trust: register, DPIA, incidents, risk analysis
  'staff',            -- scoped: only what has been pushed to them specifically
  'external_scoped'   -- auditor / customer reviewer, time-limited by design
);

-- §5: non-payment blocks access but the tenant goes read-only for up to a year
-- before it is purged, rather than being deleted immediately. 'read_only' is
-- that state, and it is enforced in the write policies below rather than in
-- application code, so a route that forgets to check it still cannot write.
create type public.tenant_status as enum ('active', 'read_only', 'suspended');

-- ---------------------------------------------------------------------------
-- Predicate schema
--
-- The access predicates live in their own schema so that `public` holds only
-- data. They are SECURITY DEFINER for a specific reason documented at
-- `app.live_tier` below — this is not decoration.
-- ---------------------------------------------------------------------------
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- people — identity, global and durable
--
-- A person exists independently of any tenant and independently of whether they
-- have signed up yet. Two requirements force this shape:
--
--   §4 tier 2 needs a MAINTAINED staff roster as the base object, not one built
--   up from whoever happened to get pinged. You can only prove who did NOT
--   acknowledge a policy if the roster exists before the pings do — hence a
--   person row with a null auth_user_id is legitimate and expected.
--
--   §4 tier 2 also needs persistent identity rather than single-use links, so
--   acknowledgment and training history accumulates against one row over years.
-- ---------------------------------------------------------------------------
create table public.people (
  id uuid primary key default gen_random_uuid(),
  -- Null until this person actually signs in. Set on first sign-up by the
  -- trigger below, which links a pre-rostered row rather than duplicating it.
  auth_user_id uuid unique references auth.users (id) on delete set null,
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);

-- One person per address. Case-insensitive because an invitation to
-- Ada@example.com and a sign-up as ada@example.com are the same human, and two
-- rows would split their acknowledgment history in half.
create unique index people_email_key on public.people (lower(email));

-- ---------------------------------------------------------------------------
-- tenants — the client company workspace
-- ---------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  status public.tenant_status not null default 'active',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- memberships — the join, and the provenance record
--
-- §5 draws a hard line between provenance and access: what persists after a
-- fractional DPO's access ends is the record that they maintained this register
-- for a given date range (their "companies advised" credential); what does not
-- persist is live access. Both are expressed by the same row — the validity
-- window IS the provenance — which is why nothing here ever deletes.
-- ---------------------------------------------------------------------------
create table public.memberships (
  id uuid primary key default gen_random_uuid(),

  -- RESTRICT, not CASCADE, on both sides. §5 requires that provenance survive
  -- the tenant being purged; a cascade would silently destroy the credential
  -- along with the workspace. Restricting forces the (not yet built) purge path
  -- to deal with provenance explicitly instead of losing it by default.
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  person_id uuid not null references public.people (id) on delete restrict,

  tier public.membership_tier not null,

  -- Half-open window [active_from, active_to). Null active_to means open-ended.
  -- A future active_to is legitimate and is how §4 tier 3's time-limited
  -- external access expires without anyone having to remember to revoke it.
  active_from timestamptz not null default now(),
  active_to timestamptz,

  created_at timestamptz not null default now(),
  revoked_by uuid references public.people (id) on delete set null,

  constraint memberships_window_ordered
    check (active_to is null or active_to > active_from),

  -- At most one live membership per person per tenant, while still allowing a
  -- person to leave and come back later as separate, non-overlapping rows. A
  -- partial unique index cannot express this (the liveness test depends on
  -- now(), which is not immutable), so it is an exclusion constraint over the
  -- validity range. This is also what lets `app.live_tier` trust that a single
  -- row answers "what is this person's tier here, right now".
  constraint memberships_no_overlap exclude using gist (
    tenant_id with =,
    person_id with =,
    tstzrange(active_from, active_to, '[)') with &&
  )
);

create index memberships_person_idx on public.memberships (person_id, tenant_id);
create index memberships_tenant_idx on public.memberships (tenant_id, tier);

-- ---------------------------------------------------------------------------
-- Access predicates
-- ---------------------------------------------------------------------------

-- The person behind the current session. Resolved from auth.uid() on every
-- call — never from a claim in the JWT, and never from anything the client
-- sends.
create or replace function app.current_person_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p.id from public.people p where p.auth_user_id = auth.uid()
$$;

-- What "live" means, defined once.
--
-- §4 specifies removal from the Active DPO list as immediate and binary with no
-- grace period, so this predicate is the revocation semantics of the whole
-- product. Stated once, as a function, rather than repeated as a WHERE clause
-- in each policy and query — a second copy is how a grace period gets
-- introduced by accident in one place and not another.
--
-- Wrapping it costs the planner the ability to use an index on the window
-- columns. At the scale of "how many tenants does one DPO advise" that is
-- irrelevant, and having one definition is worth more than the scan.
create or replace function app.is_live(p_from timestamptz, p_to timestamptz)
returns boolean
language sql
stable
as $$
  select coalesce(p_from <= now() and (p_to is null or p_to > now()), false)
$$;

-- The caller's tier in one tenant right now, or null if they have none.
--
-- Every policy, route and test descends from this, so there is one answer to
-- "can this session reach this tenant" rather than one per call site.
--
-- SECURITY DEFINER is load-bearing, not habit. This function is called from the
-- RLS policy ON `memberships` itself; if it ran as the caller it would re-enter
-- that policy to read the table the policy is about, and Postgres rejects the
-- recursion outright (SQLSTATE 42P17) rather than looping. AxioVendo hit
-- exactly this and every authenticated read on every table failed until a
-- definer function broke the cycle.
--
-- The corollary is that RLS must NOT be FORCEd on `memberships` or `people`:
-- FORCE applies policies to the table owner too, which is the role this
-- function runs as, and the recursion comes straight back.
create or replace function app.live_tier(p_tenant_id uuid)
returns public.membership_tier
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select m.tier
  from public.memberships m
  where m.tenant_id = p_tenant_id
    and m.person_id = app.current_person_id()
    and app.is_live(m.active_from, m.active_to)
  limit 1
$$;

create or replace function app.is_member_of(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select app.live_tier(p_tenant_id) is not null
$$;

-- coalesce is load-bearing. For a non-member `live_tier` is NULL, so a bare
-- `live_tier = p_tier` yields NULL rather than false. An RLS policy treats NULL
-- as "no row" and is safe, but a PL/pgSQL guard written `if not has_tier(...)`
-- does NOT fire on NULL — the check is skipped entirely and the caller proceeds
-- as if authorised. That is a fail-OPEN, and it is why this returns false
-- explicitly instead of letting three-valued logic reach a branch.
create or replace function app.has_tier(p_tenant_id uuid, p_tier public.membership_tier)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(app.live_tier(p_tenant_id) = p_tier, false)
$$;

-- Writability is membership AND an active tenant. Split from `is_member_of`
-- because §5's read-only state has to block writes without blocking reads: a
-- lapsed card must not delete a compliance register, and the DPO must still be
-- able to read what they are being asked to pay for.
create or replace function app.tenant_is_writable(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select app.is_member_of(p_tenant_id)
     and exists (
       select 1 from public.tenants t
       where t.id = p_tenant_id and t.status = 'active'
     )
$$;

-- Whether the caller administers any tenant this person is currently a member
-- of. Wrapped in a definer function rather than written inline in `people`'s
-- policy so that the policy never subqueries `memberships` as the caller —
-- keeping every cross-table access check out of RLS re-entry.
create or replace function app.shares_tenant_as_active_dpo(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
    from public.memberships m
    where m.person_id = p_person_id
      and app.is_live(m.active_from, m.active_to)
      and app.has_tier(m.tenant_id, 'active_dpo')
  )
$$;

revoke all on function
  app.is_live(timestamptz, timestamptz),
  app.current_person_id(),
  app.live_tier(uuid),
  app.is_member_of(uuid),
  app.has_tier(uuid, public.membership_tier),
  app.tenant_is_writable(uuid),
  app.shares_tenant_as_active_dpo(uuid)
from public;

-- anon needs EXECUTE too: a policy expression is evaluated as the querying
-- role, so without it an anonymous read raises a permission error instead of
-- cleanly returning nothing. The functions resolve auth.uid() to null for anon
-- and answer false, which is the correct — and quiet — refusal.
grant execute on function
  app.is_live(timestamptz, timestamptz),
  app.current_person_id(),
  app.live_tier(uuid),
  app.is_member_of(uuid),
  app.has_tier(uuid, public.membership_tier),
  app.tenant_is_writable(uuid),
  app.shares_tenant_as_active_dpo(uuid)
to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Default deny throughout: RLS is enabled on every table, and a command with no
-- policy is refused. Read access is granted by membership; write access
-- additionally requires the active_dpo tier and a writable tenant. Nothing here
-- grants access to a tenant id supplied by a client — the predicates only ever
-- ask what the CURRENT SESSION can reach.
-- ---------------------------------------------------------------------------

alter table public.people enable row level security;
alter table public.tenants enable row level security;
alter table public.memberships enable row level security;

-- people ---------------------------------------------------------------------
-- Yourself, plus the roster of any tenant you are the Active DPO of. A staff
-- member deliberately cannot enumerate their colleagues: §4 tier 2 says they
-- never see other members' assignments, and a roster is the first step to that.
create policy people_read on public.people
  for select to authenticated
  using (
    id = app.current_person_id()
    or app.shares_tenant_as_active_dpo(id)
  );

-- No client INSERT/UPDATE/DELETE policy. Person rows are created only by the
-- sign-up trigger below, so an address cannot be enrolled by whoever can reach
-- the API.

-- tenants --------------------------------------------------------------------
create policy tenants_read on public.tenants
  for select to authenticated
  using (app.is_member_of(id));

create policy tenants_update on public.tenants
  for update to authenticated
  using (app.has_tier(id, 'active_dpo') and app.tenant_is_writable(id))
  with check (app.has_tier(id, 'active_dpo') and app.tenant_is_writable(id));

-- No INSERT policy: tenants are created only through public.create_tenant(),
-- which takes the founding member from the session rather than an argument.
-- No DELETE policy: §5's purge is a deliberate, audited path that does not
-- exist yet, and until it does, deletion failing closed is the correct outcome.

-- memberships ----------------------------------------------------------------
-- Your own memberships are always visible — that list IS the portfolio of §4 —
-- plus every membership of a tenant you are the Active DPO of.
create policy memberships_read on public.memberships
  for select to authenticated
  using (
    person_id = app.current_person_id()
    or app.has_tier(tenant_id, 'active_dpo')
  );

create policy memberships_insert on public.memberships
  for insert to authenticated
  with check (
    app.has_tier(tenant_id, 'active_dpo')
    and app.tenant_is_writable(tenant_id)
  );

-- UPDATE is how revocation happens (active_to is set). The guard trigger below
-- constrains WHAT may change; this policy constrains WHO may change it.
create policy memberships_update on public.memberships
  for update to authenticated
  using (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id))
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

-- No DELETE policy, deliberately. Revocation closes the validity window; it
-- never removes the row, because the row is the evidence that this person held
-- this tenant's register for this date range (§5). Deleting it would erase a
-- credential the DPO has earned and an audit trail the tenant may need.

-- ---------------------------------------------------------------------------
-- Membership integrity
-- ---------------------------------------------------------------------------

-- What may change on a membership after it exists: only the end of its window.
-- Identity and start date are frozen because they are provenance, and a
-- revoked membership can never be reopened — coming back is a NEW row with its
-- own start date, so the gap in access stays visible in the record.
create or replace function app.guard_membership_update()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.tenant_id <> old.tenant_id
     or new.person_id <> old.person_id
     or new.tier <> old.tier
     or new.active_from <> old.active_from then
    raise exception 'membership identity and start date are immutable'
      using errcode = '42501';
  end if;

  if old.active_to is not null and new.active_to is distinct from old.active_to then
    raise exception 'a closed membership cannot be reopened or re-dated; grant a new membership instead'
      using errcode = '42501';
  end if;

  -- Backdating an end date would falsify the provenance range — it would claim
  -- the DPO stopped advising before they actually did. Future dates are fine:
  -- that is a scheduled expiry, not a rewritten history.
  if new.active_to is not null and new.active_to < now() then
    raise exception 'a membership cannot be ended in the past'
      using errcode = '42501';
  end if;

  return new;
end
$$;

create trigger memberships_guard_update
  before update on public.memberships
  for each row execute function app.guard_membership_update();

-- ---------------------------------------------------------------------------
-- Sign-up: link a rostered person, or create one
-- ---------------------------------------------------------------------------
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- A staff member may already exist on the roster with no auth account (see
  -- the note on people.auth_user_id). Claiming that row rather than inserting a
  -- second one is what keeps their acknowledgment history continuous across the
  -- moment they first sign in.
  update public.people
     set auth_user_id = new.id,
         full_name = coalesce(full_name, nullif(new.raw_user_meta_data ->> 'full_name', ''))
   where auth_user_id is null
     and lower(email) = lower(new.email);

  if not found then
    insert into public.people (auth_user_id, email, full_name)
    values (new.id, new.email, nullif(new.raw_user_meta_data ->> 'full_name', ''))
    on conflict (auth_user_id) do nothing;
  end if;

  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Tenant creation (§1 growth mechanic: self-serve)
--
-- Any signed-in person can spin up a tenant for another company and is listed
-- as its first Active DPO. The founding member is taken from the SESSION and
-- never from an argument — an endpoint that accepts "who to make the owner"
-- lets a caller enrol somebody else, or themselves into someone else's new
-- workspace. AxioVendo learned this one in production.
-- ---------------------------------------------------------------------------
create or replace function public.create_tenant(p_name text)
returns public.tenants
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_person uuid;
  v_tenant public.tenants;
begin
  v_person := app.current_person_id();
  if v_person is null then
    raise exception 'no person is associated with this session'
      using errcode = '42501';
  end if;

  insert into public.tenants (name) values (btrim(p_name))
  returning * into v_tenant;

  insert into public.memberships (tenant_id, person_id, tier)
  values (v_tenant.id, v_person, 'active_dpo');

  return v_tenant;
end
$$;

-- ---------------------------------------------------------------------------
-- Revocation (§4: immediate and binary, no grace period)
--
-- Exposed as an operation rather than left as a field update so that the end
-- date is stamped server-side from now(). A client that could choose the
-- timestamp could grant itself a grace period, which is the one thing this tier
-- is specified not to have.
--
-- SECURITY DEFINER bypasses RLS on the lookup, so the caller's right to
-- administer this tenant is checked explicitly below. That check is the only
-- thing standing between a membership id and its revocation — do not remove it
-- on the assumption that RLS covers it, because here it does not.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_membership(p_membership_id uuid)
returns public.memberships
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_row public.memberships;
  v_actor uuid;
begin
  v_actor := app.current_person_id();

  select * into v_row from public.memberships where id = p_membership_id;

  -- A membership in a tenant the caller does not administer is reported exactly
  -- as one that does not exist. Distinguishing the two would confirm that a
  -- given id is real, which is a membership map of other people's tenants.
  -- `is not true` rather than `not (...)`: it treats NULL as a refusal. Both
  -- layers of this check are deliberate — do not collapse it back to `not`.
  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  -- Idempotent: revoking twice is not an error, because the caller's intent
  -- ("this person must not have access") is already satisfied.
  if v_row.active_to is not null then
    return v_row;
  end if;

  -- Self-revocation is permitted, including by the last Active DPO. §5 is
  -- explicit that a tenant left with zero Active DPOs must force an explicit
  -- choice at the product level rather than silently auto-promoting whoever is
  -- left into a liability they never agreed to — so this layer must not quietly
  -- prevent the situation from arising.
  update public.memberships
     set active_to = now(), revoked_by = v_actor
   where id = p_membership_id
  returning * into v_row;

  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- The caller's live memberships — the portfolio of §4, as data
--
-- SECURITY INVOKER on purpose, unlike the functions above: this one is not
-- called from inside a policy, so there is no recursion to break, and running
-- it as the caller means RLS on `memberships` and `tenants` still applies. The
-- application layer and the database layer then have to agree before a row is
-- returned, rather than the application quietly trusting a definer function.
-- ---------------------------------------------------------------------------
create or replace function public.my_memberships()
returns table (
  membership_id uuid,
  tenant_id uuid,
  tenant_name text,
  tenant_status public.tenant_status,
  tier public.membership_tier,
  active_from timestamptz,
  active_to timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select m.id, m.tenant_id, t.name, t.status, m.tier, m.active_from, m.active_to
  from public.memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.person_id = app.current_person_id()
    and app.is_live(m.active_from, m.active_to)
  order by t.name
$$;

-- ---------------------------------------------------------------------------
-- Adding a member (§4 tier 2: the roster is the base object)
--
-- Takes an email rather than a person id, and creates the person row if the
-- address is new — that is what lets a DPO roster the whole company before
-- anyone has signed in, which is the only way to later prove who did NOT
-- acknowledge a policy. Definer because `people` grants no insert to anyone;
-- this function is the single door through which a roster entry appears.
-- ---------------------------------------------------------------------------
create or replace function public.add_member(
  p_tenant_id uuid,
  p_email text,
  p_tier public.membership_tier
)
returns public.memberships
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_person uuid;
  v_row public.memberships;
begin
  -- Definer bypasses RLS, so authorisation is checked explicitly here. A
  -- non-administered tenant is reported as missing, never as forbidden.
  -- `is not true` treats a NULL predicate as a refusal; see app.has_tier.
  if app.has_tier(p_tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(p_tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  select id into v_person
  from public.people
  where lower(email) = lower(btrim(p_email));

  if v_person is null then
    insert into public.people (email) values (btrim(p_email))
    returning id into v_person;
  end if;

  -- If they already hold a live membership here, the exclusion constraint
  -- rejects this (23P01) rather than silently creating a second tier for the
  -- same person, which would make "what can they see" ambiguous.
  insert into public.memberships (tenant_id, person_id, tier)
  values (p_tenant_id, v_person, p_tier)
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function public.create_tenant(text) from public, anon;
revoke all on function public.revoke_membership(uuid) from public, anon;
revoke all on function public.add_member(uuid, text, public.membership_tier) from public, anon;
grant execute on function public.create_tenant(text) to authenticated, service_role;
grant execute on function public.revoke_membership(uuid) to authenticated, service_role;
grant execute on function public.add_member(uuid, text, public.membership_tier) to authenticated, service_role;
grant execute on function public.my_memberships() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Table grants
--
-- RLS filters rows; grants decide which commands exist at all. Both are needed:
-- a table with a permissive policy and no grant is unreachable, and a table
-- with a grant and no policy returns nothing. Writes to `people` are granted to
-- nobody, so the sign-up trigger is the only way a person row is ever created.
--
-- The revoke is not redundant. Supabase's bootstrap issues a blanket
-- `grant all on all tables in schema public to anon, authenticated`, so a
-- migration that only ADDS grants leaves DELETE and TRUNCATE in place. RLS
-- covers DELETE (no policy, no rows affected) but **TRUNCATE is not subject to
-- RLS at all** — it is table-level, and a policy cannot stop it. PostgREST
-- never issues TRUNCATE, so this is not reachable today; it is revoked because
-- "unreachable through the current client" is not the same as "denied", and
-- the next thing to hold this role may not be PostgREST.
-- ---------------------------------------------------------------------------
revoke all on public.people from anon, authenticated;
revoke all on public.tenants from anon, authenticated;
revoke all on public.memberships from anon, authenticated;

grant select on public.people to authenticated;
grant select, update on public.tenants to authenticated;
grant select, insert, update on public.memberships to authenticated;
