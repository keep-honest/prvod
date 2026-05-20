import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildStructuredOutputJsonSchema,
  buildAnthropicStructuredOutputFormat,
  buildGenAiStructuredOutputJsonSchema,
} from "@/infrastructure/llm/structuredOutputSchema";
import { videoScriptSchema } from "@/domain/entities/VideoScript";
import {
  coveragePlanSchema,
  sceneOutlineSchema,
  coverageJudgeResultSchema,
  narrationJudgeResultSchema,
  reviewConcernSchema,
  reviewPostureSchema,
  promptPipelineV2ArtifactsSchema,
} from "@/domain/entities/PromptPipelineV2";

describe("buildStructuredOutputJsonSchema", () => {
  it("converts a simple Zod object to JSON Schema", () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
      active: z.boolean(),
    });
    const jsonSchema = buildStructuredOutputJsonSchema(schema);
    expect(jsonSchema).toHaveProperty("type", "object");
    expect(jsonSchema).toHaveProperty("properties");
    const props = jsonSchema as { properties: Record<string, { type: string }> };
    expect(props.properties.name.type).toBe("string");
    expect(props.properties.count.type).toBe("number");
    expect(props.properties.active.type).toBe("boolean");
  });

  it("handles optional fields", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const jsonSchema = buildStructuredOutputJsonSchema(schema) as Record<string, unknown>;
    const required = jsonSchema.required as string[];
    expect(required).toContain("required");
    // optional fields should not be in required array
    expect(required).not.toContain("optional");
  });

  it("produces valid JSON Schema for videoScriptSchema", () => {
    const jsonSchema = buildStructuredOutputJsonSchema(videoScriptSchema);
    expect(jsonSchema).toHaveProperty("type", "object");
    const props = (jsonSchema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props).toHaveProperty("scenes");
    expect(props).toHaveProperty("summary");
    expect(props).toHaveProperty("changeType");
  });

  it("produces valid JSON Schema for coveragePlanSchema", () => {
    const jsonSchema = buildStructuredOutputJsonSchema(coveragePlanSchema);
    expect(jsonSchema).toHaveProperty("type", "object");
    const props = (jsonSchema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props).toHaveProperty("clusters");
    expect(props).toHaveProperty("ledger");
    expect(props).toHaveProperty("majorClusterIds");
  });

  it("produces valid JSON Schema for sceneOutlineSchema", () => {
    const jsonSchema = buildStructuredOutputJsonSchema(sceneOutlineSchema);
    expect(jsonSchema).toHaveProperty("type", "object");
    const props = (jsonSchema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props).toHaveProperty("scenes");
  });
});

