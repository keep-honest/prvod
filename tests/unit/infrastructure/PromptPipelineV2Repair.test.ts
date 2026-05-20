import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { tryParseJson, formatZodErrors, repairLoop } from "@/infrastructure/llm/promptPipelineV2Repair";

const testSchema = z.object({
  name: z.string(),
  age: z.number().int().positive(),
});

describe("tryParseJson", () => {
  it("returns success for valid JSON matching schema", () => {
    const result = tryParseJson('{"name":"Alice","age":30}', testSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Alice", age: 30 });
    }
  });

  it("strips markdown fences before parsing", () => {
    const result = tryParseJson('```json\n{"name":"Bob","age":25}\n```', testSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Bob");
    }
  });

  it("returns failure with rawJson and zodError on schema mismatch", () => {
    const result = tryParseJson('{"name":"Charlie","age":-1}', testSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.rawJson).toBe('{"name":"Charlie","age":-1}');
      expect(result.zodError.issues.length).toBeGreaterThan(0);
    }
  });

  it("throws on invalid JSON syntax (not a ZodError)", () => {
    expect(() => tryParseJson("{broken json", testSchema)).toThrow(SyntaxError);
  });
});

describe("formatZodErrors", () => {
  it("formats a single issue with path", () => {
    const result = testSchema.safeParse({ name: 123, age: 30 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodErrors(result.error);
      expect(formatted).toContain("name:");
      expect(formatted).toContain("Expected string");
    }
  });

  it("formats multiple issues", () => {
    const result = testSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodErrors(result.error);
      const lines = formatted.split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("formats nested path correctly", () => {
    const nestedSchema = z.object({ user: z.object({ name: z.string() }) });
    const result = nestedSchema.safeParse({ user: { name: 123 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodErrors(result.error);
      expect(formatted).toContain("user.name:");
    }
  });
});

describe("repairLoop", () => {
  const validScript = '{"name":"Fixed","age":25}';

  beforeEach(() => {
    vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("repairs a broken result on first attempt", async () => {
    const brokenResult = tryParseJson('{"name":"Alice","age":-1}', testSchema);
    expect(brokenResult.success).toBe(false);

    const completeText = vi.fn().mockResolvedValueOnce(validScript);
    const result = await repairLoop(brokenResult, testSchema, {
      completeText,
      promptContext: { family: "claude" },
      validDurations: [4, 6, 8],
      label: "test",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Fixed");
    expect(completeText).toHaveBeenCalledTimes(1);
  });

  it("repairs on second attempt when first repair also fails", async () => {
    const brokenResult = tryParseJson('{"name":"Alice","age":-1}', testSchema);
    const completeText = vi.fn()
      .mockResolvedValueOnce('{"name":"StillBroken","age":-2}')
      .mockResolvedValueOnce(validScript);

    const result = await repairLoop(brokenResult, testSchema, {
      completeText,
      promptContext: { family: "gemini" },
      validDurations: [4, 6, 8],
      label: "test",
    });

    expect(result.success).toBe(true);
    expect(completeText).toHaveBeenCalledTimes(2);
  });

  it("returns failure after exhausting all attempts", async () => {
    const brokenResult = tryParseJson('{"name":"Alice","age":-1}', testSchema);
    const completeText = vi.fn()
      .mockResolvedValue('{"name":"StillBroken","age":-3}');

    const result = await repairLoop(brokenResult, testSchema, {
      completeText,
      promptContext: { family: "claude" },
      validDurations: [4, 6, 8],
      label: "test",
    });

    expect(result.success).toBe(false);
    expect(completeText).toHaveBeenCalledTimes(2);
  });

  it("skips repair when SCRIPT_REPAIR_MAX_ATTEMPTS=0", async () => {
    vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "0");
    const brokenResult = tryParseJson('{"name":"Alice","age":-1}', testSchema);
    const completeText = vi.fn();

    const result = await repairLoop(brokenResult, testSchema, {
      completeText,
      promptContext: { family: "claude" },
      validDurations: [4, 6, 8],
      label: "test",
    });

    expect(result.success).toBe(false);
    expect(completeText).not.toHaveBeenCalled();
  });

  it("continues loop when repair attempt returns syntactically invalid JSON", async () => {
    const brokenResult = tryParseJson('{"name":"Alice","age":-1}', testSchema);
    const completeText = vi.fn()
      .mockResolvedValueOnce("{broken json")      // attempt 1: syntax error
      .mockResolvedValueOnce(validScript);         // attempt 2: valid

    const result = await repairLoop(brokenResult, testSchema, {
      completeText,
      promptContext: { family: "claude" },
      validDurations: [4, 6, 8],
      label: "test",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Fixed");
    expect(completeText).toHaveBeenCalledTimes(2);
  });

  it("returns failure when all repair attempts return invalid JSON syntax", async () => {
    const brokenResult = tryParseJson('{"name":"Alice","age":-1}', testSchema);
    const completeText = vi.fn().mockResolvedValue("{not json");

    const result = await repairLoop(brokenResult, testSchema, {
      completeText,
      promptContext: { family: "claude" },
      validDurations: [4, 6, 8],
      label: "test",
    });

    expect(result.success).toBe(false);
    expect(completeText).toHaveBeenCalledTimes(2);
  });

  it("does not call repair for already-successful results", async () => {
    const goodResult = tryParseJson(validScript, testSchema);
    expect(goodResult.success).toBe(true);

    const completeText = vi.fn();
    const result = await repairLoop(goodResult, testSchema, {
      completeText,
      promptContext: { family: "claude" },
      validDurations: [4, 6, 8],
      label: "test",
    });

    expect(result.success).toBe(true);
    expect(completeText).not.toHaveBeenCalled();
  });

  it("re-throws non-SyntaxError exceptions from repair attempts", async () => {
    const brokenResult = tryParseJson('{"name":"Alice","age":-1}', testSchema);
    const completeText = vi.fn().mockRejectedValueOnce(new TypeError("network failure"));

    await expect(
      repairLoop(brokenResult, testSchema, {
        completeText,
        promptContext: { family: "claude" },
        validDurations: [4, 6, 8],
        label: "test",
      }),
    ).rejects.toThrow(TypeError);
  });
});
