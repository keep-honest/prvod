import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

type AnthropicJsonSchema = Parameters<typeof jsonSchemaOutputFormat>[0];

// Cache schema conversions — schemas are module-level singletons that never change at runtime.
const jsonSchemaCache = new WeakMap<ZodTypeAny, Record<string, unknown>>();
const anthropicFormatCache = new WeakMap<ZodTypeAny, ReturnType<typeof jsonSchemaOutputFormat>>();

export function buildStructuredOutputJsonSchema(
  schema: ZodTypeAny,
): Record<string, unknown> {
  let cached = jsonSchemaCache.get(schema);
  if (!cached) {
    cached = zodToJsonSchema(schema) as Record<string, unknown>;
    jsonSchemaCache.set(schema, cached);
  }
  return cached;
}

function normalizeSchemaForAnthropic(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => normalizeSchemaForAnthropic(item));
  }
  if (!node || typeof node !== "object") {
    return node;
  }

  const normalized = Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, normalizeSchemaForAnthropic(value)]),
  ) as Record<string, unknown>;

  if (Array.isArray(normalized.type)) {
    normalized.anyOf = normalized.type.map((type) => ({ type }));
    delete normalized.type;
  }

  if (Array.isArray(normalized.items)) {
    const items = normalized.items as Record<string, unknown>[];
    const allSameShape = items.length > 0
      && items.every((item) => JSON.stringify(item) === JSON.stringify(items[0]));

    normalized.items = allSameShape
      ? items[0]
      : { anyOf: items };
  }

  return normalized;
}

export function buildAnthropicStructuredOutputFormat(
  schema: ZodTypeAny,
) {
  let cached = anthropicFormatCache.get(schema);
  if (!cached) {
    cached = jsonSchemaOutputFormat(
      normalizeSchemaForAnthropic(
        buildStructuredOutputJsonSchema(schema),
      ) as AnthropicJsonSchema,
    );
    anthropicFormatCache.set(schema, cached);
  }
  return cached;
}

/**
 * Normalizes a JSON Schema for OpenAI's strict structured output mode.
 *
 * OpenAI requirements (as of May 2025):
 * - All properties must be in `required`; `additionalProperties: false` on every object
 * - No `default`, `$schema`, `$id`, `$comment`, `examples` keywords
 * - No `oneOf` (convert to `anyOf`), no `allOf`, `not`, `if`/`then`/`else`
 * - No tuple validation (`items` as array / `prefixItems`) — collapse to single schema
 * - Root must be `type: "object"`
 */
const STRIPPED_KEYWORDS = new Set(["default", "$schema", "$id", "$comment", "examples"]);

function normalizeSchemaForOpenAI(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => normalizeSchemaForOpenAI(item));
  }
  if (!node || typeof node !== "object") {
    return node;
  }

  const obj = node as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    normalized[key] = normalizeSchemaForOpenAI(value);
  }

  // Force all properties into required + additionalProperties: false
  if (normalized.properties && typeof normalized.properties === "object") {
    normalized.required = Object.keys(normalized.properties as Record<string, unknown>);
    normalized.additionalProperties = false;
  }

  // Convert oneOf → anyOf (OpenAI doesn't support oneOf)
  if (normalized.oneOf && !normalized.anyOf) {
    normalized.anyOf = normalized.oneOf;
    delete normalized.oneOf;
  }

  // Collapse tuple items (array of schemas) to a single schema — OpenAI doesn't support tuple validation.
  if (Array.isArray(normalized.items)) {
    const tupleItems = normalized.items as Record<string, unknown>[];
    const allSame = tupleItems.length > 0
      && tupleItems.every((item) => JSON.stringify(item) === JSON.stringify(tupleItems[0]));
    normalized.items = allSame ? tupleItems[0] : { anyOf: tupleItems };
    normalized.minItems = tupleItems.length;
    normalized.maxItems = tupleItems.length;
  }

  return normalized;
}

const openAISchemaCache = new WeakMap<ZodTypeAny, Record<string, unknown>>();

/** Builds a JSON Schema normalized for OpenAI's strict structured output (all properties required, no defaults). */
export function buildOpenAIStructuredOutputJsonSchema(
  schema: ZodTypeAny,
): Record<string, unknown> {
  let cached = openAISchemaCache.get(schema);
  if (!cached) {
    cached = normalizeSchemaForOpenAI(
      buildStructuredOutputJsonSchema(schema),
    ) as Record<string, unknown>;
    openAISchemaCache.set(schema, cached);
  }
  return cached;
}

