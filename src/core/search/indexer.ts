/**
 * Embedding indexer — orchestrates embedding all symbols from the symbol index
 * into the HNSW vector index. Handles full indexing, incremental updates,
 * progress reporting, and persistence.
 */

import type { SymbolInfo, Logger } from "../types.js";
import type { SymbolIndex } from "../index/symbol-index.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { HnswIndex } from "./hnsw-index.js";
import { serializeSymbol, symbolId } from "./serializer.js";

const EMBED_BATCH_SIZE = 32;
const PERSIST_DEBOUNCE_MS = 30_000; // 30 seconds

export type IndexingState = "idle" | "indexing" | "ready" | "error";

export interface IndexingProgress {
  state: IndexingState;
  indexed: number;
  total: number;
  error?: string;
}

export interface EmbeddingIndexerStats {
  state: IndexingState;
  indexedSymbols: number;
  totalSymbols: number;
  embeddingModel: string;
  embeddingDimension: number;
  indexAge: string;
  storageSize: string;
}

export class EmbeddingIndexer {
  private embeddingProvider: EmbeddingProvider;
  private hnswIndex: HnswIndex | null = null;
  private symbolIndex: SymbolIndex;
  private workspaceDir: string;
  private storageDir: string;
  private logger: Logger;

  // State
  private _state: IndexingState = "idle";
  private _progress: IndexingProgress = { state: "idle", indexed: 0, total: 0 };
  private _lastIndexTime: number | null = null;

