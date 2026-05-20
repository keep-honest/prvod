/**
 * Barrel export for the false-positive test corpus.
 *
 * Each category file exports an array of LegitimateFixture objects
 * representing real-world PRs that contain patterns superficially
 * resembling prompt injection but are completely benign.
 *
 * Total fixtures: 25 (across 7 categories)
 *
 * Categories:
 *   ai-llm-code             4 fixtures
 *   documentation            3 fixtures
 *   base64-encoding          3 fixtures
 *   instruction-like-patterns 4 fixtures
 *   security-related         4 fixtures
 *   infrastructure           4 fixtures
 *   test-fixture-prs         3 fixtures
 */

export type { LegitimateFixture } from "./types";

export { aiLlmCodeFixtures } from "./ai-llm-code";
export { documentationFixtures } from "./documentation";
export { base64EncodingFixtures } from "./base64-encoding";
export { instructionLikeFixtures } from "./instruction-like-patterns";
export { securityRelatedFixtures } from "./security-related";
export { infrastructureFixtures } from "./infrastructure";
export { testFixtureFixtures } from "./test-fixture-prs";

import { aiLlmCodeFixtures } from "./ai-llm-code";
import { documentationFixtures } from "./documentation";
import { base64EncodingFixtures } from "./base64-encoding";
import { instructionLikeFixtures } from "./instruction-like-patterns";
import { securityRelatedFixtures } from "./security-related";
import { infrastructureFixtures } from "./infrastructure";
import { testFixtureFixtures } from "./test-fixture-prs";
import type { LegitimateFixture } from "./types";

/** All fixture categories for iteration in tests. */
export const CATEGORIES = [
  "ai-llm-code",
  "documentation",
  "base64-encoding",
  "instruction-like-patterns",
  "security-related",
  "infrastructure",
  "test-fixture-prs",
] as const;

export type FixtureCategory = (typeof CATEGORIES)[number];

/** Complete corpus: every legitimate PR fixture across all categories. */
export const ALL_LEGITIMATE_FIXTURES: LegitimateFixture[] = [
  ...aiLlmCodeFixtures,
  ...documentationFixtures,
  ...base64EncodingFixtures,
  ...instructionLikeFixtures,
  ...securityRelatedFixtures,
  ...infrastructureFixtures,
  ...testFixtureFixtures,
];
