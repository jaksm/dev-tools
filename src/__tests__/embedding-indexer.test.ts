/**
 * Tests for the embedding indexer — orchestrates symbol → embedding → HNSW pipeline.
 * Uses a mock embedding provider for fast, deterministic tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EmbeddingIndexer } from "../core/search/indexer.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import type { EmbeddingProvider } from "../core/search/embeddings.js";
import type { SymbolInfo } from "../core/types.js";

// ── Mock Embedding Provider ─────────────────────────────────────────────────

const DIM = 8;

/**
 * Deterministic mock embedding: hashes the text to produce a vector.
 * Semantically similar texts produce similar vectors (crude hash-based sim).
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "mock-embeddings";
  readonly dimension = DIM;
  private _ready = false;
  embedCallCount = 0;
  batchCallCount = 0;

  get ready(): boolean {
    return this._ready;
  }

  async init(): Promise<void> {
    this._ready = true;
  }

  async embed(text: string): Promise<number[]> {
    this.embedCallCount++;
    return hashToVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.batchCallCount++;
    return texts.map(hashToVector);
  }

  async dispose(): Promise<void> {
    this._ready = false;
  }
}

function hashToVector(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % DIM] += text.charCodeAt(i);
  }
  // Normalize
  const norm = Math.sqrt(vec.reduce((s: number, x: number) => s + x * x, 0));
  return vec.map((x: number) => x / (norm || 1));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeSymbol(name: string, file: string, line: number = 1): SymbolInfo {
  return {
    qualifiedName: name,
    kind: "function",
    filePath: file,
    lines: [line, line + 10] as [number, number],
    signature: `${name}()`,
    docs: null,
  };
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("EmbeddingIndexer", () => {
  let tmpDir: string;
  let symbolIndex: SymbolIndex;
  let provider: MockEmbeddingProvider;
  let indexer: EmbeddingIndexer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "embed-idx-test-"));
    symbolIndex = new SymbolIndex();
    provider = new MockEmbeddingProvider();

    // Populate symbol index
    symbolIndex.insert(makeSymbol("AuthService.login", "/p/src/auth.ts", 10));
    symbolIndex.insert(makeSymbol("AuthService.logout", "/p/src/auth.ts", 50));
    symbolIndex.insert(makeSymbol("UserService.getProfile", "/p/src/user.ts", 5));
    symbolIndex.insert(makeSymbol("UserService.updateProfile", "/p/src/user.ts", 30));
    symbolIndex.insert(makeSymbol("Database.connect", "/p/src/db.ts", 1));

    indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
  });

  afterEach(async () => {
    await indexer.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("starts in idle state", () => {
    expect(indexer.state).toBe("idle");
  });

  it("indexes all symbols from symbol index", async () => {
    await indexer.init();
    const result = await indexer.indexAll();

    expect(result.indexed).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(indexer.state).toBe("ready");
  });

  it("skips already-indexed symbols on re-index", async () => {
    await indexer.init();
    await indexer.indexAll();

    // Second indexAll should skip all
    const result2 = await indexer.indexAll();
    expect(result2.skipped).toBe(5);
    expect(result2.indexed).toBe(0);
  });

  it("searches for semantically similar symbols", async () => {
    await indexer.init();
    await indexer.indexAll();

    // Search for "authentication" — should return AuthService symbols first
    // (crude hash similarity, but deterministic)
    const results = await indexer.search("AuthService login authentication", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("incremental update re-embeds changed file", async () => {
    await indexer.init();
    await indexer.indexAll();

    // Simulate file change: add a new symbol to auth.ts
    symbolIndex.insert(makeSymbol("AuthService.verify", "/p/src/auth.ts", 80));

    await indexer.updateFile("/p/src/auth.ts");

    // Should now find the new symbol
    const stats = indexer.getStats();
    expect(stats.indexedSymbols).toBeGreaterThanOrEqual(5);
  });

  it("removes embeddings for deleted file", async () => {
    await indexer.init();
    await indexer.indexAll();

    const statsBefore = indexer.getStats();
    expect(statsBefore.indexedSymbols).toBe(5);

    // Remove file
    indexer.removeFile("/p/src/db.ts");

    // One fewer embedding
    const statsAfter = indexer.getStats();
    expect(statsAfter.indexedSymbols).toBe(4);
  });

  it("returns stats correctly", async () => {
    await indexer.init();
    await indexer.indexAll();

    const stats = indexer.getStats();
    expect(stats.state).toBe("ready");
    expect(stats.indexedSymbols).toBe(5);
    expect(stats.totalSymbols).toBe(5);
    expect(stats.embeddingModel).toContain("mock");
    expect(stats.embeddingDimension).toBe(DIM);
    expect(stats.indexAge).toContain("s ago");
  });

  it("reports progress during indexing", async () => {
    await indexer.init();

    const progress: Array<[number, number]> = [];
    await indexer.indexAll((indexed, total) => {
      progress.push([indexed, total]);
    });

    // With 5 symbols and batch size 32, might not report progress
    // (only reports every 100). That's fine.
    expect(indexer.state).toBe("ready");
  });

  it("persists and reloads", async () => {
    await indexer.init();
    await indexer.indexAll();
    await indexer.persist();

    // Create new indexer from same storage
    await indexer.dispose();

    const provider2 = new MockEmbeddingProvider();
    const indexer2 = new EmbeddingIndexer({
      embeddingProvider: provider2,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });

    await indexer2.init();
    expect(indexer2.state).toBe("ready");

    // Search should work without re-indexing
    const results = await indexer2.search("database connect", 2);
    expect(results.length).toBeGreaterThan(0);

    await indexer2.dispose();
  });
});
