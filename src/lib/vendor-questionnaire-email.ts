import "server-only";

import { escFields } from "./html-escape";
import { emailButton, emailLayout } from "./send-email";

/**
 * The message a vendor receives (design resume §1, growth mechanic 3).
 *
 * Two settings decide what this is and what it contains, and §1 is explicit
 * that they are never bundled:
 *
 *   platform_send_authorized    whether this may be sent at all, branded as
 *                               sent on the DPO's behalf. Checked by the
 *                               caller; if it is false there is no message.
 *   vendor_recommendation_note  whether the closing paragraph recommending
 *                               AxioVendo is included. On by default, one click
 *                               off, decided once for the workspace.
 *
 * The note is written as what §1 says it is: the DPO's own recommendation,
 * phrased as a suggestion to the vendor, not as an advertisement inserted by a
 * platform. That wording is not decoration — §1's reasoning is that a genuine,
 * individualized professional recommendation is what makes the underlying
 * legitimate-interest case survivable, and copy that reads as a systematic ad
 * insertion would undermine the basis it depends on.
 */

export interface VendorQuestionnaireEmail {
  vendorContactEmail: string;
  vendorName: string;
  tenantName: string;
  dpoName: string;
  linkUrl: string;
  expiresAt: string;
  questionCount: number;
  includeRecommendation: boolean;
}

export function vendorQuestionnaireSubject(input: VendorQuestionnaireEmail): string {
  // Plain-text header, so it keeps the raw values.
  return `${input.tenantName}: a few data protection questions about ${input.vendorName}`;
}

export function vendorQuestionnaireBody(input: VendorQuestionnaireEmail): string {
  const e = escFields(input);
  const deadline = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(input.expiresAt));

  const recommendation = input.includeRecommendation
    ? `<p style="margin-top:28px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:13px;color:#475569">
    If you answer questions like these often, ${e.dpoName} suggests taking a look at
    <a href="https://axiovendo.com" style="color:#0f172a">AxioVendo</a> — it keeps your answers in
    one place so the next questionnaire takes minutes rather than an afternoon. Entirely optional,
    and nothing to do with answering this one.
  </p>`
    : "";

  return emailLayout(`
  <p>Hello,</p>
  <p>
    ${e.dpoName} is the Data Protection Officer for ${e.tenantName}. They are recording what personal
    data ${e.vendorName} processes on their behalf, and have
    ${input.questionCount === 1 ? "one question" : `${input.questionCount} questions`} for you.
  </p>
  <p>
    It should take a few minutes. There is no account to create — the link opens straight onto the
    questions, and you can come back and change an answer.
  </p>
  ${emailButton(input.linkUrl, "Answer the questions")}
  <p style="font-size:13px;color:#475569">
    The link stops working on ${deadline}, and ${e.dpoName} can withdraw it at any time. Your answers
    go to them for review — nothing is published.
  </p>
  <p style="font-size:13px;color:#475569">
    Sent by Fractional DPO on behalf of ${e.dpoName} at ${e.tenantName}. If you were not expecting
    this, reply and tell them.
  </p>
  ${recommendation}`);
}
