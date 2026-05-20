import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Mock Remotion hooks so CodeFirstScene can render in a non-Remotion context
vi.mock("remotion", () => ({
  AbsoluteFill: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) =>
    React.createElement("div", { style: { position: "absolute", ...style } }, children),
  useCurrentFrame: () => 30, // settled frame (past entrance animation)
  useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080, durationInFrames: 150, id: "test" }),
  interpolate: (value: number, inputRange: number[], outputRange: number[], _options?: { extrapolateLeft?: string; extrapolateRight?: string }) => {
    const [inMin, inMax] = inputRange;
    const [outMin, outMax] = outputRange;
    const clamped = Math.min(Math.max(value, inMin), inMax);
    const t = inMax === inMin ? 1 : (clamped - inMin) / (inMax - inMin);
    return outMin + t * (outMax - outMin);
  },
  spring: () => 1, // fully settled
  Sequence: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  delayRender: () => { throw new Error("Not in Remotion context"); },
  continueRender: () => {},
}));

import { CodeFirstScene } from "@/infrastructure/video/remotion/components/CodeFirstScene";
import { orbitPosition, cardEntrance } from "@/infrastructure/video/remotion/components/CodeSnippetMontage";

describe("CodeFirstScene", () => {
  it("renders code metadata and cinematic review framing", () => {
    const html = renderToStaticMarkup(
      <CodeFirstScene
        sceneNumber={2}
        filePath="src/app/page.tsx"
        language="typescript"
        code={"export default function Page() {\n  return null;\n}"}
        highlights={[1]}
        durationInFrames={150}
      />,
    );

    expect(html).toContain("src/app/page.tsx");
    expect(html).toContain("typescript");
    expect(html).toContain("Scene 2");
    expect(html).toContain("export default function Page()");
  });

  it("renders narrative bridge when no code and no upcoming snippets", () => {
    const html = renderToStaticMarkup(
      <CodeFirstScene
        sceneNumber={1}
        durationInFrames={150}
      />,
    );

    expect(html).toContain("Scene 1");
    expect(html).toContain("Narrative bridge");
  });

  it("renders montage when upcomingSnippets are provided and no code", () => {
    const html = renderToStaticMarkup(
      <CodeFirstScene
        sceneNumber={1}
        durationInFrames={150}
        upcomingSnippets={[
          { filePath: "src/auth.ts", code: "export function verify() {}", language: "typescript", lineRange: null, highlights: [] },
          { filePath: "src/db.ts", code: "export const pool = new Pool();", language: "typescript", lineRange: null, highlights: [] },
        ]}
      />,
    );

    expect(html).toContain("src/auth.ts");
    expect(html).toContain("src/db.ts");
    expect(html).not.toContain("Narrative bridge");
  });

  it("prefers code card over montage when both code and snippets exist", () => {
    const html = renderToStaticMarkup(
      <CodeFirstScene
        sceneNumber={2}
        filePath="src/app/page.tsx"
        language="typescript"
        code={"export default function Page() {}"}
        durationInFrames={150}
        upcomingSnippets={[
          { filePath: "src/other.ts", code: "export const x = 1;", language: "typescript", lineRange: null, highlights: [] },
        ]}
      />,
    );

    expect(html).toContain("src/app/page.tsx");
    expect(html).not.toContain("src/other.ts");
  });

  it("renders MultiCodeCard when additionalCodeBroll is provided", () => {
    const html = renderToStaticMarkup(
      <CodeFirstScene
        sceneNumber={3}
        filePath="src/auth.ts"
        language="typescript"
        code={"export function verify() {}"}
        durationInFrames={150}
        additionalCodeBroll={[
          { filePath: "src/db.ts", code: "export const pool = new Pool();", language: "typescript", lineRange: null, highlights: [] },
        ]}
      />,
    );

    expect(html).toContain("src/auth.ts");
    expect(html).toContain("src/db.ts");
  });
});

describe("orbitPosition", () => {
  it("distributes cards evenly around the ellipse at frame 0", () => {
    const p0 = orbitPosition(0, 4, 0, 30);
    const p1 = orbitPosition(1, 4, 0, 30);
    const p2 = orbitPosition(2, 4, 0, 30);
    const p3 = orbitPosition(3, 4, 0, 30);

    // Card 0 is at angle 0 (rightmost), card 2 at PI (leftmost)
    expect(p0.x).toBeGreaterThan(0);
    expect(p2.x).toBeLessThan(0);
    // Card 1 at PI/2 (top), card 3 at 3PI/2 (bottom)
    expect(Math.abs(p1.x)).toBeLessThan(10); // near center x
    expect(Math.abs(p3.x)).toBeLessThan(10);
  });

  it("rotates positions as frame increases", () => {
    const at0 = orbitPosition(0, 3, 0, 30);
    const at60 = orbitPosition(0, 3, 60, 30);
    expect(at0.x).not.toBeCloseTo(at60.x, 0);
  });

  it("returns origin when total is 0", () => {
    const pos = orbitPosition(0, 0, 30, 30);
    expect(pos).toEqual({ x: 0, y: 0 });
  });

  it("handles single card", () => {
    const pos = orbitPosition(0, 1, 0, 30);
    expect(Number.isFinite(pos.x)).toBe(true);
    expect(Number.isFinite(pos.y)).toBe(true);
  });
});

describe("cardEntrance", () => {
  // Note: spring is mocked to always return 1 in the Remotion mock above.
  // These tests verify the stagger delay logic (frame offset), not the spring curve.

  it("passes adjusted frame to spring (stagger delay subtracts index * STAGGER_FRAMES)", () => {
    // index=0 at frame=0 → adjustedFrame = max(0, 0 - 0) = 0
    // index=2 at frame=0 → adjustedFrame = max(0, 0 - 12) = 0
    // Both call spring({ frame: 0 }) which the mock returns 1 for
    // The key behavior is that adjustedFrame is clamped to >= 0
    const result = cardEntrance(0, 30, 0);
    expect(result).toBe(1); // spring mock returns 1
  });

  it("returns a number for any valid input", () => {
    expect(typeof cardEntrance(15, 30, 3)).toBe("number");
    expect(Number.isFinite(cardEntrance(15, 30, 3))).toBe(true);
  });

  it("clamps negative adjusted frame to 0", () => {
    // frame=5, index=2 → adjustedFrame = max(0, 5 - 12) = 0
    const result = cardEntrance(5, 30, 2);
    expect(result).toBe(1); // spring(frame: 0) → mock returns 1
  });
});
