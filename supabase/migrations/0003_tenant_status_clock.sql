-- When the tenant last changed state.
--
-- §5 gives a read-only tenant up to a year before it is purged. That is a
-- deadline the portfolio has to be able to show — "read-only" on its own tells
-- a DPO nothing about how long they have to act — and it cannot be computed
-- from `status` alone, because a status column records where a tenant is, not
-- when it got there.
--
-- Maintained by trigger rather than by the code that changes status. A
-- retention clock that depends on every future caller remembering to stamp it
-- is a clock that will eventually be wrong, and being wrong here means either
-- purging a paying customer's register early or keeping a purged one past its
-- storage-limitation window.

alter table public.tenants
  add column status_changed_at timestamptz not null default now();

create or replace function app.stamp_tenant_status_change()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end
$$;

create trigger tenants_stamp_status_change
  before update on public.tenants
  for each row execute function app.stamp_tenant_status_change();

-- ---------------------------------------------------------------------------
-- Least privilege on `tenants`
--
-- 0001 granted UPDATE on the whole table, which included `status`. An Active
-- DPO could therefore set their own workspace to 'read_only' — and then not set
-- it back, because `tenant_is_writable` refuses writes to a non-active tenant.
-- One request, workspace bricked, recoverable only by the service role.
--
-- `status` is lifecycle and billing state (§5): it belongs to the system, not
-- to a member. `name` and `legal_basis` are the tenant's own to maintain — §6's
-- answer genuinely can change when a contract ends or an obligation begins, and
-- keeping it current is the DPO's job.
--
-- Restated in full because a column-level grant list REPLACES the previous one
-- rather than adding to it.
-- ---------------------------------------------------------------------------
revoke update on public.tenants from authenticated;
grant update (name, legal_basis) on public.tenants to authenticated;
