import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCRIPT_DURATION_GUARD_COEFFICIENT,
  buildDurationGuard,
  formatDurationGuardExceededError,
  parseScriptDurationGuardCoefficient,
} from "@/lib/durationGuard";

function makeLogger() {
  return { warn: vi.fn() };
}

describe("durationGuard", () => {
  it("uses the default coefficient when env is missing", () => {
    const logger = makeLogger();

    expect(parseScriptDurationGuardCoefficient(undefined, logger)).toBe(
      DEFAULT_SCRIPT_DURATION_GUARD_COEFFICIENT,
    );
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("uses a valid coefficient override", () => {
    const logger = makeLogger();

    expect(parseScriptDurationGuardCoefficient("1.25", logger)).toBe(1.25);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["not-a-number", "1.2abc", "Infinity", "0", "-1", "0.99"])(
    "falls back for invalid coefficient %s",
    (raw) => {
      const logger = makeLogger();

      expect(parseScriptDurationGuardCoefficient(raw, logger)).toBe(
        DEFAULT_SCRIPT_DURATION_GUARD_COEFFICIENT,
      );
      expect(logger.warn).toHaveBeenCalledOnce();
    },
  );

  it("rounds guard caps up", () => {
    expect(buildDurationGuard(121, 1.1)).toEqual({
      requestedSeconds: 121,
      coefficient: 1.1,
      guardCapSeconds: 134,
    });
  });

  it("formats guard failures with requested duration, coefficient, guard cap, and actual duration", () => {
    const message = formatDurationGuardExceededError(
      "default",
      { requestedSeconds: 120, coefficient: 1.4, guardCapSeconds: 168 },
      169,
    );

    expect(message).toContain("requested=120s");
    expect(message).toContain("coefficient=1.4");
    expect(message).toContain("guardCap=168s");
    expect(message).toContain("actual=169s");
  });
});
