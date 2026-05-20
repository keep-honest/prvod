import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("logger", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("warns on invalid LOG_LEVEL value", async () => {
    vi.stubEnv("LOG_LEVEL", "trace");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("@/lib/logger");

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/Invalid LOG_LEVEL="trace"/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/Valid: debug, info, warn, error/);
    warnSpy.mockRestore();
  });

  it("does not warn when LOG_LEVEL is valid", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("@/lib/logger");

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not warn when LOG_LEVEL is unset", async () => {
    vi.stubEnv("LOG_LEVEL", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("@/lib/logger");

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("accepts case-insensitive LOG_LEVEL", async () => {
    vi.stubEnv("LOG_LEVEL", "DEBUG");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { createLogger } = await import("@/lib/logger");
    const logger = createLogger("test");

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logger).toBeDefined();
    warnSpy.mockRestore();
  });
});
