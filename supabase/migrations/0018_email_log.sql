-- Outbound email, and the record that it happened.
--
-- Ported from AxioVendo's `lib/email.ts` discipline rather than invented: the
-- same allow-list, the same idempotency key, and the same rule that a failed
-- notification must never fail the work that triggered it. What changes here is
-- what the mail is FOR — this product sends on a DPO's behalf, to a vendor, and
-- §1 makes that an authorization the DPO has to have given.
--
-- `recipient` and `subject` live here and never in the platform log. A subject
-- carries customer content (a vendor's name, a questionnaire title) and an
-- address is personal data; this table is scoped by RLS to the tenant's Active
-- DPO, while the platform log is retained centrally and read by anyone with
-- deployment access.

create table public.email_log (
  id uuid primary key default gen_random_uuid(),

  -- Nullable: not every message belongs to a workspace. A tenant-scoped one
  -- must say which, so the DPO can see what was sent on their behalf.
  tenant_id uuid references public.tenants (id) on delete restrict,

  template_key text not null check (length(btrim(template_key)) > 0),
  recipient text not null check (length(btrim(recipient)) > 0),
  subject text not null,

  -- Makes a send happen at most once. A double-submitted form or a retried
  -- request produces the same key, the unique index rejects the second insert,
  -- and the message is not sent again.
  idempotency_key text unique,

  outcome text not null check (
    outcome in ('sent', 'skipped_unconfigured', 'skipped_allowlist', 'failed')
  ),
  provider_id text,
  error text,

  -- Which grant this message carried, when it carried one. Makes "we sent them
  -- the link on the 4th" answerable from the same place the view log lives.
  scoped_access_grant_id uuid,

  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,

  constraint email_log_grant_same_tenant
    foreign key (scoped_access_grant_id, tenant_id)
    references public.scoped_access_grant (id, tenant_id)
    on delete restrict
);

create index email_log_tenant_idx on public.email_log (tenant_id, created_at desc);
create index email_log_grant_idx
  on public.email_log (tenant_id, scoped_access_grant_id)
  where scoped_access_grant_id is not null;

alter table public.email_log enable row level security;

create policy email_log_read on public.email_log
  for select to authenticated
  using (tenant_id is not null and app.has_tier(tenant_id, 'active_dpo'));

-- No insert or update policy. Only the server writes here, as the service role;
-- a client that could write its own delivery record could also forge one.
revoke all on public.email_log from anon, authenticated;
grant select on public.email_log to authenticated;
