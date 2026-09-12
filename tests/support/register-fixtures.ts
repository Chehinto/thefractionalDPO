/**
 * Seeding register rows for tests.
 *
 * Direct inserts, because intake does not exist yet — Prompt A, Prompt B and
 * the elicitation prompt are all unbuilt, and there is no creation form. These
 * go in through the service role so a test can set up a draft without first
 * having to be the DPO who would eventually create it.
 *
 * Note what this helper canNOT do: create an already-approved row. The insert
 * trigger refuses it even for the service role, so any test needing an approved
 * activity has to approve it the way the product does.
 */

import { adminClient } from "./tenancy-fixtures";

export type Confidence = "stated" | "inferred" | "unknown";

export interface ActivitySeed {
  purpose?: string;
  purposeConfidence?: Confidence;
  purposeEvidence?: string | null;
  recipientVendor?: string | null;
  recipientVendorConfidence?: Confidence;
  role?: "controller" | "processor";
  ordinary?: string[];
  special?: string[];
  categoriesConfidence?: Confidence;
  subjects?: string[];
  subjectsConfidence?: Confidence;
  retention?: string | null;
  retentionConfidence?: Confidence;
}

/** Insert one draft activity, returning its id. */
export async function seedActivity(tenantId: string, seed: ActivitySeed = {}): Promise<string> {
  const { data, error } = await adminClient()
    .from("processing_activity")
    .insert({
      tenant_id: tenantId,
      purpose: seed.purpose ?? "Payroll administration",
      purpose_confidence: seed.purposeConfidence ?? "stated",
      purpose_evidence: seed.purposeEvidence ?? null,
      recipient_vendor: seed.recipientVendor === undefined ? "Acme Payroll Ltd" : seed.recipientVendor,
      recipient_vendor_confidence: seed.recipientVendorConfidence ?? "stated",
      role: seed.role ?? "controller",
      data_categories_ordinary: seed.ordinary ?? ["employment_data", "financial_data"],
      data_categories_special: seed.special ?? [],
      data_categories_confidence: seed.categoriesConfidence ?? "inferred",
      data_subjects: seed.subjects ?? ["employees"],
      data_subjects_confidence: seed.subjectsConfidence ?? "stated",
      retention: seed.retention === undefined ? "7 years from end of employment" : seed.retention,
      retention_confidence: seed.retentionConfidence ?? "unknown",
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedActivity failed: ${error.message}`);
  return data!.id as string;
}

/** Share one activity with one person, as an Active DPO would. */
export async function shareActivity(activityId: string, personId: string): Promise<void> {
  const { error } = await adminClient()
    .from("processing_activity_share")
    .insert({ activity_id: activityId, person_id: personId });
  if (error) throw new Error(`shareActivity failed: ${error.message}`);
}
