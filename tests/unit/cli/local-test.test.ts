import { describe, it, expect } from "vitest";
import {
  buildCreateJobPayload,
  formatTTSReadable,
  parseRepoFullName,
  resolveGitMaxBufferBytes,
} from "@/cli/local-test";

describe("parseRepoFullName", () => {
  it("parses SSH URL", () => {
    expect(parseRepoFullName("git@github.com:owner/repo.git")).toBe(
      "owner/repo",
    );
  });

  it("parses SSH URL without .git suffix", () => {
    expect(parseRepoFullName("git@github.com:owner/repo")).toBe("owner/repo");
  });

  it("parses HTTPS URL", () => {
    expect(parseRepoFullName("https://github.com/owner/repo.git")).toBe(
      "owner/repo",
    );
  });

  it("parses HTTPS URL without .git suffix", () => {
    expect(parseRepoFullName("https://github.com/owner/repo")).toBe(
      "owner/repo",
    );
  });

  it("throws on unparseable URL", () => {
    expect(() => parseRepoFullName("not-a-url")).toThrow(
      "Cannot parse repo from remote URL",
    );
  });
});

describe("buildCreateJobPayload", () => {
  const git = {
    diff: "diff --git a/a.ts b/a.ts",
    repoFullName: "owner/repo",
    headBranch: "feature/theme",
    title: "Add theme support",
  };

  it("builds payload with required fields", () => {
    const payload = buildCreateJobPayload(
      { prNumber: 7, scriptOnly: true, ttsOnly: false, deepdive: false, durationMode: "default" },
      git,
    );

    expect(payload).toMatchObject({
      repoFullName: "owner/repo",
      prNumber: 7,
      prTitle: "Add theme support",
      scriptOnly: true,
      durationMode: "default",
    });
    expect(payload).not.toHaveProperty("theme");
  });

  it("includes ttsOnly when set", () => {
    const payload = buildCreateJobPayload(
      { prNumber: 9, scriptOnly: false, ttsOnly: true, deepdive: false, durationMode: "default" },
      git,
    );

    expect(payload).toMatchObject({
      prNumber: 9,
      scriptOnly: false,
      ttsOnly: true,
    });
    expect(payload).not.toHaveProperty("theme");
  });

  it("sets durationMode to 'short' when shortDur is requested", () => {
    const payload = buildCreateJobPayload(
      { prNumber: 10, scriptOnly: false, ttsOnly: false, deepdive: false, durationMode: "short" },
      git,
    );

    expect(payload).toMatchObject({
      prNumber: 10,
      durationMode: "short",
    });
  });

  it("sets durationMode to 'popcorn' when popcorn is requested", () => {
    const payload = buildCreateJobPayload(
      { prNumber: 12, scriptOnly: false, ttsOnly: false, deepdive: false, durationMode: "popcorn" },
      git,
    );

    expect(payload).toMatchObject({
      prNumber: 12,
      durationMode: "popcorn",
    });
  });

  it("sets durationMode to 'default' when shortDur is not requested", () => {
    const payload = buildCreateJobPayload(
      { prNumber: 11, scriptOnly: false, ttsOnly: false, deepdive: false, durationMode: "default" },
      git,
    );

    expect(payload).toMatchObject({
      prNumber: 11,
      durationMode: "default",
    });
  });
});

describe("resolveGitMaxBufferBytes", () => {
  it("uses default when env var is missing", () => {
    expect(resolveGitMaxBufferBytes({})).toBe(64 * 1024 * 1024);
  });

  it("uses env override when valid", () => {
    expect(resolveGitMaxBufferBytes({ CLI_GIT_MAX_BUFFER_MB: "128" })).toBe(
      128 * 1024 * 1024,
    );
  });

  it("falls back to default for invalid override", () => {
    expect(resolveGitMaxBufferBytes({ CLI_GIT_MAX_BUFFER_MB: "-3" })).toBe(
      64 * 1024 * 1024,
    );
    expect(resolveGitMaxBufferBytes({ CLI_GIT_MAX_BUFFER_MB: "abc" })).toBe(
      64 * 1024 * 1024,
    );
  });
});

// ── Reviewer-oriented CLI output validation scaffolding ────────────────
// These tests verify that the CLI preview output remains compatible when
// reviewer narration is active. The job payload and TTS output should not
// leak reviewer-specific internal fields.

