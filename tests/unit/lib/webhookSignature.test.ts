import { describe, it, expect } from "vitest";
import { parseAnnotations, ANNOTATION_REGEX } from "@/lib/webhookSignature";

/**
 * `parseAnnotations` only recognises a `@prvod` command when it appears on
 * a line by itself (ignoring surrounding whitespace and an optional trailing
 * sentence-punctuation mark). Drive-by mentions inside longer prose are
 * rejected — this is what the user means by "only purposeful comments."
 *
 * These tests are the behavioural contract. Two invariants matter:
 *   1. Every supported `@prvod [mode]` whole-line form must be accepted.
 *   2. Every drive-by mention, typo, URL, email, compound word, or bot
 *      error-comment body must be rejected (`hasAnnotation === false`).
 */

describe("parseAnnotations — accepted whole-line commands", () => {
  it("recognises bare @prvod on its own line", () => {
    const r = parseAnnotations("@prvod");
    expect(r.hasAnnotation).toBe(true);
    expect(r.scriptOnly).toBe(false);
    expect(r.shortDuration).toBe(false);
    expect(r.popcornDuration).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(parseAnnotations("@PRVOD").hasAnnotation).toBe(true);
    expect(parseAnnotations("@PrVod SHORT").shortDuration).toBe(true);
    expect(parseAnnotations("@prvod PoPcOrN").popcornDuration).toBe(true);
    expect(parseAnnotations("@prvod Script").scriptOnly).toBe(true);
  });

  it("tolerates leading/trailing whitespace", () => {
    expect(parseAnnotations("   @prvod   ").hasAnnotation).toBe(true);
    expect(parseAnnotations("\t@prvod short\t").shortDuration).toBe(true);
  });

  it("tolerates a single trailing sentence punctuation mark", () => {
    expect(parseAnnotations("@prvod.").hasAnnotation).toBe(true);
    expect(parseAnnotations("@prvod!").hasAnnotation).toBe(true);
    expect(parseAnnotations("@prvod?").hasAnnotation).toBe(true);
    expect(parseAnnotations("@prvod short.").shortDuration).toBe(true);
    expect(parseAnnotations("@prvod popcorn!").popcornDuration).toBe(true);
    expect(parseAnnotations("@prvod script?").scriptOnly).toBe(true);
  });

  it("recognises @prvod script", () => {
    const r = parseAnnotations("@prvod script");
    expect(r.scriptOnly).toBe(true);
    expect(r.hasAnnotation).toBe(true);
  });

  it("recognises @prvod short", () => {
    const r = parseAnnotations("@prvod short");
    expect(r.shortDuration).toBe(true);
    expect(r.hasAnnotation).toBe(true);
  });

  it("recognises @prvod popcorn", () => {
    const r = parseAnnotations("@prvod popcorn");
    expect(r.popcornDuration).toBe(true);
    expect(r.hasAnnotation).toBe(true);
  });

  it("recognises the command inside a multi-line body when the command is on its own line", () => {
    const body = [
      "Here's what I changed:",
      "",
      "- refactored the auth module",
      "- added tests",
      "",
      "@prvod short",
      "",
      "Thanks!",
    ].join("\n");
    const r = parseAnnotations(body);
    expect(r.hasAnnotation).toBe(true);
    expect(r.shortDuration).toBe(true);
  });
});

describe("parseAnnotations — rejected drive-by mentions", () => {
  const rejected: Array<[string, string]> = [
    ["bare mention in prose", "Please generate @prvod short for this PR"],
    ["mention surrounded by words", "Please generate a video @prvod popcorn thanks"],
    ["email-like prefix", "user@prvod short"],
    ["mention in a sentence", "I think @prvod can handle this"],
    ["mention wrapped in backticks", "Please re-run by commenting `@prvod` above"],
    ["typo compound", "@prvod shortly"],
    ["typo compound (script)", "@prvod scriptwriter"],
    ["typo compound (popcorn)", "@prvod popcornmaker"],
    ["hyphenated compound", "@prvod short-lived"],
    ["file extension", "@prvod short.png"],
    ["URL-like", "@prvod.io"],
    ["URL-like with path", "@prvod.io/docs"],
    ["double-mode is invalid", "@prvod script short"],
    ["two tokens on the same line around the command", "hi @prvod there"],
  ];

  for (const [label, body] of rejected) {
    it(`rejects: ${label}`, () => {
      const r = parseAnnotations(body);
      expect(r.hasAnnotation).toBe(false);
      expect(r.scriptOnly).toBe(false);
      expect(r.shortDuration).toBe(false);
      expect(r.popcornDuration).toBe(false);
    });
  }
});

