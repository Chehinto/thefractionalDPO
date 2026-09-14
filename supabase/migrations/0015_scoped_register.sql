-- The read path for an `auditor_review` link (design resume §4, tier 3).
--
-- 0013 created the purpose and left it with nowhere to go: a link could be
-- issued and redeemed, and then showed nothing. This is the door it was missing.
--
-- What an auditor or a customer's compliance reviewer gets is the Art. 30
-- record and only that — the seven canonical fields of §9, for APPROVED
-- activities. Everything else the register carries is working state, not the
-- record:
--
--   * `pending_dpo_review` rows are excluded. A draft is the DPO thinking, and
--     disclosing it as part of a register misrepresents what the company has
--     actually recorded.
--   * `*_evidence` is excluded. It quotes internal source documents — contracts,
--     emails, a vendor's own policy — which are the company's material, not
--     part of what Art. 30 obliges them to show.
--   * The confidence tags are excluded. They are a product-internal quality
--     signal, and "purpose: inferred" handed to a regulator out of context says
--     something about this tool's certainty, not about the company's compliance.
--   * `created_by` / `approved_by` are excluded. Those are people, and an
--     auditor is scoped to a register, not to a staff roster.
--
-- Like every other tier-3 door this re-checks the token on each call and
-- returns no rows rather than raising, so a refusal commits its audit entry
-- instead of rolling it back.

create or replace function public.scoped_register(p_token_hash text)
returns table (
  activity_id uuid,
  purpose text,
  recipient_vendor text,
  role public.processing_role,
  data_categories_ordinary public.ordinary_category[],
  data_categories_special public.special_category[],
  data_subjects public.data_subject[],
  retention text,
  dpia_risk_flag boolean,
  approved_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  g record;
begin
  select * into g from app.live_scoped_grant(app.decode_token_hash(p_token_hash));

  -- A questionnaire link presented here is refused exactly as an unknown token
  -- is: purpose confines a link to one door, in both directions.
  if g.grant_id is null or g.purpose is distinct from 'auditor_review' then
    return;
  end if;

  if g.refusal is not null then
    perform app.record_scoped_event(g.grant_id, g.tenant_id, 'refused', g.refusal);
    return;
  end if;

  return query
    select
      a.id,
      a.purpose,
      a.recipient_vendor,
      a.role,
      a.data_categories_ordinary,
      a.data_categories_special,
      a.data_subjects,
      a.retention,
      a.dpia_risk_flag,
      a.approved_at
    from public.processing_activity a
    where a.tenant_id = g.tenant_id
      and a.status = 'approved'
    order by a.approved_at desc nulls last, a.purpose;
end
$$;

revoke all on function public.scoped_register(text) from public;
grant execute on function public.scoped_register(text) to anon, authenticated, service_role;