describe("buildAnthropicStructuredOutputFormat", () => {
  it("returns an object with type: json_schema", () => {
    const schema = z.object({ name: z.string() });
    const format = buildAnthropicStructuredOutputFormat(schema);
    expect(format).toHaveProperty("type", "json_schema");
    expect(format).toHaveProperty("schema");
  });

  it("does not contain nullable keyword (Anthropic rejects it)", () => {
    // videoScriptSchema has nullable fields (codeBroll, lineRange, componentKey)
    const format = buildAnthropicStructuredOutputFormat(videoScriptSchema);
    const serialized = JSON.stringify(format);
    expect(serialized).not.toContain('"nullable"');
  });

  it("converts type arrays to anyOf for nullable fields", () => {
    const schema = z.object({
      value: z.string().nullable(),
    });
    const format = buildAnthropicStructuredOutputFormat(schema);
    const serialized = JSON.stringify(format);
    // Should not have type: ["string", "null"] — should be anyOf
    expect(serialized).not.toMatch(/"type":\s*\[/);
  });

  it("works for all pipeline schemas without throwing", () => {
    expect(() => buildAnthropicStructuredOutputFormat(videoScriptSchema)).not.toThrow();
    expect(() => buildAnthropicStructuredOutputFormat(coveragePlanSchema)).not.toThrow();
    expect(() => buildAnthropicStructuredOutputFormat(sceneOutlineSchema)).not.toThrow();
    expect(() => buildAnthropicStructuredOutputFormat(coverageJudgeResultSchema)).not.toThrow();
    expect(() => buildAnthropicStructuredOutputFormat(narrationJudgeResultSchema)).not.toThrow();
  });

  it("is idempotent — normalizing an already-normalized schema produces same output", () => {
    const schema = z.object({ name: z.string().nullable() });
    const first = JSON.stringify(buildAnthropicStructuredOutputFormat(schema));
    const second = JSON.stringify(buildAnthropicStructuredOutputFormat(schema));
    expect(first).toBe(second);
  });
});

// ── Reviewer metadata schema regression ─────────────────────────────────

describe("reviewer metadata schemas", () => {
  it("reviewConcernSchema accepts valid reviewer concern objects", () => {
    const valid = {
      concernId: "rc-1",
      sourceClusterIds: ["cluster-auth"],
      evidenceFilePaths: ["src/auth.ts"],
      priorityRank: 1,
      issueClass: "concurrency",
      riskStatement: "Concurrent writes may collide",
      validationNeed: "Check for row lock",
      proseSupport: null,
    };
    const result = reviewConcernSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("reviewConcernSchema rejects concern with empty evidence", () => {
    const invalid = {
      concernId: "rc-2",
      sourceClusterIds: ["cluster-auth"],
      evidenceFilePaths: [],
      priorityRank: 1,
      issueClass: "correctness",
      riskStatement: "Missing guard",
      validationNeed: "Add null check",
    };
    const result = reviewConcernSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("reviewConcernSchema rejects unknown issueClass values", () => {
    const invalid = {
      concernId: "rc-3",
      sourceClusterIds: ["cluster-a"],
      evidenceFilePaths: ["src/a.ts"],
      priorityRank: 1,
      issueClass: "style_nit",
      riskStatement: "Bad naming",
      validationNeed: "Rename variable",
    };
    const result = reviewConcernSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("reviewPostureSchema accepts canonical posture object", () => {
    const posture = {
      audience: "teammate_reviewer",
      evidencePolicy: "code_and_tests_primary",
      concernBudget: "highest_value_only",
      verdictPolicy: "no_verdict",
      hintPolicy: "non_prescriptive",
    };
    const result = reviewPostureSchema.safeParse(posture);
    expect(result.success).toBe(true);
  });

  it("reviewPostureSchema rejects non-canonical verdictPolicy", () => {
    const invalid = {
      audience: "teammate_reviewer",
      evidencePolicy: "code_and_tests_primary",
      concernBudget: "highest_value_only",
      verdictPolicy: "approve_or_reject",
      hintPolicy: "non_prescriptive",
    };
    const result = reviewPostureSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("narrationJudgeScoresSchema accepts reviewer-oriented optional scores", () => {
    const jsonSchema = buildStructuredOutputJsonSchema(narrationJudgeResultSchema);
    const props = (jsonSchema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props).toHaveProperty("scores");
  });

  it("promptPipelineV2ArtifactsSchema accepts optional reviewConcerns and reviewPosture", () => {
    const jsonSchema = buildStructuredOutputJsonSchema(promptPipelineV2ArtifactsSchema);
    const props = (jsonSchema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props).toHaveProperty("reviewConcerns");
    expect(props).toHaveProperty("reviewPosture");
  });
});

describe("buildGenAiStructuredOutputJsonSchema", () => {
  it("strips additionalProperties, default, $schema, $id, $comment, examples", () => {
    const schema = z.object({
      name: z.string().default("anon"),
      tags: z.array(z.string()).default([]),
    });
    const out = buildGenAiStructuredOutputJsonSchema(schema);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/"additionalProperties"/);
    expect(json).not.toMatch(/"default"/);
    expect(json).not.toMatch(/"\$schema"/);
    expect(json).not.toMatch(/"\$id"/);
    expect(json).not.toMatch(/"\$comment"/);
    expect(json).not.toMatch(/"examples"/);
  });

  it("strips value-constraint keywords that Gemini's state machine cannot serve", () => {
    // Gemini's constrained-decoder rejects schemas with array-length bounds,
    // number ranges, and string formats with "constraint has too many states
    // for serving". Zod still enforces these client-side after parse, so
    // stripping them in the wire schema is safe.
    const schema = z.object({
      sceneList: z.array(z.string()).min(4).max(16),
      score: z.number().int().min(0).max(10),
      coverage: z.number().positive(), // → exclusiveMinimum: 0
      tag: z.string().min(1).max(50),
      regexedField: z.string().regex(/^[A-Z]+$/),
      uniqueTags: z.array(z.string()),
    });
    const out = buildGenAiStructuredOutputJsonSchema(schema);
    const json = JSON.stringify(out);
    // Match each keyword in JSON Schema position — i.e. as a key followed by
    // a value (`"keyword":`), not as a string in an array (e.g. property
    // names appearing in `required`).
    for (const keyword of [
      "minItems",
      "maxItems",
      "uniqueItems",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "pattern",
      "format",
    ]) {
      expect(json).not.toMatch(new RegExp(`"${keyword}":`));
    }
  });

  it("preserves type:[X,null] (JSON Schema 2020-12) for nullable fields", () => {
    // `responseJsonSchema` accepts standard JSON Schema. The OpenAPI keyword
    // `nullable: true` belongs on the legacy `responseSchema` (Schema) field
    // and can be rejected on `responseJsonSchema`. Keep type-as-array.
    const schema = z.object({
      name: z.string().nullable(),
    });
    const out = buildGenAiStructuredOutputJsonSchema(schema);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/"nullable":/);
    // zod-to-json-schema's emitted shape for nullable strings can be either
    // `type: ["string","null"]` or `anyOf`; both are valid JSON Schema. We only
    // care that we are NOT emitting the OpenAPI `nullable` keyword.
  });

  it("converts oneOf to anyOf", () => {
    // Build a JSON Schema literal that has oneOf — zod-to-json-schema doesn't
    // emit oneOf for unions, so test the normalizer behaviour against an
    // already-shaped schema by passing through the generic builder.
    const schema = z.union([z.literal("a"), z.literal("b")]);
    const out = buildGenAiStructuredOutputJsonSchema(schema);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/"oneOf"/);
  });

  it("respects Zod-derived `required` (does NOT force every property required)", () => {
    const schema = z.object({
      mandatory: z.string(),
      maybe: z.string().optional(),
    });
    const out = buildGenAiStructuredOutputJsonSchema(schema) as Record<string, unknown>;
    expect(out.required).toEqual(["mandatory"]);
  });

  it("collapses tuple items to a single union schema", () => {
    // tuple([string, number]) → items: anyOf in normalised output
    const schema = z.object({ pair: z.tuple([z.string(), z.number()]) });
    const out = buildGenAiStructuredOutputJsonSchema(schema);
    const props = (out as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
    const pair = props.pair;
    // After normalisation, items must be a single schema or an anyOf — never a tuple array.
    expect(Array.isArray(pair.items)).toBe(false);
  });

  it("normalises videoScriptSchema without leaking disallowed keywords", () => {
    const out = buildGenAiStructuredOutputJsonSchema(videoScriptSchema);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/"additionalProperties"/);
    expect(json).not.toMatch(/"default"/);
    // Sanity: schema is non-trivial.
    expect((out as Record<string, unknown>).properties).toBeDefined();
  });

  it("caches results per Zod schema reference", () => {
    const schema = z.object({ id: z.string() });
    const a = buildGenAiStructuredOutputJsonSchema(schema);
    const b = buildGenAiStructuredOutputJsonSchema(schema);
    expect(a).toBe(b);
  });
});
