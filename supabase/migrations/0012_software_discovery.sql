-- Software discovery signals from accounting and SSO integrations.
--
-- These rows are source signals, not ROPA entries. A payment to "Notion" or an
-- Okta app assignment tells the DPO "this software likely exists here"; it does
-- not prove purpose, data categories, data subjects, role or retention. The AI
-- output therefore lands as review work, linked back to the signal.

create type public.software_discovery_source as enum (
  'accounting_subscription',
  'accounting_payment',
  'sso_application'
);

create table public.software_discovery_signal (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,

  source public.software_discovery_source not null,
  source_name text not null check (length(btrim(source_name)) > 0),
  external_ref text,

  software_name text not null check (length(btrim(software_name)) > 0),
  vendor_name text,
  signal_text text not null check (length(btrim(signal_text)) > 0),

  amount numeric,
  currency text,
  occurred_on date,
  last_seen_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,

  unique (id, tenant_id)
);

alter table public.ai_suggestion
  add column software_discovery_signal_id uuid;

alter table public.ai_suggestion
  add constraint ai_suggestion_software_signal_same_tenant
    foreign key (software_discovery_signal_id, tenant_id)
    references public.software_discovery_signal (id, tenant_id)
    on delete restrict;

grant insert (software_discovery_signal_id) on public.ai_suggestion to authenticated;
grant update (software_discovery_signal_id) on public.ai_suggestion to authenticated;

create index software_discovery_signal_tenant_idx
  on public.software_discovery_signal (tenant_id, source, software_name, last_seen_at desc);
create index ai_suggestion_software_signal_idx
  on public.ai_suggestion (tenant_id, software_discovery_signal_id)
  where software_discovery_signal_id is not null;

alter table public.software_discovery_signal enable row level security;

create policy software_discovery_signal_read on public.software_discovery_signal
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy software_discovery_signal_insert on public.software_discovery_signal
  for insert to authenticated
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

revoke all on public.software_discovery_signal from anon, authenticated;
grant select on public.software_discovery_signal to authenticated;
grant insert (
  tenant_id, source, source_name, external_ref,
  software_name, vendor_name, signal_text,
  amount, currency, occurred_on, created_by
) on public.software_discovery_signal to authenticated;
