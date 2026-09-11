# Fractional DPO Product — Design Resume

Working title: no name settled yet. Second product alongside AxioVendo, same founder (Chehin), same holding company (Toumi Ventures Ltd once the rename files). Domain already purchased, repo and local files created.

---

## 1. Product concept & positioning

- One workspace per client company. Two roles operate inside it, at the same time, under a retainer relationship:
  - **Fractional DPO** — external, professional of record. Sets up the register, signs off on judgment calls, carries liability. Paid on retainer because there isn't enough ongoing volume at most clients to justify a full-time hire.
  - **Accidental DPO** — internal (Head of Ops, Head of Legal, whoever got the title), handles day-to-day events as they happen (new vendor, new tool, a marketing question) but lacks the vocabulary or standing to make the judgment call alone.
- **The fractional DPO is the heart of the business** (the buyer, the trust signal, the reason a client is defensibly compliant). **The accidental DPO is why the product sticks** (the daily user, the reason renewal doesn't depend on the consultant relationship alone).
- **Business model**: wholesale/retail split on the same tenant.
  - ~$79/month while a fractional DPO is running the tenant as part of their portfolio (they pitch it to the CEO as "I'm using this, I'll expense it").
  - ~$99/month if the company ever holds the tenant alone (fractional DPO exits, e.g. company hires an in-house DPO).
  - Handoff should be a single billing-object transfer (card swap on the same subscription) — not a fresh signup. Friction at that exact moment risks losing the tenant.
- **Growth mechanic**: self-serve tenant creation. Any accidental DPO who's used the tool can spin up a new tenant for another company (a friend's startup, a side gig) and list themselves as Active DPO there. This organically manufactures fractional DPOs out of the existing user base — sidesteps the classic marketplace cold-start problem (need supply and demand simultaneously) flagged in an earlier session, without requiring you to recruit DPOs yourself.
- **Marketplace/credit escalation idea** (accidental DPO buys credits, a real DPO earns credits reviewing scoped questions, converts to cash monthly) — raised in an earlier session, not yet reconciled with the tenant architecture below. Still a live idea, parked.

---

## 2. Six features originally scoped (plus competitive gap-check)

1. **ROPA tool** (Art. 30 register).
2. **AI-assisted document generation** (privacy notices, policies) — LLM asks questions, DPO answers, document generates; template reuse after the first pass so the consultant isn't re-reviewing every passage each time; versioning with staleness-flagging when the underlying template changes (legal drift shouldn't be silent); share to the org with open/read tracking for audit purposes.
3. **DPIA automation** — send a questionnaire to a vendor, get answers back, generate the DPIA. Confirmed as a real gap vs. the competitor (see below). Needs, beyond the questionnaire: a risk-scoring method (likelihood × severity against a stated scale), necessity/proportionality reasoning, mitigations and residual risk, the Art. 36 prior-consultation trigger when residual risk stays high, and sign-off with a review date.
4. **Incident management** — logs, templates, project management. Recommendation: reuse AxioVendo's role-based assignment/deadline/audit-trail pattern rather than building a bespoke PM tool.
5. **Staff training** — quiz + content, ideally with some animation (deprioritized from v1: expensive, orthogonal to the core thesis). Confirmed gap vs. competitor: their "staff training" is a record of who was trained, not training content itself.
6. **Dashboard** — per-client actions and deadlines needed.

---

## 3. Competitor: DPO Workspace (dpoworkspace.eu)

Found mid-conversation; live trial account inspected via screenshots, not just the marketing site.

**What it already does well**, roughly covering sections 1, 2, 4, 5 (partial), 6:
- Art. 30 register (manual form entry, sector templates) — not AI-derived from documents.
- Document generator: guided questionnaire → professionally formatted draft, mandatory DPO validation before export. Same interaction pattern independently proposed for section 2.
- Data breach handling with an automatic Art. 33 72-hour timer, and a client self-report portal (link + code, no account needed) — but this is one-way incident reporting only, not a daily workspace for staff.
- Staff training register (attendance/certificates), no actual training content.
- Compliance score, weekly digest, deadline calendar feed.
- **Sentinel**: matches new case law / DPA decisions against every client's register, flags which processing activities might be affected. Shipped in a deliberately cautious half-state — client-notification feature explicitly paused pending further field testing.
- Built and run by a practicing certified DPO (Pietro Cravero) — a credibility signal a non-DPO founder can't replicate directly.
- Pricing: €19/39/79 per month, unlimited clients on the Pro tier.

