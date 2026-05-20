import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { ProceduralBackground } from "./ProceduralBackground";

interface AnimatedBackgroundProps {
  variant?: "gradient" | "procedural";
}

/**
 * Animated dark background with slowly shifting gradient layers.
 *
 * `"gradient"` (default): Two CSS radial gradients at different drift speeds.
 * `"procedural"`: Canvas-rendered simplex noise at 1/4 resolution — organic,
 * animated dark-navy field. More cinematic but heavier per-frame cost (~6.5ms).
 */
export const AnimatedBackground: React.FC<AnimatedBackgroundProps> = ({
  variant = "gradient",
}) => {
  const frame = useCurrentFrame();

  if (variant === "procedural") {
    return <ProceduralBackground />;
  }

  return <GradientBackground frame={frame} />;
};

const GradientBackground: React.FC<{ frame: number }> = ({ frame }) => {
  // Slow hue shift on the primary accent (blue → slightly purple → back)
  const hueShift = interpolate(frame, [0, 600], [0, 20], {
    extrapolateRight: "extend",
  });
  const hue = 225 + hueShift; // Base blue hue with drift

  // Primary gradient center drifts slowly across the top
  const centerX = interpolate(frame, [0, 900], [42, 58], {
    extrapolateRight: "extend",
  });
  const centerY = interpolate(frame, [0, 1200], [18, 32], {
    extrapolateRight: "extend",
  });

  // Secondary accent (deeper, slower) for depth
  const secondaryX = interpolate(frame, [0, 1500], [65, 40], {
    extrapolateRight: "extend",
  });
  const secondaryY = interpolate(frame, [0, 1800], [70, 55], {
    extrapolateRight: "extend",
  });

  return (
    <AbsoluteFill>
      {/* Base layer: near-black */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(180deg, #0a0b0d 0%, #080808 100%)",
        }}
      />
      {/* Primary accent: blue glow drifting across the top */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse 50% 40% at ${centerX}% ${centerY}%, hsla(${hue}, 70%, 35%, 0.18), transparent 70%)`,
        }}
      />
      {/* Secondary accent: deeper, slower, warmer for depth */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse 40% 35% at ${secondaryX}% ${secondaryY}%, hsla(${hue + 30}, 50%, 25%, 0.08), transparent 60%)`,
        }}
      />
    </AbsoluteFill>
  );
};
