import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { DiagnosticsCollector } from "../core/lsp/diagnostics.js";
import { LspResolver } from "../core/lsp/resolver.js";
import { codeRefactor } from "../tools/code-refactor.js";
import type { SymbolInfo, ToolContext, WorkspaceInfo } from "../core/types.js";
import type { LspManager } from "../core/lsp/manager.js";
import type { WorkspaceEdit, CodeAction, Diagnostic } from "vscode-languageserver-protocol";

// ── Test workspace on disk (for file edit tests) ────────────────────────────

let tmpDir: string;

async function setupTmpWorkspace() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-tools-refactor-"));
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });

  await fs.writeFile(path.join(tmpDir, "src", "user.ts"), [
    'import { DB } from "./db";',
    "",
    "export class UserService {",
    "  private db: DB;",
    "",
    "  async authenticate(user: string) {",
    "    return this.db.check(user);",
    "  }",
    "}",
  ].join("\n"));

  await fs.writeFile(path.join(tmpDir, "src", "main.ts"), [
    'import { UserService } from "./user";',
    "",
    "const svc = new UserService(db);",
    "svc.authenticate('admin');",
  ].join("\n"));
}

async function cleanupTmp() {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sym(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    qualifiedName: "testFunc",
    kind: "function",
    filePath: path.join(tmpDir, "src", "test.ts"),
    lines: [1, 5] as [number, number],
    signature: "function testFunc(): void",
    docs: null,
    ...overrides,
  };
}

