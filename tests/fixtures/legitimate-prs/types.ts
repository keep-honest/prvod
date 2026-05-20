/**
 * Shape for legitimate PR fixtures used in false-positive testing.
 *
 * Each fixture represents a real-world PR that contains patterns superficially
 * resembling prompt injection but is, in fact, completely benign.  The
 * InputSanitizer SHOULD NOT flag these, or at worst should flag only patterns
 * in "permissive" fields (diff, issueBody, milestoneDescription) where
 * encoding_evasion is already suppressed.
 */
export interface LegitimateFixture {
  /** Short, unique identifier for test output. */
  name: string;
  /** Broad category grouping (see index.ts CATEGORIES constant). */
  category: string;
  /** Realistic PR title. */
  prTitle: string;
  /** Realistic PR description/body. */
  prDescription: string;
  /** Unified diff snippet with +/- prefixes. */
  diff: string;
  /** Related issue titles (may be empty). */
  issues: string[];
  /** Milestone title (may be empty string). */
  milestone: string;
  /**
   * Which injection pattern IDs this fixture is expected to trigger
   * (if any) in a given field.  Empty means "should trigger nothing".
   * When populated, the test can assert that the detection is a known
   * false-positive the system is expected to tolerate.
   */
  expectedTriggerPatterns?: string[];
}