export function buildTextModeSchemaHint(jsonSchema: Record<string, unknown>): string {
  return `\n\nReturn ONLY valid JSON matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`;
}

/**
 * Normalizes a JSON Schema for Google GenAI's `responseJsonSchema` field.
 *
 * `responseJsonSchema` accepts JSON Schema 2020-12 (per the SDK's "Since
 * v1.9.0, we switch to use backend JSON schema support" note), so we keep
 * standard JSON Schema syntax — `type: ["X", "null"]` for nullable fields.
 * The OpenAPI 3.0 keyword `nullable: true` belongs on the legacy `Schema`
 * type used by `responseSchema`; emitting it on `responseJsonSchema` can be
 * rejected by the backend.
 *
 * Other adjustments:
 * - Drops `$schema`, `$id`, `$comment`, `examples`, `default`, `additionalProperties`
 *   (the SDK rejects unknown keywords).
 * - Drops value-constraint keywords (`minItems`, `maxItems`, `minimum`,
 *   `maximum`, `minLength`, `maxLength`, `pattern`, `format`, `multipleOf`,
 *   `exclusiveMinimum`, `exclusiveMaximum`, `uniqueItems`). Gemini accepts
 *   them but its constrained-decoding state machine refuses with
 *   "constraint has too many states for serving" once they nest. The
 *   constraints are still enforced client-side by the Zod parse that runs
 *   on the response, so stripping them server-side is safe.
 * - Converts `oneOf` → `anyOf` (Gemini doesn't accept `oneOf`).
 * - Respects the Zod-derived `required` array — does NOT force every property
 *   into required (unlike the OpenAI strict normalizer), so optional Zod
 *   fields stay optional in the schema.
 * - Collapses tuple-style `items: [...]` to a single union schema.
 */
const GENAI_STRIPPED_KEYWORDS = new Set([
  // Metadata Gemini doesn't accept.
  "$schema",
  "$id",
  "$comment",
  "examples",
  "default",
  "additionalProperties",
  // Value constraints — explode the constraint-decoder state machine.
  // Zod enforces these client-side after parse.
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
]);

function normalizeSchemaForGenAi(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => normalizeSchemaForGenAi(item));
  }
  if (!node || typeof node !== "object") {
    return node;
  }

  const obj = node as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (GENAI_STRIPPED_KEYWORDS.has(key)) continue;
    normalized[key] = normalizeSchemaForGenAi(value);
  }

  // Multi-type unions — collapse into anyOf. JSON Schema 2020-12 (which
  // `responseJsonSchema` accepts) supports `type: ["X", "null"]` natively, so
  // a 2-element type array (one nullable plus one concrete) is left as-is.
  // We only touch the >2 case where some validators reject type-as-array.
  // We do NOT emit OpenAPI `nullable: true` — that keyword only belongs on
  // the legacy `responseSchema` field (Schema type). On `responseJsonSchema`
  // it can be rejected by the backend before generation.
  if (Array.isArray(normalized.type) && (normalized.type as string[]).length > 2) {
    const types = normalized.type as string[];
    normalized.anyOf = types.map((t) => ({ type: t }));
    delete normalized.type;
  }

  if (normalized.oneOf && !normalized.anyOf) {
    normalized.anyOf = normalized.oneOf;
    delete normalized.oneOf;
  }

  if (Array.isArray(normalized.items)) {
    const tuple = normalized.items as Record<string, unknown>[];
    const allSame = tuple.length > 0
      && tuple.every((item) => JSON.stringify(item) === JSON.stringify(tuple[0]));
    normalized.items = allSame ? tuple[0] : { anyOf: tuple };
  }

  return normalized;
}

const genAiSchemaCache = new WeakMap<ZodTypeAny, Record<string, unknown>>();

/** Builds a JSON Schema normalized for Google GenAI's responseJsonSchema. */
export function buildGenAiStructuredOutputJsonSchema(
  schema: ZodTypeAny,
): Record<string, unknown> {
  let cached = genAiSchemaCache.get(schema);
  if (!cached) {
    cached = normalizeSchemaForGenAi(
      buildStructuredOutputJsonSchema(schema),
    ) as Record<string, unknown>;
    genAiSchemaCache.set(schema, cached);
  }
  return cached;
}