function makeCtx(): ToolContext {
  return {
    workspaceDir: tmpDir,
    storageDir: path.join(tmpDir, ".dev-tools"),
    config: {},
    workspace: {
      root: tmpDir,
      hasGit: false,
      languages: [],
      testRunners: [],
      gitignoreFilter: () => false,
    } as WorkspaceInfo,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
}

function createMockClient(overrides: {
  rename?: WorkspaceEdit | null;
  codeAction?: (CodeAction | { title: string })[] | null;
} = {}) {
  return {
    ensureDocumentOpen: vi.fn().mockResolvedValue("uri"),
    rename: vi.fn().mockResolvedValue(overrides.rename ?? null),
    codeAction: vi.fn().mockResolvedValue(overrides.codeAction ?? null),
    state: "ready" as const,
  };
}

function createMockLspManager(
  client: ReturnType<typeof createMockClient> | null = null,
  collector?: DiagnosticsCollector,
): LspManager {
  return {
    getClient: vi.fn().mockResolvedValue(client),
    getClientWithReason: vi.fn().mockResolvedValue({ client, reason: client ? undefined : { kind: "no_server_configured", language: "typescript" } }),
    diagnostics: collector ?? new DiagnosticsCollector(),
    notifyShellCommand: vi.fn(),
    startHealthChecks: vi.fn(),
    stopHealthChecks: vi.fn(),
    getStatus: vi.fn().mockReturnValue([]),
    getAvailableLanguages: vi.fn().mockReturnValue([]),
    restartAll: vi.fn(),
    dispose: vi.fn(),
  } as unknown as LspManager;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("code_refactor", () => {
  let index: SymbolIndex;
  let ctx: ToolContext;

  beforeEach(async () => {
    await setupTmpWorkspace();
    index = new SymbolIndex();
    ctx = makeCtx();
  });

  afterEach(async () => {
    await cleanupTmp();
  });

  it("returns error when LSP not available", async () => {
    const result = await codeRefactor(
      { action: "rename", symbol: "foo", newName: "bar" },
      ctx, index, null, null,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("LSP not available");
  });

  // ── Rename ────────────────────────────────────────────────────────────

  describe("rename", () => {
    it("renames a symbol across files", async () => {
      const userFile = path.join(tmpDir, "src", "user.ts");
      const mainFile = path.join(tmpDir, "src", "main.ts");

      index.insert(sym({
        qualifiedName: "UserService.authenticate",
        kind: "method",
        filePath: userFile,
        lines: [6, 8],
        signature: "async authenticate(user: string)",
      }));

      // Mock LSP returning workspace edits for both files
      const mockEdit: WorkspaceEdit = {
        changes: {
          [pathToFileURL(userFile).toString()]: [{
            range: { start: { line: 5, character: 8 }, end: { line: 5, character: 20 } },
            newText: "login",
          }],
          [pathToFileURL(mainFile).toString()]: [{
            range: { start: { line: 3, character: 4 }, end: { line: 3, character: 16 } },
            newText: "login",
          }],
        },
      };

      const mockClient = createMockClient({ rename: mockEdit });
      const lspManager = createMockLspManager(mockClient as any);
      const resolver = new LspResolver({
        symbolIndex: index,
        workspaceRoot: tmpDir,
      });

      const result = await codeRefactor(
        { action: "rename", symbol: "UserService.authenticate", newName: "login" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.action).toBe("rename");
      expect(result.data!.changes).toHaveLength(2);
      expect(result.data!.totalEdits).toBe(2);
      expect(result.data!.message).toContain("login");

      // Verify files were actually modified
      const userContent = await fs.readFile(userFile, "utf-8");
      expect(userContent).toContain("login");
      expect(userContent).not.toContain("authenticate");

      const mainContent = await fs.readFile(mainFile, "utf-8");
      expect(mainContent).toContain("login");
    });

    it("requires symbol parameter", async () => {
      const lspManager = createMockLspManager();
      const result = await codeRefactor(
        { action: "rename", newName: "bar" },
        ctx, index, lspManager, null,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("symbol");
    });

    it("requires newName parameter", async () => {
      const lspManager = createMockLspManager();
      const resolver = new LspResolver({ symbolIndex: index, workspaceRoot: tmpDir });
      const result = await codeRefactor(
        { action: "rename", symbol: "foo" },
        ctx, index, lspManager, resolver,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("newName");
    });

    it("handles LSP rename failure", async () => {
      const userFile = path.join(tmpDir, "src", "user.ts");
      index.insert(sym({
        qualifiedName: "UserService",
        kind: "class",
        filePath: userFile,
        lines: [3, 9],
      }));

      const mockClient = createMockClient();
      mockClient.rename.mockRejectedValue(new Error("Cannot rename built-in"));
      const lspManager = createMockLspManager(mockClient as any);
      const resolver = new LspResolver({ symbolIndex: index, workspaceRoot: tmpDir });

      const result = await codeRefactor(
        { action: "rename", symbol: "UserService", newName: "AuthService" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("LSP rename failed");
    });
  });

  // ── Organize Imports ──────────────────────────────────────────────────

  describe("organize_imports", () => {
    it("organizes imports in a file", async () => {
      const mainFile = path.join(tmpDir, "src", "main.ts");

      // Write a file with messy imports
      await fs.writeFile(mainFile, [
        'import { z } from "zod";',
        'import { a } from "alib";',
        "",
        "const x = a + z;",
      ].join("\n"));

      const organizeAction: CodeAction = {
        title: "Organize Imports",
        kind: "source.organizeImports",
        edit: {
          changes: {
            [pathToFileURL(mainFile).toString()]: [{
              range: { start: { line: 0, character: 0 }, end: { line: 1, character: 25 } },
              newText: 'import { a } from "alib";\nimport { z } from "zod";',
            }],
          },
        },
      };

      const mockClient = createMockClient({ codeAction: [organizeAction] });
      const lspManager = createMockLspManager(mockClient as any);

      const result = await codeRefactor(
        { action: "organize_imports", path: "src/main.ts" },
        ctx, index, lspManager, null,
      );

      expect(result.success).toBe(true);
      expect(result.data!.action).toBe("organize_imports");
      expect(result.data!.totalEdits).toBe(1);

      const content = await fs.readFile(mainFile, "utf-8");
      expect(content).toContain('import { a } from "alib";\nimport { z } from "zod";');
    });

    it("requires path parameter", async () => {
      const lspManager = createMockLspManager();
      const result = await codeRefactor(
        { action: "organize_imports" },
        ctx, index, lspManager, null,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("path");
    });

    it("handles no organize action available", async () => {
      const mockClient = createMockClient({ codeAction: [] });
      const lspManager = createMockLspManager(mockClient as any);

      const result = await codeRefactor(
        { action: "organize_imports", path: "src/main.ts" },
        ctx, index, lspManager, null,
      );

      expect(result.success).toBe(true);
      expect(result.data!.totalEdits).toBe(0);
    });
  });

  // ── Apply Fix ─────────────────────────────────────────────────────────

  describe("apply_fix", () => {
    it("applies a quickfix from diagnostics", async () => {
      const mainFile = path.join(tmpDir, "src", "main.ts");
      const mainUri = pathToFileURL(mainFile).toString();

      // Seed diagnostics
      const collector = new DiagnosticsCollector();
      const diag: Diagnostic = {
        range: { start: { line: 2, character: 6 }, end: { line: 2, character: 9 } },
        message: "'svc' is declared but never used",
        severity: 2,
        source: "typescript",
        code: 6133,
      };
      collector.onDiagnostics({ uri: mainUri, diagnostics: [diag] });

      // Mock LSP returning a quickfix
      const fixAction: CodeAction = {
        title: "Remove unused variable",
        kind: "quickfix",
        edit: {
          changes: {
            [mainUri]: [{
              range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } },
              newText: "",
            }],
          },
        },
      };

      const mockClient = createMockClient({ codeAction: [fixAction] });
      const lspManager = createMockLspManager(mockClient as any, collector);

      const result = await codeRefactor(
        { action: "apply_fix", fixFile: "src/main.ts", fixLine: 3 }, // 1-indexed
        ctx, index, lspManager, null,
      );

      expect(result.success).toBe(true);
      expect(result.data!.action).toBe("apply_fix");
      expect(result.data!.message).toContain("Remove unused variable");
    });

    it("requires fixFile parameter", async () => {
      const lspManager = createMockLspManager();
      const result = await codeRefactor(
        { action: "apply_fix", fixLine: 5 },
        ctx, index, lspManager, null,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("fixFile");
    });

    it("requires fixLine parameter", async () => {
      const lspManager = createMockLspManager();
      const result = await codeRefactor(
        { action: "apply_fix", fixFile: "src/main.ts" },
        ctx, index, lspManager, null,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("fixLine");
    });

    it("returns error when no diagnostics at line", async () => {
      const collector = new DiagnosticsCollector();
      const mockClient = createMockClient();
      const lspManager = createMockLspManager(mockClient as any, collector);

      const result = await codeRefactor(
        { action: "apply_fix", fixFile: "src/main.ts", fixLine: 5 },
        ctx, index, lspManager, null,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No diagnostics found");
    });
  });

  // ── Workspace Edit Application ────────────────────────────────────────

  describe("workspace edit application", () => {
    it("handles documentChanges format", async () => {
      const userFile = path.join(tmpDir, "src", "user.ts");
      index.insert(sym({
        qualifiedName: "UserService",
        kind: "class",
        filePath: userFile,
        lines: [3, 9],
      }));

      const mockEdit: WorkspaceEdit = {
        documentChanges: [
          {
            textDocument: { uri: pathToFileURL(userFile).toString(), version: 1 },
            edits: [{
              range: { start: { line: 2, character: 13 }, end: { line: 2, character: 24 } },
              newText: "AuthService",
            }],
          },
        ],
      };

      const mockClient = createMockClient({ rename: mockEdit });
      const lspManager = createMockLspManager(mockClient as any);
      const resolver = new LspResolver({ symbolIndex: index, workspaceRoot: tmpDir });

      const result = await codeRefactor(
        { action: "rename", symbol: "UserService", newName: "AuthService" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      const content = await fs.readFile(userFile, "utf-8");
      expect(content).toContain("AuthService");
      expect(content).not.toContain("UserService");
    });

    it("handles multi-edit in single file (bottom-up application)", async () => {
      const userFile = path.join(tmpDir, "src", "user.ts");
      index.insert(sym({
        qualifiedName: "UserService",
        kind: "class",
        filePath: userFile,
        lines: [3, 9],
      }));

      // Two edits in the same file at different lines
      const mockEdit: WorkspaceEdit = {
        changes: {
          [pathToFileURL(userFile).toString()]: [
            {
              range: { start: { line: 2, character: 13 }, end: { line: 2, character: 24 } },
              newText: "AuthService",
            },
            {
              range: { start: { line: 5, character: 8 }, end: { line: 5, character: 20 } },
              newText: "login",
            },
          ],
        },
      };

      const mockClient = createMockClient({ rename: mockEdit });
      const lspManager = createMockLspManager(mockClient as any);
      const resolver = new LspResolver({ symbolIndex: index, workspaceRoot: tmpDir });

      const result = await codeRefactor(
        { action: "rename", symbol: "UserService", newName: "AuthService" },
        ctx, index, lspManager, resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.totalEdits).toBe(2);

      const content = await fs.readFile(userFile, "utf-8");
      expect(content).toContain("AuthService");
      expect(content).toContain("login");
    });
  });
});
