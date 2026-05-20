import { describe, expect, it } from "vitest";
import { parseCaptionOffsetMs } from "@/infrastructure/video/ffmpeg/parseCaptionOffsetMs";

describe("parseCaptionOffsetMs", () => {
  it("returns 0 with no warning when env var is undefined", () => {
    const result = parseCaptionOffsetMs(undefined);
    expect(result).toEqual({ offsetMs: 0 });
    expect(result.warning).toBeUndefined();
  });

  it("parses a valid positive number", () => {
    expect(parseCaptionOffsetMs("200")).toEqual({ offsetMs: 200 });
  });

  it("parses a valid negative number", () => {
    expect(parseCaptionOffsetMs("-50")).toEqual({ offsetMs: -50 });
  });

  it("parses a valid float", () => {
    expect(parseCaptionOffsetMs("33.5")).toEqual({ offsetMs: 33.5 });
  });

  it("returns 0 with no warning for '0'", () => {
    const result = parseCaptionOffsetMs("0");
    expect(result).toEqual({ offsetMs: 0 });
    expect(result.warning).toBeUndefined();
  });

  it("returns 0 with warning for NaN string", () => {
    const result = parseCaptionOffsetMs("abc");
    expect(result.offsetMs).toBe(0);
    expect(result.warning).toContain("Invalid");
  });

  it("returns 0 with warning for Infinity", () => {
    const result = parseCaptionOffsetMs("Infinity");
    expect(result.offsetMs).toBe(0);
    expect(result.warning).toContain("Invalid");
  });

  it("returns 0 with warning for empty string", () => {
    const result = parseCaptionOffsetMs("");
    expect(result.offsetMs).toBe(0);
    expect(result.warning).toContain("Invalid");
  });
});
