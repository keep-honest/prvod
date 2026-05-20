import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    ignores: [
      "node_modules/",
      "dist/",
      "build/",
      ".next/",
      "out/",
      "coverage/",
      "remotion-bundle/",
      ".local-storage/",
      "**/*.min.js",
      "action/",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  // Test files: Vitest's expect(x).toBeDefined() does not narrow the TS type,
  // so the canonical idiom is `expect(x).toBeDefined(); x!.prop`. Banning
  // non-null assertions in tests forces every test to allocate a separate
  // narrowed local for the same value — pure noise. Production code stays
  // strict (the global rule above still fires there). Empty test fakes /
  // shape classes are likewise normal in vitest.
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
);
