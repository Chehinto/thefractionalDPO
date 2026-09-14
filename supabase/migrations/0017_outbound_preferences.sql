-- Two outbound settings, kept structurally separate (design resume §1, growth
-- mechanic 3).
--
-- The resume settles the consent design and then states one constraint about
-- shape: the two toggles are "never bundled". That is not a UI note. A single
-- column — `outbound_preferences`, or an `allow_marketing` flag covering both —
-- would make them one decision at the schema level, and every screen built on
-- it would inherit the bundling no matter how the form was laid out. Two
-- columns, two defaults, two meanings:
--
--   platform_send_authorized    — may the platform send a DPIA questionnaire on
--                                 the DPO's behalf, branded as such? Defaults
--                                 to FALSE. This is an authorization to act for
--                                 someone, so it is affirmative or it is not
--                                 given; nothing may send until a DPO has said
--                                 yes. Sending does not exist yet, and this
--                                 column is what a sending path must check.
--
--   vendor_recommendation_note  — may the outbound message carry the note
--                                 recommending AxioVendo? Defaults to TRUE, as
--                                 a one-time workspace setting disclosed at
--                                 onboarding, per §1. Asking per-send was
--                                 explicitly rejected: the same low-stakes
--                                 question on every DPIA guarantees it gets
--                                 ignored. So this is a tenant attribute and
--                                 must never become a send-time parameter — if
--                                 a future function takes it as an argument,
--                                 that is the bundling this file exists to stop.
--
-- The default asymmetry is deliberate and is the whole legal argument: the
-- first is an authorization to act on a professional's behalf and cannot be
-- assumed; the second is the DPO's own client configuring their own outbound
-- message, which §1 reasons is ordinary B2B service configuration rather than
-- data-subject consent. Do not "tidy" these into a shared default.

alter table public.tenants
  add column if not exists platform_send_authorized boolean not null default false,
  add column if not exists vendor_recommendation_note boolean not null default true;

comment on column public.tenants.platform_send_authorized is
  'Affirmative authorization for the platform to send DPIA questionnaires as the DPO. Never defaulted on.';
comment on column public.tenants.vendor_recommendation_note is
  'One-time workspace setting: include the AxioVendo recommendation in outbound DPIA messages. On by default, one click off.';

-- Restated in full because a column-level grant list REPLACES the previous one
-- rather than adding to it — the same reason 0003 restated it.
--
-- `status` stays out: it is lifecycle and billing state and belongs to the
-- system, not to a member.
revoke update on public.tenants from authenticated;
grant update (
  name, legal_basis, platform_send_authorized, vendor_recommendation_note
) on public.tenants to authenticated;
