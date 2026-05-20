import { afterEach, describe, expect, it } from "vitest";
import { isJudgeSkipped } from "@/lib/featureFlags";

function makeEnv(skipJudge?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (skipJudge === undefined) {
    delete env.SKIP_JUDGE;
  } else {
    env.SKIP_JUDGE = skipJudge;
  }
  return env;
}

describe("isJudgeSkipped", () => {
  const originalEnv = process.env.SKIP_JUDGE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SKIP_JUDGE;
    } else {
      process.env.SKIP_JUDGE = originalEnv;
    }
  });

  it("returns false when SKIP_JUDGE is unset (default)", () => {
    expect(isJudgeSkipped(makeEnv())).toBe(false);
  });

  it("returns false when SKIP_JUDGE=false", () => {
    expect(isJudgeSkipped(makeEnv("false"))).toBe(false);
  });

  it("returns true when SKIP_JUDGE=true", () => {
    expect(isJudgeSkipped(makeEnv("true"))).toBe(true);
  });

  it("returns true when SKIP_JUDGE=1", () => {
    expect(isJudgeSkipped(makeEnv("1"))).toBe(true);
  });

  it("returns false for any other truthy-looking value", () => {
    // The shared isEnabled helper only accepts "1" or "true"
    expect(isJudgeSkipped(makeEnv("yes"))).toBe(false);
    expect(isJudgeSkipped(makeEnv("TRUE"))).toBe(false);
    expect(isJudgeSkipped(makeEnv("on"))).toBe(false);
  });

  it("defaults to process.env when no bag is provided", () => {
    process.env.SKIP_JUDGE = "true";
    expect(isJudgeSkipped()).toBe(true);
    process.env.SKIP_JUDGE = "false";
    expect(isJudgeSkipped()).toBe(false);
  });
});
