/**
 * Integration tests: false-positive prevention for InputSanitizer.
 *
 * For every fixture in the legitimate-PR corpus we run the sanitizer over
 * all text fields and assert that:
 *
 *   - Fixtures WITHOUT `expectedTriggerPatterns`: every field returns
 *     `injectionDetected: false` (zero false positives).
 *
 *   - Fixtures WITH `expectedTriggerPatterns`: only patterns listed in that
 *     array are allowed to fire; any additional detection is a false positive.
 *     For diff fields we additionally verify that key code identifiers are
 *     preserved in the sanitized output (semantic meaning is not destroyed).
 *
 * A final summary test reports the corpus-wide false-positive rate so it
 * remains visible in CI output.
 */

import { describe, it, expect } from "vitest";
import { InputSanitizer } from "@/domain/services/InputSanitizer";
import {
  ALL_LEGITIMATE_FIXTURES,
  type LegitimateFixture,
} from "../fixtures/legitimate-prs/index";
import type { DetectionDetail } from "@/interfaces/IPromptInjectionGuard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sanitizer = new InputSanitizer();

/**
 * Tokens that must survive sanitisation in a diff to confirm semantic meaning
 * is preserved.  Covers both code identifiers and documentation structure:
 *   - Code: export|import|function|class|const|let|var, or any word(
 *   - Docs: Markdown headers (##), YAML keys (word:), diff markers (@@, +++)
 */
