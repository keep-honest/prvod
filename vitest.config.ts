import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // Use the automatic JSX runtime so `.tsx` files (including Next.js App
  // Router components that rely on Next's default React 19 runtime) don't
  // need an explicit `import React from "react"` to be rendered through
  // `react-dom/server` in tests.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    globals: true,
    include: [
      "tests/unit/**/*.test.ts",
      "tests/unit/**/*.test.tsx",
      "tests/integration/**/*.test.ts",
      "tests/integration/**/*.test.tsx",
      "tests/contract/**/*.test.ts",
      "tests/contract/**/*.test.tsx",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/app/**", "src/mocks/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
