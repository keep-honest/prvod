import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { z, ZodError } from "zod";
import {
  tryParseJson,
  formatZodErrors,
  repairLoop,
  completeJsonWithRepair,
  StructuredOutputValidationError,
} from "@/infrastructure/llm/promptPipelineV2Repair";
import type { PromptPipelineV2Model } from "@/infrastructure/llm/promptPipelineV2Runner";

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

describe("StructuredOutputValidationError", () => {
  it("carries rawJson, zodError, schemaName fields", () => {
    const zodError = testSchema.safeParse({}).success === false
      ? (testSchema.safeParse({}) as { success: false; error: ZodError }).error
      : new ZodError([]);
    const err = new StructuredOutputValidationError(
      "test message",
      '{"raw":"data"}',
      zodError,
      "test_schema",
    );
    expect(err.message).toBe("test message");
    expect(err.rawJson).toBe('{"raw":"data"}');
    expect(err.zodError).toBe(zodError);
    expect(err.schemaName).toBe("test_schema");
    expect(err.name).toBe("StructuredOutputValidationError");
    expect(err).toBeInstanceOf(Error);
  });

  it("message contains 'structured output' so isLlmValidationError matches", () => {
    const err = new StructuredOutputValidationError(
      'CLI structured output for "coverage_plan" failed: ...',
      "{}",
      new ZodError([]),
      "coverage_plan",
    );
    expect(err.message).toContain("structured output");
  });

  it("forwards { cause } via super(message, options) so err.cause is set", () => {
    const root = new Error("root cause");
    const err = new StructuredOutputValidationError(
      "wrapped",
      "{}",
      new ZodError([]),
      "test_cause",
      { cause: root },
    );
    expect(err.cause).toBe(root);
  });

  it("leaves cause undefined when not provided (no implicit chaining)", () => {
    const err = new StructuredOutputValidationError(
      "wrapped",
      "{}",
      new ZodError([]),
      "test_no_cause",
    );
    expect(err.cause).toBeUndefined();
  });
});

