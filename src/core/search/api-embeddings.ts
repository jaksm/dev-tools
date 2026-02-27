/**
 * API embedding provider — configurable external API (OpenAI, Voyage, etc.).
 * Batch requests, exponential backoff on 429.
 */

import type { EmbeddingProvider } from "./embeddings.js";
import type { Logger } from "../types.js";

// Known API configurations
const API_CONFIGS: Record<string, { url: string; envKey: string; dimension: number }> = {
  "text-embedding-3-small": {
    url: "https://api.openai.com/v1/embeddings",
    envKey: "OPENAI_API_KEY",
    dimension: 1536,
  },
  "text-embedding-3-large": {
    url: "https://api.openai.com/v1/embeddings",
    envKey: "OPENAI_API_KEY",
    dimension: 3072,
  },
  "voyage-code-3": {
    url: "https://api.voyageai.com/v1/embeddings",
    envKey: "VOYAGE_API_KEY",
    dimension: 1024,
  },
};

const MAX_BATCH_SIZE = 50;
const MAX_RETRIES = 5;
const BASE_RETRY_MS = 1000;

export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "api";
  readonly model: string;
  private _dimension: number;
  private _ready = false;
  private logger: Logger;
  private apiUrl: string;
  private apiKey: string;

  constructor(opts: {
    model?: string;
    apiKey?: string;
    apiBaseUrl?: string;
    logger: Logger;
  }) {
    this.model = opts.model ?? "text-embedding-3-small";
    this.logger = opts.logger;

    const config = API_CONFIGS[this.model];
    this.apiUrl = opts.apiBaseUrl ?? config?.url ?? "https://api.openai.com/v1/embeddings";
    this._dimension = config?.dimension ?? 1536;

    // Resolve API key from env if not provided
    const envKey = config?.envKey ?? "OPENAI_API_KEY";
    this.apiKey = opts.apiKey ?? process.env[envKey] ?? "";
  }

  get dimension(): number {
    return this._dimension;
  }

  get ready(): boolean {
    return this._ready;
  }

  async init(): Promise<void> {
    if (!this.apiKey) {
      const config = API_CONFIGS[this.model];
      const envKey = config?.envKey ?? "OPENAI_API_KEY";
      throw new Error(
        `API embedding provider requires ${envKey} environment variable or apiKey config`,
      );
    }

    // Test with a single embedding
    try {
      const result = await this.embed("test");
      this._dimension = result.length;
      this._ready = true;
      this.logger.info(
        `[dev-tools] API embedding provider ready: ${this.model} (${this._dimension}d)`,
      );
    } catch (e) {
      throw new Error(`API embedding provider init failed: ${e}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const allResults: number[][] = [];

    // Chunk into batches
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const results = await this.requestWithRetry(batch);
      allResults.push(...results);
    }

    return allResults;
  }

  private async requestWithRetry(texts: string[]): Promise<number[][]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.doRequest(texts);
      } catch (e: any) {
        lastError = e;

        if (e.status === 429 || e.message?.includes("429")) {
          const delay = BASE_RETRY_MS * Math.pow(2, attempt);
          this.logger.warn(
            `[dev-tools] API rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        // Non-retryable error
        throw e;
      }
    }

    throw lastError ?? new Error("Max retries exceeded");
  }

  private async doRequest(texts: string[]): Promise<number[][]> {
    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error: any = new Error(`API error: ${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index (API may return out of order)
    const sorted = data.data.sort((a, b) => a.index - b.index);
    return sorted.map(d => d.embedding);
  }

  async dispose(): Promise<void> {
    this._ready = false;
  }
}
