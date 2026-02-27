/**
 * Advanced HNSW index tests — edge cases, persistence bugs, stress testing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HnswIndex } from "../core/search/hnsw-index.js";
import type { SymbolInfo } from "../core/types.js";

const DIM = 8;

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

function makeVector(seed: number[]): number[] {
  const v = seed.slice(0, DIM);
  while (v.length < DIM) v.push(0);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / (norm || 1));
}

function randomVector(): number[] {
  const v = Array.from({ length: DIM }, () => Math.random() - 0.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / (norm || 1));
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("HnswIndex — advanced", () => {
  let tmpDir: string;
  let index: HnswIndex;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hnsw-adv-"));
    index = new HnswIndex({ dimension: DIM, storageDir: tmpDir, logger });
    await index.init();
  });

  afterEach(async () => {
    index.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── BUG REGRESSION: reload + update ───────────────────────────────────────

  it("updates vectors AFTER reload from disk (allowReplaceDeleted)", async () => {
    // Insert initial vector
    index.insert("id1", makeVector([1, 0, 0, 0, 0, 0, 0, 0]), makeSymbol("foo", "/p/a.ts"));
    await index.persist();

    // Reload from disk
    index.dispose();
    const index2 = new HnswIndex({ dimension: DIM, storageDir: tmpDir, logger });
    await index2.init();

    // THIS WAS THE BUG: updating after reload threw
    // "Replacement of deleted elements is disabled in constructor"
    expect(() => {
      index2.insert("id1", makeVector([0, 1, 0, 0, 0, 0, 0, 0]), makeSymbol("foo_updated", "/p/a.ts"));
    }).not.toThrow();

    expect(index2.stats.count).toBe(1);

    // Search should find the updated vector, not the old one
    const results = index2.search(makeVector([0, 1, 0, 0, 0, 0, 0, 0]), 1);
    expect(results[0].symbol.qualifiedName).toBe("foo_updated");

    index2.dispose();
  });

  // ── BUG REGRESSION: freeLabels persistence ────────────────────────────────

  it("preserves freeLabels across persist/reload", async () => {
    // Insert and then remove to create free labels
    index.insert("id1", makeVector([1, 0, 0, 0, 0, 0, 0, 0]), makeSymbol("a", "/p/a.ts"));
    index.insert("id2", makeVector([0, 1, 0, 0, 0, 0, 0, 0]), makeSymbol("b", "/p/b.ts"));
    index.insert("id3", makeVector([0, 0, 1, 0, 0, 0, 0, 0]), makeSymbol("c", "/p/c.ts"));

    index.remove("id2"); // Creates a free label
    expect(index.stats.count).toBe(2);

    await index.persist();

    // Reload
    index.dispose();
    const index2 = new HnswIndex({ dimension: DIM, storageDir: tmpDir, logger });
    await index2.init();

    // Insert a new entry — should reuse the free label, not allocate a new one
    index2.insert("id4", makeVector([0, 0, 0, 1, 0, 0, 0, 0]), makeSymbol("d", "/p/d.ts"));
    expect(index2.stats.count).toBe(3);

    // Verify all 3 are searchable
    const results = index2.search(makeVector([1, 1, 1, 1, 0, 0, 0, 0]), 10);
    expect(results.length).toBe(3);
    const names = results.map(r => r.symbol.qualifiedName).sort();
    expect(names).toEqual(["a", "c", "d"]);

    index2.dispose();
  });

  it("freeLabels work after reload + multiple insert/delete cycles", async () => {
    // Build up and tear down multiple times
    for (let i = 0; i < 10; i++) {
      index.insert(`id-${i}`, randomVector(), makeSymbol(`sym${i}`, `/p/f${i}.ts`));
    }
    // Remove half
    for (let i = 0; i < 5; i++) {
      index.remove(`id-${i}`);
    }
    expect(index.stats.count).toBe(5);

    await index.persist();
    index.dispose();

    // Reload and insert new ones
    const index2 = new HnswIndex({ dimension: DIM, storageDir: tmpDir, logger });
    await index2.init();
    expect(index2.stats.count).toBe(5);

    for (let i = 10; i < 15; i++) {
      index2.insert(`id-${i}`, randomVector(), makeSymbol(`sym${i}`, `/p/f${i}.ts`));
    }
    expect(index2.stats.count).toBe(10);

    // All should be searchable
    const results = index2.search(randomVector(), 20);
    expect(results.length).toBe(10);

    index2.dispose();
  });

  // ── Capacity & edge cases ─────────────────────────────────────────────────

  it("handles inserting at the maxElements limit", async () => {
    index.dispose();
    const small = new HnswIndex({ dimension: DIM, storageDir: tmpDir, logger, maxElements: 10 });
    await small.init();

    for (let i = 0; i < 10; i++) {
      small.insert(`id-${i}`, randomVector(), makeSymbol(`s${i}`, `/p/${i}.ts`));
    }
    expect(small.stats.count).toBe(10);

    // 11th should throw (hnswlib capacity exceeded)
    expect(() => {
      small.insert("id-10", randomVector(), makeSymbol("s10", "/p/10.ts"));
    }).toThrow();

    small.dispose();
  });

  it("handles remove + insert to stay within capacity", async () => {
    index.dispose();
    const small = new HnswIndex({ dimension: DIM, storageDir: tmpDir, logger, maxElements: 5 });
    await small.init();

    // Fill to capacity
    for (let i = 0; i < 5; i++) {
      small.insert(`id-${i}`, randomVector(), makeSymbol(`s${i}`, `/p/${i}.ts`));
    }

    // Remove one, then insert — should work (reuses free label)
    small.remove("id-0");
    expect(() => {
      small.insert("id-new", randomVector(), makeSymbol("new", "/p/new.ts"));
    }).not.toThrow();

    expect(small.stats.count).toBe(5);
    small.dispose();
  });

  it("throws on insert before init", () => {
    const uninit = new HnswIndex({ dimension: DIM, storageDir: tmpDir, logger });
    expect(() => {
      uninit.insert("id1", randomVector(), makeSymbol("a", "/p/a.ts"));
    }).toThrow("not initialized");
    uninit.dispose();
  });

  it("returns empty on search before any inserts", () => {
    const results = index.search(randomVector(), 5);
    expect(results).toEqual([]);
  });

  it("search with k larger than index size returns all entries", () => {
    index.insert("id1", makeVector([1, 0, 0, 0, 0, 0, 0, 0]), makeSymbol("a", "/p/a.ts"));
    index.insert("id2", makeVector([0, 1, 0, 0, 0, 0, 0, 0]), makeSymbol("b", "/p/b.ts"));

    const results = index.search(randomVector(), 100);
    expect(results.length).toBe(2);
  });

  // ── Multiple updates to same ID ──────────────────────────────────────────

  it("handles rapid sequential updates to the same symbol", () => {
    const id = "id1";
    for (let i = 0; i < 20; i++) {
      index.insert(id, randomVector(), makeSymbol(`version${i}`, "/p/a.ts", i + 1));
    }
    // Should only have 1 entry
    expect(index.stats.count).toBe(1);
    expect(index.has(id)).toBe(true);

    const results = index.search(randomVector(), 5);
    expect(results.length).toBe(1);
    expect(results[0].symbol.qualifiedName).toBe("version19"); // Last version
  });

  // ── removeByFile edge cases ───────────────────────────────────────────────

  it("removeByFile with no matching file is a no-op", () => {
    index.insert("id1", randomVector(), makeSymbol("a", "/p/a.ts"));
    const removed = index.removeByFile("/p/nonexistent.ts");
    expect(removed).toBe(0);
    expect(index.stats.count).toBe(1);
  });

  it("removeByFile removes all symbols for that file", () => {
    index.insert("id1", randomVector(), makeSymbol("a", "/p/file.ts", 1));
    index.insert("id2", randomVector(), makeSymbol("b", "/p/file.ts", 20));
    index.insert("id3", randomVector(), makeSymbol("c", "/p/file.ts", 40));
    index.insert("id4", randomVector(), makeSymbol("d", "/p/other.ts", 1));

    const removed = index.removeByFile("/p/file.ts");
    expect(removed).toBe(3);
    expect(index.stats.count).toBe(1);
    expect(index.has("id4")).toBe(true);
  });

  // ── Scope filtering ───────────────────────────────────────────────────────

  it("scope filter with partial directory match", () => {
    index.insert("id1", makeVector([1, 0, 0, 0, 0, 0, 0, 0]), makeSymbol("a", "/p/src/auth/login.ts"));
    index.insert("id2", makeVector([0.9, 0.1, 0, 0, 0, 0, 0, 0]), makeSymbol("b", "/p/src/auth/register.ts"));
    index.insert("id3", makeVector([0.8, 0.2, 0, 0, 0, 0, 0, 0]), makeSymbol("c", "/p/src/user/profile.ts"));
    index.insert("id4", makeVector([0.7, 0.3, 0, 0, 0, 0, 0, 0]), makeSymbol("d", "/p/src/authorization/check.ts")); // Note: "authorization" contains "auth"

    const results = index.search(makeVector([1, 0, 0, 0, 0, 0, 0, 0]), 10, "src/auth/");
    // Should match auth/login.ts and auth/register.ts, but NOT authorization/check.ts
    const files = results.map(r => r.symbol.filePath);
    expect(files.every(f => f.includes("src/auth/"))).toBe(true);
  });

  // ── Score correctness ─────────────────────────────────────────────────────

  it("identical vectors return score ≈ 1.0", () => {
    const v = makeVector([1, 2, 3, 4, 5, 6, 7, 8]);
    index.insert("id1", v, makeSymbol("a", "/p/a.ts"));

    const results = index.search(v, 1);
    expect(results[0].score).toBeGreaterThan(0.99);
    expect(results[0].distance).toBeLessThan(0.01);
  });

  it("orthogonal vectors return lower score", () => {
    const v1 = makeVector([1, 0, 0, 0, 0, 0, 0, 0]);
    const v2 = makeVector([0, 0, 0, 0, 0, 0, 0, 1]);
    index.insert("id1", v1, makeSymbol("a", "/p/a.ts"));

    const results = index.search(v2, 1);
    expect(results[0].score).toBeLessThan(0.6);
  });

  // ── Persistence edge cases ────────────────────────────────────────────────

  it("persist with no changes (not dirty) is a no-op", async () => {
    index.insert("id1", randomVector(), makeSymbol("a", "/p/a.ts"));
    await index.persist();

    // Read the file
    const before = await fs.readFile(path.join(tmpDir, "symbols.json"), "utf-8");

    // Persist again — should not write (not dirty)
    await index.persist();
    const after = await fs.readFile(path.join(tmpDir, "symbols.json"), "utf-8");
    expect(before).toBe(after);
  });

  it("persist on empty index still creates valid files", async () => {
    // Insert and remove everything
    index.insert("id1", randomVector(), makeSymbol("a", "/p/a.ts"));
    index.remove("id1");
    await index.persist();

    const data = JSON.parse(await fs.readFile(path.join(tmpDir, "symbols.json"), "utf-8"));
    expect(data.entries).toEqual([]);
    expect(data.freeLabels.length).toBe(1);
  });

  it("persisted symbols.json contains correct structure", async () => {
    index.insert("id1", randomVector(), makeSymbol("alpha", "/p/a.ts", 10));
    index.insert("id2", randomVector(), makeSymbol("beta", "/p/b.ts", 20));
    index.remove("id1");
    await index.persist();

    const data = JSON.parse(await fs.readFile(path.join(tmpDir, "symbols.json"), "utf-8"));
    expect(data).toHaveProperty("nextLabel");
    expect(data).toHaveProperty("dimension", DIM);
    expect(data).toHaveProperty("freeLabels");
    expect(data).toHaveProperty("entries");
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].id).toBe("id2");
    expect(data.entries[0].symbol.qualifiedName).toBe("beta");
    expect(data.freeLabels).toContain(0); // label 0 was freed
  });

  // ── indexedIds ─────────────────────────────────────────────────────────────

  it("indexedIds returns all current IDs", () => {
    index.insert("id1", randomVector(), makeSymbol("a", "/p/a.ts"));
    index.insert("id2", randomVector(), makeSymbol("b", "/p/b.ts"));
    index.insert("id3", randomVector(), makeSymbol("c", "/p/c.ts"));
    index.remove("id2");

    const ids = index.indexedIds;
    expect(ids.size).toBe(2);
    expect(ids.has("id1")).toBe(true);
    expect(ids.has("id3")).toBe(true);
    expect(ids.has("id2")).toBe(false);
  });

  // ── Stress: many inserts, searches, and removes ───────────────────────────

  it("handles 500 inserts and accurate search", () => {
    // Insert 500 symbols with random vectors
    for (let i = 0; i < 500; i++) {
      index.insert(`id-${i}`, randomVector(), makeSymbol(`sym${i}`, `/p/f${i % 50}.ts`, i));
    }
    expect(index.stats.count).toBe(500);

    // Search should return k results
    const results = index.search(randomVector(), 10);
    expect(results.length).toBe(10);

    // All scores should be between 0 and 1
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});
