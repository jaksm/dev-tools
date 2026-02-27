/**
 * Advanced embedding indexer tests — error handling, edge cases, concurrency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EmbeddingIndexer } from "../core/search/indexer.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import type { EmbeddingProvider } from "../core/search/embeddings.js";
import type { SymbolInfo, Logger } from "../core/types.js";

const DIM = 8;

// ── Mock Providers ──────────────────────────────────────────────────────────

function hashToVector(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  for (let i = 0; i < text.length; i++) vec[i % DIM] += text.charCodeAt(i);
  const norm = Math.sqrt(vec.reduce((s: number, x: number) => s + x * x, 0));
  return vec.map((x: number) => x / (norm || 1));
}

class GoodProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "mock-embed";
  readonly dimension = DIM;
  readonly ready = true;
  callCount = 0;

  async init(): Promise<void> {}
  async dispose(): Promise<void> {}
  async embed(text: string): Promise<number[]> { this.callCount++; return hashToVector(text); }
  async embedBatch(texts: string[]): Promise<number[][]> { this.callCount++; return texts.map(hashToVector); }
}

class FailingProvider implements EmbeddingProvider {
  readonly name = "failing";
  readonly model = "failing-embed";
  readonly dimension = DIM;
  readonly ready = true;
  callsBeforeFail: number;
  callCount = 0;

  constructor(callsBeforeFail: number = 0) {
    this.callsBeforeFail = callsBeforeFail;
  }

  async init(): Promise<void> {}
  async dispose(): Promise<void> {}
  async embed(text: string): Promise<number[]> {
    this.callCount++;
    if (this.callCount > this.callsBeforeFail) throw new Error("Embedding API error: rate limited");
    return hashToVector(text);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    this.callCount++;
    if (this.callCount > this.callsBeforeFail) throw new Error("Embedding API error: rate limited");
    return texts.map(hashToVector);
  }
}

class SlowProvider implements EmbeddingProvider {
  readonly name = "slow";
  readonly model = "slow-embed";
  readonly dimension = DIM;
  readonly ready = true;
  delayMs: number;

  constructor(delayMs: number = 50) {
    this.delayMs = delayMs;
  }

  async init(): Promise<void> {}
  async dispose(): Promise<void> {}
  async embed(text: string): Promise<number[]> {
    await new Promise(r => setTimeout(r, this.delayMs));
    return hashToVector(text);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    await new Promise(r => setTimeout(r, this.delayMs));
    return texts.map(hashToVector);
  }
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

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeSymbolIndex(symbols: SymbolInfo[]): SymbolIndex {
  const idx = new SymbolIndex();
  for (const s of symbols) idx.insert(s);
  return idx;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("EmbeddingIndexer — advanced", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "embed-adv-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Error resilience ────────────────────────────────────────────────────

  it("continues indexing when a batch fails (partial failure)", async () => {
    const symbols = Array.from({ length: 100 }, (_, i) =>
      makeSymbol(`sym${i}`, `/p/f${i % 10}.ts`, i * 10),
    );
    const symbolIndex = makeSymbolIndex(symbols);

    // Fail after 2 batch calls (batch size is 32, so first 2 batches succeed = 64 symbols)
    const provider = new FailingProvider(2);
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    await indexer.init();
    const result = await indexer.indexAll();

    // Some should have been indexed before failure
    expect(result.indexed).toBeGreaterThan(0);
    expect(result.indexed).toBeLessThan(100);
    expect(indexer.state).toBe("ready");

    await indexer.dispose();
  });

  it("updateFile handles embedding failure gracefully", async () => {
    const symbolIndex = makeSymbolIndex([
      makeSymbol("a", "/p/a.ts", 1),
      makeSymbol("b", "/p/a.ts", 20),
    ]);

    const provider = new GoodProvider();
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    await indexer.init();
    await indexer.indexAll();
    expect(indexer.getStats().indexedSymbols).toBe(2);

    // Now make the provider fail
    const origBatch = provider.embedBatch.bind(provider);
    provider.embedBatch = async () => { throw new Error("API down"); };

    // updateFile should not throw
    await expect(indexer.updateFile("/p/a.ts")).resolves.not.toThrow();

    // Restore
    provider.embedBatch = origBatch;
    await indexer.dispose();
  });

  // ── Empty/edge cases ──────────────────────────────────────────────────

  it("indexAll with empty symbol index", async () => {
    const symbolIndex = new SymbolIndex();
    const provider = new GoodProvider();
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    await indexer.init();
    const result = await indexer.indexAll();

    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(indexer.state).toBe("ready");

    await indexer.dispose();
  });

  it("search on empty index returns empty array", async () => {
    const symbolIndex = new SymbolIndex();
    const provider = new GoodProvider();
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    await indexer.init();
    await indexer.indexAll();

    const results = await indexer.search("anything", 10);
    expect(results).toEqual([]);

    await indexer.dispose();
  });

  it("search before init returns empty", async () => {
    const symbolIndex = makeSymbolIndex([makeSymbol("a", "/p/a.ts")]);
    const provider = new GoodProvider();
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    // Don't init
    const results = await indexer.search("anything", 10);
    expect(results).toEqual([]);

    await indexer.dispose();
  });

  it("search before indexAll returns empty (ready state check)", async () => {
    const symbolIndex = makeSymbolIndex([makeSymbol("a", "/p/a.ts")]);
    const provider = new GoodProvider();
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    await indexer.init();
    // Init but don't indexAll — state is "idle" (no persisted index)
    const results = await indexer.search("anything", 10);
    expect(results).toEqual([]);

    await indexer.dispose();
  });

  it("updateFile with non-existent file is a no-op", async () => {
    const symbolIndex = makeSymbolIndex([makeSymbol("a", "/p/a.ts")]);
    const provider = new GoodProvider();
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    await indexer.init();
    await indexer.indexAll();

    // Update a file that doesn't exist in symbol index
    await indexer.updateFile("/p/nonexistent.ts");
    expect(indexer.getStats().indexedSymbols).toBe(1); // Original still there

    await indexer.dispose();
  });

  it("removeFile that doesn't exist is a no-op", async () => {
    const symbolIndex = makeSymbolIndex([makeSymbol("a", "/p/a.ts")]);
    const provider = new GoodProvider();
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    await indexer.init();
    await indexer.indexAll();

    indexer.removeFile("/p/nonexistent.ts");
    expect(indexer.getStats().indexedSymbols).toBe(1);

    await indexer.dispose();
  });

  // ── Dispose safety ────────────────────────────────────────────────────

  it("double dispose doesn't crash", async () => {
    const symbolIndex = makeSymbolIndex([makeSymbol("a", "/p/a.ts")]);
    const provider = new GoodProvider();
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    await indexer.init();
    await indexer.indexAll();

    await indexer.dispose();
    await expect(indexer.dispose()).resolves.not.toThrow();
  });

  // ── Stats accuracy ────────────────────────────────────────────────────

  it("stats reflect all operations accurately", async () => {
    const symbolIndex = makeSymbolIndex([
      makeSymbol("a", "/p/x.ts", 1),
      makeSymbol("b", "/p/x.ts", 20),
      makeSymbol("c", "/p/y.ts", 1),
    ]);
    const provider = new GoodProvider();
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    await indexer.init();
    await indexer.indexAll();

    let stats = indexer.getStats();
    expect(stats.indexedSymbols).toBe(3);
    expect(stats.totalSymbols).toBe(3);

    // Remove a file
    indexer.removeFile("/p/y.ts");
    stats = indexer.getStats();
    expect(stats.indexedSymbols).toBe(2);
    expect(stats.totalSymbols).toBe(3); // Symbol index still has it

    // Add new symbol and update
    symbolIndex.insert(makeSymbol("d", "/p/z.ts", 1));
    await indexer.updateFile("/p/z.ts");
    stats = indexer.getStats();
    expect(stats.indexedSymbols).toBe(3);
    expect(stats.totalSymbols).toBe(4);

    await indexer.dispose();
  });

  // ── Large dataset ─────────────────────────────────────────────────────

  it("handles 1000 symbols efficiently", async () => {
    const symbols = Array.from({ length: 1000 }, (_, i) =>
      makeSymbol(`Symbol${i}`, `/p/file${i % 100}.ts`, (i % 50) * 20),
    );
    const symbolIndex = makeSymbolIndex(symbols);
    const provider = new GoodProvider();
    const indexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: "/p",
      storageDir: tmpDir,
      logger,
    });
    await indexer.init();

    const start = Date.now();
    const result = await indexer.indexAll();
    const elapsed = Date.now() - start;

    expect(result.indexed).toBe(1000);
    expect(elapsed).toBeLessThan(5000); // Should be fast with mock provider

    // Search works
    const searchResults = await indexer.search("Symbol42", 5);
    expect(searchResults.length).toBeGreaterThan(0);

    // Persist works
    await indexer.persist();
    const files = await fs.readdir(tmpDir);
    expect(files).toContain("vectors.hnsw");
    expect(files).toContain("symbols.json");

    await indexer.dispose();
  });
});
