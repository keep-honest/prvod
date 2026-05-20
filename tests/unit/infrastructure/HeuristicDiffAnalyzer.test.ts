import { describe, it, expect } from "vitest";
import { HeuristicDiffAnalyzer } from "@/infrastructure/diff/HeuristicDiffAnalyzer";

const analyzer = new HeuristicDiffAnalyzer();

const simpleDiff = `diff --git a/src/auth.ts b/src/auth.ts
index abc123..def456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,5 @@
 export function auth() {
+  checkRateLimit();
   return true;
 }
+function checkRateLimit() {}`;

const multiFileDiff = `diff --git a/src/api/routes.ts b/src/api/routes.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/api/routes.ts
@@ -0,0 +1,10 @@
+import express from "express";
+const router = express.Router();
+router.get("/health", (req, res) => res.ok());
+router.get("/users", getUsers);
+router.post("/users", createUser);
+router.get("/users/:id", getUserById);
+router.put("/users/:id", updateUser);
+router.delete("/users/:id", deleteUser);
+export default router;
+// end
diff --git a/src/models/user.ts b/src/models/user.ts
new file mode 100644
index 0000000..def5678
--- /dev/null
+++ b/src/models/user.ts
@@ -0,0 +1,5 @@
+export interface User {
+  id: string;
+  name: string;
+  email: string;
+}
diff --git a/tests/user.test.ts b/tests/user.test.ts
new file mode 100644
index 0000000..ghi9012
--- /dev/null
+++ b/tests/user.test.ts
@@ -0,0 +1,3 @@
+test("creates user", () => {
+  expect(true).toBe(true);
+});`;

const docsDiff = `diff --git a/README.md b/README.md
index abc123..def456 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,4 @@
 # Project
+
+## Getting Started
+Run \`npm install\` to get started.`;

describe("HeuristicDiffAnalyzer", () => {
  it("extracts file changes from a simple diff", () => {
    const result = analyzer.analyze(simpleDiff);
    expect(result.totalFilesChanged).toBe(1);
    expect(result.files[0].filePath).toBe("src/auth.ts");
    expect(result.files[0].linesAdded).toBe(2);
    expect(result.files[0].linesRemoved).toBe(0);
  });

  it("detects new files", () => {
    const result = analyzer.analyze(multiFileDiff);
    expect(result.totalFilesChanged).toBe(3);
    expect(result.files.find((f) => f.filePath === "src/api/routes.ts")?.isNew).toBe(true);
    expect(result.files.find((f) => f.filePath === "src/models/user.ts")?.isNew).toBe(true);
  });

  it("groups files by directory", () => {
    const result = analyzer.analyze(multiFileDiff);
    expect(result.directoryGroups["src/api"]).toBeDefined();
    expect(result.directoryGroups["src/models"]).toBeDefined();
    expect(result.directoryGroups["tests"]).toBeDefined();
  });

  it("scores src files higher than test files", () => {
    const result = analyzer.analyze(multiFileDiff);
    const srcFile = result.files.find((f) => f.filePath === "src/api/routes.ts");
    const testFile = result.files.find((f) => f.filePath === "tests/user.test.ts");
    if (!srcFile || !testFile) {
      throw new Error("Expected both src and test files in analysis output");
    }
    expect(srcFile.importanceScore).toBeGreaterThan(testFile.importanceScore);
  });

  it("detects feature change type for many new files", () => {
    const result = analyzer.analyze(multiFileDiff);
    expect(result.suggestedChangeType).toBe("feature");
  });

  it("detects docs change type for markdown-only changes", () => {
    const result = analyzer.analyze(docsDiff);
    expect(result.suggestedChangeType).toBe("docs");
  });

  it("returns top files sorted by importance", () => {
    const result = analyzer.analyze(multiFileDiff);
    for (let i = 1; i < result.topFiles.length; i++) {
      expect(result.topFiles[i - 1].importanceScore).toBeGreaterThanOrEqual(
        result.topFiles[i].importanceScore,
      );
    }
  });

  it("handles empty diff", () => {
    const result = analyzer.analyze("");
    expect(result.totalFilesChanged).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("calculates correct totals", () => {
    const result = analyzer.analyze(multiFileDiff);
    expect(result.totalLinesAdded).toBe(18); // 10 + 5 + 3
    expect(result.totalLinesRemoved).toBe(0);
  });

  it("detects dependency change type for package.json-only changes", () => {
    const depDiff = `diff --git a/package.json b/package.json
index abc123..def456 100644
--- a/package.json
+++ b/package.json
@@ -5,3 +5,4 @@
   "dependencies": {
+    "lodash": "^4.17.21",
     "express": "^4.18.0"
   }`;
    const result = analyzer.analyze(depDiff);
    expect(result.suggestedChangeType).toBe("dependency");
  });

  it("detects config change type for config-only changes", () => {
    const configDiff = `diff --git a/tsconfig.json b/tsconfig.json
index abc123..def456 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -1,3 +1,4 @@
 {
+  "strict": true,
   "compilerOptions": {}
 }`;
    const result = analyzer.analyze(configDiff);
    expect(result.suggestedChangeType).toBe("config");
  });

  it("detects bugfix for small targeted changes", () => {
    const bugfixDiff = `diff --git a/src/utils.ts b/src/utils.ts
index abc123..def456 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -5,3 +5,4 @@
 function parse(input: string) {
-  return input.split(",");
+  if (!input) return [];
+  return input.split(",");
 }`;
    const result = analyzer.analyze(bugfixDiff);
    expect(result.suggestedChangeType).toBe("bugfix");
  });

  it("detects refactor for high delete-to-add ratio", () => {
    const refactorDiff = `diff --git a/src/old.ts b/src/old.ts
index abc123..def456 100644
--- a/src/old.ts
+++ b/src/old.ts
@@ -1,20 +1,5 @@
-function oldHelper() { return 1; }
-function anotherOld() { return 2; }
-function yetAnother() { return 3; }
-function oneMore() { return 4; }
-function lastOld() { return 5; }
-function extraOld() { return 6; }
-function more() { return 7; }
-function evenMore() { return 8; }
-function soMany() { return 9; }
-function tooMany() { return 10; }
-function excessive() { return 11; }
+function consolidated() { return [1,2,3]; }
+function helper() { return true; }`;
    const result = analyzer.analyze(refactorDiff);
    expect(result.suggestedChangeType).toBe("refactor");
  });

  it("extracts diff chunks for top files", () => {
    const result = analyzer.analyze(multiFileDiff);
    expect(Object.keys(result.topFileDiffs).length).toBeGreaterThan(0);
    expect(result.topFileDiffs["src/api/routes.ts"]).toContain("diff --git");
  });
});