**Confirmed structural gaps**, found via the live trial, not just inferred from marketing copy:
- **No AI extraction/derivation from arbitrary client documents anywhere.** Everything is manual entry, guided questionnaires, or CSV import. This remains the core technical differentiator to build toward.
- **International breadth is largely unbuilt scaffolding.** The France retention matrix is entirely tagged "to be confirmed" with a banner admitting the legal references haven't been checked against source yet.
- **Localization is UI-only, not content-deep.** The DPIA Wizard's actual WP248 question text is still in Italian even with the interface set to English.
- **No vendor-facing DPIA questionnaire round-trip** — the DPO answers all DPIA questions themselves.
- **No product surface for anyone other than the DPO.** Everything happens inside "the DPO's account," with clients as rows/tabs beneath it. There is no first-class object for a client company that other people (an accidental DPO, staff) can be invited into as members. This is the single most important structural finding — it's the reason they can't support a distributed workspace no matter how many features they add, and it's the direct justification for the tenant-first architecture in Section 4.
- Their buyer segments (independent DPOs, consultants, law firms, public-sector/healthcare specialists, SME consultants, consultant networks) are all professional-acting-for-clients roles — there is no accidental-DPO segment. Sentinel's cross-client case-law monitoring only makes sense at consultant scale (many clients across sectors); it isn't a problem the target segment (a single startup with a part-time DPO on retainer) actually has.
- "Practice documents" (the DPO's own compliance paperwork — appointment letters, insurance, qualifications, their own Art. 30 register as a processor) is real, distinct scope, correctly parked as not a v1 priority.

---

## 4. Architecture: tenant-first design

**The core reframing**: the workspace is the company, not the DPO's app. This is a Slack/Notion-style multi-tenant model — a tenant with members of varying trust levels — not a DPO account with client rows underneath it.

### Access tiers

1. **Active DPO** (a list per tenant, not a single owner) — full trust, full visibility: register, DPIA, incidents, risk analysis. Can be accidental or fractional; a tenant can have more than one simultaneously (e.g. during a handover).
   - Removal from this list is **immediate and binary** in v1 — no grace period. A "temporary access" grant is a plausible future feature, explicitly not built into the core model now.
   - A fractional DPO's **portfolio dashboard** is a computed rollup across every tenant where they currently appear on this list — not a separate object, same shape as AxioVendo's admin view.
2. **Staff / tenant member** — scoped visibility only: whatever's been specifically published or assigned to them (a policy to acknowledge, a training module, one scoped question like "what's the retention period on this vendor's data"). Never sees the register, DPIA, or other members' assignments.
   - Needs a **maintained staff roster** as the base object, not one built up incidentally from whoever happened to get pinged — otherwise you can prove who *did* acknowledge a policy but never who *didn't*, which undercuts the audit value of the log.
   - Needs **persistent identity** (not single-use links) so training/acknowledgment history accumulates per person over time. Named explicitly as a fundamental difference from DPO Workspace, which has no equivalent.
   - One shared mechanism underlies both "answer this scoped question" and "read this policy and confirm": push one specific thing to one specific member, log the response. Content type varies (question / document / training module); the primitive doesn't.
3. **External scoped access** — time-limited, revocable, logged share links for auditors or a customer's compliance reviewer. Reuses the AxioVendo Digital DPO Response Desk pattern (unique link, full view log), strictly scoped to one tenant so an auditor for Company A can never see Company B.

### Approval discipline

Every draft — whether raised by a staff member's scoped answer or the accidental DPO's own intake — lands as `pending_dpo_review`. Nothing writes to the register automatically. Reaffirmed explicitly and unconditionally.

---

## 5. Handover, billing, and data-retention mechanics

- **Provenance vs. access are different things.** What persists after a fractional DPO's access ends: a record that they maintained the register for a given date range (their permanent "companies advised" count, a real credential). What does *not* persist: live access to current data. Provenance must be stored separately from the tenant's live/deletable data so it survives even if the tenant is later purged.
- **Zero-Active-DPO handling**: if a fractional DPO leaves and there's no qualified successor, the product should force an explicit choice (keep the tenant with no Active DPO / promote someone / find a new fractional DPO) rather than silently auto-promoting the accidental DPO into a liability they never agreed to.
- **Non-payment**: access blocks, but the tenant goes **read-only for up to a year** before being purged — not immediate deletion. Balances storage-limitation principles against punishing an accidental lapsed card, and keeps "you'll lose everything" as real, actionable leverage rather than something that's already happened before anyone notices.
- **Still open**: billing ownership during a transition window where two Active DPOs are listed simultaneously (who's charged until one is removed) — not yet resolved.

---

## 6. Legal-basis triage (raised, direction agreed, not fully closed)

- Not every company with a named DPO is legally required to have one under GDPR Art. 37 — only public bodies, large-scale systematic monitoring, or large-scale special-category processing are mandatory.
- Most of the target market has a DPO for one of two other reasons, which carry different weight:
  - **Contractual** — a customer's vendor questionnaire or DPA required naming one (direct link to AxioVendo's sell-side use case).
  - **Voluntary** — self-designated out of caution, which still triggers Art. 37(4) independence/resourcing obligations once done.
- **Agreed direction**: tenant onboarding should capture *why* the company has a DPO, because it determines how urgently the product treats an empty Active DPO seat — mandatory (live compliance breach), contractual (commercial/reputational exposure — a customer representation now false), or voluntary (governance lapse). Onboarding wording/flow not yet built.

---

## 7. Prompt design status

- **Prompt A — batch intake** (fractional DPO onboarding a new client's existing document pile): two-stage pipeline — per-document candidate extraction with source/passage attribution, then cross-document reconciliation — reporting found-vs-not-evidenced against a canonical processing-activity checklist rather than assuming silence means absence. Designed in outline, not written in full.
- **Prompt B — incremental reconciliation** (one new document against an existing register): enrich / propose new / flag drift, matched on purpose + vendor name, falling back to semantic similarity. Designed in outline, not written in full.
- **Day-to-day elicitation prompt** (the new, sticky, high-frequency primitive — an accidental DPO reporting something like "we just signed up for a new vendor"): **fully drafted**, including system prompt and worked example. Key properties: conversational one-question-at-a-time, plain English with jargon explained inline, every field tagged `stated` / `inferred` / `unknown`, retrieval-based matching against the existing register happens before the model asks anything, DPIA-relevant risk signals are screened for quietly without exposing WP248 jargon to a non-specialist, output is a structured `pending_dpo_review` draft with tenant ID and source attribution. Flagged as needing tool-call/structured-output implementation rather than free-text parsing, given the confidence-tagging requirement.
- **Not yet designed**: the vendor-facing DPIA questionnaire round-trip; the scoped single-question assignment prompt for tier-2 staff (distinct from the day-to-day elicitation prompt aimed at the accidental DPO); anything for Sentinel-style external case-law monitoring (explicitly parked — not a v1 priority for this target segment).

---

## 8. Open decisions checklist

1. Onboarding: capture legal basis for having a DPO (mandatory / contractual / voluntary) — wording/flow not built.
2. Zero-Active-DPO handling — direction agreed, not built.
3. Billing during a two-Active-DPO transition window — unresolved.
4. How the credit/marketplace escalation idea integrates with the tenant model — parked.
5. Tier-2 (staff) persistent identity mechanism — confirmed wanted, exact implementation (magic link vs. lightweight account) not finalized.
6. Prompt B full text — not written.
7. Vendor-facing DPIA questionnaire prompt — not designed.
