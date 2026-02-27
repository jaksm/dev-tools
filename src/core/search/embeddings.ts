/**
 * Embedding provider abstraction — interface + factory for local/API providers.
 */

import type { DevToolsConfig, Logger } from "../types.js";

/**
 * Core embedding provider interface.
 */
export interface EmbeddingProvider {
  /** Provider name for display */
  readonly name: string;
  /** Model name/identifier */
  readonly model: string;
  /** Embedding dimension */
  readonly dimension: number;
  /** Whether provider is ready (model loaded, API key present, etc.) */
  readonly ready: boolean;

  /** Initialize the provider (download model, check API key, etc.) */
  init(): Promise<void>;

  /** Embed a single text string → float vector */
  embed(text: string): Promise<number[]>;

  /** Embed multiple texts in batch → array of float vectors */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** Dispose resources (unload model, close connections) */
  dispose(): Promise<void>;
}

/**
 * Embedding provider configuration.
 */
export interface EmbeddingProviderConfig {
  provider: "local" | "api";
  model?: string;
  /** For API providers */
  apiKey?: string;
  apiBaseUrl?: string;
  /** Local model cache directory */
  modelCacheDir?: string;
  /** Max batch size for API calls */
  batchSize?: number;
}

/**
 * Create an embedding provider based on config.
 */
export async function createEmbeddingProvider(
  config: DevToolsConfig,
  logger: Logger,
): Promise<EmbeddingProvider> {
  const searchConfig = config.search ?? {};
  const providerType = searchConfig.provider ?? "local";

  if (providerType === "api") {
    const { ApiEmbeddingProvider } = await import("./api-embeddings.js");
    return new ApiEmbeddingProvider({
      model: searchConfig.model ?? "text-embedding-3-small",
      logger,
    });
  }

  // Default: local
  const { LocalEmbeddingProvider } = await import("./local-embeddings.js");
  return new LocalEmbeddingProvider({
    model: searchConfig.model,
    logger,
  });
}