describe("parseAnnotations — mode precedence", () => {
  it("script wins over popcorn when both appear on separate lines", () => {
    const r = parseAnnotations("@prvod popcorn\n@prvod script");
    expect(r.scriptOnly).toBe(true);
    expect(r.popcornDuration).toBe(false);
    expect(r.shortDuration).toBe(false);
  });

  it("popcorn wins over short when both appear on separate lines", () => {
    const r = parseAnnotations("@prvod short\n@prvod popcorn");
    expect(r.popcornDuration).toBe(true);
    expect(r.shortDuration).toBe(false);
  });

  it("a mode line wins over a plain line", () => {
    const r = parseAnnotations("@prvod\n@prvod short");
    expect(r.shortDuration).toBe(true);
    expect(r.hasAnnotation).toBe(true);
  });
});

describe("parseAnnotations — defence in depth against the webhook loop", () => {
  // These bodies intentionally include the literal `@prvod` substring but
  // NOT as the entire line content — they're the kind of strings that our
  // own bot posts. None of them should trigger the pipeline.
  const loopBodies: Array<[string, string]> = [
    [
      "rate-limit error comment",
      [
        "### 🎬 PrVod",
        "",
        "⏳ Video generation failed because the underlying LLM provider is rate-limited.",
        "",
        "Try again in a few minutes by commenting `@prvod` on this PR. If the issue persists…",
        "",
        "---",
      ].join("\n"),
    ],
    [
      "generic error comment",
      [
        "### 🎬 PrVod",
        "",
        "😞 Video generation failed. Please try again by commenting `@prvod` on this PR.",
        "",
        "---",
      ].join("\n"),
    ],
  ];

  for (const [label, body] of loopBodies) {
    it(`does not match drive-by @prvod inside a bot ${label}`, () => {
      const r = parseAnnotations(body);
      expect(r.hasAnnotation).toBe(false);
    });
  }
});

describe("ANNOTATION_REGEX (deprecated direct export)", () => {
  // The legacy export is preserved for any remaining call sites. It now
  // carries the same whole-line contract as `parseAnnotations` — drive-by
  // mentions are rejected.
  it("matches a bare @prvod line", () => {
    expect(ANNOTATION_REGEX.test("@prvod")).toBe(true);
  });

  it("matches @prvod <mode> lines", () => {
    expect(ANNOTATION_REGEX.test("@prvod script")).toBe(true);
    expect(ANNOTATION_REGEX.test("@prvod short")).toBe(true);
    expect(ANNOTATION_REGEX.test("@prvod popcorn")).toBe(true);
  });

  it("rejects drive-by mentions", () => {
    expect(ANNOTATION_REGEX.test("hi @prvod there")).toBe(false);
    expect(ANNOTATION_REGEX.test("Please comment `@prvod` on this PR")).toBe(false);
    expect(ANNOTATION_REGEX.test("@prvodbot")).toBe(false);
    expect(ANNOTATION_REGEX.test("@prvod.io")).toBe(false);
  });
});

describe("parseAnnotations", () => {
  it("detects bare deepdive annotations", () => {
    expect(parseAnnotations("@prvod deepdive")).toEqual({
      hasAnnotation: true,
      scriptOnly: false,
      shortDuration: false,
      popcornDuration: false,
      deepdive: true,
    });
  });

  it("detects deepdive regardless of ordering with duration modifiers", () => {
    expect(parseAnnotations("@prvod short deepdive")).toMatchObject({
      shortDuration: true,
      deepdive: true,
      scriptOnly: false,
    });
    expect(parseAnnotations("@prvod deepdive short")).toMatchObject({
      shortDuration: true,
      deepdive: true,
      scriptOnly: false,
    });
    expect(parseAnnotations("@prvod popcorn deepdive")).toMatchObject({
      popcornDuration: true,
      deepdive: true,
      scriptOnly: false,
    });
    expect(parseAnnotations("@prvod deepdive popcorn")).toMatchObject({
      popcornDuration: true,
      deepdive: true,
      scriptOnly: false,
    });
  });

  it("detects script deepdive in either order", () => {
    expect(parseAnnotations("@prvod script deepdive")).toMatchObject({
      scriptOnly: true,
      deepdive: true,
      shortDuration: false,
      popcornDuration: false,
    });
    expect(parseAnnotations("@prvod deepdive script")).toMatchObject({
      scriptOnly: true,
      deepdive: true,
      shortDuration: false,
      popcornDuration: false,
    });
  });

  it("detects deepdive on a separate line from script", () => {
    const r = parseAnnotations("@prvod script\n@prvod deepdive");
    expect(r.scriptOnly).toBe(true);
    expect(r.deepdive).toBe(true);
  });

  it("rejects double non-deepdive modes as ambiguous", () => {
    // Two non-deepdive modes on the same line are rejected (same as main)
    expect(parseAnnotations("@prvod script short").hasAnnotation).toBe(false);
    // Three tokens exceed the two-token limit
    expect(parseAnnotations("@prvod script popcorn deepdive").hasAnnotation).toBe(false);
  });
});
