import { describe, it, expect, beforeEach, vi } from "vitest";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { codeInspect, type CodeInspectParams } from "../tools/code-inspect.js";
import type { SymbolInfo, ToolContext, WorkspaceInfo } from "../core/types.js";
import type { LspManager } from "../core/lsp/manager.js";
import { LspResolver } from "../core/lsp/resolver.js";
import { pathToFileURL } from "node:url";

// ── Helpers ─────────────────────────────────────────────────────────────────

function sym(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    qualifiedName: "testFunc",
    kind: "function",
    filePath: "/project/src/test.ts",
    lines: [1, 5] as [number, number],
    signature: "function testFunc(): void",
    docs: null,
    ...overrides,
  };
}

function makeCtx(): ToolContext {
  return {
    workspaceDir: "/project",
    storageDir: "/tmp/dev-tools-test",
    config: {},
    workspace: {
      root: "/project",
      hasGit: true,
      languages: [],
      testRunners: [],
      gitignoreFilter: () => false,
    } as WorkspaceInfo,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

// Mock file system for LspResolver
const mockFiles = new Map<string, string>();

function createMockResolver(index: SymbolIndex) {
  return new LspResolver({
    symbolIndex: index,
    workspaceRoot: "/project",
    readFile: async (filePath: string) => {
      const content = mockFiles.get(filePath);
      if (content === undefined) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return content;
    },
  });
}

// Mock LspClient
function createMockClient(overrides: {
  hover?: unknown;
  definition?: unknown;
  references?: unknown;
} = {}) {
  return {
    ensureDocumentOpen: vi.fn().mockResolvedValue("file:///project/src/test.ts"),
    hover: vi.fn().mockResolvedValue(overrides.hover ?? null),
    definition: vi.fn().mockResolvedValue(overrides.definition ?? null),
    references: vi.fn().mockResolvedValue(overrides.references ?? null),
    state: "ready" as const,
    pid: 12345,
  };
}

// Mock LspManager
function createMockLspManager(client: ReturnType<typeof createMockClient> | null = null): LspManager {
  return {
    getClient: vi.fn().mockResolvedValue(client),
    getClientWithReason: vi.fn().mockResolvedValue({ client, reason: client ? undefined : { kind: "no_server_configured", language: "typescript" } }),
    notifyShellCommand: vi.fn(),
    startHealthChecks: vi.fn(),
    stopHealthChecks: vi.fn(),
    getStatus: vi.fn().mockReturnValue([]),
    getAvailableLanguages: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
  } as unknown as LspManager;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("code_inspect", () => {
  let index: SymbolIndex;
  let ctx: ToolContext;

  beforeEach(() => {
    index = new SymbolIndex();
    ctx = makeCtx();
    mockFiles.clear();

    // Standard file content
    mockFiles.set("/project/src/user.ts", [
      "import { DB } from './db';",
      "",
      "export class UserService {",
      "  private db: DB;",
      "",
      "  async authenticate(user: string) {",
      "    return this.db.check(user);",
      "  }",
      "",
      "  async register(user: string) {",
      "    return this.db.create(user);",
      "  }",
      "}",
    ].join("\n"));

    mockFiles.set("/project/src/utils.ts", [
      "export function helper() {",
      "  return 42;",
      "}",
    ].join("\n"));

    // Populate symbol index
    index.insert(sym({
      qualifiedName: "UserService",
      kind: "class",
      filePath: "/project/src/user.ts",
      lines: [3, 13],
      signature: "class UserService",
    }));
    index.insert(sym({
      qualifiedName: "UserService.authenticate",
      kind: "method",
      filePath: "/project/src/user.ts",
      lines: [6, 8],
      signature: "async authenticate(user: string)",
    }));
    index.insert(sym({
      qualifiedName: "helper",
      kind: "function",
      filePath: "/project/src/utils.ts",
      lines: [1, 3],
      signature: "function helper()",
    }));
  });

  // ── No LSP (index-only fallback) ────────────────────────────────────────

  describe("without LSP", () => {
    it("returns symbol info from index", async () => {
      const result = await codeInspect(
        { symbol: "UserService.authenticate" },
        ctx, index, null, null,
      );

      expect(result.success).toBe(true);
      expect(result.data!.symbol.qualifiedName).toBe("UserService.authenticate");
      expect(result.data!.symbol.kind).toBe("method");
      expect(result.data!.symbol.file).toBe("src/user.ts"); // relative
      expect(result.data!.lspAvailable).toBe(false);
      expect(result.data!.definition).toBeDefined();
      expect(result.data!.definition!.file).toBe("src/user.ts");
      expect(result.data!.definition!.line).toBe(6);
    });

    it("returns error for nonexistent symbol", async () => {
      const result = await codeInspect(
        { symbol: "nonexistent" },
        ctx, index, null, null,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Symbol not found");
    });

    it("returns error for ambiguous symbol without file hint", async () => {
      // Add duplicate
      index.insert(sym({
        qualifiedName: "helper",
        kind: "function",
        filePath: "/project/src/other.ts",
        lines: [1, 3],
      }));

      const result = await codeInspect(
        { symbol: "helper" },
        ctx, index, null, null,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Ambiguous");
    });

    it("resolves ambiguous symbol with file hint", async () => {
      index.insert(sym({
        qualifiedName: "helper",
        kind: "function",
        filePath: "/project/src/other.ts",
        lines: [1, 3],
      }));

      const result = await codeInspect(
        { symbol: "helper", file: "src/utils.ts" },
        ctx, index, null, null,
      );

      expect(result.success).toBe(true);
      expect(result.data!.symbol.file).toBe("src/utils.ts");
    });
  });

  // ── With LSP ────────────────────────────────────────────────────────────

  describe("with LSP", () => {
    it("combines hover + definition + references", async () => {
      const mockClient = createMockClient({
        hover: {
          contents: {
            kind: "markdown",
            value: "```typescript\n(method) UserService.authenticate(user: string): Promise<boolean>\n```\nAuthenticates a user against the database.",
          },
        },
        definition: [{
          uri: pathToFileURL("/project/src/user.ts").toString(),
          range: { start: { line: 5, character: 8 }, end: { line: 5, character: 20 } },
        }],
        references: [
          {
            uri: pathToFileURL("/project/src/main.ts").toString(),
            range: { start: { line: 10, character: 4 }, end: { line: 10, character: 16 } },
          },
          {
            uri: pathToFileURL("/project/src/test.ts").toString(),
            range: { start: { line: 5, character: 8 }, end: { line: 5, character: 20 } },
          },
        ],
      });

      // Mock reading main.ts and test.ts for previews
      mockFiles.set("/project/src/main.ts", [
        "import { UserService } from './user';",
        "",
        "const svc = new UserService(db);",
        "",
        "async function main() {",
        "  const result = await svc.authenticate('admin');",
        "  if (result) {",
        "    console.log('authenticated');",
        "  }",
        "}",
        "  await svc.authenticate(username);",
      ].join("\n"));

      mockFiles.set("/project/src/test.ts", [
        "import { UserService } from './user';",
        "",
        "describe('auth', () => {",
        "  it('works', async () => {",
        "    const svc = new UserService(mockDb);",
        "    const ok = await svc.authenticate('test');",
        "    expect(ok).toBe(true);",
        "  });",
        "});",
      ].join("\n"));

      const lspManager = createMockLspManager(mockClient as any);
      const resolver = createMockResolver(index);

      const result = await codeInspect(
        { symbol: "UserService.authenticate" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.lspAvailable).toBe(true);

      // Type from hover
      expect(result.data!.type).toContain("UserService.authenticate");
      expect(result.data!.type).toContain("Promise<boolean>");

      // Documentation from hover
      expect(result.data!.documentation).toContain("Authenticates a user");

      // Definition
      expect(result.data!.definition).toBeDefined();
      expect(result.data!.definition!.file).toBe("src/user.ts");
      expect(result.data!.definition!.line).toBe(6); // 0-indexed 5 → 1-indexed 6

      // References
      expect(result.data!.references).toHaveLength(2);
      expect(result.data!.references![0].file).toBe("src/main.ts");
      expect(result.data!.references![0].line).toBe(11); // 0-indexed 10 → 1-indexed 11
      // Preview is best-effort (reads from disk, which is mocked at resolver level, not tool level)
      expect(result.data!.referenceCount).toBe(2);
    });

    it("includes summary with type and ref count", async () => {
      const mockClient = createMockClient({
        hover: {
          contents: { kind: "markdown", value: "```typescript\nfunction helper(): number\n```" },
        },
        definition: [{
          uri: pathToFileURL("/project/src/utils.ts").toString(),
          range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
        }],
        references: [
          {
            uri: pathToFileURL("/project/src/utils.ts").toString(),
            range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
          },
        ],
      });

      const lspManager = createMockLspManager(mockClient as any);
      const resolver = createMockResolver(index);

      const result = await codeInspect(
        { symbol: "helper" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      expect(result.summary).toContain("function helper");
      expect(result.summary).toContain("reference");
    });

    it("falls back to index when LSP client unavailable", async () => {
      const lspManager = createMockLspManager(null); // getClient returns null
      const resolver = createMockResolver(index);

      const result = await codeInspect(
        { symbol: "UserService" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.lspAvailable).toBe(false);
    });

    it("respects includeReferences=false", async () => {
      const mockClient = createMockClient({
        hover: { contents: "some type info" },
        definition: null,
      });

      const lspManager = createMockLspManager(mockClient as any);
      const resolver = createMockResolver(index);

      const result = await codeInspect(
        { symbol: "helper", includeReferences: false },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      // references() should not have been called
      expect(mockClient.references).not.toHaveBeenCalled();
      expect(result.data!.references).toBeUndefined();
    });

    it("caps references at maxReferences", async () => {
      const manyRefs = Array.from({ length: 50 }, (_, i) => ({
        uri: pathToFileURL("/project/src/utils.ts").toString(),
        range: { start: { line: i, character: 0 }, end: { line: i, character: 6 } },
      }));

      const mockClient = createMockClient({
        hover: null,
        definition: null,
        references: manyRefs,
      });

      const lspManager = createMockLspManager(mockClient as any);
      const resolver = createMockResolver(index);

      const result = await codeInspect(
        { symbol: "helper", maxReferences: 5 },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.references).toHaveLength(5);
      expect(result.data!.referenceCount).toBe(50); // total count preserved
    });

    it("handles LSP hover with plain string contents", async () => {
      const mockClient = createMockClient({
        hover: { contents: "const x: number" },
      });

      const lspManager = createMockLspManager(mockClient as any);
      const resolver = createMockResolver(index);

      const result = await codeInspect(
        { symbol: "helper" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.type).toBe("const x: number");
    });

    it("handles LSP hover with array contents", async () => {
      const mockClient = createMockClient({
        hover: {
          contents: [
            { language: "typescript", value: "function helper(): number" },
            "Returns a magic number",
          ],
        },
      });

      const lspManager = createMockLspManager(mockClient as any);
      const resolver = createMockResolver(index);

      const result = await codeInspect(
        { symbol: "helper" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.type).toContain("helper");
    });

    it("handles LocationLink definition format", async () => {
      const mockClient = createMockClient({
        hover: null,
        definition: [{
          targetUri: pathToFileURL("/project/src/utils.ts").toString(),
          targetRange: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
          targetSelectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
        }],
      });

      const lspManager = createMockLspManager(mockClient as any);
      const resolver = createMockResolver(index);

      const result = await codeInspect(
        { symbol: "helper" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.definition).toBeDefined();
      expect(result.data!.definition!.file).toBe("src/utils.ts");
      // Uses targetSelectionRange (more precise)
      expect(result.data!.definition!.line).toBe(1); // 0-indexed 0 → 1-indexed 1
    });

    it("reports drifted position", async () => {
      // Modify file so symbol moved
      mockFiles.set("/project/src/user.ts", [
        "// new comment added",
        "// another comment",
        "import { DB } from './db';",
        "",
        "export class UserService {",
        "  private db: DB;",
        "",
        "  async authenticate(user: string) {",
        "    return this.db.check(user);",
        "  }",
        "}",
      ].join("\n"));

      const mockClient = createMockClient({
        hover: { contents: "type info" },
      });

      const lspManager = createMockLspManager(mockClient as any);
      const resolver = createMockResolver(index);

      const result = await codeInspect(
        { symbol: "UserService.authenticate" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.drifted).toBe(true);
    });

    it("handles LSP request failures gracefully", async () => {
      const mockClient = createMockClient();
      mockClient.hover.mockRejectedValue(new Error("LSP hover failed"));
      mockClient.definition.mockRejectedValue(new Error("LSP definition failed"));
      mockClient.references.mockRejectedValue(new Error("LSP references failed"));

      const lspManager = createMockLspManager(mockClient as any);
      const resolver = createMockResolver(index);

      const result = await codeInspect(
        { symbol: "helper" },
        ctx, index, lspManager, resolver,
      );

      // Should still succeed — individual LSP failures don't break the tool
      expect(result.success).toBe(true);
      expect(result.data!.lspAvailable).toBe(true);
      expect(result.data!.type).toBeUndefined();
      expect(result.data!.definition).toBeUndefined();
      expect(result.data!.references).toBeUndefined();
    });
  });
});
