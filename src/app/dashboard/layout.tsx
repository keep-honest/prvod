import { getContainer } from "@/config/container";
import { createLogger } from "@/lib/logger";
import { DashboardSidebar } from "@/app/dashboard/_components/DashboardSidebar";
import { toOrgEntry, type OrgEntry } from "@/app/dashboard/orgEntry";

const logger = createLogger("dashboard/layout");

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // null = load failed (distinct from [] = fresh install with no accounts)
  let organizations: OrgEntry[] | null = null;

  try {
    const container = await getContainer();
    const installations = await container.installationRepository.findAllActive();
    organizations = installations.map(toOrgEntry);
    logger.debug("Dashboard layout: loaded installations", {
      count: organizations.length,
    });
  } catch (err) {
    logger.error("Dashboard layout: failed to load installations", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return (
    <div className="grid min-h-screen grid-cols-[auto_1fr]">
      <DashboardSidebar organizations={organizations} />
      <main className="min-w-0 overflow-y-auto p-6 md:p-8 lg:p-10">
        {children}
      </main>
    </div>
  );
}
