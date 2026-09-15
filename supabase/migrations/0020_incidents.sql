-- Personal data breaches, and the clock (design resume §2.4, §3).
--
-- Three GDPR facts shape this table, and each one is a constraint rather than a
-- convention, because each is the kind of thing that gets lost under pressure —
-- and a breach is precisely when people are under pressure.
--
-- Art. 33(1): notify the supervisory authority without undue delay and, where
--   feasible, not later than 72 HOURS AFTER HAVING BECOME AWARE of it. The
--   clock starts on AWARENESS, not on occurrence. A breach that happened in
--   March and was discovered today is due in 72 hours, not overdue by months —
--   which is why `discovered_at` is the required column and `occurred_at` is
--   the nullable one. Getting these the wrong way round would either invent a
--   missed deadline or hide a real one.
--
-- Art. 33(1) again: where notification is later than 72 hours it "shall be
--   accompanied by reasons for the delay". So a late notification without a
--   reason is refused by the check below. The system will not let you record
--   the fact without the thing the regulation requires alongside it.
--
-- Art. 33(5): the controller shall DOCUMENT ANY personal data breach — all of
--   them, including the ones that are never notified — comprising the facts,
--   the effects and the remedial action, so the authority can verify
--   compliance. That is why deciding "not notifiable" requires writing down
--   why. "We decided it was fine" with no reasoning is the state Art. 33(5)
--   exists to prevent, and it is the easiest state to end up in.

create type public.incident_status as enum ('open', 'contained', 'closed');

create type public.incident_notifiability as enum (
  'not_assessed',
  -- Art. 33(1): "unless the personal data breach is unlikely to result in a
  -- risk to the rights and freedoms of natural persons".
  'not_notifiable',
  'notifiable_authority',
  -- Art. 34: high risk to the individuals, so they are told as well.
  'notifiable_authority_and_subjects'
);

create table public.incident (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,

  title text not null check (length(btrim(title)) > 0),
  -- Art. 33(3)(a): the nature of the breach, categories and approximate
  -- numbers. Required, because an incident with no description documents
  -- nothing.
  description text not null check (length(btrim(description)) > 0),

  -- May genuinely be unknown, and often is at first. Left nullable so nobody
  -- has to invent a time to get the record saved.
  occurred_at timestamptz,
  -- The clock. Not nullable, because without it there is no deadline.
  discovered_at timestamptz not null,

  -- Derived, never written, so no code path can quietly move a deadline.
  --
  -- A trigger rather than a generated column: `timestamptz + interval` is only
  -- STABLE, not immutable — the result depends on the session time zone across
  -- a DST boundary — and Postgres refuses a generated expression that is not
  -- immutable. The guarantee is kept a different way: this column appears in
  -- no grant, so no client can write it, and the trigger recomputes it on
  -- every insert and update.
  authority_deadline timestamptz not null default '-infinity',

  data_categories_ordinary public.ordinary_category[] not null default '{}',
  data_categories_special public.special_category[] not null default '{}',
  data_subjects public.data_subject[] not null default '{}',
  -- Art. 33(3)(a) asks for the approximate number. Approximate is the honest
  -- answer early on, so this is nullable rather than defaulted to zero — zero
  -- would read as "nobody affected", which is a finding, not a gap.
  approximate_people_affected integer check (approximate_people_affected >= 0),

  notifiability public.incident_notifiability not null default 'not_assessed',
  notifiability_rationale text,

  notified_authority_at timestamptz,
  notified_subjects_at timestamptz,
  late_notification_reason text,

  -- Art. 33(3)(d): the measures taken or proposed.
  remedial_action text,

  status public.incident_status not null default 'open',
  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,
  closed_at timestamptz,
  closed_by uuid references public.people (id) on delete set null,

  -- Art. 33(5): a decision either way has to carry its reasoning.
  constraint incident_decision_is_reasoned check (
    notifiability = 'not_assessed'
    or length(btrim(coalesce(notifiability_rationale, ''))) > 0
  ),

  -- Art. 33(1): a late notification must be accompanied by reasons for the
  -- delay. Recorded together or not at all.
  constraint incident_late_notification_is_explained check (
    notified_authority_at is null
    or notified_authority_at <= discovered_at + interval '72 hours'
    or length(btrim(coalesce(late_notification_reason, ''))) > 0
  ),

  -- Telling the individuals only makes sense once the assessment says to.
  constraint incident_subject_notice_follows_assessment check (
    notified_subjects_at is null
    or notifiability = 'notifiable_authority_and_subjects'
  ),

  constraint incident_closure_is_attributed check (
    (status = 'closed' and closed_at is not null and closed_by is not null)
    or (status <> 'closed' and closed_at is null and closed_by is null)
  ),

  unique (id, tenant_id)
);

