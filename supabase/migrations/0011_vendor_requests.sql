-- Staff-submittable new-vendor requests.
--
-- This is not the register. A staff member may ask for a vendor to be reviewed
-- without gaining visibility into the ROPA or DPIA. The DPO receives the
-- request and any linked AI suggestion as review work; applying it to the
-- register remains a separate approval path.

create table public.vendor_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  requester_id uuid not null references public.people (id) on delete restrict,

  vendor_name text not null check (length(btrim(vendor_name)) > 0),
  purpose text not null check (length(btrim(purpose)) > 0),
  data_description text,

  status public.review_status not null default 'pending_dpo_review',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.people (id) on delete set null,

  constraint reviewed_vendor_requests_are_attributed check (
    (status = 'approved' and reviewed_at is not null and reviewed_by is not null)
    or (status = 'pending_dpo_review' and reviewed_at is null and reviewed_by is null)
  ),

  unique (id, tenant_id)
);

alter table public.ai_suggestion
  add column vendor_request_id uuid;

alter table public.ai_suggestion
  add constraint ai_suggestion_vendor_request_same_tenant
    foreign key (vendor_request_id, tenant_id)
    references public.vendor_request (id, tenant_id)
    on delete restrict;

grant insert (vendor_request_id) on public.ai_suggestion to authenticated;
grant update (vendor_request_id) on public.ai_suggestion to authenticated;

create index vendor_request_tenant_idx
  on public.vendor_request (tenant_id, status, created_at desc);
create index vendor_request_requester_idx
  on public.vendor_request (requester_id, created_at desc);
create index ai_suggestion_vendor_request_idx
  on public.ai_suggestion (tenant_id, vendor_request_id)
  where vendor_request_id is not null;

alter table public.vendor_request enable row level security;

create policy vendor_request_read on public.vendor_request
  for select to authenticated
  using (
    app.has_tier(tenant_id, 'active_dpo')
    or requester_id = app.current_person_id()
  );

create policy vendor_request_insert on public.vendor_request
  for insert to authenticated
  with check (
    app.is_member_of(tenant_id)
    and app.tenant_is_writable(tenant_id)
    and requester_id = app.current_person_id()
  );

revoke all on public.vendor_request from anon, authenticated;
grant select on public.vendor_request to authenticated;
grant insert (
  tenant_id, requester_id, vendor_name, purpose, data_description
) on public.vendor_request to authenticated;

create or replace function app.force_vendor_request_pending_on_insert()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from 'pending_dpo_review' then
    raise exception 'a vendor request cannot be created already approved'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger vendor_request_starts_pending
  before insert on public.vendor_request
  for each row execute function app.force_vendor_request_pending_on_insert();

create or replace function public.approve_vendor_request(
  p_caller_person_id uuid,
  p_request_id uuid
)
returns public.vendor_request
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.vendor_request;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.vendor_request where id = p_request_id;

  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  if v_row.status = 'approved' then
    return v_row;
  end if;

  update public.vendor_request
     set status = 'approved',
         reviewed_at = now(),
         reviewed_by = v_session_person
   where id = p_request_id
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function public.approve_vendor_request(uuid, uuid) from public, anon;
grant execute on function public.approve_vendor_request(uuid, uuid)
to authenticated, service_role;
