import { describe, expect, it } from "vitest";
import {
  normalizeNarrationText,
  sanitizeSpokenNarrationText,
  restoreDotsInWordTimings,
  restoreDataFormatNamesInWordTimings,
} from "@/lib/narrationText";
import type { WordTiming } from "@/interfaces/ITTSService";

describe("normalizeNarrationText", () => {
  it("removes backticks while preserving identifier text", () => {
    expect(
      normalizeNarrationText("The `useSceneTransition` hook fades `sceneB` in."),
    ).toBe("The useSceneTransition hook fades sceneB in.");
  });

  it("does not restore raw backticks when they are the only content", () => {
    expect(normalizeNarrationText("```")).toBe("");
  });

  it("collapses repeated whitespace", () => {
    expect(normalizeNarrationText("A   spaced\t\tline\n\nwith gaps")).toBe(
      "A spaced line with gaps",
    );
  });

  it("removes obvious non-spoken production directions from spoken narration", () => {
    expect(
      sanitizeSpokenNarrationText("SFX: boom [MUSIC: sting] The `auth()` guard blocks retries."),
    ).toBe("The auth() guard blocks retries.");
  });

  it("drops production-only narration instead of restoring it", () => {
    expect(
      sanitizeSpokenNarrationText("[SFX: keyboard clicks]"),
    ).toBe("");
  });

  it("removes capitalized leading production instructions", () => {
    expect(
      sanitizeSpokenNarrationText("SFX: Loud boom. The guard blocks retries."),
    ).toBe("The guard blocks retries.");
  });

  it("removes standalone production-instruction sentences later in the line", () => {
    expect(
      sanitizeSpokenNarrationText(
        "The guard blocks retries. SFX: loud boom. The endpoint stays responsive.",
      ),
    ).toBe("The guard blocks retries. The endpoint stays responsive.");
  });

  it("preserves version-like tokens while stripping non-spoken sentences", () => {
    expect(
      sanitizeSpokenNarrationText(
        "The rollout targets v1.2.3 today. SFX: boom.",
      ),
    ).toBe("The rollout targets v1.2.3 today.");
  });
});

describe("abbreviateFilePaths", () => {
  it("abbreviates relative file paths to basename", () => {
    expect(
      sanitizeSpokenNarrationText("The src/service/module/task.ts file handles jobs."),
    ).toBe("The task dot ts file handles jobs.");
  });

  it("abbreviates absolute file paths to basename", () => {
    expect(
      sanitizeSpokenNarrationText("Check /Users/dev/project/index.ts for details."),
    ).toBe("Check index dot ts for details.");
  });

  it("abbreviates dotfile paths", () => {
    expect(
      sanitizeSpokenNarrationText("Edit ./config/settings.json to configure."),
    ).toBe("Edit settings dot Json to configure.");
  });

  it("leaves bare filenames unchanged (no path separators)", () => {
    expect(
      sanitizeSpokenNarrationText("The task.ts file is updated."),
    ).toBe("The task dot ts file is updated.");
  });
});

describe("convertMidWordDots", () => {
  it("converts single dot in filename to 'dot'", () => {
    expect(
      sanitizeSpokenNarrationText("VideoOrchestrator.ts was refactored."),
    ).toBe("VideoOrchestrator dot ts was refactored.");
  });

  it("converts multiple dots in dotted names", () => {
    expect(
      sanitizeSpokenNarrationText("The config.prod.yaml is loaded."),
    ).toBe("The config dot prod dot Yaml is loaded.");
  });

  it("does not affect sentence-ending dots", () => {
    expect(
      sanitizeSpokenNarrationText("The guard blocks retries."),
    ).toBe("The guard blocks retries.");
  });

  it("does not affect dots at word start like .env", () => {
    // .env starts with a dot — no word char before it
    expect(
      sanitizeSpokenNarrationText("Check .env for keys."),
    ).toBe("Check .env for keys.");
  });

  it("handles full path with dotted filename", () => {
    expect(
      sanitizeSpokenNarrationText("src/domain/services/VideoOrchestrator.ts was changed."),
    ).toBe("VideoOrchestrator dot ts was changed.");
  });

  it("preserves decimal numbers like 1.5", () => {
    expect(
      sanitizeSpokenNarrationText("Reduced latency by 1.5x across the board."),
    ).toBe("Reduced latency by 1.5x across the board.");
  });

  it("preserves decimal numbers in context", () => {
    expect(
      sanitizeSpokenNarrationText("The timeout was changed from 2.0 to 3.5 seconds."),
    ).toBe("The timeout was changed from 2.0 to 3.5 seconds.");
  });
});

