import React, { useCallback, useEffect, useRef } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { createNoise2D } from "@/infrastructure/video/remotion/lib/simplexNoise";

/**
 * Procedural background using simplex noise rendered to a canvas.
 *
 * Renders at 1/4 resolution (480x270) and scales up via CSS — the bilinear
 * interpolation on the scale-up produces smooth organic gradients. Three
 * noise layers at different animation speeds and cell sizes create depth.
 *
 * Color palette: deep navy to dark blue with a subtle cyan tint, matching
 * the prvod.dev constellation graph aesthetic.
 *
 * Performance: ~130K noise evaluations per frame at 480x270. At ~50ns per
 * evaluation (simplex noise is fast), that's ~6.5ms per frame — well within
 * Remotion's render budget.
 */

const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 270;
const SEED = 42;

// Three noise layers with increasing frequency and speed
const LAYERS = [
  { cellSize: 200, speed: 0.003, weight: 0.5 },  // slow/large — dominant
  { cellSize: 80,  speed: 0.008, weight: 0.35 },  // medium
  { cellSize: 40,  speed: 0.015, weight: 0.15 },  // fast/subtle — detail
] as const;

/**
 * Writes noise-to-color RGB values directly into the ImageData buffer.
 * Avoids per-pixel array allocation (~130K pixels/frame).
 */
function writeNoiseColor(n: number, data: Uint8ClampedArray, idx: number): void {
  const t = (n + 1) * 0.5;
  data[idx] = 8 + t * 10;       // r: 8-18
  data[idx + 1] = 10 + t * 18;  // g: 10-28
  data[idx + 2] = 18 + t * 24;  // b: 18-42
  data[idx + 3] = 255;
}

export const ProceduralBackground: React.FC = () => {
  const frame = useCurrentFrame();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const noiseRef = useRef(createNoise2D(SEED));

  const renderFrame = useCallback((currentFrame: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.warn(
        "[ProceduralBackground] canvas.getContext('2d') returned null — " +
        "frame will be blank. This may indicate GPU resource exhaustion.",
      );
      return;
    }

    const noise = noiseRef.current;
    const imageData = ctx.createImageData(CANVAS_WIDTH, CANVAS_HEIGHT);
    const data = imageData.data;

    for (let y = 0; y < CANVAS_HEIGHT; y++) {
      for (let x = 0; x < CANVAS_WIDTH; x++) {
        let accumulated = 0;

        for (const layer of LAYERS) {
          const nx = x / layer.cellSize;
          const ny = y / layer.cellSize;
          const z = currentFrame * layer.speed;
          // Use z as a y-offset to animate through the noise field
          accumulated += noise(nx + z * 0.7, ny + z) * layer.weight;
        }

        writeNoiseColor(accumulated, data, (y * CANVAS_WIDTH + x) * 4);
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }, []);

  useEffect(() => {
    renderFrame(frame);
  }, [frame, renderFrame]);

  return (
    <AbsoluteFill>
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          imageRendering: "auto", // bilinear interpolation on scale-up
        }}
      />
    </AbsoluteFill>
  );
};
