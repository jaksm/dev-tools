/**
 * Phase 3 fixture-based tests — runs the FULL pipeline against real codebases.
 * 
 * Pipeline: real code → tree-sitter parse → symbol extraction → serialization
 *           → mock embeddings → HNSW index → search → verify results
 * 
 * Validates that our symbol extraction + serialization + indexing pipeline
 * works correctly on real-world code in multiple languages.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TreeSitterEngine } from "../core/tree-sitter/engine.js";
import { FileParser } from "../core/tree-sitter/parser.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { WorkspaceIndexer } from "../core/index/indexer.js";
import { createGitignoreFilter } from "../core/gitignore.js";
import { EmbeddingIndexer } from "../core/search/indexer.js";
import { HnswIndex } from "../core/search/hnsw-index.js";
import type { EmbeddingProvider } from "../core/search/embeddings.js";
import type { SymbolInfo, Logger } from "../core/types.js";
import { serializeSymbol, symbolId } from "../core/search/serializer.js";
import { codeSearch } from "../tools/code-search.js";

// ── Mock Provider ───────────────────────────────────────────────────────────

const DIM = 32; // Slightly higher dim for better discrimination with real symbols

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock-fixture";
  readonly model = "mock-fixture-v1";
  readonly dimension = DIM;
  readonly ready = true;

  async init(): Promise<void> {}
  async dispose(): Promise<void> {}

  async embed(text: string): Promise<number[]> {
    return this.hash(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.hash(t));
  }

  /**
   * Character trigram hashing — better semantic signal than single-char hash.
   */
  private hash(text: string): number[] {
    const v = new Array(DIM).fill(0);
    const lower = text.toLowerCase();
    for (let i = 0; i < lower.length - 2; i++) {
      const trigram = lower.charCodeAt(i) * 31 * 31 + lower.charCodeAt(i + 1) * 31 + lower.charCodeAt(i + 2);
      v[Math.abs(trigram) % DIM] += 1;
    }
    const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0));
    return norm > 0 ? v.map((x: number) => x / norm) : v;
  }
}

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../fixtures");

// ── Helper ──────────────────────────────────────────────────────────────────

async function fixtureExists(name: string): Promise<boolean> {
  try {
    await fs.access(path.join(FIXTURES_DIR, name));
    return true;
  } catch {
    return false;
  }
}

async function indexFixture(fixtureName: string): Promise<{
  symbolIndex: SymbolIndex;
  embeddingIndexer: EmbeddingIndexer;
  workspaceDir: string;
  tmpDir: string;
  fileCount: number;
  symbolCount: number;
}> {
  const workspaceDir = path.join(FIXTURES_DIR, fixtureName);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `fixture-${fixtureName}-`));

  const engine = new TreeSitterEngine();
  await engine.init();
  const parser = new FileParser(engine);
  const symbolIndex = new SymbolIndex();
  const indexer = new WorkspaceIndexer({ engine, parser, symbolIndex, logger });

  const gitignoreFilter = await createGitignoreFilter(workspaceDir);
  const result = await indexer.indexWorkspace(workspaceDir, gitignoreFilter);

  const provider = new MockEmbeddingProvider();
  const embeddingIndexer = new EmbeddingIndexer({
    embeddingProvider: provider,
    symbolIndex,
    workspaceDir,
    storageDir: tmpDir,
    logger,
  });
  await embeddingIndexer.init();
  await embeddingIndexer.indexAll();

  return {
    symbolIndex,
    embeddingIndexer,
    workspaceDir,
    tmpDir,
    fileCount: result.filesIndexed,
    symbolCount: result.symbolCount,
  };
}

// ── Fixture Tests ───────────────────────────────────────────────────────────

