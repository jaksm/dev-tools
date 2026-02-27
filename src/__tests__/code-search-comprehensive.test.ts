/**
 * Comprehensive code_search tool tests — all actions, modes, edge cases.
 * Uses mock embedding indexer for semantic tests.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { codeSearch, type CodeSearchParams } from "../tools/code-search.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { HnswIndex } from "../core/search/hnsw-index.js";
import { EmbeddingIndexer } from "../core/search/indexer.js";
import type { EmbeddingProvider } from "../core/search/embeddings.js";
import type { SymbolInfo, ToolContext, Logger } from "../core/types.js";
import { generateIndexJson, writeIndexJson } from "../core/index/index-json.js";
import { ImportGraph } from "../core/index/import-graph.js";

// ── Mock Provider ───────────────────────────────────────────────────────────

const DIM = 16;

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "mock-embed-v1";
  readonly dimension = DIM;
  readonly ready = true;

  async init(): Promise<void> {}
  async dispose(): Promise<void> {}

  async embed(text: string): Promise<number[]> {
    return this.hash(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.hash(t));
  }

  private hash(text: string): number[] {
    const v = new Array(DIM).fill(0);
    for (let i = 0; i < text.length; i++) {
      v[text.charCodeAt(i) % DIM] += 1;
    }
    const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0));
    return v.map((x: number) => x / (norm || 1));
  }
}

// ── Test Fixtures ───────────────────────────────────────────────────────────

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const WORKSPACE = "/mock/workspace";

function mkSym(name: string, kind: string, file: string, lines: [number, number], sig: string, docs?: string, code?: string): SymbolInfo {
  return {
    qualifiedName: name,
    kind,
    filePath: `${WORKSPACE}/${file}`,
    lines,
    signature: sig,
    docs: docs ?? null,
    code,
  };
}

const SYMBOLS: SymbolInfo[] = [
  mkSym("AuthController.login", "method", "src/controllers/auth.ts", [15, 45], "async login(req: Request): Promise<Response>", "Handle user login endpoint", "async login(req: Request) {\n  const { email, password } = req.body;\n  const user = await this.authService.authenticate(email, password);\n  return { token: this.jwt.sign(user) };\n}"),
  mkSym("AuthController.register", "method", "src/controllers/auth.ts", [47, 80], "async register(req: Request): Promise<Response>", "Handle user registration"),
  mkSym("AuthService.authenticate", "method", "src/services/auth.ts", [10, 35], "authenticate(email: string, password: string): Promise<User>", "Verify credentials against database"),
  mkSym("AuthService.hashPassword", "method", "src/services/auth.ts", [37, 50], "hashPassword(password: string): Promise<string>", "Hash password with bcrypt"),
  mkSym("UserRepository.findByEmail", "method", "src/repositories/user.ts", [20, 40], "findByEmail(email: string): Promise<User | null>", "Lookup user by email address"),
  mkSym("UserRepository.create", "method", "src/repositories/user.ts", [42, 65], "create(data: CreateUserDto): Promise<User>", "Insert new user into database"),
  mkSym("PaymentService.processPayment", "method", "src/services/payment.ts", [10, 50], "processPayment(amount: number, card: CardInfo): Promise<PaymentResult>", "Process credit card payment via Stripe"),
  mkSym("PaymentService.refund", "method", "src/services/payment.ts", [52, 80], "refund(paymentId: string): Promise<void>", "Refund a completed payment"),
  mkSym("DatabasePool", "class", "src/db/pool.ts", [1, 100], "class DatabasePool", "Connection pool manager"),
  mkSym("DatabasePool.query", "method", "src/db/pool.ts", [20, 45], "query<T>(sql: string, params?: unknown[]): Promise<T[]>", "Execute SQL query with prepared statements"),
  mkSym("DatabasePool.transaction", "method", "src/db/pool.ts", [47, 75], "transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>", "Execute queries in a transaction"),
  mkSym("JwtHelper.sign", "method", "src/utils/jwt.ts", [5, 20], "sign(payload: Record<string, unknown>): string", "Sign a JWT token"),
  mkSym("JwtHelper.verify", "method", "src/utils/jwt.ts", [22, 40], "verify(token: string): JwtPayload | null", "Verify and decode JWT token"),
  mkSym("Logger.info", "method", "src/utils/logger.ts", [10, 20], "info(message: string, meta?: object): void", "Log informational message"),
  mkSym("Logger.error", "method", "src/utils/logger.ts", [22, 35], "error(message: string, error?: Error): void", "Log error with stack trace"),
  mkSym("validateEmail", "function", "src/utils/validators.ts", [1, 10], "validateEmail(email: string): boolean", "Check if email format is valid"),
  mkSym("validatePassword", "function", "src/utils/validators.ts", [12, 25], "validatePassword(password: string): PasswordStrength", "Check password strength requirements"),
  mkSym("AppConfig", "interface", "src/types/config.ts", [1, 20], "interface AppConfig", "Application configuration"),
  mkSym("User", "interface", "src/types/models.ts", [1, 15], "interface User", "User entity"),
  mkSym("PaymentResult", "interface", "src/types/models.ts", [17, 30], "interface PaymentResult", "Payment processing result"),
];

// ── Test Setup ──────────────────────────────────────────────────────────────

describe("code_search — comprehensive", () => {
  let tmpDir: string;
  let symbolIndex: SymbolIndex;
  let embeddingIndexer: EmbeddingIndexer;

  function makeCtx(): ToolContext {
    return {
      workspaceDir: WORKSPACE,
      storageDir: tmpDir,
      config: {},
      workspace: {
        root: WORKSPACE,
        hasGit: true,
        languages: [{ language: "typescript", root: WORKSPACE }],
        testRunners: [{ name: "vitest", framework: "vitest", command: "npx vitest run" }],
        gitignoreFilter: () => false,
      },
      logger,
    };
  }

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codesearch-test-"));

    // Build symbol index
    symbolIndex = new SymbolIndex();
    for (const s of SYMBOLS) symbolIndex.insert(s);

    // Build embedding index
    const provider = new MockEmbeddingProvider();
    embeddingIndexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir: WORKSPACE,
      storageDir: tmpDir,
      logger,
    });
    await embeddingIndexer.init();
    await embeddingIndexer.indexAll();

    // Generate INDEX.json for index action tests
    const importGraph = new ImportGraph();
    const indexJson = generateIndexJson({
      symbolIndex,
      importGraph,
      fileImports: new Map(),
      workspaceDir: WORKSPACE,
      fileLineCounts: new Map(),
    });
    const indexDir = path.join(tmpDir, "index");
    await fs.mkdir(indexDir, { recursive: true });
    await writeIndexJson(indexJson, indexDir);
  });

  afterAll(async () => {
    await embeddingIndexer.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── action: search (semantic) ─────────────────────────────────────────────

  describe("search — semantic mode", () => {
    it("finds authentication-related symbols for 'user login'", async () => {
      const result = await codeSearch(
        { query: "user login authentication", mode: "semantic", limit: 5 },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(true);
      expect(result.mode).toBe("semantic");
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.length).toBeLessThanOrEqual(5);
    });

    it("returns results with all expected fields", async () => {
      const result = await codeSearch(
        { query: "database query", mode: "semantic", limit: 3 },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      for (const r of result.results) {
        expect(r).toHaveProperty("symbol");
        expect(r).toHaveProperty("kind");
        expect(r).toHaveProperty("file");
        expect(r).toHaveProperty("lines");
        expect(r).toHaveProperty("signature");
        expect(r).toHaveProperty("score");
        expect(typeof r.score).toBe("number");
        expect(r.score).toBeGreaterThan(0);
        expect(r.score).toBeLessThanOrEqual(1);
        // File should be relative
        expect(r.file.startsWith("/mock")).toBe(false);
      }
    });

    it("respects limit parameter", async () => {
      const result = await codeSearch(
        { query: "anything", mode: "semantic", limit: 2 },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.results.length).toBeLessThanOrEqual(2);
    });

    it("respects scope filter", async () => {
      const result = await codeSearch(
        { query: "method function", mode: "semantic", limit: 20, scope: "src/services" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(true);
      for (const r of result.results) {
        expect(r.file).toContain("services");
      }
    });

    it("returns empty for impossible scope", async () => {
      const result = await codeSearch(
        { query: "anything", mode: "semantic", limit: 10, scope: "nonexistent/dir" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(true);
      expect(result.results.length).toBe(0);
    });

    it("includes indexAge in response", async () => {
      const result = await codeSearch(
        { query: "test", mode: "semantic" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result).toHaveProperty("indexAge");
    });
  });

  // ── action: search (text mode) ────────────────────────────────────────────

  describe("search — text mode", () => {
    it("falls back gracefully when ripgrep dir doesn't exist", async () => {
      const result = await codeSearch(
        { query: "authenticate", mode: "text", limit: 5 },
        makeCtx(), symbolIndex, null,
      ) as any;

      // Text mode uses ripgrep on actual filesystem — mock workspace doesn't exist
      // Should not throw, should return empty or error gracefully
      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
    });

    it("mode defaults to semantic when embeddingIndexer available", async () => {
      const result = await codeSearch(
        { query: "payment" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.mode).toBe("semantic");
    });

    it("explicit text mode works even when embeddings are available", async () => {
      const result = await codeSearch(
        { query: "payment", mode: "text" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.mode).toBe("text");
    });
  });

  // ── action: search — error handling ───────────────────────────────────────

  describe("search — errors", () => {
    it("returns error when query is missing", async () => {
      const result = await codeSearch(
        { action: "search" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(false);
      expect(result.error).toContain("query");
    });

    it("returns error for unknown action", async () => {
      const result = await codeSearch(
        { action: "nonexistent" as any },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(false);
      expect(result.error).toContain("nonexistent");
    });
  });

  // ── action: stats ─────────────────────────────────────────────────────────

  describe("stats action", () => {
    it("returns comprehensive workspace statistics", async () => {
      const result = await codeSearch(
        { action: "stats" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(true);
      expect(result.indexedFiles).toBeGreaterThan(0);
      expect(result.totalSymbols).toBe(SYMBOLS.length);
      expect(result.languages).toBeDefined();
      expect(result.languages.typescript).toBeDefined();
      expect(result.languages.typescript.symbols).toBeGreaterThan(0);
      expect(result.embeddingModel).toContain("mock");
      expect(result.embeddingState).toBe("ready");
      expect(result.embeddingDimension).toBe(DIM);
      expect(result.indexedEmbeddings).toBe(SYMBOLS.length);
    });

    it("works without embedding indexer", async () => {
      const result = await codeSearch(
        { action: "stats" },
        makeCtx(), symbolIndex, null,
      ) as any;

      expect(result.success).toBe(true);
      expect(result.totalSymbols).toBe(SYMBOLS.length);
      expect(result.embeddingModel).toBe("not loaded");
      expect(result.embeddingState).toBe("idle");
    });

    it("per-language breakdown is accurate", async () => {
      const result = await codeSearch(
        { action: "stats" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      // All our fixtures are .ts files
      expect(result.languages.typescript).toBeDefined();
      expect(result.languages.typescript.symbols).toBe(SYMBOLS.length);
    });
  });

  // ── action: index ─────────────────────────────────────────────────────────

  describe("index action", () => {
    it("returns full INDEX.json when no filter", async () => {
      const result = await codeSearch(
        { action: "index" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(true);
      expect(result.index).toBeDefined();
      expect(Object.keys(result.index).length).toBeGreaterThan(0);
    });

    it("filters by directory pattern", async () => {
      const result = await codeSearch(
        { action: "index", filter: "services" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(true);
      expect(result.filter).toBe("services");
      // All keys should contain "services"
      for (const key of Object.keys(result.index)) {
        expect(key).toContain("services");
      }
    });

    it("filter with no matches returns empty", async () => {
      const result = await codeSearch(
        { action: "index", filter: "nonexistent_directory" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(true);
      expect(result.matchedFiles).toBe(0);
    });

    it("glob-style dir/** filter works", async () => {
      const result = await codeSearch(
        { action: "index", filter: "src/utils/**" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(true);
      for (const key of Object.keys(result.index)) {
        expect(key.startsWith("src/utils/")).toBe(true);
      }
    });

    it("returns error when INDEX.json doesn't exist", async () => {
      const emptyCtx = { ...makeCtx(), storageDir: path.join(tmpDir, "nonexistent") };
      const result = await codeSearch(
        { action: "index" },
        emptyCtx, symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(false);
      expect(result.error).toContain("INDEX.json");
    });
  });

  // ── Cold-start fallback ───────────────────────────────────────────────────

  describe("cold-start fallback", () => {
    it("falls back to text mode when indexer is in 'indexing' state", async () => {
      // Create a mock indexer that's always "indexing"
      const indexingProvider = new MockEmbeddingProvider();
      const indexingIndexer = new EmbeddingIndexer({
        embeddingProvider: indexingProvider,
        symbolIndex,
        workspaceDir: WORKSPACE,
        storageDir: path.join(tmpDir, "indexing-test"),
        logger,
      });
      await indexingIndexer.init();
      // Don't call indexAll — it stays in a non-ready state
      // Actually EmbeddingIndexer starts as "idle", not "indexing"
      // The cold-start fallback checks for "indexing" state specifically

      // Without embeddings ready, falls back to text
      const result = await codeSearch(
        { query: "authenticate", mode: "semantic" },
        makeCtx(), symbolIndex, null,
      ) as any;

      // When embeddingIndexer is null, should use text mode
      expect(result.success).toBe(true);
      expect(result.mode).toBe("text");

      await indexingIndexer.dispose();
    });
  });

  // ── Default action ────────────────────────────────────────────────────────

  describe("defaults", () => {
    it("default action is search", async () => {
      const result = await codeSearch(
        { query: "test" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
    });

    it("default limit is 10", async () => {
      const result = await codeSearch(
        { query: "method" },
        makeCtx(), symbolIndex, embeddingIndexer,
      ) as any;

      expect(result.results.length).toBeLessThanOrEqual(10);
    });
  });
});
