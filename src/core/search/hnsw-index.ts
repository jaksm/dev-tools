/**
 * HNSW vector index — wraps hnswlib-node for nearest-neighbor search.
 * 
 * Persistence: vectors.hnsw (binary) + symbols.json (metadata map).
 * Sub-millisecond search for typical project sizes (500-5000 symbols).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SymbolInfo } from "../types.js";
import type { Logger } from "../types.js";

// hnswlib-node is CJS, we need createRequire for ESM
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { HierarchicalNSW } = require("hnswlib-node") as typeof import("hnswlib-node");

const VECTORS_FILE = "vectors.hnsw";
const SYMBOLS_FILE = "symbols.json";
const DEFAULT_MAX_ELEMENTS = 50_000;
const DEFAULT_EF_CONSTRUCTION = 200;
const DEFAULT_M = 16;

export interface HnswSearchResult {
  /** Internal label (numeric ID in HNSW) */
  label: number;
  /** Cosine distance (0 = identical, 2 = opposite) */
  distance: number;
  /** Symbol metadata (resolved from symbols map) */
  symbol: SymbolInfo;
  /** Similarity score (1 - distance/2, range 0-1) */
  score: number;
}

/**
 * Metadata stored alongside each vector in the HNSW index.
 */
interface SymbolMetadata {
  /** Symbol string ID (filePath::qualifiedName::line) */
  id: string;
  /** Symbol info snapshot */
  symbol: SymbolInfo;
}

export class HnswIndex {
  private index: InstanceType<typeof HierarchicalNSW> | null = null;
  private dimension: number;
  private maxElements: number;
  private logger: Logger;
  private storageDir: string;

  // Label management — HNSW uses numeric labels
  private nextLabel = 0;
  private idToLabel = new Map<string, number>();  // symbolId → hnsw label
  private labelToMeta = new Map<number, SymbolMetadata>(); // hnsw label → metadata
  private freeLabels: number[] = []; // Recycled labels from removals

  // Dirty flag for persistence
  private dirty = false;

  constructor(opts: {
    dimension: number;
    storageDir: string;
    logger: Logger;
    maxElements?: number;
  }) {
    this.dimension = opts.dimension;
    this.storageDir = opts.storageDir;
    this.logger = opts.logger;
    this.maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;
  }

  /**
   * Initialize the index — load from disk if available, else create new.
   */
  async init(): Promise<{ loaded: boolean; count: number }> {
    const vectorsPath = path.join(this.storageDir, VECTORS_FILE);
    const symbolsPath = path.join(this.storageDir, SYMBOLS_FILE);

    let loaded = false;

    try {
      await fs.access(vectorsPath);
      await fs.access(symbolsPath);

      // Load persisted index
      const symbolsData = JSON.parse(await fs.readFile(symbolsPath, "utf-8")) as {
        nextLabel: number;
        freeLabels?: number[];
        entries: Array<{ label: number; id: string; symbol: SymbolInfo }>;
      };

      this.index = new HierarchicalNSW("cosine", this.dimension);
      await this.index.readIndex(vectorsPath, /* allowReplaceDeleted */ true);

      // Rebuild maps
      this.nextLabel = symbolsData.nextLabel;
      this.freeLabels = symbolsData.freeLabels ?? [];
      for (const entry of symbolsData.entries) {
        this.idToLabel.set(entry.id, entry.label);
        this.labelToMeta.set(entry.label, { id: entry.id, symbol: entry.symbol });
      }

      loaded = true;
      this.logger.info(
        `[dev-tools] HNSW index loaded: ${this.labelToMeta.size} vectors (${this.dimension}d)`,
      );
    } catch {
      // No persisted index — create new
      this.index = new HierarchicalNSW("cosine", this.dimension);
      this.index.initIndex(this.maxElements, DEFAULT_M, DEFAULT_EF_CONSTRUCTION, /* randomSeed */ 42, /* allowReplaceDeleted */ true);
      this.logger.info(
        `[dev-tools] New HNSW index created (${this.dimension}d, max ${this.maxElements})`,
      );
    }

    return { loaded, count: this.labelToMeta.size };
  }