const DIFF_CONTENT_RE =
  /(?:export|import|function|class|const|let|var|\w+\(|##\s+\w|@@\s+-|\+{3}\s+\w|\w+:\s)/;

/**
 * Run the sanitizer over every text field of a fixture and return a flat list
 * of detections grouped by field name.
 */
function scanAllFields(fixture: LegitimateFixture): {
  field: DetectionDetail["field"];
  patternIds: string[];
  sanitizedContent: string;
  originalContent: string;
}[] {
  const results: {
    field: DetectionDetail["field"];
    patternIds: string[];
    sanitizedContent: string;
    originalContent: string;
  }[] = [];

  // prTitle
  const titleResult = sanitizer.sanitize(fixture.prTitle, "prTitle");
  results.push({
    field: "prTitle",
    patternIds: titleResult.detections.map((d) => d.patternId),
    sanitizedContent: titleResult.content,
    originalContent: fixture.prTitle,
  });

  // prDescription
  const descResult = sanitizer.sanitize(fixture.prDescription, "prDescription");
  results.push({
    field: "prDescription",
    patternIds: descResult.detections.map((d) => d.patternId),
    sanitizedContent: descResult.content,
    originalContent: fixture.prDescription,
  });

  // diff — use "code" content context as required by the task spec
  const diffResult = sanitizer.sanitize(fixture.diff, "diff", {
    contentContext: "code",
  });
  results.push({
    field: "diff",
    patternIds: diffResult.detections.map((d) => d.patternId),
    sanitizedContent: diffResult.content,
    originalContent: fixture.diff,
  });

  // issues — each issue string is treated as both a title and a body
  for (const issue of fixture.issues) {
    const issueTitleResult = sanitizer.sanitize(issue, "issueTitle");
    results.push({
      field: "issueTitle",
      patternIds: issueTitleResult.detections.map((d) => d.patternId),
      sanitizedContent: issueTitleResult.content,
      originalContent: issue,
    });

    const issueBodyResult = sanitizer.sanitize(issue, "issueBody");
    results.push({
      field: "issueBody",
      patternIds: issueBodyResult.detections.map((d) => d.patternId),
      sanitizedContent: issueBodyResult.content,
      originalContent: issue,
    });
  }

  // milestone
  if (fixture.milestone) {
    const milestoneTitleResult = sanitizer.sanitize(
      fixture.milestone,
      "milestoneTitle",
    );
    results.push({
      field: "milestoneTitle",
      patternIds: milestoneTitleResult.detections.map((d) => d.patternId),
      sanitizedContent: milestoneTitleResult.content,
      originalContent: fixture.milestone,
    });

    const milestoneDescResult = sanitizer.sanitize(
      fixture.milestone,
      "milestoneDescription",
    );
    results.push({
      field: "milestoneDescription",
      patternIds: milestoneDescResult.detections.map((d) => d.patternId),
      sanitizedContent: milestoneDescResult.content,
      originalContent: fixture.milestone,
    });
  }

  return results;
}

/** Returns detections that are NOT in the fixture's allow-list. */
function unexpectedDetections(
  fieldResults: ReturnType<typeof scanAllFields>,
  allowedPatternIds: string[],
) {
  return fieldResults.flatMap(({ field, patternIds }) =>
    patternIds
      .filter((id) => !allowedPatternIds.includes(id))
      .map((id) => ({ field, patternId: id })),
  );
}

// ---------------------------------------------------------------------------
// Per-fixture tests — split by whether the fixture expects any triggers
// ---------------------------------------------------------------------------

const noTriggerFixtures = ALL_LEGITIMATE_FIXTURES.filter(
  (f) => !f.expectedTriggerPatterns || f.expectedTriggerPatterns.length === 0,
);

const knownTriggerFixtures = ALL_LEGITIMATE_FIXTURES.filter(
  (f) => f.expectedTriggerPatterns && f.expectedTriggerPatterns.length > 0,
);

// ---------------------------------------------------------------------------
// Group 1: fixtures that must produce zero detections in all fields
// ---------------------------------------------------------------------------

describe("false-positive prevention — zero-trigger fixtures", () => {
  it.each(noTriggerFixtures.map((f) => [f.name, f] as [string, LegitimateFixture]))(
    "%s: all fields pass with injectionDetected=false",
    (_name, fixture) => {
      const fieldResults = scanAllFields(fixture);

      for (const { field, patternIds, originalContent } of fieldResults) {
        expect(patternIds, [
          `Fixture "${fixture.name}" (${fixture.category})`,
          `Field "${field}" triggered unexpected pattern(s): [${patternIds.join(", ")}]`,
          `Content preview: ${originalContent.slice(0, 120)}`,
        ].join("\n")).toHaveLength(0);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Group 2: fixtures that may trigger — only the allow-listed patterns allowed
// ---------------------------------------------------------------------------

describe("false-positive prevention — known-trigger fixtures", () => {
  it.each(
    knownTriggerFixtures.map((f) => [f.name, f] as [string, LegitimateFixture]),
  )(
    "%s: only allow-listed patterns fire; no unexpected detections",
    (_name, fixture) => {
      const allowed = fixture.expectedTriggerPatterns ?? [];
      const fieldResults = scanAllFields(fixture);
      const unexpected = unexpectedDetections(fieldResults, allowed);

      expect(unexpected, [
        `Fixture "${fixture.name}" (${fixture.category})`,
        `Unexpected detections beyond allow-list [${allowed.join(", ")}]:`,
        unexpected.map((u) => `  field="${u.field}" patternId="${u.patternId}"`).join("\n"),
      ].join("\n")).toHaveLength(0);
    },
  );

  it.each(
    knownTriggerFixtures.map((f) => [f.name, f] as [string, LegitimateFixture]),
  )(
    "%s diff: sanitized output preserves semantic code identifiers",
    (_name, fixture) => {
      const diffResult = sanitizer.sanitize(fixture.diff, "diff", {
        contentContext: "code",
      });

      // The diff must still contain recognisable content tokens after sanitization.
      expect(
        DIFF_CONTENT_RE.test(diffResult.content),
        [
          `Fixture "${fixture.name}": sanitized diff lost all code identifiers.`,
          `Sanitized diff preview: ${diffResult.content.slice(0, 200)}`,
        ].join("\n"),
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Group 3: field-level isolation — strict fields must never tolerate encoding
// ---------------------------------------------------------------------------

describe("false-positive prevention — strict fields (prTitle, issueTitle, milestoneTitle)", () => {
  it.each(
    ALL_LEGITIMATE_FIXTURES.map((f) => [f.name, f] as [string, LegitimateFixture]),
  )(
    "%s: prTitle contains no injection detections",
    (_name, fixture) => {
      const result = sanitizer.sanitize(fixture.prTitle, "prTitle");
      expect(result.injectionDetected, [
        `Fixture "${fixture.name}" — prTitle fired: [${result.detections.map((d) => d.patternId).join(", ")}]`,
        `prTitle value: "${fixture.prTitle}"`,
      ].join("\n")).toBe(false);
    },
  );

  it.each(
    ALL_LEGITIMATE_FIXTURES.filter((f) => f.issues.length > 0).map(
      (f) => [f.name, f] as [string, LegitimateFixture],
    ),
  )(
    "%s: issue titles contain no injection detections",
    (_name, fixture) => {
      for (const issue of fixture.issues) {
        const result = sanitizer.sanitize(issue, "issueTitle");
        expect(result.injectionDetected, [
          `Fixture "${fixture.name}" — issueTitle fired: [${result.detections.map((d) => d.patternId).join(", ")}]`,
          `issueTitle value: "${issue}"`,
        ].join("\n")).toBe(false);
      }
    },
  );

  it.each(
    ALL_LEGITIMATE_FIXTURES.filter((f) => !!f.milestone).map(
      (f) => [f.name, f] as [string, LegitimateFixture],
    ),
  )(
    "%s: milestoneTitle contains no injection detections",
    (_name, fixture) => {
      const result = sanitizer.sanitize(fixture.milestone, "milestoneTitle");
      expect(result.injectionDetected, [
        `Fixture "${fixture.name}" — milestoneTitle fired: [${result.detections.map((d) => d.patternId).join(", ")}]`,
        `milestoneTitle value: "${fixture.milestone}"`,
      ].join("\n")).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Group 4: diff content-context exercises code-mode suppression
// ---------------------------------------------------------------------------

describe("false-positive prevention — diff content-context suppression", () => {
  it.each(
    ALL_LEGITIMATE_FIXTURES.map((f) => [f.name, f] as [string, LegitimateFixture]),
  )(
    '%s: diff with contentContext="code" never fires encoding_evasion (delimiter_escape always active)',
    (_name, fixture) => {
      const result = sanitizer.sanitize(fixture.diff, "diff", {
        contentContext: "code",
      });

      // Code context only suppresses encoding_evasion (ee-*).
      // delimiter_escape (de-*) is NEVER suppressed — it targets our XML
      // boundary tags and must always be caught.
      const disallowedPrefixes = ["ee-"];

      const violatingDetections = result.detections.filter((d) =>
        disallowedPrefixes.some((prefix) => d.patternId.startsWith(prefix)),
      );

      expect(violatingDetections, [
        `Fixture "${fixture.name}": diff (contentContext=code) should not fire`,
        `encoding_evasion (ee-*) patterns, but got:`,
        violatingDetections.map((d) => `  ${d.patternId}`).join("\n"),
        `\nNote: expectedTriggerPatterns = [${fixture.expectedTriggerPatterns?.join(", ") ?? ""}]`,
      ].join("\n")).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Summary: corpus-wide false-positive rate
// ---------------------------------------------------------------------------

describe("false-positive rate — corpus summary", () => {
  it("reports overall false-positive rate across all 25 fixtures", () => {
    let totalFields = 0;
    let falsePositiveFields = 0;
    const falsePositiveDetails: string[] = [];

    for (const fixture of ALL_LEGITIMATE_FIXTURES) {
      const allowed = fixture.expectedTriggerPatterns ?? [];
      const fieldResults = scanAllFields(fixture);

      for (const { field, patternIds } of fieldResults) {
        totalFields++;
        const unexpectedIds = patternIds.filter((id) => !allowed.includes(id));
        if (unexpectedIds.length > 0) {
          falsePositiveFields++;
          falsePositiveDetails.push(
            `  ${fixture.name} / ${field}: [${unexpectedIds.join(", ")}]`,
          );
        }
      }
    }

    const fpRate = totalFields > 0 ? falsePositiveFields / totalFields : 0;
    const fpPercent = (fpRate * 100).toFixed(2);

    // Log summary regardless of pass/fail for CI visibility.
    console.info(
      [
        "",
        "=== False-positive prevention summary ===",
        `Fixtures: ${ALL_LEGITIMATE_FIXTURES.length}`,
        `Total field scans: ${totalFields}`,
        `Fields with unexpected detections: ${falsePositiveFields}`,
        `False-positive rate: ${fpPercent}%`,
        falsePositiveDetails.length > 0
          ? `\nUnexpected detections:\n${falsePositiveDetails.join("\n")}`
          : "No unexpected detections.",
        "=========================================",
      ].join("\n"),
    );

    // The corpus must achieve a 0% false-positive rate.
    expect(
      falsePositiveFields,
      `Expected 0 fields with false positives across ${ALL_LEGITIMATE_FIXTURES.length} fixtures ` +
        `(${totalFields} field scans), but got ${falsePositiveFields} (${fpPercent}%).\n` +
        falsePositiveDetails.join("\n"),
    ).toBe(0);
  });
});
