import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REMOTION_RENDER_TIMEOUT_MS,
  DEFAULT_REMOTION_RENDERER_PORT,
  RemotionRenderTimeoutError,
  resolveRemotionRenderTimeoutMs,
  resolveRemotionRendererPort,
  withRemotionRendererLock,
} from "@/infrastructure/video/remotionRendererConfig";

describe("resolveRemotionRendererPort", () => {
  it("uses 3300 when the env var is missing", () => {
    expect(resolveRemotionRendererPort(undefined)).toBe(DEFAULT_REMOTION_RENDERER_PORT);
  });

  it("uses a valid env override", () => {
    expect(resolveRemotionRendererPort("4400")).toBe(4400);
  });

  it.each(["abc", "3.5", "0", "-1", "65536", "Infinity"])(
    "falls back for invalid value %s",
    (rawValue) => {
      const warn = vi.fn();
      expect(resolveRemotionRendererPort(rawValue, { warn })).toBe(DEFAULT_REMOTION_RENDERER_PORT);
      expect(warn).toHaveBeenCalledWith(
        "Invalid REMOTION_RENDERER_PORT; using default",
        expect.objectContaining({ value: rawValue, defaultPort: DEFAULT_REMOTION_RENDERER_PORT }),
      );
    },
  );

  it("allows the full valid port range", () => {
    expect(resolveRemotionRendererPort("1")).toBe(1);
    expect(resolveRemotionRendererPort("65535")).toBe(65_535);
  });
});

describe("withRemotionRendererLock", () => {
  it("serializes concurrent renderer sections", async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = withRemotionRendererLock(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
    });

    const second = withRemotionRendererLock(async () => {
      events.push("second:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("releases the lock when fn() rejects so the next holder can acquire", async () => {
    await expect(
      withRemotionRendererLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A subsequent acquire must resolve quickly — if release() were skipped
    // on rejection, this would hang and the timeout would fail the test.
    const next = withRemotionRendererLock(async () => 42);
    await expect(
      Promise.race([
        next,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("deadlock")), 250),
        ),
      ]),
    ).resolves.toBe(42);
  });

  it("queues a second holder behind a rejecting first holder", async () => {
    const events: string[] = [];
    const firstRan = vi.fn();
    const first = withRemotionRendererLock(async () => {
      events.push("first:start");
      firstRan();
      throw new Error("boom");
    });

    const second = withRemotionRendererLock(async () => {
      // First must have started before the second body runs.
      expect(firstRan).toHaveBeenCalledTimes(1);
      events.push("second:start");
    });

    await expect(first).rejects.toThrow("boom");
    await second;
    expect(events).toEqual(["first:start", "second:start"]);
  });

  it("rejects with RemotionRenderTimeoutError when fn() exceeds the deadline and releases the lock", async () => {
    let neverResolve: (() => void) | null = null;
    const hanging = withRemotionRendererLock(
      () =>
        new Promise<void>(() => {
          // Held forever — the timeout must break us out.
          neverResolve = () => {};
        }),
      { timeoutMs: 50 },
    );

    await expect(hanging).rejects.toBeInstanceOf(RemotionRenderTimeoutError);

    // After the timeout fires, the lock is released; the next holder must
    // acquire and run promptly even though the hanging body is still pending.
    const next = withRemotionRendererLock(async () => "next-ran", { timeoutMs: 500 });
    await expect(
      Promise.race([
        next,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("deadlock")), 250),
        ),
      ]),
    ).resolves.toBe("next-ran");

    // Reference the captured ref so eslint doesn't complain about unused assignment.
    expect(neverResolve).not.toBeNull();
  });
});

describe("resolveRemotionRenderTimeoutMs", () => {
  it("uses the default when the env var is missing", () => {
    expect(resolveRemotionRenderTimeoutMs(undefined)).toBe(DEFAULT_REMOTION_RENDER_TIMEOUT_MS);
  });

  it("uses a valid integer override", () => {
    expect(resolveRemotionRenderTimeoutMs("60000")).toBe(60_000);
  });

  it.each(["abc", "1.5", "0", "-1"])(
    "falls back for invalid value %s",
    (rawValue) => {
      const warn = vi.fn();
      expect(resolveRemotionRenderTimeoutMs(rawValue, { warn })).toBe(
        DEFAULT_REMOTION_RENDER_TIMEOUT_MS,
      );
      expect(warn).toHaveBeenCalledWith(
        "Invalid REMOTION_RENDER_TIMEOUT_MS; using default",
        expect.objectContaining({ value: rawValue }),
      );
    },
  );
});