describe("Phase 3 — fixture: Python (httpie)", async () => {
  const exists = await fixtureExists("python-httpie");
  if (!exists) {
    it.skip("fixture not available", () => {});
    return;
  }

  let ctx: Awaited<ReturnType<typeof indexFixture>>;

  beforeAll(async () => {
    ctx = await indexFixture("python-httpie");
  });

  afterAll(async () => {
    await ctx.embeddingIndexer.dispose();
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it("indexes significant number of Python symbols", () => {
    expect(ctx.symbolCount).toBeGreaterThan(50);
    expect(ctx.fileCount).toBeGreaterThan(10);
  });

  it("all symbols have valid serialization", () => {
    for (const sym of ctx.symbolIndex.allSymbols()) {
      const text = serializeSymbol(sym, ctx.workspaceDir);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(sym.kind);
      expect(text).toContain(sym.qualifiedName);

      const id = symbolId(sym);
      expect(id.length).toBeGreaterThan(0);
      expect(id).toContain(sym.qualifiedName);
    }
  });

  it("embedding count matches symbol count", () => {
    const stats = ctx.embeddingIndexer.getStats();
    expect(stats.indexedSymbols).toBe(ctx.symbolCount);
  });

  it("semantic search returns relevant results for 'http request'", async () => {
    const results = await ctx.embeddingIndexer.search("http request send", 10);
    expect(results.length).toBeGreaterThan(0);
    // All results should have valid symbols
    for (const r of results) {
      expect(r.symbol.qualifiedName).toBeDefined();
      expect(r.symbol.filePath).toContain("python-httpie");
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("semantic search returns relevant results for 'parse response'", async () => {
    const results = await ctx.embeddingIndexer.search("parse response output", 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it("scoped search restricts to directory", async () => {
    const results = await ctx.embeddingIndexer.search("request", 20, "tests");
    for (const r of results) {
      expect(r.symbol.filePath).toContain("tests");
    }
  });

  it("persist and reload works with real data", async () => {
    await ctx.embeddingIndexer.persist();

    const provider = new MockEmbeddingProvider();
    const reloaded = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex: ctx.symbolIndex,
      workspaceDir: ctx.workspaceDir,
      storageDir: ctx.tmpDir,
      logger,
    });
    await reloaded.init();

    expect(reloaded.state).toBe("ready");
    const stats = reloaded.getStats();
    expect(stats.indexedSymbols).toBe(ctx.symbolCount);

    // Search still works
    const results = await reloaded.search("http", 3);
    expect(results.length).toBeGreaterThan(0);

    await reloaded.dispose();
  });
});

describe("Phase 3 — fixture: Go (bubbletea)", async () => {
  const exists = await fixtureExists("go-bubbletea");
  if (!exists) {
    it.skip("fixture not available", () => {});
    return;
  }

  let ctx: Awaited<ReturnType<typeof indexFixture>>;

  beforeAll(async () => {
    ctx = await indexFixture("go-bubbletea");
  });

  afterAll(async () => {
    await ctx.embeddingIndexer.dispose();
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it("indexes Go symbols", () => {
    expect(ctx.symbolCount).toBeGreaterThan(20);
    expect(ctx.fileCount).toBeGreaterThan(5);
  });

  it("serialization works for Go symbols", () => {
    let checked = 0;
    for (const sym of ctx.symbolIndex.allSymbols()) {
      const text = serializeSymbol(sym, ctx.workspaceDir);
      expect(text.length).toBeGreaterThan(0);
      const id = symbolId(sym);
      expect(id).toContain(sym.filePath);
      checked++;
      if (checked > 50) break; // Spot check
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("embedding index matches symbol count", () => {
    const stats = ctx.embeddingIndexer.getStats();
    expect(stats.indexedSymbols).toBe(ctx.symbolCount);
  });

  it("semantic search for 'render terminal'", async () => {
    const results = await ctx.embeddingIndexer.search("render terminal output", 5);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("Phase 3 — fixture: Rust (ripgrep)", async () => {
  const exists = await fixtureExists("rust-ripgrep");
  if (!exists) {
    it.skip("fixture not available", () => {});
    return;
  }

  let ctx: Awaited<ReturnType<typeof indexFixture>>;

  beforeAll(async () => {
    ctx = await indexFixture("rust-ripgrep");
  });

  afterAll(async () => {
    await ctx.embeddingIndexer.dispose();
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it("indexes Rust symbols", () => {
    expect(ctx.symbolCount).toBeGreaterThan(30);
  });

  it("all Rust symbols serialize and embed without errors", () => {
    const stats = ctx.embeddingIndexer.getStats();
    expect(stats.indexedSymbols).toBe(ctx.symbolCount);
    expect(stats.state).toBe("ready");
  });

  it("semantic search for 'search file pattern'", async () => {
    const results = await ctx.embeddingIndexer.search("search file pattern matching", 5);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("Phase 3 — fixture: C# (mediatr)", async () => {
  const exists = await fixtureExists("csharp-mediatr");
  if (!exists) {
    it.skip("fixture not available", () => {});
    return;
  }

  let ctx: Awaited<ReturnType<typeof indexFixture>>;

  beforeAll(async () => {
    ctx = await indexFixture("csharp-mediatr");
  });

  afterAll(async () => {
    await ctx.embeddingIndexer.dispose();
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it("indexes C# symbols", () => {
    expect(ctx.symbolCount).toBeGreaterThan(10);
  });

  it("all C# symbols serialize correctly", () => {
    for (const sym of ctx.symbolIndex.allSymbols()) {
      const text = serializeSymbol(sym, ctx.workspaceDir);
      expect(text.length).toBeGreaterThan(5);
    }
  });

  it("embedding count matches", () => {
    const stats = ctx.embeddingIndexer.getStats();
    expect(stats.indexedSymbols).toBe(ctx.symbolCount);
  });
});

describe("Phase 3 — fixture: Java (gson)", async () => {
  const exists = await fixtureExists("java-gson");
  if (!exists) {
    it.skip("fixture not available", () => {});
    return;
  }

  let ctx: Awaited<ReturnType<typeof indexFixture>>;

  beforeAll(async () => {
    ctx = await indexFixture("java-gson");
  });

  afterAll(async () => {
    await ctx.embeddingIndexer.dispose();
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it("indexes Java symbols", () => {
    expect(ctx.symbolCount).toBeGreaterThan(50);
  });

  it("embedding count matches symbol count", () => {
    const stats = ctx.embeddingIndexer.getStats();
    expect(stats.indexedSymbols).toBe(ctx.symbolCount);
  });

  it("semantic search for 'json serialize'", async () => {
    const results = await ctx.embeddingIndexer.search("json serialize deserialize", 10);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("Phase 3 — fixture: Kotlin (okio)", async () => {
  const exists = await fixtureExists("kotlin-okio");
  if (!exists) {
    it.skip("fixture not available", () => {});
    return;
  }

  let ctx: Awaited<ReturnType<typeof indexFixture>>;

  beforeAll(async () => {
    ctx = await indexFixture("kotlin-okio");
  });

  afterAll(async () => {
    await ctx.embeddingIndexer.dispose();
    await fs.rm(ctx.tmpDir, { recursive: true, force: true });
  });

  it("indexes Kotlin symbols", () => {
    expect(ctx.symbolCount).toBeGreaterThan(20);
  });

  it("embedding count matches symbol count", () => {
    const stats = ctx.embeddingIndexer.getStats();
    expect(stats.indexedSymbols).toBe(ctx.symbolCount);
  });
});

// ── Cross-fixture: dogfooding (our own codebase) ────────────────────────────

describe("Phase 3 — dogfooding: dev-tools codebase", async () => {
  const devToolsDir = path.resolve(import.meta.dirname!, "../..");
  let ctx: Awaited<ReturnType<typeof indexFixture>> | null = null;

  beforeAll(async () => {
    // Index our own codebase
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fixture-self-"));
    const engine = new TreeSitterEngine();
    await engine.init();
    const parser = new FileParser(engine);
    const symbolIndex = new SymbolIndex();
    const indexer = new WorkspaceIndexer({ engine, parser, symbolIndex, logger });

    const gitignoreFilter = await createGitignoreFilter(devToolsDir);
    const result = await indexer.indexWorkspace(devToolsDir, gitignoreFilter);

    const provider = new MockEmbeddingProvider();
    const embeddingIndexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: devToolsDir,
      storageDir: tmpDir,
      logger,
    });
    await embeddingIndexer.init();
    await embeddingIndexer.indexAll();

    ctx = {
      symbolIndex,
      embeddingIndexer,
      workspaceDir: devToolsDir,
      tmpDir,
      fileCount: result.filesIndexed,
      symbolCount: result.symbolCount,
    };
  });

  afterAll(async () => {
    if (ctx) {
      await ctx.embeddingIndexer.dispose();
      await fs.rm(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  it("indexes our own codebase (100+ symbols)", () => {
    expect(ctx!.symbolCount).toBeGreaterThan(100);
    expect(ctx!.fileCount).toBeGreaterThan(15);
  });

  it("all symbols embed successfully", () => {
    const stats = ctx!.embeddingIndexer.getStats();
    expect(stats.indexedSymbols).toBe(ctx!.symbolCount);
    expect(stats.state).toBe("ready");
  });

  it("finds HnswIndex when searching for 'vector search'", async () => {
    const results = await ctx!.embeddingIndexer.search("vector search nearest neighbor", 5);
    expect(results.length).toBeGreaterThan(0);
    const names = results.map(r => r.symbol.qualifiedName);
    // HnswIndex.search or HnswIndex should be in results
    expect(names.some(n => n.toLowerCase().includes("hnsw") || n.toLowerCase().includes("search"))).toBe(true);
  });

  it("finds EmbeddingIndexer when searching for 'embedding index'", async () => {
    const results = await ctx!.embeddingIndexer.search("embedding indexer symbols", 5);
    expect(results.length).toBeGreaterThan(0);
    const names = results.map(r => r.symbol.qualifiedName);
    expect(names.some(n => n.toLowerCase().includes("embedding") || n.toLowerCase().includes("index"))).toBe(true);
  });

  it("finds file operations when searching for 'read file contents'", async () => {
    const results = await ctx!.embeddingIndexer.search("read file contents path", 5);
    expect(results.length).toBeGreaterThan(0);
    const names = results.map(r => r.symbol.qualifiedName);
    expect(names.some(n => n.toLowerCase().includes("file") || n.toLowerCase().includes("read"))).toBe(true);
  });

  it("scope filter works on own codebase", async () => {
    const results = await ctx!.embeddingIndexer.search("parse extract", 10, "tree-sitter");
    for (const r of results) {
      expect(r.symbol.filePath).toContain("tree-sitter");
    }
  });

  it("incremental update: add symbol, re-embed, find it", async () => {
    // Add a fake symbol to a real file
    const testFile = path.join(ctx!.workspaceDir, "src/core/search/hnsw-index.ts");
    const fakeSym: SymbolInfo = {
      qualifiedName: "HnswIndex.testOnlyFakeMethod",
      kind: "method",
      filePath: testFile,
      lines: [999, 999],
      signature: "testOnlyFakeMethod(): void",
      docs: "A fake method for testing incremental updates",
    };
    ctx!.symbolIndex.insert(fakeSym);
    await ctx!.embeddingIndexer.updateFile(testFile);

    // Should be findable via search
    const results = await ctx!.embeddingIndexer.search("testOnlyFakeMethod", 3);
    expect(results.some(r => r.symbol.qualifiedName === "HnswIndex.testOnlyFakeMethod")).toBe(true);

    // Cleanup: remove fake symbol
    ctx!.symbolIndex.removeByFile(testFile);
  });
});
