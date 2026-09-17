/**
 * The two API routes where the tier gate in `requireMembership` is the ONLY
 * thing refusing a tier-3 member — there is no policy behind it to catch a
 * mistake here.
 *
 * `tenants_read` (0001:316) and `vendor_request_insert` (0011:59) are both
 * `app.is_member_of(...)`, which is true for any live tier including
 * `external_scoped`, and the vendor-request route goes on to write the
 * resulting `ai_suggestion` with the service client
 * (`bypassRlsAfterMembershipCheck: true`). So an `external_scoped` member who
 * got past the application check would genuinely read the workspace's name,
 * status and legal basis, or insert a row in their own name. Unlike the
 * register, RLS does not independently refuse them here.
 *
 * Supabase and the AI path are stubbed: what is under test is whether the
 * handler ever reaches them, which is exactly what the stubs can observe.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestClient: vi.fn(),
  generateAiSuggestionDraft: vi.fn(),
  saveAiSuggestion: vi.fn(),
}));

vi.mock("@/lib/supabase-server", () => ({ requestClient: mocks.requestClient }));

// Stubbed so that a regression shows up as "the AI path ran for a tier-3
// caller" rather than as a network error, and so the service-role client in
// save-ai-suggestion is never constructed in a unit test.
vi.mock("@/lib/ai-suggestion-runtime", () => ({
  AiRuntimeError: class AiRuntimeError extends Error {
    status = 502;
  },
  generateAiSuggestionDraft: mocks.generateAiSuggestionDraft,
}));
vi.mock("@/lib/save-ai-suggestion", () => ({
  saveAiSuggestion: mocks.saveAiSuggestion,
  messageForAiSuggestionSaveError: () => "The vendor request could not be saved",
  statusForAiSuggestionSaveError: () => 500,
}));

import { GET as getTenant } from "@/app/api/tenants/[tenantId]/route";
import { POST as postVendorRequest } from "@/app/api/tenants/[tenantId]/vendor-requests/route";
import type { MembershipTier } from "@/lib/tenant-access";

const TENANT_A = "11111111-1111-4111-8111-111111111111";

/** Tables the stub was asked for, so a test can assert one was never reached. */
let tablesTouched: string[] = [];

function withMemberAtTier(tier: MembershipTier) {
  tablesTouched = [];

  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "auth-1" } } }) },
    from: (table: string) => {
      tablesTouched.push(table);
      if (table === "people") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "person-1", email: "member@example.test" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: TENANT_A,
                  name: "Under Audit Ltd",
                  status: "active",
                  legal_basis: "mandatory",
                  created_at: "2026-01-01T00:00:00Z",
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "vendor_request") {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: {
                  id: "44444444-4444-4444-8444-444444444444",
                  vendor_name: "Figma",
                  purpose: "Design collaboration",
                  data_description: null,
                  status: "pending_dpo_review",
                },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc: async () => ({
      data: [
        {
          membership_id: "33333333-3333-4333-8333-333333333333",
          tenant_id: TENANT_A,
          tenant_name: "Under Audit Ltd",
          tenant_status: "active",
          tier,
          active_from: "2026-01-01T00:00:00Z",
          active_to: null,
        },
      ],
      error: null,
    }),
  };

  mocks.requestClient.mockResolvedValue(client);
}

const params = { params: Promise.resolve({ tenantId: TENANT_A }) };

function vendorRequestBody() {
  return new Request("http://localhost/api/tenants/x/vendor-requests", {
    method: "POST",
    body: JSON.stringify({
      vendorName: "Figma",
      purpose: "Design collaboration for the marketing team",
    }),
  });
}

beforeEach(() => {
  mocks.generateAiSuggestionDraft.mockReset();
  mocks.saveAiSuggestion.mockReset();
  mocks.generateAiSuggestionDraft.mockResolvedValue({ usedFallback: false, output: {} });
  mocks.saveAiSuggestion.mockResolvedValue({ data: { id: "s1" }, error: null });
});

describe("GET /api/tenants/{tenantId}", () => {
  it("answers an external_scoped member with 404 and never reads the tenant row", async () => {
    withMemberAtTier("external_scoped");

    const response = await getTenant(new Request("http://localhost/api/tenants/x"), params);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    // The refusal has to happen before the query, because the query itself
    // would have succeeded: `tenants_read` admits any live tier.
    expect(tablesTouched).not.toContain("tenants");
  });

  it("still answers a staff member, so the refusal above is about tier", async () => {
    withMemberAtTier("staff");

    const response = await getTenant(new Request("http://localhost/api/tenants/x"), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tenant.id).toBe(TENANT_A);
    expect(body.yourTier).toBe("staff");
  });
});

describe("POST /api/tenants/{tenantId}/vendor-requests", () => {
  it("answers an external_scoped member with 404, inserting nothing", async () => {
    withMemberAtTier("external_scoped");

    const response = await postVendorRequest(vendorRequestBody(), params);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(tablesTouched).not.toContain("vendor_request");
    // The AI suggestion this route creates is written with the service client,
    // so a tier-3 caller reaching it would write past RLS entirely.
    expect(mocks.generateAiSuggestionDraft).not.toHaveBeenCalled();
    expect(mocks.saveAiSuggestion).not.toHaveBeenCalled();
  });

  it("refuses an external_scoped member identically to a non-member", async () => {
    withMemberAtTier("external_scoped");
    const scoped = await postVendorRequest(vendorRequestBody(), params);
    const scopedBody = await scoped.json();

    mocks.requestClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "auth-2" } } }) },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: "person-2", email: "stranger@example.test" },
              error: null,
            }),
          }),
        }),
      }),
      rpc: async () => ({ data: [], error: null }),
    });
    const stranger = await postVendorRequest(vendorRequestBody(), params);

    expect(scoped.status).toBe(stranger.status);
    expect(scopedBody).toEqual(await stranger.json());
  });

  it("still accepts a staff member, so the refusal above is about tier", async () => {
    withMemberAtTier("staff");

    const response = await postVendorRequest(vendorRequestBody(), params);

    expect(response.status).toBe(201);
    expect(mocks.saveAiSuggestion).toHaveBeenCalledTimes(1);
  });
});
