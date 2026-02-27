/**
 * Phase 3 integration test — semantic search end-to-end.
 * 
 * Tests the full pipeline: symbol extraction → serialization → embedding → HNSW → search.
 * Uses a mock embedding provider (deterministic, no ONNX model download).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EmbeddingProvider } from "../core/search/embeddings.js";
import type { SymbolInfo, Logger } from "../core/types.js";
import { HnswIndex } from "../core/search/hnsw-index.js";
import { EmbeddingIndexer } from "../core/search/indexer.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { serializeSymbol, symbolId } from "../core/search/serializer.js";
import { codeSearch } from "../tools/code-search.js";

// ── Mock Embedding Provider ─────────────────────────────────────────────────

const DIM = 16;

/**
 * Deterministic mock: hashes the input text to produce a consistent vector.
 * Similar texts produce similar vectors via character overlap.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "mock-embed-v1";
  readonly dimension = DIM;
  readonly ready = true;

  async init(): Promise<void> {}

  async embed(text: string): Promise<number[]> {
    return this.textToVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.textToVector(t));
  }

  async dispose(): Promise<void> {}

  private textToVector(text: string): number[] {
    // Simple hash-based embedding — character frequency in DIM buckets
    const v = new Array(DIM).fill(0);
    for (let i = 0; i < text.length; i++) {
      v[text.charCodeAt(i) % DIM] += 1;
    }
    // Normalize
    const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0));
    return v.map((x: number) => x / (norm || 1));
  }
}

// ── Test Data ───────────────────────────────────────────────────────────────

function makeSymbol(name: string, kind: string, file: string, lines: [number, number], sig: string, docs?: string): SymbolInfo {
  return { qualifiedName: name, kind, filePath: file, lines, signature: sig, docs: docs ?? null };
}

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const WORKSPACE = "/mock/project";

const TEST_SYMBOLS: SymbolInfo[] = [
  makeSymbol("AuthService.login", "method", `${WORKSPACE}/src/auth/service.ts`, [10, 35], "async login(email: string, password: string): Promise<User>", "Authenticate a user with email and password"),
  makeSymbol("AuthService.logout", "method", `${WORKSPACE}/src/auth/service.ts`, [37, 50], "async logout(userId: string): Promise<void>", "Log out a user and invalidate session"),
  makeSymbol("AuthService.refreshToken", "method", `${WORKSPACE}/src/auth/service.ts`, [52, 80], "async refreshToken(token: string): Promise<TokenPair>", "Refresh an expired JWT token"),
  makeSymbol("UserRepository.findById", "method", `${WORKSPACE}/src/user/repository.ts`, [15, 30], "async findById(id: string): Promise<User | null>", "Find user by ID in database"),
  makeSymbol("UserRepository.create", "method", `${WORKSPACE}/src/user/repository.ts`, [32, 55], "async create(data: CreateUserDto): Promise<User>", "Create a new user in the database"),
  makeSymbol("PaymentProcessor.charge", "method", `${WORKSPACE}/src/payment/processor.ts`, [20, 60], "async charge(amount: number, currency: string, source: string): Promise<PaymentResult>", "Process a credit card payment"),
  makeSymbol("PaymentProcessor.refund", "method", `${WORKSPACE}/src/payment/processor.ts`, [62, 90], "async refund(paymentId: string, amount?: number): Promise<RefundResult>", "Refund a payment partially or fully"),
  makeSymbol("EmailNotifier.send", "method", `${WORKSPACE}/src/notifications/email.ts`, [10, 40], "async send(to: string, subject: string, body: string): Promise<void>", "Send an email notification"),
  makeSymbol("DatabaseConnection.connect", "method", `${WORKSPACE}/src/db/connection.ts`, [5, 25], "async connect(): Promise<void>", "Establish database connection"),
  makeSymbol("DatabaseConnection.query", "method", `${WORKSPACE}/src/db/connection.ts`, [27, 45], "async query<T>(sql: string, params?: unknown[]): Promise<T[]>", "Execute a SQL query"),
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Phase 3 integration — semantic search", () => {
  let tmpDir: string;
  let symbolIndex: SymbolIndex;
  let embeddingIndexer: EmbeddingIndexer;
  let mockProvider: MockEmbeddingProvider;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase3-test-"));

    // Build symbol index
    symbolIndex = new SymbolIndex();
    for (const sym of TEST_SYMBOLS) {
      symbolIndex.insert(sym);
    }

    // Create embedding indexer with mock provider
    mockProvider = new MockEmbeddingProvider();
    embeddingIndexer = new EmbeddingIndexer({
      embeddingProvider: mockProvider,
      symbolIndex,
      workspaceDir: WORKSPACE,
      storageDir: tmpDir,
      logger,
    });

    await embeddingIndexer.init();
    await embeddingIndexer.indexAll();
  });

  afterAll(async () => {
    await embeddingIndexer.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("indexes all symbols", () => {
    expect(embeddingIndexer.state).toBe("ready");
    const stats = embeddingIndexer.getStats();
    expect(stats.indexedSymbols).toBe(TEST_SYMBOLS.length);
    expect(stats.totalSymbols).toBe(TEST_SYMBOLS.length);
  });

  it("searches semantically and returns results", async () => {
    const results = await embeddingIndexer.search("authentication login", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    // Results should have scores
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.symbol).toBeDefined();
      expect(r.symbol.qualifiedName).toBeDefined();
    }
  });

  it("scope filter works", async () => {
    const results = await embeddingIndexer.search("find user", 10, "auth");
    // Should only return symbols from auth directory
    for (const r of results) {
      expect(r.symbol.filePath).toContain("auth");
    }
  });

  it("incremental update works", async () => {
    // Add a new symbol to the symbol index
    const newSymbol = makeSymbol(
      "CacheManager.invalidate",
      "method",
      `${WORKSPACE}/src/cache/manager.ts`,
      [10, 25],
      "async invalidate(key: string): Promise<void>",
      "Invalidate a cache entry",
    );
    symbolIndex.insert(newSymbol);

    // Simulate incremental embedding update
    await embeddingIndexer.updateFile(`${WORKSPACE}/src/cache/manager.ts`);

    const stats = embeddingIndexer.getStats();
    expect(stats.indexedSymbols).toBe(TEST_SYMBOLS.length + 1);
  });

  it("file removal works", () => {
    embeddingIndexer.removeFile(`${WORKSPACE}/src/cache/manager.ts`);
    const stats = embeddingIndexer.getStats();
    expect(stats.indexedSymbols).toBe(TEST_SYMBOLS.length);
  });

  it("persists and reloads", async () => {
    await embeddingIndexer.persist();

    // Create new indexer from same storage
    const newIndexer = new EmbeddingIndexer({
      embeddingProvider: mockProvider,
      symbolIndex,
      workspaceDir: WORKSPACE,
      storageDir: tmpDir,
      logger,
    });
    await newIndexer.init();

    expect(newIndexer.state).toBe("ready");
    const stats = newIndexer.getStats();
    expect(stats.indexedSymbols).toBe(TEST_SYMBOLS.length);

    // Search works after reload
    const results = await newIndexer.search("payment", 3);
    expect(results.length).toBeGreaterThan(0);

    await newIndexer.dispose();
  });

  it("stats action returns comprehensive info", async () => {
    const stats = embeddingIndexer.getStats();
    expect(stats.state).toBe("ready");
    expect(stats.embeddingModel).toContain("mock");
    expect(stats.embeddingDimension).toBe(DIM);
    expect(stats.indexAge).toBeDefined();
  });

  it("serializer produces meaningful text", () => {
    const sym = TEST_SYMBOLS[0]; // AuthService.login
    const text = serializeSymbol(sym, WORKSPACE);
    expect(text).toContain("AuthService.login");
    expect(text).toContain("method");
    expect(text).toContain("auth/service.ts");
    expect(text).toContain("login");
  });

  it("symbolId is deterministic", () => {
    const sym = TEST_SYMBOLS[0];
    const id1 = symbolId(sym);
    const id2 = symbolId(sym);
    expect(id1).toBe(id2);
    expect(id1).toContain(sym.filePath);
    expect(id1).toContain(sym.qualifiedName);
  });

  it("code_search tool works with semantic mode", async () => {
    const ctx = {
      workspaceDir: WORKSPACE,
      storageDir: tmpDir,
      config: {},
      workspace: {
        root: WORKSPACE,
        hasGit: false,
        languages: [],
        testRunners: [],
        gitignoreFilter: () => false,
      },
      logger,
    };

    const result = await codeSearch(
      { action: "search", query: "database connection", mode: "semantic", limit: 5 },
      ctx,
      symbolIndex,
      embeddingIndexer,
    ) as any;

    expect(result.success).toBe(true);
    expect(result.mode).toBe("semantic");
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("code_search stats action works", async () => {
    const ctx = {
      workspaceDir: WORKSPACE,
      storageDir: tmpDir,
      config: {},
      workspace: {
        root: WORKSPACE,
        hasGit: false,
        languages: [],
        testRunners: [],
        gitignoreFilter: () => false,
      },
      logger,
    };

    const result = await codeSearch(
      { action: "stats" },
      ctx,
      symbolIndex,
      embeddingIndexer,
    ) as any;

    expect(result.success).toBe(true);
    expect(result.totalSymbols).toBeGreaterThanOrEqual(TEST_SYMBOLS.length);
    expect(result.embeddingState).toBe("ready");
    expect(result.indexedEmbeddings).toBe(TEST_SYMBOLS.length);
  });
});