-- Set on the way in, always, from whatever `discovered_at` is at that moment.
create or replace function app.stamp_incident_deadline()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  new.authority_deadline := new.discovered_at + interval '72 hours';
  return new;
end
$$;

create trigger incident_deadline_follows_discovery
  before insert or update on public.incident
  for each row execute function app.stamp_incident_deadline();

create index incident_tenant_idx on public.incident (tenant_id, status, discovered_at desc);
create index incident_deadline_idx
  on public.incident (tenant_id, authority_deadline)
  where status <> 'closed';

alter table public.incident enable row level security;

-- DPO-only. §4 gives tier 2 "whatever's been specifically published or
-- assigned to them" and nothing else; a breach register is not that. A staff
-- member who needs to contribute gets an `assignment`, which is the primitive
-- built for exactly this.
create policy incident_read on public.incident
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy incident_insert on public.incident
  for insert to authenticated
  with check (
    app.has_tier(tenant_id, 'active_dpo')
    and app.tenant_is_writable(tenant_id)
  );

create policy incident_update on public.incident
  for update to authenticated
  using (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id))
  with check (app.has_tier(tenant_id, 'active_dpo') and app.tenant_is_writable(tenant_id));

revoke all on public.incident from anon, authenticated;
grant select on public.incident to authenticated;
grant insert (
  tenant_id, title, description, occurred_at, discovered_at,
  data_categories_ordinary, data_categories_special, data_subjects,
  approximate_people_affected, notifiability, notifiability_rationale,
  remedial_action, created_by
) on public.incident to authenticated;
grant update (
  title, description, occurred_at,
  data_categories_ordinary, data_categories_special, data_subjects,
  approximate_people_affected, notifiability, notifiability_rationale,
  notified_authority_at, notified_subjects_at, late_notification_reason,
  remedial_action, status
) on public.incident to authenticated;

-- `discovered_at` is absent from the UPDATE grant on purpose. It is the start
-- of a statutory clock, and a record whose deadline can be moved after the fact
-- is not evidence of anything. Correcting a genuinely wrong discovery date is a
-- deliberate act for the service role, not a form field.
--
-- `closed_at` / `closed_by` are absent too: closing goes through the function
-- below, so it is always attributed.

create or replace function public.close_incident(
  p_caller_person_id uuid,
  p_incident_id uuid
)
returns public.incident
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.incident;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.incident where id = p_incident_id;

  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  -- Art. 33(5) again: closing an unassessed breach would leave exactly the
  -- undocumented decision the article exists to prevent.
  if v_row.notifiability = 'not_assessed' then
    raise exception 'assess whether this is notifiable before closing it'
      using errcode = '22023';
  end if;

  if v_row.status = 'closed' then
    return v_row;
  end if;

  update public.incident
     set status = 'closed', closed_at = now(), closed_by = v_session_person
   where id = p_incident_id
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function public.close_incident(uuid, uuid) from public, anon;
grant execute on function public.close_incident(uuid, uuid) to authenticated, service_role;
