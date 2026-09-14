/**
 * The message a vendor receives, and the two settings that shape it.
 *
 * This is the only content this product sends to a company that has no
 * relationship with it, under a professional's name. So the tests are about
 * injection, and about §1's rule that the two toggles are never bundled.
 */

import { describe, expect, it } from "vitest";
import { esc, escFields } from "@/lib/html-escape";
import { allowedRecipient } from "@/lib/send-email";
import {
  vendorQuestionnaireBody,
  vendorQuestionnaireSubject,
  type VendorQuestionnaireEmail,
} from "@/lib/vendor-questionnaire-email";

const BASE: VendorQuestionnaireEmail = {
  vendorContactEmail: "security@acme.test",
  vendorName: "ScreenCo",
  tenantName: "Northwind Retail",
  dpoName: "Dana Okafor",
  linkUrl: "https://app.example.test/s/tok3n",
  expiresAt: "2026-10-01T00:00:00.000Z",
  questionCount: 2,
  includeRecommendation: true,
};

describe("escaping", () => {
  it("escapes the five characters that matter", () => {
    expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("escapes every string field and leaves non-strings alone", () => {
    const out = escFields({ name: "<b>", count: 3, flag: true });
    expect(out).toEqual({ name: "&lt;b&gt;", count: 3, flag: true });
  });

  // A vendor name is typed by a staff member or extracted by a model. Either
  // way it reaches a stranger's inbox inside a message carrying a real DPO's
  // name — markup in it would put an attacker's link under that name.
  it("cannot be used to inject markup into the body", () => {
    const body = vendorQuestionnaireBody({
      ...BASE,
      vendorName: `</p><a href="https://evil.test">Click here to verify</a><p>`,
      dpoName: `<script>alert(1)</script>`,
    });

    expect(body).not.toContain("<a href=\"https://evil.test\"");
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  // The subject is a plain-text header, not HTML, so it keeps raw values.
  it("leaves the subject unescaped, because it is not HTML", () => {
    const subject = vendorQuestionnaireSubject({ ...BASE, vendorName: "Smith & Co" });
    expect(subject).toContain("Smith & Co");
  });
});

describe("the recommendation note", () => {
  it("is included when the workspace setting is on", () => {
    const body = vendorQuestionnaireBody({ ...BASE, includeRecommendation: true });
    expect(body).toContain("AxioVendo");
  });

  it("is absent when it is off, and nothing else changes", () => {
    const withNote = vendorQuestionnaireBody({ ...BASE, includeRecommendation: true });
    const without = vendorQuestionnaireBody({ ...BASE, includeRecommendation: false });

    expect(without).not.toContain("AxioVendo");
    // The questionnaire itself is untouched by the marketing decision: the same
    // link, the same deadline, the same explanation of who is asking.
    expect(without).toContain(BASE.linkUrl);
    expect(without).toContain("Northwind Retail");
    expect(withNote.replace(/<p style="margin-top:28px[\s\S]*?<\/p>/, "").trim()).toBe(
      without.trim()
    );
  });

  // §1: the note is the DPO's own recommendation, not an advertisement the
  // platform inserted. The copy has to read that way, because that framing is
  // what the legitimate-interest argument rests on.
  it("is written as the DPO's suggestion, and says it is optional", () => {
    const body = vendorQuestionnaireBody(BASE);
    expect(body).toContain("Dana Okafor suggests");
    expect(body).toContain("optional");
  });
});

describe("who the message says it is from", () => {
  it("names the DPO and the workspace it is sent on behalf of", () => {
    const body = vendorQuestionnaireBody(BASE);
    expect(body).toContain("on behalf of Dana Okafor");
    expect(body).toContain("Northwind Retail");
  });

  it("tells the vendor the link expires and can be withdrawn", () => {
    const body = vendorQuestionnaireBody(BASE);
    expect(body).toContain("01 October 2026");
    expect(body).toContain("withdraw");
  });
});

describe("the recipient allow-list", () => {
  it("sends to anyone when it is not configured", () => {
    expect(allowedRecipient("someone@real-company.test", "")).toBe(true);
    expect(allowedRecipient("someone@real-company.test", undefined)).toBe(true);
  });

  // A seed fixture using a plausible company address must not mail a stranger.
  it("sends only to listed addresses and domains when it is", () => {
    const list = "dpo@example.test, @safe.test";
    expect(allowedRecipient("dpo@example.test", list)).toBe(true);
    expect(allowedRecipient("anyone@safe.test", list)).toBe(true);
    expect(allowedRecipient("someone@real-company.test", list)).toBe(false);
  });

  it("ignores case and surrounding space", () => {
    expect(allowedRecipient("  DPO@Example.test ", "dpo@example.test")).toBe(true);
  });
});