  // Debounced persist
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    embeddingProvider: EmbeddingProvider;
    symbolIndex: SymbolIndex;
    workspaceDir: string;
    storageDir: string;
    logger: Logger;
  }) {
    this.embeddingProvider = opts.embeddingProvider;
    this.symbolIndex = opts.symbolIndex;
    this.workspaceDir = opts.workspaceDir;
    this.storageDir = opts.storageDir;
    this.logger = opts.logger;
  }

  get state(): IndexingState {
    return this._state;
  }

  get progress(): IndexingProgress {
    return { ...this._progress };
  }

  get lastIndexTime(): number | null {
    return this._lastIndexTime;
  }

  get hnswStats() {
    return this.hnswIndex?.stats ?? null;
  }

  /**
   * Initialize — load HNSW from disk if available, init embedding provider.
   */
  async init(): Promise<void> {
    // Init embedding provider (downloads model if needed)
    await this.embeddingProvider.init();

    // Create and init HNSW index
    this.hnswIndex = new HnswIndex({
      dimension: this.embeddingProvider.dimension,
      storageDir: this.storageDir,
      logger: this.logger,
    });

    const { loaded, count } = await this.hnswIndex.init();

    if (loaded && count > 0) {
      this._state = "ready";
      this._lastIndexTime = Date.now();
      this.logger.info(`[dev-tools] Embedding index loaded with ${count} vectors`);
    }
  }

  /**
   * Full index — embed all symbols from symbol index into HNSW.
   * Called on first boot or when index is stale.
   */
  async indexAll(
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<{ indexed: number; skipped: number; durationMs: number }> {
    if (!this.hnswIndex) throw new Error("Embedding indexer not initialized");

    this._state = "indexing";
    const start = Date.now();

    const allSymbols = [...this.symbolIndex.allSymbols()];
    const total = allSymbols.length;
    this._progress = { state: "indexing", indexed: 0, total };

    this.logger.info(`[dev-tools] Embedding ${total} symbols...`);

    let indexed = 0;
    let skipped = 0;

    // Process in batches
    for (let i = 0; i < allSymbols.length; i += EMBED_BATCH_SIZE) {
      const batch = allSymbols.slice(i, i + EMBED_BATCH_SIZE);

      // Separate already-indexed from new
      const toEmbed: SymbolInfo[] = [];
      const toEmbedTexts: string[] = [];

      for (const symbol of batch) {
        const id = symbolId(symbol);
        if (this.hnswIndex.has(id)) {
          skipped++;
          continue;
        }
        toEmbed.push(symbol);
        toEmbedTexts.push(serializeSymbol(symbol, this.workspaceDir));
      }

      if (toEmbed.length > 0) {
        try {
          const vectors = await this.embeddingProvider.embedBatch(toEmbedTexts);

          for (let j = 0; j < toEmbed.length; j++) {
            const id = symbolId(toEmbed[j]);
            this.hnswIndex.insert(id, vectors[j], toEmbed[j]);
          }
          indexed += toEmbed.length;
        } catch (e) {
          this.logger.warn(`[dev-tools] Embedding batch failed (${toEmbed.length} symbols skipped): ${e}`);
          // Continue with next batch — these symbols stay un-embedded
        }
      }
      this._progress = { state: "indexing", indexed: indexed + skipped, total };

      if (onProgress && (indexed + skipped) % 100 === 0) {
        onProgress(indexed + skipped, total);
      }
    }

    // Persist
    await this.hnswIndex.persist();

    const durationMs = Date.now() - start;
    this._state = "ready";
    this._lastIndexTime = Date.now();
    this._progress = { state: "ready", indexed: indexed + skipped, total };

    this.logger.info(
      `[dev-tools] Embedded ${indexed} symbols (${skipped} cached) in ${durationMs}ms`,
    );

    return { indexed, skipped, durationMs };
  }

  /**
   * Incremental update — re-embed only changed symbols for a file.
   * Called by file watcher when files change.
   */
  async updateFile(filePath: string): Promise<void> {
    if (!this.hnswIndex || this._state !== "ready") return;

    // Remove old embeddings for this file
    this.hnswIndex.removeByFile(filePath);

    // Get current symbols for this file from symbol index
    const symbols = this.symbolIndex.lookupByFile(filePath);
    if (symbols.length === 0) return;

    // Embed new symbols
    const texts = symbols.map(s => serializeSymbol(s, this.workspaceDir));
    try {
      const vectors = await this.embeddingProvider.embedBatch(texts);

      for (let i = 0; i < symbols.length; i++) {
        const id = symbolId(symbols[i]);
        this.hnswIndex.insert(id, vectors[i], symbols[i]);
      }

      this.logger.debug?.(
        `[dev-tools] Re-embedded ${symbols.length} symbols for ${filePath}`,
      );
    } catch (e) {
      this.logger.warn(`[dev-tools] Failed to re-embed symbols for ${filePath}: ${e}`);
    }

    // Schedule debounced persist
    this.schedulePersist();
  }

  /**
   * Remove all embeddings for a file (file deleted).
   */
  removeFile(filePath: string): void {
    if (!this.hnswIndex) return;

    const removed = this.hnswIndex.removeByFile(filePath);
    if (removed > 0) {
      this.logger.debug?.(`[dev-tools] Removed ${removed} embeddings for deleted file: ${filePath}`);
      this.schedulePersist();
    }
  }

  /**
   * Search for symbols semantically similar to a query.
   */
  async search(query: string, k: number = 10, scope?: string): Promise<import("./hnsw-index.js").HnswSearchResult[]> {
    if (!this.hnswIndex || this._state !== "ready") return [];

    const queryVector = await this.embeddingProvider.embed(query);
    return this.hnswIndex.search(queryVector, k, scope);
  }

  /**
   * Get indexer statistics for the stats action.
   */
  getStats(): EmbeddingIndexerStats {
    const hnswStats = this.hnswIndex?.stats;
    const age = this._lastIndexTime
      ? `${Math.round((Date.now() - this._lastIndexTime) / 1000)}s ago`
      : "never";

    return {
      state: this._state,
      indexedSymbols: hnswStats?.count ?? 0,
      totalSymbols: this.symbolIndex.size,
      embeddingModel: `${this.embeddingProvider.model} (${this.embeddingProvider.name})`,
      embeddingDimension: this.embeddingProvider.dimension,
      indexAge: age,
      storageSize: "N/A", // TODO: compute from files
    };
  }

  /**
   * Persist index to disk (flush).
   */
  async persist(): Promise<void> {
    await this.hnswIndex?.persist();
  }

  /**
   * Dispose resources.
   */
  async dispose(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    // Final persist before shutdown
    try {
      await this.hnswIndex?.persist();
    } catch {
      // Best effort
    }

    this.hnswIndex?.dispose();
    this.hnswIndex = null;
    await this.embeddingProvider.dispose();
    this._state = "idle";
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(async () => {
      this.persistTimer = null;
      try {
        await this.hnswIndex?.persist();
      } catch (e) {
        this.logger.warn(`[dev-tools] Failed to persist HNSW index: ${e}`);
      }
    }, PERSIST_DEBOUNCE_MS);
  }
}
