"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { OrgEntry } from "@/app/dashboard/orgEntry";

interface OrgSwitcherProps {
  organizations: OrgEntry[];
}

function orgDisplayName(org: { orgLogin: string | null; accountType: string } | null | undefined): string {
  if (!org) return "Personal";
  return org.accountType === "User" ? "Personal" : (org.orgLogin ?? "Personal");
}

export function OrgSwitcher({ organizations }: OrgSwitcherProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const selectedOrgId = searchParams.get("org");
  const selectedOrg = organizations.find(
    (o) => String(o.installationId) === selectedOrgId,
  );
  const displayOrg = selectedOrg ?? organizations[0] ?? null;

  function selectOrg(installationId: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("org", String(installationId));
    router.push(`${pathname}?${params.toString()}`);
  }

  if (organizations.length === 0) {
    return (
      <div className="rounded-md bg-[var(--background-panel)] px-3 py-2 text-sm text-[var(--foreground-soft)]">
        No accounts
      </div>
    );
  }

  if (organizations.length === 1) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-[var(--background-panel)] px-3 py-2">
        <OrgAvatar name={displayOrg?.orgLogin ?? "?"} />
        <span className="truncate text-sm font-medium text-[var(--foreground)]">
          {orgDisplayName(displayOrg)}
        </span>
      </div>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="cine-transition flex w-full items-center gap-2 rounded-md bg-[var(--background-panel)] px-3 py-2 text-left hover:bg-[var(--background-panel-strong)]"
          aria-label="Switch organization"
        >
          <OrgAvatar name={displayOrg?.orgLogin ?? "?"} />
          <span className="flex-1 truncate text-sm font-medium text-[var(--foreground)]">
            {orgDisplayName(displayOrg)}
          </span>
          <ChevronIcon />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={4}
          align="start"
          className="z-50 min-w-[200px] rounded-lg border border-[var(--border)] bg-[var(--background-elevated)] p-1 shadow-lg"
        >
          {organizations.map((org) => {
            const isSelected =
              org === displayOrg ||
              String(org.installationId) === selectedOrgId;
            return (
              <DropdownMenu.Item
                key={org.installationId}
                onSelect={() => selectOrg(org.installationId)}
                className={`
                  flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none
                  ${
                    isSelected
                      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "text-[var(--foreground-muted)] hover:bg-[var(--background-panel)]"
                  }
                `}
              >
                <OrgAvatar name={org.orgLogin || "?"} />
                <span className="truncate">{orgDisplayName(org)}</span>
                {isSelected && (
                  <CheckIcon className="ml-auto h-3.5 w-3.5 shrink-0" />
                )}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function OrgAvatar({ name }: { name: string }) {
  const letter = name.charAt(0).toUpperCase();
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--accent-soft)] text-xs font-bold text-[var(--accent)]">
      {letter}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-[var(--foreground-soft)]">
      <path d="M3 4.5l3 3 3-3" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7l3 3 5-6" />
    </svg>
  );
}
