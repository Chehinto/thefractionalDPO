"use client";

/**
 * The tab bar itself. Split out as a Client Component because the active tab
 * has to be computed client-side (see `layout.tsx` for why): the layout that
 * renders this does not re-render on navigation, so a server-computed "active"
 * tab would freeze on whichever tab was open the first time the layout loaded.
 * `useSelectedLayoutSegment()` re-reads on every client-side navigation, which
 * is what keeps the highlight honest.
 */

import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { activeTabId, hrefForTab, type WorkspaceTab } from "./tenant-tabs";

export function TenantTabBar({
  tenantId,
  tabs,
}: {
  tenantId: string;
  tabs: readonly WorkspaceTab[];
}) {
  const segment = useSelectedLayoutSegment();
  const active = activeTabId(tabs, segment);

  return (
    <nav aria-label="Workspace" className="border-b border-slate-200">
      <ul className="mx-auto flex max-w-5xl flex-wrap gap-1 px-4">
        {tabs.map((tab) => (
          <li key={tab.id}>
            <Link
              href={hrefForTab(tenantId, tab)}
              aria-current={active === tab.id ? "page" : undefined}
              data-testid={`tab-${tab.id}`}
              className={`inline-block border-b-2 px-3 py-2.5 text-sm ${
                active === tab.id
                  ? "border-slate-900 font-medium text-slate-900"
                  : "border-transparent text-slate-600 hover:text-slate-900"
              }`}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