describe("completeJsonWithRepair", () => {
  const validData = { name: "Alice", age: 30 };
  const validJsonText = '{"name":"Fixed","age":25}';

  beforeEach(() => {
    vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "2");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function buildModel(overrides: Partial<PromptPipelineV2Model> = {}): PromptPipelineV2Model {
    return {
      family: "claude",
      supportsNativeStructuredOutput: true,
      completeJson: vi.fn(),
      completeText: vi.fn(),
      ...overrides,
    } as PromptPipelineV2Model;
  }

  it("happy path: returns completeJson result when schema-valid (no repair fired)", async () => {
    const completeJson = vi.fn().mockResolvedValueOnce(validData);
    const completeText = vi.fn();
    const model = buildModel({ completeJson, completeText });

    const result = await completeJsonWithRepair({
      model,
      system: "sys",
      userPrompt: "user",
      schema: testSchema,
      options: { schemaName: "test_happy" },
      repair: { completeText, promptContext: { family: "claude" }, validDurations: [4, 6, 8], label: "test_happy" },
    });

    expect(result).toEqual(validData);
    expect(completeText).not.toHaveBeenCalled();
  });

  it("repairs when completeJson throws StructuredOutputValidationError", async () => {
    const zodError = (testSchema.safeParse({ name: "X", age: -1 }) as { success: false; error: ZodError }).error;
    const completeJson = vi.fn().mockRejectedValueOnce(
      new StructuredOutputValidationError("structured output failed", '{"name":"X","age":-1}', zodError, "test_repair"),
    );
    const completeText = vi.fn().mockResolvedValueOnce(validJsonText);
    const model = buildModel({ completeJson, completeText });

    const result = await completeJsonWithRepair({
      model,
      system: "sys",
      userPrompt: "user",
      schema: testSchema,
      options: { schemaName: "test_repair" },
      repair: { completeText, promptContext: { family: "claude" }, validDurations: [4, 6, 8], label: "test_repair" },
    });

    expect(result).toEqual({ name: "Fixed", age: 25 });
    expect(completeText).toHaveBeenCalledTimes(1);
  });

  it("rethrows StructuredOutputValidationError carrying final-attempt rawJson + zodError + cause chain when repair exhausts", async () => {
    const originalZodError = (testSchema.safeParse({ name: "X", age: -1 }) as { success: false; error: ZodError }).error;
    const originalError = new StructuredOutputValidationError(
      "structured output failed",
      '{"name":"X","age":-1}',
      originalZodError,
      "test_exhaust",
    );
    const completeJson = vi.fn().mockRejectedValueOnce(originalError);
    const finalAttemptPayload = '{"name":"StillBroken","age":-2}';
    const completeText = vi.fn().mockResolvedValue(finalAttemptPayload);
    const model = buildModel({ completeJson, completeText });

    let thrown: unknown;
    try {
      await completeJsonWithRepair({
        model,
        system: "sys",
        userPrompt: "user",
        schema: testSchema,
        options: { schemaName: "test_exhaust" },
        repair: { completeText, promptContext: { family: "claude" }, validDurations: [4, 6, 8], label: "test_exhaust" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StructuredOutputValidationError);
    const typed = thrown as InstanceType<typeof StructuredOutputValidationError>;
    expect(typed.schemaName).toBe("test_exhaust");
    // rawJson + zodError MUST reflect the FINAL repair attempt, not the original.
    expect(typed.rawJson).toBe(finalAttemptPayload);
    expect(typed.zodError).not.toBe(originalZodError);
    expect(typed.zodError.issues.some((i) => i.path.includes("age"))).toBe(true);
    expect(typed.message).toContain("repair attempt(s)");
    // cause must preserve the chain to the original error for log consumers
    // walking err.cause (Sentry, structured loggers).
    expect(typed.cause).toBe(originalError);
    expect(completeText).toHaveBeenCalledTimes(2);
  });

  it("surfaces lastSyntaxError on the rethrown error when final repair attempt returns unparseable JSON", async () => {
    const originalZodError = (testSchema.safeParse({ name: "X", age: -1 }) as { success: false; error: ZodError }).error;
    const originalError = new StructuredOutputValidationError(
      "structured output failed",
      '{"name":"X","age":-1}',
      originalZodError,
      "test_syntax_exhaust",
    );
    const completeJson = vi.fn().mockRejectedValueOnce(originalError);
    // Final attempt returns garbage. lastSyntaxError captures this so the
    // rethrown error message tells operators the model gave up by emitting
    // non-JSON, not just by emitting wrong-shape JSON.
    const completeText = vi.fn()
      .mockResolvedValueOnce('{"name":"AlsoBroken","age":-3}') // first repair: schema-invalid
      .mockResolvedValueOnce("{NOT VALID JSON");                  // final repair: SyntaxError
    const model = buildModel({ completeJson, completeText });

    let thrown: unknown;
    try {
      await completeJsonWithRepair({
        model,
        system: "sys",
        userPrompt: "user",
        schema: testSchema,
        options: { schemaName: "test_syntax_exhaust" },
        repair: { completeText, promptContext: { family: "claude" }, validDurations: [4, 6, 8], label: "test_syntax_exhaust" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StructuredOutputValidationError);
    const typed = thrown as InstanceType<typeof StructuredOutputValidationError>;
    expect(typed.message).toContain("final attempt returned unparseable JSON");
  });

  it("rethrows original StructuredOutputValidationError when completeText is absent", async () => {
    const zodError = (testSchema.safeParse({ name: "X", age: -1 }) as { success: false; error: ZodError }).error;
    const original = new StructuredOutputValidationError("structured output failed", '{"name":"X","age":-1}', zodError, "test_no_text");
    const completeJson = vi.fn().mockRejectedValueOnce(original);
    const model = buildModel({ completeJson, completeText: undefined });

    await expect(
      completeJsonWithRepair({
        model,
        system: "sys",
        userPrompt: "user",
        schema: testSchema,
        options: { schemaName: "test_no_text" },
        // repair argument intentionally omits completeText
        repair: { promptContext: { family: "claude" }, validDurations: [4, 6, 8], label: "test_no_text" },
      }),
    ).rejects.toBe(original);
  });

  it("rethrows original StructuredOutputValidationError unchanged when SCRIPT_REPAIR_MAX_ATTEMPTS=0", async () => {
    // Honour the docstring contract: when repair is configured at the call site
    // but the env knob is 0, the wrapper rethrows the ORIGINAL typed error
    // (preserving identity), it does NOT re-wrap with "after 0 repair attempt(s)".
    vi.stubEnv("SCRIPT_REPAIR_MAX_ATTEMPTS", "0");
    const zodError = (testSchema.safeParse({ name: "X", age: -1 }) as { success: false; error: ZodError }).error;
    const original = new StructuredOutputValidationError("structured output failed", '{"name":"X","age":-1}', zodError, "test_zero_attempts");
    const completeJson = vi.fn().mockRejectedValueOnce(original);
    const completeText = vi.fn();
    const model = buildModel({ completeJson, completeText });

    await expect(
      completeJsonWithRepair({
        model,
        system: "sys",
        userPrompt: "user",
        schema: testSchema,
        options: { schemaName: "test_zero_attempts" },
        repair: { completeText, promptContext: { family: "claude" }, validDurations: [4, 6, 8], label: "test_zero_attempts" },
      }),
    ).rejects.toBe(original);
    expect(completeText).not.toHaveBeenCalled();
  });

  it("rethrows original error when repair argument is omitted entirely", async () => {
    const zodError = (testSchema.safeParse({ name: "X", age: -1 }) as { success: false; error: ZodError }).error;
    const original = new StructuredOutputValidationError("structured output failed", '{"name":"X","age":-1}', zodError, "test_no_repair");
    const completeJson = vi.fn().mockRejectedValueOnce(original);
    const model = buildModel({ completeJson });

    await expect(
      completeJsonWithRepair({
        model,
        system: "sys",
        userPrompt: "user",
        schema: testSchema,
        options: { schemaName: "test_no_repair" },
        // no repair argument at all
      }),
    ).rejects.toBe(original);
  });

  it("defensive re-validate: routes a misbehaving impl's unvalidated payload through repair", async () => {
    // Mock returns schema-invalid data WITHOUT throwing — simulates a misbehaving
    // impl or a naive test mock. The wrapper's defensive safeParse catches it
    // and routes through repair just like a thrown StructuredOutputValidationError.
    const completeJson = vi.fn().mockResolvedValueOnce({ name: "X", age: -1 });
    const completeText = vi.fn().mockResolvedValueOnce(validJsonText);
    const model = buildModel({ completeJson, completeText });

    const result = await completeJsonWithRepair({
      model,
      system: "sys",
      userPrompt: "user",
      schema: testSchema,
      options: { schemaName: "test_misbehaving" },
      repair: { completeText, promptContext: { family: "claude" }, validDurations: [4, 6, 8], label: "test_misbehaving" },
    });

    expect(result).toEqual({ name: "Fixed", age: 25 });
    expect(completeText).toHaveBeenCalledTimes(1);
  });

  it("defensive re-validate: tolerates a circular-reference payload and surfaces String(value) fallback to the repair LLM", async () => {
    // JSON.stringify throws TypeError on circular refs — safeStringifyForRepair
    // falls back to String(value). The repair LLM sees the degraded payload
    // (e.g. "[object Object]") and the test asserts the fallback path executed.
    const circular: Record<string, unknown> = { name: "X", age: -1 };
    circular.self = circular;
    const completeJson = vi.fn().mockResolvedValueOnce(circular);
    const completeText = vi.fn().mockResolvedValueOnce(validJsonText);
    const model = buildModel({ completeJson, completeText });

    const result = await completeJsonWithRepair({
      model,
      system: "sys",
      userPrompt: "user",
      schema: testSchema,
      options: { schemaName: "test_circular" },
      repair: { completeText, promptContext: { family: "claude" }, validDurations: [4, 6, 8], label: "test_circular" },
    });

    expect(result).toEqual({ name: "Fixed", age: 25 });
    // Verify the fallback path executed: the repair LLM's user prompt should
    // contain the String(value) output ("[object Object]") — not parsed fields.
    const [, repairUserPrompt] = completeText.mock.calls[0];
    expect(repairUserPrompt).toContain("[object Object]");
  });

  it("defensive re-validate: non-circular payload reaches the repair LLM as indented JSON", async () => {
    // The repair prompt format relies on indentation. Verify the happy path
    // (no circular ref) produces indented JSON.stringify output, not compact.
    const completeJson = vi.fn().mockResolvedValueOnce({ name: "X", age: -1 });
    const completeText = vi.fn().mockResolvedValueOnce(validJsonText);
    const model = buildModel({ completeJson, completeText });

    await completeJsonWithRepair({
      model,
      system: "sys",
      userPrompt: "user",
      schema: testSchema,
      options: { schemaName: "test_indented" },
      repair: { completeText, promptContext: { family: "claude" }, validDurations: [4, 6, 8], label: "test_indented" },
    });

    const [, repairUserPrompt] = completeText.mock.calls[0];
    expect(repairUserPrompt).toContain('"name": "X"'); // indented form (space after colon)
    expect(repairUserPrompt).toContain('"age": -1');
  });

  it("propagates non-validation errors untouched (e.g. network failures)", async () => {
    const networkErr = new Error("ECONNRESET");
    const completeJson = vi.fn().mockRejectedValueOnce(networkErr);
    const completeText = vi.fn();
    const model = buildModel({ completeJson, completeText });

    await expect(
      completeJsonWithRepair({
        model,
        system: "sys",
        userPrompt: "user",
        schema: testSchema,
        options: { schemaName: "test_network" },
        repair: { completeText, promptContext: { family: "claude" }, validDurations: [4, 6, 8], label: "test_network" },
      }),
    ).rejects.toBe(networkErr);
    expect(completeText).not.toHaveBeenCalled();
  });

  it("threads systemPrompt and shapeHint through to repairLoop's repair turn", async () => {
    // Verify the override system prompt is what the LLM sees for the repair attempt
    // (not the default VideoScript repair system prompt). The shapeHint reaches
    // the repair user prompt.
    const zodError = (testSchema.safeParse({ name: "X", age: -1 }) as { success: false; error: ZodError }).error;
    const completeJson = vi.fn().mockRejectedValueOnce(
      new StructuredOutputValidationError("structured output failed", '{"name":"X","age":-1}', zodError, "test_overrides"),
    );
    const completeText = vi.fn().mockResolvedValueOnce(validJsonText);
    const model = buildModel({ completeJson, completeText });

    await completeJsonWithRepair({
      model,
      system: "sys",
      userPrompt: "user",
      schema: testSchema,
      options: { schemaName: "test_overrides" },
      repair: {
        completeText,
        promptContext: { family: "claude" },
        validDurations: [4, 6, 8],
        label: "test_overrides",
        systemPrompt: "REPAIR_SYSTEM_PROMPT_MARKER",
        shapeHint: "REPAIR_SHAPE_HINT_MARKER",
      },
    });

    expect(completeText).toHaveBeenCalledTimes(1);
    const [systemArg, userArg] = completeText.mock.calls[0];
    expect(systemArg).toBe("REPAIR_SYSTEM_PROMPT_MARKER");
    expect(userArg).toContain("REPAIR_SHAPE_HINT_MARKER");
  });
});
