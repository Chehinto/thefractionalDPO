/**
 * Why a company has a DPO (design resume §6).
 *
 * Shared because there are already three callers — both tenant-creation entry
 * points and the signup form — and they must agree on the exact strings, which
 * are also the values of a Postgres enum. A fourth spelling anywhere is a
 * rejected insert at best.
 *
 * The three are not interchangeable. They decide how urgently the product
 * treats an empty Active DPO seat, which is the whole reason §6 asks:
 *
 *   mandatory   — Art. 37 requires a DPO here (public body, large-scale
 *                 systematic monitoring, large-scale special-category data).
 *                 An empty seat is a live compliance breach.
 *   contractual — a customer's DPA or vendor questionnaire required naming
 *                 one. An empty seat makes a representation already made to
 *                 that customer false.
 *   voluntary   — self-designated out of caution. Still binding: Art. 37(4)
 *                 independence and resourcing duties attach once a company has
 *                 designated someone, so this is a governance lapse, not a
 *                 free choice to walk away from.
 */

export const LEGAL_BASES = ["mandatory", "contractual", "voluntary"] as const;

export type LegalBasis = (typeof LEGAL_BASES)[number];

/** Wording for the onboarding question. §6 leaves the copy open; this is a
 *  placeholder that states the distinction accurately rather than finally. */
export const LEGAL_BASIS_LABELS: Record<LegalBasis, string> = {
  mandatory: "We're legally required to have one (Art. 37)",
  contractual: "A customer contract or questionnaire required us to name one",
  voluntary: "We appointed one voluntarily",
};
