-- First look at a detected vendor (design resume §3, §9).
--
-- Between "an accounting export mentions Notion" and "here is a register
-- entry" there is a question a DPO asks first: what IS this thing, does it
-- plausibly touch personal data, and how worried should I be? That is triage,
-- and it is what this table records.
--
-- NOTHING IS FETCHED.
--
-- The obvious design is to take the vendor's URL and have the server read their
-- privacy policy. That makes the server issue requests to an address a user
-- controls, which is server-side request forgery: a hostname resolving to
-- 169.254.169.254 turns "summarise this vendor" into "read our cloud
-- credentials", and since the whole feature is to show the DPO what was found,
-- anything leaked is displayed straight back. Defending it properly needs
-- connect-time IP validation on every redirect hop.
--
-- None of which is necessary, because a model already knows what Notion,
-- Xero or Slack are. So `homepage_url` is stored as a REFERENCE for a human to
-- open — never as something this system retrieves. If a future change makes
-- anything here fetch it, that change reintroduces the whole problem.
--
-- WHY THE CONFIDENCE CAN NEVER BE 'stated'.
--
-- §9 defines `stated` as a person directly saying something, or a document
-- explicitly stating it in terms needing no interpretation. A model's general
-- knowledge of a product is neither. It is recollection: it can be out of date
-- (a vendor moved region, changed sub-processors, was acquired), and it is not
-- evidence anybody could show a regulator.
--
-- So the check constraint below makes `stated` unrepresentable here. That is
-- the difference between a tool that helps a DPO decide where to look and one
-- that quietly launders a model's memory into a compliance record. Evidence
-- still comes from `vendor_document` — the privacy policy, terms and cookie
-- policy a human uploads — and facts extracted from those may be `stated`,
-- because a document really does state them.

create type public.vendor_triage_verdict as enum (
  -- "We looked and did not see a risk." NOT "there is no risk." The wording is
  -- load-bearing: this is a screen over what a model recalls about a product,
  -- and the register's own `dpia_risk_flag` carries the same caveat — treat it
  -- as something that can say "definitely look", never "no need to look".
  'no_risk_identified',

  -- Enough signal that an Art. 35 assessment should actually be done.
  'dpia_recommended',

  -- High risk, mitigation required.
  --
  -- Art. 36 prior consultation with the ICO turns on RESIDUAL risk — what is
  -- left after mitigations are decided. At first detection no mitigations
  -- exist yet, so this verdict can only ever mean "this looks like it could
  -- end up needing consultation", never "consult the ICO". The UI copy says
  -- possible for that reason, and `dpia.residual_risk` is where the real
  -- answer is eventually computed.
  'high_risk_mitigation_required'
);

create table public.vendor_triage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,

  software_name text not null check (length(btrim(software_name)) > 0),
  vendor_name text,

  -- A reference a human opens. Never fetched. See the note above.
  homepage_url text,

  -- What the model recalls. Nullable because "I do not know this product" is a
  -- legitimate and useful answer — §9: never filled with a plausible-sounding
  -- guess — and an obscure or internal tool is exactly where a confident
  -- summary would be invented.
  what_it_does text,
  what_it_processes text,

  verdict public.vendor_triage_verdict,
  verdict_rationale text,

  confidence public.confidence_tag not null,
  confidence_score integer not null default 0 check (confidence_score between 0 and 100),

  constraint vendor_triage_is_never_stated check (confidence <> 'stated'),

  -- A verdict has to come with its reasoning and a real score. A bare verdict
  -- is a number a DPO would have to trust blind.
  constraint vendor_triage_verdict_is_reasoned check (
    verdict is null
    or (length(btrim(coalesce(verdict_rationale, ''))) > 0 and confidence_score > 0)
  ),

  model_name text,
  prompt_key text,

  status public.review_status not null default 'pending_dpo_review',
  created_at timestamptz not null default now(),
  created_by uuid references public.people (id) on delete set null,
  reviewed_at timestamptz,
  reviewed_by uuid references public.people (id) on delete set null,

  constraint reviewed_triage_is_attributed check (
    (status = 'approved' and reviewed_at is not null and reviewed_by is not null)
    or (status = 'pending_dpo_review' and reviewed_at is null and reviewed_by is null)
  ),

  unique (id, tenant_id)
);

create index vendor_triage_tenant_idx
  on public.vendor_triage (tenant_id, status, created_at desc);

-- Tie a triage to the signal that prompted it, so the register entry it
-- eventually becomes traces back to the line in the accounting export.
alter table public.software_discovery_signal
  add column if not exists vendor_triage_id uuid;

alter table public.software_discovery_signal
  add constraint discovery_signal_triage_same_tenant
    foreign key (vendor_triage_id, tenant_id)
    references public.vendor_triage (id, tenant_id)
    on delete restrict;

alter table public.vendor_triage enable row level security;

-- DPO-only, like every other piece of the DPO's working evidence. A staff
-- member who reported the software does not thereby get a view of the risk
-- assessment of it.
create policy vendor_triage_read on public.vendor_triage
  for select to authenticated
  using (app.has_tier(tenant_id, 'active_dpo'));

create policy vendor_triage_insert on public.vendor_triage
  for insert to authenticated
  with check (
    app.has_tier(tenant_id, 'active_dpo')
    and app.tenant_is_writable(tenant_id)
  );

revoke all on public.vendor_triage from anon, authenticated;
grant select on public.vendor_triage to authenticated;
grant insert (
  tenant_id, software_name, vendor_name, homepage_url,
  what_it_does, what_it_processes, verdict, verdict_rationale,
  confidence, confidence_score, model_name, prompt_key, created_by
) on public.vendor_triage to authenticated;

-- `status` is absent from both grants on purpose: a triage cannot be created
-- already reviewed, and cannot be marked reviewed by an update. The function
-- below is the only way, and it records who did it.
create or replace function app.force_triage_pending_on_insert()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.status is distinct from 'pending_dpo_review' then
    raise exception 'a vendor triage cannot be created already reviewed'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger vendor_triage_starts_pending
  before insert on public.vendor_triage
  for each row execute function app.force_triage_pending_on_insert();

create or replace function public.review_vendor_triage(
  p_caller_person_id uuid,
  p_triage_id uuid
)
returns public.vendor_triage
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_session_person uuid;
  v_row public.vendor_triage;
begin
  v_session_person := app.current_person_id();

  if v_session_person is null then
    raise exception 'no person is associated with this session' using errcode = '42501';
  end if;

  if p_caller_person_id is distinct from v_session_person then
    raise exception 'caller_person_id does not match the session' using errcode = '42501';
  end if;

  select * into v_row from public.vendor_triage where id = p_triage_id;

  if v_row.id is null or app.has_tier(v_row.tenant_id, 'active_dpo') is not true then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if app.tenant_is_writable(v_row.tenant_id) is not true then
    raise exception 'this workspace is read-only' using errcode = '42501';
  end if;

  if v_row.status = 'approved' then
    return v_row;
  end if;

  update public.vendor_triage
     set status = 'approved', reviewed_at = now(), reviewed_by = v_session_person
   where id = p_triage_id
  returning * into v_row;

  return v_row;
end
$$;

revoke all on function public.review_vendor_triage(uuid, uuid) from public, anon;
grant execute on function public.review_vendor_triage(uuid, uuid) to authenticated, service_role;
