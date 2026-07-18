import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

import { redirect } from "next/navigation";

describe("Dashboard page", () => {
  it("redirects to /dashboard/walkthroughs", async () => {
    const { default: DashboardPage } = await import("@/app/dashboard/page");
    expect(() => DashboardPage()).toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/dashboard/walkthroughs");
  });
});
