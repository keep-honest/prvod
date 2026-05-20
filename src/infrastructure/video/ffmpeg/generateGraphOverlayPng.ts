/**
 * Renders the completed constellation graph as a static PNG overlay.
 *
 * The FFmpeg compositor has no per-frame animation primitives, so it
 * substitutes the Remotion shrink+reveal sequence with a single fade-in of
 * this pre-rendered image on the final scene. The image uses the exact same
 * coordinates as `computeGraphLayout` (1920×1080 canvas) so it lines up with
 * the rest of the video framing.
 *
 * Pipeline: `GraphLayoutData` → hand-written SVG → Sharp rasterization → PNG
 */

import sharp from "sharp";
import type { GraphLayoutData } from "@/infrastructure/video/graph/types";
import { createLogger } from "@/lib/logger";
import { escapeXml } from "@/lib/xml";

const logger = createLogger("generateGraphOverlayPng");

const BG_COLOR = "#0d1117";
const EDGE_COLOR = "rgba(84, 214, 255, 0.55)";
const NODE_FILL = "rgba(84, 214, 255, 0.32)";
const NODE_STROKE = "rgba(84, 214, 255, 0.9)";
const LABEL_COLOR = "rgba(230, 237, 243, 0.88)";
const TITLE_COLOR = "rgba(230, 237, 243, 0.7)";

/**
 * Renders the given graph layout as a transparent-background PNG buffer.
 *
 * The background is a translucent dark panel rather than fully transparent so
 * the overlay reads clearly against whatever the scene's video frame contains
 * behind it. The FFmpeg overlay filter fades it in over ~0.5s.
 */
export async function generateGraphOverlayPng(
  graphLayout: GraphLayoutData,
): Promise<Buffer> {
  const startMs = Date.now();
  logger.info("Generating constellation graph PNG", {
    nodes: graphLayout.nodes.length,
    edges: graphLayout.edges.length,
    viewport: `${graphLayout.viewportWidth}x${graphLayout.viewportHeight}`,
  });

  const { nodes, edges, viewportWidth, viewportHeight } = graphLayout;

  const edgeElements = edges
    .map(
      (edge) =>
        `<path d="${escapeXml(edge.pathD)}" fill="none" stroke="${EDGE_COLOR}" ` +
        `stroke-width="2" stroke-linecap="round"/>`,
    )
    .join("");

  const nodeElements = nodes
    .map((node) => {
      const labelY = node.y + node.radius + 26;
      return (
        `<circle cx="${node.x}" cy="${node.y}" r="${node.radius}" ` +
        `fill="${NODE_FILL}" stroke="${NODE_STROKE}" stroke-width="2"/>` +
        `<text x="${node.x}" y="${labelY}" ` +
        `font-family="'Inter', sans-serif" font-size="20" ` +
        `fill="${LABEL_COLOR}" text-anchor="middle">${escapeXml(node.label)}</text>`
      );
    })
    .join("");

  const title = `${nodes.length} file${nodes.length === 1 ? "" : "s"} · ${edges.length} relationship${edges.length === 1 ? "" : "s"}`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${viewportWidth}" height="${viewportHeight}">` +
    `<rect x="0" y="0" width="${viewportWidth}" height="${viewportHeight}" fill="${BG_COLOR}" opacity="0.72"/>` +
    `<text x="64" y="80" font-family="'Inter', sans-serif" font-size="28" ` +
    `fill="${TITLE_COLOR}" letter-spacing="0.08em">CONSTELLATION · ${escapeXml(title)}</text>` +
    edgeElements +
    nodeElements +
    `</svg>`;

  let pngBuffer: Buffer;
  try {
    pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  } catch (err) {
    // Re-throw with rich context so the outer compositor can log exactly
    // which graph was being rendered and what the problematic inputs were.
    logger.error("sharp failed to rasterize constellation graph SVG", {
      error: err instanceof Error ? err.message : String(err),
      svgLength: svg.length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      sampleNodeLabel: nodes[0]?.label ?? null,
    });
    throw err;
  }

  logger.info("Constellation graph PNG generated", {
    sizeBytes: pngBuffer.length,
    durationMs: Date.now() - startMs,
  });

  return pngBuffer;
}