  /**
   * Insert or update a vector for a symbol.
   */
  insert(id: string, vector: number[], symbol: SymbolInfo): void {
    if (!this.index) throw new Error("HNSW index not initialized");

    let label: number;
    let replaceDeleted = false;

    // Check if this symbol already has a label
    const existingLabel = this.idToLabel.get(id);
    if (existingLabel !== undefined) {
      // Mark old point as deleted, then reuse a free label slot
      try { this.index.markDelete(existingLabel); } catch { /* already deleted */ }
      this.labelToMeta.delete(existingLabel);
      this.freeLabels.push(existingLabel);
      // Use a new label for the replacement (addPoint with replaceDeleted=true)
      label = this.freeLabels.pop()!;
      replaceDeleted = true;
    } else if (this.freeLabels.length > 0) {
      label = this.freeLabels.pop()!;
      replaceDeleted = true;
    } else {
      label = this.nextLabel++;
    }

    this.index.addPoint(vector, label, replaceDeleted);
    this.idToLabel.set(id, label);
    this.labelToMeta.set(label, { id, symbol });
    this.dirty = true;
  }

  /**
   * Remove a symbol from the index.
   * Note: hnswlib doesn't truly delete — we mark as deleted and recycle the label.
   */
  remove(id: string): boolean {
    if (!this.index) return false;

    const label = this.idToLabel.get(id);
    if (label === undefined) return false;

    try {
      this.index.markDelete(label);
    } catch {
      // Label might not exist in index yet (race condition)
    }

    this.idToLabel.delete(id);
    this.labelToMeta.delete(label);
    this.freeLabels.push(label);
    this.dirty = true;
    return true;
  }

  /**
   * Remove all symbols for a given file path.
   */
  removeByFile(filePath: string): number {
    let removed = 0;
    const toRemove: string[] = [];

    for (const [_label, meta] of this.labelToMeta) {
      if (meta.symbol.filePath === filePath) {
        toRemove.push(meta.id);
      }
    }

    for (const id of toRemove) {
      if (this.remove(id)) removed++;
    }

    return removed;
  }

  /**
   * Search for k nearest neighbors to a query vector.
   */
  search(queryVector: number[], k: number = 10, scope?: string): HnswSearchResult[] {
    if (!this.index || this.labelToMeta.size === 0) return [];

    // Set ef for search (must be >= k)
    const ef = Math.max(k * 2, 50);
    this.index.setEf(ef);

    // Search more than k to account for scope filtering + deleted entries
    const searchK = scope ? Math.min(k * 5, this.labelToMeta.size) : Math.min(k, this.labelToMeta.size);

    const result = this.index.searchKnn(queryVector, searchK);

    const results: HnswSearchResult[] = [];

    for (let i = 0; i < result.neighbors.length; i++) {
      const label = result.neighbors[i];
      const distance = result.distances[i];
      const meta = this.labelToMeta.get(label);

      if (!meta) continue; // Deleted entry

      // Scope filter — only include symbols within the specified directory
      if (scope && !meta.symbol.filePath.includes(scope)) continue;

      results.push({
        label,
        distance,
        symbol: meta.symbol,
        score: 1 - distance / 2, // Cosine distance to similarity
      });

      if (results.length >= k) break;
    }

    return results;
  }

  /**
   * Persist index to disk.
   */
  async persist(): Promise<void> {
    if (!this.index || !this.dirty) return;

    await fs.mkdir(this.storageDir, { recursive: true });

    const vectorsPath = path.join(this.storageDir, VECTORS_FILE);
    const symbolsPath = path.join(this.storageDir, SYMBOLS_FILE);

    // Save HNSW binary
    await this.index.writeIndex(vectorsPath);

    // Save metadata
    const entries: Array<{ label: number; id: string; symbol: SymbolInfo }> = [];
    for (const [label, meta] of this.labelToMeta) {
      entries.push({ label, id: meta.id, symbol: meta.symbol });
    }

    const symbolsData = {
      nextLabel: this.nextLabel,
      dimension: this.dimension,
      freeLabels: this.freeLabels,
      entries,
    };

    await fs.writeFile(symbolsPath, JSON.stringify(symbolsData), "utf-8");
    this.dirty = false;

    this.logger.info(
      `[dev-tools] HNSW index persisted: ${entries.length} vectors to ${this.storageDir}`,
    );
  }

  /**
   * Get index statistics.
   */
  get stats(): { count: number; dimension: number; maxElements: number; dirty: boolean } {
    return {
      count: this.labelToMeta.size,
      dimension: this.dimension,
      maxElements: this.maxElements,
      dirty: this.dirty,
    };
  }

  /**
   * Check if a symbol ID is indexed.
   */
  has(id: string): boolean {
    return this.idToLabel.has(id);
  }

  /**
   * Get all indexed symbol IDs.
   */
  get indexedIds(): Set<string> {
    return new Set(this.idToLabel.keys());
  }

  /**
   * Dispose the index and free resources.
   */
  dispose(): void {
    this.index = null;
    this.idToLabel.clear();
    this.labelToMeta.clear();
    this.freeLabels = [];
    this.dirty = false;
  }
}
