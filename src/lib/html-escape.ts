/**
 * HTML escaping for the strings we assemble by hand — email bodies, today.
 *
 * Ported from AxioVendo's `lib/html.ts`, and the reasoning carries over intact:
 * any value that came from a person has to be escaped before it lands in HTML,
 * or someone can inject markup. Here the stakes are a little higher than there.
 * A vendor-questionnaire email is sent BY this platform ON a DPO's behalf, to a
 * company that has no relationship with us — so a vendor name containing an
 * anchor tag would put an attacker's link inside a message that carries a
 * professional's name and a real workspace's branding.
 *
 * The pattern is to escape the whole options object once, at the top of each
 * template, and use the escaped copy in the body:
 *
 *     const e = escFields(opts);
 *     send(opts.to, `Questions about ${opts.vendorName}`, `<p>${e.vendorName}</p>`);
 *
 * Subjects are a plain-text header rather than HTML, so they keep the raw
 * values. Bodies use the escaped ones. Escaping every field at once beats
 * relying on whoever edits the template next to remember each interpolation.
 */

/** Escape the five characters that matter in HTML text and attributes. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;") // first, so the escapes below are not re-encoded
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape every string field of an object, leaving non-strings alone. */
export function escFields<T extends object>(
  fields: T
): { [K in keyof T]: T[K] extends string ? string : T[K] } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === "string" ? esc(value) : value;
  }
  return out as { [K in keyof T]: T[K] extends string ? string : T[K] };
}
