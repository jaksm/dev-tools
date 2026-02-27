/**
 * Local embedding provider — runs ONNX models via @huggingface/transformers.
 * Zero API cost. Model stored at ~/.dev-tools/models/.
 * 
 * Default model: Xenova/all-MiniLM-L6-v2 (22MB, 384 dims, well-tested with transformers.js)
 * Alternative: jinaai/jina-embeddings-v2-small-en (33MB, 512 dims)
 */

import type { EmbeddingProvider } from "./embeddings.js";
import type { Logger } from "../types.js";

// Default model — small, fast, well-tested in transformers.js ecosystem
const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const MODEL_CACHE_DIR = `${process.env.HOME}/.dev-tools/models`;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly model: string;
  private _dimension = 0;
  private _ready = false;
  private logger: Logger;
  private extractor: any = null; // Pipeline instance from transformers.js
  private initPromise: Promise<void> | null = null;

  constructor(opts: { model?: string; logger: Logger }) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.logger = opts.logger;
  }

  get dimension(): number {
    return this._dimension;
  }

  get ready(): boolean {
    return this._ready;
  }

  async init(): Promise<void> {
    if (this._ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    this.logger.info(`[dev-tools] Loading embedding model: ${this.model}...`);
    const start = Date.now();

    try {
      // Dynamic import to avoid loading transformers.js at module load time
      const { pipeline, env } = await import("@huggingface/transformers");

      // Configure cache directory
      env.cacheDir = MODEL_CACHE_DIR;

      // Create feature-extraction pipeline
      this.extractor = await pipeline("feature-extraction", this.model, {
        // Use ONNX quantized model for speed
        dtype: "fp32",
      });

      // Probe dimension with a test embedding
      const testResult = await this.extractor("test", {
        pooling: "mean",
        normalize: true,
      });
      this._dimension = testResult.dims[testResult.dims.length - 1];
      this._ready = true;

      const elapsed = Date.now() - start;
      this.logger.info(
        `[dev-tools] Embedding model loaded: ${this.model} (${this._dimension}d, ${elapsed}ms)`,
      );
    } catch (e) {
      this.logger.error(`[dev-tools] Failed to load embedding model: ${e}`);
      throw e;
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this._ready) await this.init();

    const result = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(result.data as Float32Array);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this._ready) await this.init();
    if (texts.length === 0) return [];

    // transformers.js supports batch input
    const result = await this.extractor(texts, {
      pooling: "mean",
      normalize: true,
    });

    // Result shape: [batchSize, dimension]
    const dim = this._dimension;
    const data = result.data as Float32Array;
    const vectors: number[][] = [];

    for (let i = 0; i < texts.length; i++) {
      const start = i * dim;
      vectors.push(Array.from(data.slice(start, start + dim)));
    }

    return vectors;
  }

  async dispose(): Promise<void> {
    if (this.extractor) {
      // transformers.js pipeline cleanup
      try {
        await this.extractor.dispose?.();
      } catch {
        // Best effort
      }
      this.extractor = null;
    }
    this._ready = false;
    this.initPromise = null;
  }
}