describe("reviewer narration CLI compatibility", () => {
  const git = {
    diff: "diff --git a/a.ts b/a.ts",
    repoFullName: "owner/repo",
    headBranch: "feature/reviewer",
    title: "Review narration check",
  };

  it("buildCreateJobPayload does not include reviewer-internal fields", () => {
    const payload = buildCreateJobPayload(
      { prNumber: 50, scriptOnly: true, ttsOnly: false, deepdive: false, durationMode: "default" },
      git,
    );

    // Public payload must not expose reviewer-specific internal concepts
    expect(payload).not.toHaveProperty("reviewMode");
    expect(payload).not.toHaveProperty("reviewPosture");
    expect(payload).not.toHaveProperty("reviewConcerns");
  });

  it("includes deepdive when requested", () => {
    const payload = buildCreateJobPayload(
      { prNumber: 51, scriptOnly: true, ttsOnly: false, deepdive: true, durationMode: "default" },
      git,
    );

    expect(payload).toMatchObject({
      prNumber: 51,
      deepdive: true,
    });
  });
});

describe("formatTTSReadable", () => {
  const scriptJson = {
    changeType: "feature",
    summary: "Added multi-clip scene support",
    totalDurationSeconds: 58,
    totalWordCount: 30,
    scenes: [
      { sceneNumber: 1, sceneType: "hook", durationSeconds: 7, narration: "Hello world" },
      { sceneNumber: 2, sceneType: "code_walkthrough", durationSeconds: 10, narration: "Walking through code" },
    ],
  };

  const ttsAudio = [
    {
      sceneNumber: 1,
      wordTimings: [
        { word: "Hello", startTimeMs: 0, endTimeMs: 400 },
        { word: "world", startTimeMs: 400, endTimeMs: 800 },
      ],
      clipDurations: [5],
      audioUrl: "https://example.com/scene-1.mp3",
    },
    {
      sceneNumber: 2,
      wordTimings: [
        { word: "Walking", startTimeMs: 0, endTimeMs: 350 },
        { word: "through", startTimeMs: 350, endTimeMs: 700 },
        { word: "code", startTimeMs: 700, endTimeMs: 1050 },
      ],
      clipDurations: [5, 5],
      audioUrl: "https://example.com/scene-2.mp3",
    },
  ];

  it("includes header with script metadata", () => {
    const output = formatTTSReadable(scriptJson, ttsAudio as Array<Record<string, unknown>>);
    expect(output).toContain("PR VIDEO SCRIPT — TTS Preview");
    expect(output).toContain("Change type: feature");
    expect(output).toContain("Summary: Added multi-clip scene support");
    expect(output).toContain("Total duration: 58s | Word count: 30 | Scenes: 2");
  });

  it("renders each scene with narration", () => {
    const output = formatTTSReadable(scriptJson, ttsAudio as Array<Record<string, unknown>>);
    expect(output).toContain("Scene 1 — hook (7s)");
    expect(output).toContain("  Hello world");
    expect(output).toContain("Scene 2 — code_walkthrough (10s)");
    expect(output).toContain("  Walking through code");
  });

  it("formats word timings as seconds", () => {
    const output = formatTTSReadable(scriptJson, ttsAudio as Array<Record<string, unknown>>);
    expect(output).toContain("[0.000s – 0.400s] Hello");
    expect(output).toContain("[0.400s – 0.800s] world");
    expect(output).toContain("[0.700s – 1.050s] code");
  });

  it("renders clip durations", () => {
    const output = formatTTSReadable(scriptJson, ttsAudio as Array<Record<string, unknown>>);
    expect(output).toContain("Clip durations: 5s");
    expect(output).toContain("Clip durations: 5s + 5s");
  });

  it("renders audio URLs", () => {
    const output = formatTTSReadable(scriptJson, ttsAudio as Array<Record<string, unknown>>);
    expect(output).toContain("Audio URL: https://example.com/scene-1.mp3");
    expect(output).toContain("Audio URL: https://example.com/scene-2.mp3");
  });

  it("shows '(no audio)' for scenes without audio data", () => {
    const noAudio = [{ sceneNumber: 1 }, { sceneNumber: 2 }];
    const output = formatTTSReadable(scriptJson, noAudio as Array<Record<string, unknown>>);
    expect(output).toContain("Audio: (no audio)");
    expect(output).not.toContain("Word timings:");
  });

  it("handles multiline narration", () => {
    const multiline = {
      ...scriptJson,
      scenes: [{ sceneNumber: 1, sceneType: "hook", durationSeconds: 7, narration: "Line one\nLine two" }],
    };
    const output = formatTTSReadable(multiline, [] as Array<Record<string, unknown>>);
    expect(output).toContain("  Line one");
    expect(output).toContain("  Line two");
  });
});