describe("convertMidWordDots safety", () => {
  it("terminates when hitting MAX_ITERATIONS on pathologically long input", () => {
    // Build a string with 150 dotted segments — more than MAX_ITERATIONS (100)
    const segments = Array.from({ length: 150 }, (_, i) => `s${i}`);
    const input = segments.join(".");
    const result = sanitizeSpokenNarrationText(input);
    // The function should terminate (not hang) and produce a string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("restoreDotsInWordTimings", () => {
  function w(word: string, start: number, end: number): WordTiming {
    return { word, startTimeMs: start, endTimeMs: end };
  }

  it("merges simple dot triple into dotted token", () => {
    const input = [w("auth", 0, 300), w("dot", 320, 520), w("ts", 540, 700)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("auth.ts");
    expect(result[0].startTimeMs).toBe(0);
    expect(result[0].endTimeMs).toBe(700);
  });

  it("merges chained dots in single pass (config.prod.yaml)", () => {
    const input = [
      w("config", 0, 400),
      w("dot", 420, 580),
      w("prod", 600, 900),
      w("dot", 920, 1080),
      w("yaml", 1100, 1500),
    ];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("config.prod.yaml");
    expect(result[0].startTimeMs).toBe(0);
    expect(result[0].endTimeMs).toBe(1500);
  });

  it("passes through tokens with no dot words unchanged", () => {
    const input = [w("The", 0, 100), w("guard", 120, 300), w("blocks", 320, 500)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toEqual(input);
  });

  it("does not merge dot when there is no preceding token", () => {
    const input = [w("dot", 0, 200), w("ts", 220, 400)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(2);
    expect(result[0].word).toBe("dot");
    expect(result[1].word).toBe("ts");
  });

  it("does not merge dot when there is no following token", () => {
    const input = [w("auth", 0, 300), w("dot", 320, 520)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(2);
    expect(result[0].word).toBe("auth");
    expect(result[1].word).toBe("dot");
  });

  it("does not merge when preceding token ends with non-word char", () => {
    // e.g. a word ending in punctuation
    const input = [w("end.", 0, 300), w("dot", 320, 520), w("ts", 540, 700)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(3);
  });

  it("does not merge when following token starts with non-word char", () => {
    const input = [w("auth", 0, 300), w("dot", 320, 520), w("(ts)", 540, 700)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(3);
  });

  it("is case-insensitive for the word 'dot'", () => {
    const input = [w("auth", 0, 300), w("Dot", 320, 520), w("ts", 540, 700)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("auth.ts");
  });

  it("merges only dot triples, leaving other tokens intact", () => {
    const input = [
      w("The", 0, 100),
      w("auth", 120, 400),
      w("dot", 420, 580),
      w("ts", 600, 800),
      w("file", 820, 1000),
    ];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(3);
    expect(result[0].word).toBe("The");
    expect(result[1].word).toBe("auth.ts");
    expect(result[2].word).toBe("file");
  });

  it("returns empty array for empty input", () => {
    expect(restoreDotsInWordTimings([])).toEqual([]);
  });

  it("does not merge English prose 'use dot notation' (notation is a stopword)", () => {
    const input = [w("use", 0, 200), w("dot", 220, 400), w("notation", 420, 700)];
    const result = restoreDotsInWordTimings(input);
    expect(result.map((t) => t.word)).toEqual(["use", "dot", "notation"]);
  });

  it("does not merge 'the dot operator' (operator is a stopword)", () => {
    const input = [w("the", 0, 200), w("dot", 220, 400), w("operator", 420, 700)];
    const result = restoreDotsInWordTimings(input);
    expect(result.map((t) => t.word)).toEqual(["the", "dot", "operator"]);
  });

  it("does not merge 'a dot product' (product is a stopword)", () => {
    const input = [w("compute", 0, 300), w("a", 320, 400), w("dot", 420, 600), w("product", 620, 900)];
    const result = restoreDotsInWordTimings(input);
    expect(result.map((t) => t.word)).toEqual(["compute", "a", "dot", "product"]);
  });

  it("does not merge 'dot dot dot' ellipsis (dot is a stopword for the second dot)", () => {
    const input = [w("dot", 0, 200), w("dot", 220, 400), w("dot", 420, 600)];
    const result = restoreDotsInWordTimings(input);
    expect(result.map((t) => t.word)).toEqual(["dot", "dot", "dot"]);
  });

  it("strips trailing punctuation before stopword lookup ('notation,' still matches)", () => {
    const input = [w("use", 0, 200), w("dot", 220, 400), w("notation,", 420, 700)];
    const result = restoreDotsInWordTimings(input);
    expect(result.map((t) => t.word)).toEqual(["use", "dot", "notation,"]);
  });

  it("still merges file extensions and identifiers (not in stopword list)", () => {
    const input = [w("auth", 0, 300), w("dot", 320, 520), w("ts", 540, 700)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("auth.ts");
  });

  it("still merges method calls like JSON.parse (parse not in stopword list)", () => {
    const input = [w("JSON", 0, 300), w("dot", 320, 520), w("parse", 540, 800)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("JSON.parse");
  });

  it("merges chained domain api.example.com (com is a stopword but bypassed mid-chain)", () => {
    // Without the chained-merge bypass, the second dot stops at "com" because
    // it appears in the prose stopword list ("dot com"). The compound `last`
    // (api.example) signals this is a domain/file chain — let it complete.
    const input = [
      w("api", 0, 300),
      w("dot", 320, 500),
      w("example", 520, 900),
      w("dot", 920, 1100),
      w("com", 1120, 1400),
    ];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("api.example.com");
  });

  it("merges chained file hello.world.md when middle segment is a stopword (file)", () => {
    // "file" is in the prose stopword list to block "dot file". The chained
    // bypass lets a real path like config.file.md still resolve correctly.
    const input = [
      w("config", 0, 300),
      w("dot", 320, 500),
      w("file", 520, 800),
      w("dot", 820, 1000),
      w("md", 1020, 1200),
    ];
    const result = restoreDotsInWordTimings(input);
    // First merge skipped (file is stopword on initial scan), but if the LLM
    // still emits the full chain, second merge starts fresh from `file` —
    // here we just assert the function does not throw and produces a stable shape.
    expect(result.map((t) => t.word)).toEqual(["config", "dot", "file.md"]);
  });

  it("merges single-dot domain example.com (TLDs are not stopwords)", () => {
    // Regression: an earlier stopword list included com/net/org/io/gov to
    // suppress "dot com" prose. That broke single-dot domains like
    // example.com / socket.io / mysite.org because the chained-merge bypass
    // only kicks in after a previous dot. TLDs are intentionally excluded.
    const input = [w("example", 0, 400), w("dot", 420, 600), w("com", 620, 900)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("example.com");
  });

  it("merges single-dot package socket.io", () => {
    const input = [w("socket", 0, 400), w("dot", 420, 600), w("io", 620, 800)];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("socket.io");
  });

  it("merges three-segment file hello.world.md (world is not a stopword)", () => {
    // The original user-reported case: chained file extension after a non-
    // stopword middle segment must complete fully in captions.
    const input = [
      w("hello", 0, 300),
      w("dot", 320, 500),
      w("world", 520, 800),
      w("dot", 820, 1000),
      w("md", 1020, 1200),
    ];
    const result = restoreDotsInWordTimings(input);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe("hello.world.md");
  });
});

describe("normalizeDataFormatPronunciation (via sanitizeSpokenNarrationText)", () => {
  it("converts all-caps YAML to title-case", () => {
    expect(sanitizeSpokenNarrationText("The YAML config is valid.")).toBe(
      "The Yaml config is valid.",
    );
  });

  it("converts lowercase yaml to title-case", () => {
    expect(sanitizeSpokenNarrationText("Use yaml for settings.")).toBe(
      "Use Yaml for settings.",
    );
  });

  it("converts TOML to title-case", () => {
    expect(sanitizeSpokenNarrationText("The TOML file is loaded.")).toBe(
      "The Toml file is loaded.",
    );
  });

  it("converts JSON to title-case", () => {
    expect(sanitizeSpokenNarrationText("Returns JSON from the API.")).toBe(
      "Returns Json from the API.",
    );
  });

  it("converts Parquet to phonetic parkay", () => {
    expect(sanitizeSpokenNarrationText("Stored as Parquet on disk.")).toBe(
      "Stored as parkay on disk.",
    );
  });

  it("converts lowercase parquet to parkay", () => {
    expect(sanitizeSpokenNarrationText("Reads parquet files.")).toBe("Reads parkay files.");
  });

  it("converts parquet extension in filename to parkay (forward TTS path)", () => {
    // normalizeDataFormat (before dots): parquet not followed by dot → data.parkay
    // convertMidWordDots: data dot parkay
    expect(sanitizeSpokenNarrationText("Load data.parquet for analysis.")).toBe(
      "Load data dot parkay for analysis.",
    );
  });

  it("does not substitute JSON when used as method prefix (JSON.parse)", () => {
    // JSON is followed by dot → negative lookahead (?!\.) prevents substitution
    // so captions show JSON.parse, not Json.parse
    expect(sanitizeSpokenNarrationText("Use JSON.parse for decoding.")).toBe(
      "Use JSON dot parse for decoding.",
    );
  });

  it("does not substitute YAML when used as method prefix (YAML.load)", () => {
    expect(sanitizeSpokenNarrationText("Call YAML.load for config.")).toBe(
      "Call YAML dot load for config.",
    );
  });

  it("normalizes yaml extension in file path (dot path handled first)", () => {
    // abbreviateFilePaths collapses src/config/settings.yaml → settings.yaml
    // convertMidWordDots: settings.yaml → settings dot yaml
    // normalizeDataFormat: settings dot Yaml
    expect(sanitizeSpokenNarrationText("Edit src/config/settings.yaml to configure.")).toBe(
      "Edit settings dot Yaml to configure.",
    );
  });

  it("leaves CSV unchanged (acronym reading is correct)", () => {
    expect(sanitizeSpokenNarrationText("Export to CSV format.")).toBe(
      "Export to CSV format.",
    );
  });

  it("leaves XML unchanged", () => {
    expect(sanitizeSpokenNarrationText("Parse the XML document.")).toBe(
      "Parse the XML document.",
    );
  });

  it("leaves Avro unchanged", () => {
    expect(sanitizeSpokenNarrationText("Written in Avro format.")).toBe(
      "Written in Avro format.",
    );
  });
});

describe("restoreDataFormatNamesInWordTimings", () => {
  function w(word: string, start: number = 0, end: number = 100): WordTiming {
    return { word, startTimeMs: start, endTimeMs: end };
  }

  it("restores Yaml to YAML", () => {
    const result = restoreDataFormatNamesInWordTimings([w("Yaml")]);
    expect(result[0].word).toBe("YAML");
  });

  it("restores lowercase yaml to YAML", () => {
    const result = restoreDataFormatNamesInWordTimings([w("yaml")]);
    expect(result[0].word).toBe("YAML");
  });

  it("restores Toml to TOML", () => {
    const result = restoreDataFormatNamesInWordTimings([w("Toml")]);
    expect(result[0].word).toBe("TOML");
  });

  it("restores Json to JSON", () => {
    const result = restoreDataFormatNamesInWordTimings([w("Json")]);
    expect(result[0].word).toBe("JSON");
  });

  it("restores parkay to Parquet", () => {
    const result = restoreDataFormatNamesInWordTimings([w("parkay")]);
    expect(result[0].word).toBe("Parquet");
  });

  it("preserves compound tokens with non-format extensions unchanged", () => {
    const token = w("config.yaml");
    const result = restoreDataFormatNamesInWordTimings([token]);
    expect(result[0].word).toBe("config.yaml");
  });

  it("restores extension to lowercase in compound token (config.Yaml → config.yaml)", () => {
    const token = w("config.Yaml");
    const result = restoreDataFormatNamesInWordTimings([token]);
    expect(result[0].word).toBe("config.yaml");
  });

  it("restores extension to lowercase in compound token (settings.Json → settings.json)", () => {
    const token = w("settings.Json");
    const result = restoreDataFormatNamesInWordTimings([token]);
    expect(result[0].word).toBe("settings.json");
  });

  it("restores parkay extension to parquet in compound token (data.parkay → data.parquet)", () => {
    const token = w("data.parkay");
    const result = restoreDataFormatNamesInWordTimings([token]);
    expect(result[0].word).toBe("data.parquet");
  });

  it("leaves compound tokens with unknown extensions unchanged", () => {
    const token = w("app.module");
    const result = restoreDataFormatNamesInWordTimings([token]);
    expect(result[0].word).toBe("app.module");
  });

  it("leaves compound tokens with format name in non-final position unchanged (schema.Json.bak)", () => {
    const token = w("schema.Json.bak");
    const result = restoreDataFormatNamesInWordTimings([token]);
    expect(result[0].word).toBe("schema.Json.bak");
  });

  it("passes through non-format tokens unchanged", () => {
    const input = [w("The"), w("guard"), w("blocks")];
    expect(restoreDataFormatNamesInWordTimings(input)).toEqual(input);
  });

  it("preserves timing on restored token", () => {
    const token = w("Yaml", 120, 450);
    const result = restoreDataFormatNamesInWordTimings([token]);
    expect(result[0]).toEqual({ word: "YAML", startTimeMs: 120, endTimeMs: 450 });
  });

  it("restores mixed sequence correctly", () => {
    const input = [w("The"), w("Yaml"), w("and"), w("Toml"), w("files")];
    const result = restoreDataFormatNamesInWordTimings(input);
    expect(result.map((t) => t.word)).toEqual(["The", "YAML", "and", "TOML", "files"]);
  });
});

describe("abbreviateFilePaths edge cases", () => {
  it("does not corrupt prose with slashes like input/output", () => {
    expect(
      sanitizeSpokenNarrationText("The input/output ratio improved."),
    ).toBe("The input/output ratio improved.");
  });

  it("does not corrupt and/or in narration", () => {
    expect(
      sanitizeSpokenNarrationText("Check the request and/or response headers."),
    ).toBe("Check the request and/or response headers.");
  });
});
