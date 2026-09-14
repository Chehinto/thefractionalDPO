/**
 * The register as an auditor sees it.
 *
 * A server component with no data access of its own: it renders exactly the
 * rows `scoped_register` returned and cannot widen that. What is absent is the
 * point — no drafts, no evidence quotes, no confidence tags, no names — and the
 * reasoning for each exclusion lives in 0015 next to the query that enforces it.
 */

export interface RegisterRow {
  activity_id: string;
  purpose: string;
  recipient_vendor: string | null;
  role: "controller" | "processor";
  data_categories_ordinary: string[];
  data_categories_special: string[];
  data_subjects: string[];
  retention: string | null;
  dpia_risk_flag: boolean;
  approved_at: string | null;
}

export function RegisterView({
  tenantName,
  rows,
}: {
  tenantName: string;
  rows: RegisterRow[];
}) {
  if (rows.length === 0) {
    return (
      <p className="py-10 text-sm text-slate-600" data-testid="scoped-register-empty">
        {tenantName} has no approved processing activities on its register yet. Nothing is hidden
        here — an activity appears once their Data Protection Officer has approved it.
      </p>
    );
  }

  return (
    <ul className="mt-6 space-y-6" data-testid="scoped-register-list">
      {rows.map((row) => (
        <li
          key={row.activity_id}
          className="rounded border border-slate-200 p-4"
          data-testid="scoped-register-row"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="font-medium" data-testid="scoped-register-purpose">
              {row.purpose}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <Tag testId="scoped-register-role">{row.role}</Tag>
              {row.dpia_risk_flag ? (
                <span
                  className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-amber-900"
                  data-testid="scoped-register-dpia-flag"
                >
                  Special category
                </span>
              ) : null}
            </div>
          </div>

          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Field label="Recipient">
              {row.recipient_vendor ?? <NotRecorded>No recipient — handled in-house</NotRecorded>}
            </Field>
            <Field label="Retention">
              {row.retention ?? <NotRecorded>Not recorded</NotRecorded>}
            </Field>
            <Field label="Data subjects">
              {row.data_subjects.length > 0 ? (
                humanise(row.data_subjects)
              ) : (
                <NotRecorded>Not recorded</NotRecorded>
              )}
            </Field>
            <Field label="Data categories">
              {row.data_categories_ordinary.length + row.data_categories_special.length > 0 ? (
                humanise([...row.data_categories_ordinary, ...row.data_categories_special])
              ) : (
                <NotRecorded>Not recorded</NotRecorded>
              )}
            </Field>
          </dl>

          {row.approved_at ? (
            <p className="mt-3 text-xs text-slate-500" data-testid="scoped-register-approved">
              Approved {formatDate(row.approved_at)}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-800">{children}</dd>
    </div>
  );
}

/**
 * An unrecorded field says so rather than rendering blank. A gap in a register
 * is a finding an auditor is entitled to see; an empty cell reads as an
 * oversight in the tool instead of a fact about the record.
 */
function NotRecorded({ children }: { children: React.ReactNode }) {
  return <span className="text-slate-500">{children}</span>;
}

function Tag({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <span
      className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-slate-700"
      data-testid={testId}
    >
      {children}
    </span>
  );
}

function humanise(values: string[]): string {
  return values.map((value) => value.replaceAll("_", " ")).join(", ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}
