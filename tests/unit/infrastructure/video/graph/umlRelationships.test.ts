import { describe, expect, it } from "vitest";
import {
  deriveUmlEdges,
  resolveRelativeImport,
} from "@/infrastructure/video/graph/umlRelationships";
import { makeGraphNode as makeNode, makeCodeScript as makeScript } from "./fixtures";

// ── resolveRelativeImport ────────────────────────────────────────────────

describe("resolveRelativeImport", () => {
  const fileMap = new Map<number, string>([
    [1, "src/lib/Auth.ts"],
    [2, "src/lib/Crypto.ts"],
    [3, "src/api/route.ts"],
    [4, "src/auth/index.ts"],
  ]);

  it("returns undefined for bare/npm specifiers", () => {
    expect(resolveRelativeImport("src/lib/Auth.ts", "react", fileMap)).toBeUndefined();
    expect(resolveRelativeImport("src/lib/Auth.ts", "@acme/pkg", fileMap)).toBeUndefined();
  });

  it("resolves sibling file via './Crypto'", () => {
    expect(resolveRelativeImport("src/lib/Auth.ts", "./Crypto", fileMap)).toBe(2);
  });

  it("resolves sibling file with explicit .ts extension", () => {
    expect(resolveRelativeImport("src/lib/Auth.ts", "./Crypto.ts", fileMap)).toBe(2);
  });

  it("resolves parent-directory imports via '../'", () => {
    expect(resolveRelativeImport("src/api/route.ts", "../lib/Auth", fileMap)).toBe(1);
  });

  it("resolves index.ts via directory-style imports", () => {
    expect(resolveRelativeImport("src/api/route.ts", "../auth", fileMap)).toBe(4);
  });

  it("returns undefined when no known node matches", () => {
    expect(resolveRelativeImport("src/lib/Auth.ts", "./UnknownThing", fileMap)).toBeUndefined();
  });
});

// ── deriveUmlEdges ────────────────────────────────────────────────────────

describe("deriveUmlEdges", () => {
  it("returns no edges when there are fewer than 2 nodes", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/a.ts", code: "class A {}" },
    ]);
    expect(deriveUmlEdges([makeNode(1, "src/a.ts")], script)).toEqual([]);
  });

  it("detects inheritance (class X extends Y)", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/Base.ts", code: "export class Base {}" },
      { sceneNumber: 2, filePath: "src/Derived.ts", code: "class Derived extends Base {}" },
    ]);
    const nodes = [makeNode(1, "src/Base.ts"), makeNode(2, "src/Derived.ts")];
    const edges = deriveUmlEdges(nodes, script);
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("inheritance");
    const [a, b] = [edges[0].sourceSceneNumber, edges[0].targetSceneNumber].sort();
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("detects realization with multiple implements", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/IAuth.ts", code: "export interface IAuth {}" },
      { sceneNumber: 2, filePath: "src/ICrypto.ts", code: "export interface ICrypto {}" },
      {
        sceneNumber: 3,
        filePath: "src/Service.ts",
        code: "class Service implements IAuth, ICrypto { }",
      },
    ]);
    const nodes = [
      makeNode(1, "src/IAuth.ts"),
      makeNode(2, "src/ICrypto.ts"),
      makeNode(3, "src/Service.ts"),
    ];
    const edges = deriveUmlEdges(nodes, script);
    const realizations = edges.filter((e) => e.relationship === "realization");
    expect(realizations).toHaveLength(2);
  });

  it("detects composition (class field typed as known class)", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/Repo.ts", code: "export class Repo {}" },
      {
        sceneNumber: 2,
        filePath: "src/Service.ts",
        code: "class Service { private readonly repo: Repo }",
      },
    ]);
    const edges = deriveUmlEdges(
      [makeNode(1, "src/Repo.ts"), makeNode(2, "src/Service.ts")],
      script,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("composition");
  });

  it("detects dependency via relative import", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/lib/Auth.ts", code: "export const verify = () => true;" },
      {
        sceneNumber: 2,
        filePath: "src/api/route.ts",
        code: "import { verify } from '../lib/Auth'; verify();",
      },
    ]);
    const edges = deriveUmlEdges(
      [makeNode(1, "src/lib/Auth.ts"), makeNode(2, "src/api/route.ts")],
      script,
    );
    // Dependency wins over association (precedence)
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("dependency");
  });

  it("falls back to association for plain identifier usage", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/helper.ts", code: "export function helper() {}" },
      { sceneNumber: 2, filePath: "src/main.ts", code: "function main() { helper(); }" },
    ]);
    const edges = deriveUmlEdges(
      [makeNode(1, "src/helper.ts"), makeNode(2, "src/main.ts")],
      script,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("association");
  });

  it("enforces precedence: inheritance beats composition for the same pair", () => {
    // Scene 2 both extends Base AND has a Base field — we should pick inheritance
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/Base.ts", code: "export class Base {}" },
      {
        sceneNumber: 2,
        filePath: "src/Derived.ts",
        code: "class Derived extends Base { private readonly parent: Base }",
      },
    ]);
    const edges = deriveUmlEdges(
      [makeNode(1, "src/Base.ts"), makeNode(2, "src/Derived.ts")],
      script,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("inheritance");
  });

  it("enforces precedence: dependency beats association for the same pair", () => {
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/lib/helper.ts", code: "export const helper = () => 1;" },
      {
        sceneNumber: 2,
        filePath: "src/app/main.ts",
        code: "import { helper } from '../lib/helper'; helper();",
      },
    ]);
    const edges = deriveUmlEdges(
      [makeNode(1, "src/lib/helper.ts"), makeNode(2, "src/app/main.ts")],
      script,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("dependency");
  });

  it("ignores self-references within the same scene", () => {
    // Both Base and Derived live in scene 1 — the extends reference resolves
    // to a symbol defined in the SAME scene, so `upsert` drops it.
    const script = makeScript([
      {
        sceneNumber: 1,
        filePath: "src/Base.ts",
        code: "class Base {} class Derived extends Base {}",
      },
      { sceneNumber: 2, filePath: "src/unrelated.ts", code: "export const x = 1;" },
    ]);
    const edges = deriveUmlEdges(
      [makeNode(1, "src/Base.ts"), makeNode(2, "src/unrelated.ts")],
      script,
    );
    expect(edges).toEqual([]);
  });

  it("leaves orphan nodes without edges", () => {
    // Scene 3 is a standalone config file that references nothing and
    // nothing references it — still counts as a node in the graph.
    const script = makeScript([
      { sceneNumber: 1, filePath: "src/Auth.ts", code: "export class Auth {}" },
      {
        sceneNumber: 2,
        filePath: "src/main.ts",
        code: "import { Auth } from './Auth'; new Auth();",
      },
      {
        sceneNumber: 3,
        filePath: "config/tsconfig.json",
        code: "{ \"compilerOptions\": { \"strict\": true } }",
      },
    ]);
    const nodes = [
      makeNode(1, "src/Auth.ts"),
      makeNode(2, "src/main.ts"),
      makeNode(3, "config/tsconfig.json"),
    ];
    const edges = deriveUmlEdges(nodes, script);
    // Scene 1 ↔ 2 edge exists, but scene 3 has no incident edges.
    expect(edges.every((e) => e.sourceSceneNumber !== 3 && e.targetSceneNumber !== 3)).toBe(true);
    // Scene 3 is an orphan — verified by the graph consumer, not this module.
  });
});
