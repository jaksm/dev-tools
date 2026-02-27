/**
 * Tests for HNSW index wrapper.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HnswIndex } from "../core/search/hnsw-index.js";
import type { SymbolInfo } from "../core/types.js";

const DIM = 4; // Small dimension for tests

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

function makeVector(values: number[]): number[] {
  // Pad/truncate to DIM
  const v = values.slice(0, DIM);
  while (v.length < DIM) v.push(0);
  // Normalize
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / (norm || 1));
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("HnswIndex", () => {
  let tmpDir: string;
  let index: HnswIndex;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hnsw-test-"));
    index = new HnswIndex({
      dimension: DIM,
      storageDir: tmpDir,
      logger,
    });
    await index.init();
  });

  afterEach(async () => {
    index.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("initializes empty index", () => {
    expect(index.stats.count).toBe(0);
    expect(index.stats.dimension).toBe(DIM);
  });

  it("inserts and searches vectors", () => {
    const sym1 = makeSymbol("auth", "/p/auth.ts");
    const sym2 = makeSymbol("user", "/p/user.ts");

    index.insert("id1", makeVector([1, 0, 0, 0]), sym1);
    index.insert("id2", makeVector([0, 1, 0, 0]), sym2);

    expect(index.stats.count).toBe(2);

    // Search near sym1
    const results = index.search(makeVector([0.9, 0.1, 0, 0]), 2);
    expect(results.length).toBe(2);
    expect(results[0].symbol.qualifiedName).toBe("auth");
    expect(results[0].score).toBeGreaterThan(0.5);
  });

  it("removes vectors by ID", () => {
    const sym = makeSymbol("foo", "/p/foo.ts");
    index.insert("id1", makeVector([1, 0, 0, 0]), sym);
    expect(index.has("id1")).toBe(true);

    const removed = index.remove("id1");
    expect(removed).toBe(true);
    expect(index.has("id1")).toBe(false);
  });

  it("removes vectors by file", () => {
    index.insert("id1", makeVector([1, 0, 0, 0]), makeSymbol("a", "/p/file.ts", 1));
    index.insert("id2", makeVector([0, 1, 0, 0]), makeSymbol("b", "/p/file.ts", 20));
    index.insert("id3", makeVector([0, 0, 1, 0]), makeSymbol("c", "/p/other.ts"));

    const removed = index.removeByFile("/p/file.ts");
    expect(removed).toBe(2);
    expect(index.stats.count).toBe(1);
    expect(index.has("id3")).toBe(true);
  });

  it("persists and reloads from disk", async () => {
    index.insert("id1", makeVector([1, 0, 0, 0]), makeSymbol("alpha", "/p/a.ts"));
    index.insert("id2", makeVector([0, 1, 0, 0]), makeSymbol("beta", "/p/b.ts"));

    await index.persist();

    // Verify files exist
    const files = await fs.readdir(tmpDir);
    expect(files).toContain("vectors.hnsw");
    expect(files).toContain("symbols.json");

    // Create new index from same storage
    index.dispose();
    const index2 = new HnswIndex({
      dimension: DIM,
      storageDir: tmpDir,
      logger,
    });
    const { loaded, count } = await index2.init();

    expect(loaded).toBe(true);
    expect(count).toBe(2);
    expect(index2.has("id1")).toBe(true);
    expect(index2.has("id2")).toBe(true);

    // Search works after reload
    const results = index2.search(makeVector([1, 0, 0, 0]), 1);
    expect(results.length).toBe(1);
    expect(results[0].symbol.qualifiedName).toBe("alpha");

    index2.dispose();
  });

  it("updates existing vectors (replace)", () => {
    const sym = makeSymbol("foo", "/p/foo.ts");
    index.insert("id1", makeVector([1, 0, 0, 0]), sym);

    // Update with new vector
    const symUpdated = makeSymbol("foo_updated", "/p/foo.ts");
    index.insert("id1", makeVector([0, 1, 0, 0]), symUpdated);

    expect(index.stats.count).toBe(1);

    const results = index.search(makeVector([0, 1, 0, 0]), 1);
    expect(results[0].symbol.qualifiedName).toBe("foo_updated");
  });

  it("scope filter restricts results", () => {
    index.insert("id1", makeVector([1, 0, 0, 0]), makeSymbol("a", "/p/src/auth/login.ts"));
    index.insert("id2", makeVector([0.9, 0.1, 0, 0]), makeSymbol("b", "/p/src/user/profile.ts"));

    const all = index.search(makeVector([1, 0, 0, 0]), 10);
    expect(all.length).toBe(2);

    const scoped = index.search(makeVector([1, 0, 0, 0]), 10, "auth");
    expect(scoped.length).toBe(1);
    expect(scoped[0].symbol.qualifiedName).toBe("a");
  });

  it("returns empty array for empty index search", () => {
    const results = index.search(makeVector([1, 0, 0, 0]), 5);
    expect(results).toEqual([]);
  });

  it("handles remove of non-existent ID", () => {
    const removed = index.remove("nonexistent");
    expect(removed).toBe(false);
  });

  it("tracks dirty state", async () => {
    expect(index.stats.dirty).toBe(false);

    index.insert("id1", makeVector([1, 0, 0, 0]), makeSymbol("a", "/p/a.ts"));
    expect(index.stats.dirty).toBe(true);

    await index.persist();
    expect(index.stats.dirty).toBe(false);
  });
});
