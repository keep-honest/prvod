"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { OrgSwitcher } from "./OrgSwitcher";
import type { OrgEntry } from "@/app/dashboard/orgEntry";

interface DashboardSidebarProps {
  organizations: OrgEntry[];
}

const NAV_ITEMS = [
  { href: "/dashboard/walkthroughs", label: "Walkthroughs", icon: JobsIcon },
] as const;

export function DashboardSidebar({ organizations }: DashboardSidebarProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => { setMobileOpen(true); setCollapsed(false); }}
        className={`fixed left-4 top-4 z-50 rounded-lg border border-[var(--border)] bg-[var(--background-panel)] p-2 ${collapsed ? "" : "md:hidden"}`}
        aria-label="Open navigation menu"
      >
        <HamburgerIcon />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-[var(--border)]
          bg-[var(--background-elevated)] transition-[transform,width,min-width] duration-[var(--duration-medium)]
          md:relative md:translate-x-0
          ${collapsed ? "md:w-0 md:min-w-0 md:overflow-hidden md:border-r-0" : ""}
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Logo + close */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <Link
            href="/dashboard/walkthroughs"
            prefetch={false}
            className="font-[family-name:var(--font-display)] text-lg font-bold tracking-tight text-[var(--foreground)]"
          >
            PrVod
          </Link>
          <button
            onClick={() => { setMobileOpen(false); setCollapsed(true); }}
            className="rounded p-1 text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
            aria-label="Collapse sidebar"
          >
            <CollapseIcon />
          </button>
        </div>

        {/* Org switcher */}
        <div className="border-b border-[var(--border)] px-3 py-3">
          <OrgSwitcher organizations={organizations} />
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4" aria-label="Dashboard navigation">
          <ul className="space-y-1">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
              const active = pathname.startsWith(href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    prefetch={false}
                    onClick={() => setMobileOpen(false)}
                    className={`
                      cine-transition flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium
                      ${
                        active
                          ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                          : "text-[var(--foreground-muted)] hover:bg-[var(--background-panel)] hover:text-[var(--foreground)]"
                      }
                    `}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
    </>
  );
}

// ── Inline SVG Icons ─────────────────────────────────────────────────

function HamburgerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 5h14M3 10h14M3 15h14" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3l-5 5 5 5" />
    </svg>
  );
}

function JobsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 7h6M5 10h4" />
    </svg>
  );
}
