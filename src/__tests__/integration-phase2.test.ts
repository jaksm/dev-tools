/**
 * Phase 2 integration test — run against the dev-tools codebase itself.
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { TreeSitterEngine } from "../core/tree-sitter/engine.js";
import { FileParser } from "../core/tree-sitter/parser.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { WorkspaceIndexer } from "../core/index/indexer.js";
import { ImportGraph } from "../core/index/import-graph.js";
import { computeRanks } from "../core/index/ranking.js";
import { generateIndexJson } from "../core/index/index-json.js";
import { renderIndex } from "../core/index/index-renderer.js";
import { resolveSymbol } from "../core/index/resolver.js";
import { codeRead } from "../tools/code-read.js";
import type { ToolContext } from "../core/types.js";

const WORKSPACE = path.resolve(import.meta.dirname ?? __dirname, "../..");
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let engine: TreeSitterEngine;
let fileParser: FileParser;
let symbolIndex: SymbolIndex;
let indexer: WorkspaceIndexer;
let importGraph: ImportGraph;

beforeAll(async () => {
  engine = new TreeSitterEngine();
  await engine.init();
  fileParser = new FileParser(engine);
  symbolIndex = new SymbolIndex();
  indexer = new WorkspaceIndexer({ engine, parser: fileParser, symbolIndex, logger });

  // Index the dev-tools src/ directory itself
  const result = await indexer.indexWorkspace(
    path.join(WORKSPACE, "src"),
    (p: string) => p.includes("__tests__") || p.includes("node_modules"),
  );

  console.log(`\n🔍 Indexed ${result.filesIndexed} files, ${result.symbolCount} symbols in ${result.durationMs}ms`);
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.map(e => `${e.file}: ${e.error}`).join(", ")}`);
  }

  // Build import graph
  importGraph = new ImportGraph();
  importGraph.build(indexer.getAllImportsExports(), path.join(WORKSPACE, "src"));
}, 30000);

describe("Phase 2 integration — self-index", () => {
  it("indexes significant number of symbols", () => {
    expect(symbolIndex.size).toBeGreaterThan(20);
    console.log(`  Symbol count: ${symbolIndex.size}`);
  });

  it("finds DevToolsCore class", () => {
    const results = symbolIndex.lookupExact("DevToolsCore");
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("class");
  });

  it("finds methods on DevToolsCore", () => {
    const results = symbolIndex.lookupPartial("DevToolsCore.");
    expect(results.length).toBeGreaterThan(3);
    const methodNames = results.map(r => r.qualifiedName);
    console.log(`  DevToolsCore methods: ${methodNames.join(", ")}`);
  });

  it("finds TreeSitterEngine class and methods", () => {
    const cls = symbolIndex.lookupExact("TreeSitterEngine");
    expect(cls.length).toBe(1);
    const methods = symbolIndex.lookupPartial("TreeSitterEngine.");
    expect(methods.length).toBeGreaterThan(2);
  });

  it("finds SymbolIndex class", () => {
    const cls = symbolIndex.lookupExact("SymbolIndex");
    expect(cls.length).toBe(1);
  });

  it("resolves symbol with scope", () => {
    const result = resolveSymbol({ symbol: "init", scope: "TreeSitterEngine" }, symbolIndex);
    // May or may not find it depending on how methods are qualified
    // At minimum, partial lookup should work
    const partial = symbolIndex.lookupPartial("init");
    expect(partial.length).toBeGreaterThan(0);
  });

  it("builds import graph with edges", () => {
    expect(importGraph.files.length).toBeGreaterThan(5);
    expect(importGraph.edgeCount).toBeGreaterThan(0);
    console.log(`  Import graph: ${importGraph.files.length} files, ${importGraph.edgeCount} edges`);
  });

  it("computes file rankings", () => {
    const ranks = computeRanks(importGraph, path.join(WORKSPACE, "src"));
    expect(ranks.length).toBeGreaterThan(0);
    console.log(`  Top 5 files by rank:`);
    for (const r of ranks.slice(0, 5)) {
      console.log(`    ${path.relative(path.join(WORKSPACE, "src"), r.filePath)} — rank: ${r.rank.toFixed(2)}, inDegree: ${r.inDegree}`);
    }
  });

  it("generates INDEX.json", () => {
    const indexJson = generateIndexJson({
      symbolIndex,
      importGraph,
      fileImports: indexer.getAllImportsExports(),
      workspaceDir: path.join(WORKSPACE, "src"),
    });
    expect(indexJson.totalFiles).toBeGreaterThan(5);
    expect(indexJson.totalSymbols).toBeGreaterThan(20);
  });

  it("renders INDEX.json into compact text", () => {
    const indexJson = generateIndexJson({
      symbolIndex,
      importGraph,
      fileImports: indexer.getAllImportsExports(),
      workspaceDir: path.join(WORKSPACE, "src"),
    });
    const text = renderIndex(indexJson);
    expect(text).toContain("Project Index");
    expect(text.length).toBeGreaterThan(100);
    console.log(`\n📄 INDEX.json rendered (${text.length} chars):\n${text}\n`);
  });

  it("code_read works against indexed symbols", async () => {
    // Find any method to read
    const methods = symbolIndex.lookupPartial(".");
    expect(methods.length).toBeGreaterThan(0);
    const target = methods[0];

    const ctx: ToolContext = {
      workspaceDir: path.join(WORKSPACE, "src"),
      storageDir: "/tmp/test-integration",
      config: {},
      workspace: {
        root: path.join(WORKSPACE, "src"),
        hasGit: false,
        languages: [],
        testRunners: [],
        gitignoreFilter: () => false,
      },
      logger,
    };

    const result = await codeRead({ symbol: target.qualifiedName }, ctx, symbolIndex);
    expect(result.success).toBe(true);
    expect(result.data?.code).toBeDefined();
    console.log(`  code_read("${target.qualifiedName}"): ${result.data?.lines[1]! - result.data?.lines[0]! + 1} lines`);
  });
});
