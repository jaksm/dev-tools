import { describe, it, expect, beforeEach, vi } from "vitest";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { DiagnosticsCollector } from "../core/lsp/diagnostics.js";
import { codeDiagnose } from "../tools/code-diagnose.js";
import type { ToolContext, WorkspaceInfo } from "../core/types.js";
import type { LspManager, ServerStatus } from "../core/lsp/manager.js";
import type { EmbeddingIndexer } from "../core/search/indexer.js";
import type { PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import { pathToFileURL } from "node:url";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(): ToolContext {
  return {
    workspaceDir: "/project",
    storageDir: "/tmp/dev-tools-test",
    config: {},
    workspace: {
      root: "/project",
      hasGit: true,
      languages: [{ language: "typescript", root: "/project", configFile: "tsconfig.json" }],
      testRunners: [],
      gitignoreFilter: () => false,
    } as WorkspaceInfo,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
}

function makeDiagnosticsParams(uri: string, diagnostics: Array<{
  line: number;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
}>): PublishDiagnosticsParams {
  return {
    uri,
    diagnostics: diagnostics.map(d => ({
      range: {
        start: { line: d.line, character: 0 },
        end: { line: d.line, character: 10 },
      },
      message: d.message,
      severity: d.severity ?? 1,
      source: d.source,
      code: d.code,
    })),
  };
}

function createMockLspManager(
  collector: DiagnosticsCollector,
  statuses: ServerStatus[] = [],
): LspManager {
  return {
    diagnostics: collector,
    getClient: vi.fn().mockResolvedValue(null),
    getStatus: vi.fn().mockReturnValue(statuses),
    getAvailableLanguages: vi.fn().mockReturnValue(["typescript"]),
    restartAll: vi.fn().mockResolvedValue(undefined),
    notifyShellCommand: vi.fn(),
    startHealthChecks: vi.fn(),
    stopHealthChecks: vi.fn(),
    dispose: vi.fn(),
  } as unknown as LspManager;
}

function createMockEmbeddingIndexer(state: string = "ready"): EmbeddingIndexer {
  return {
    getStats: vi.fn().mockReturnValue({
      state,
      embeddingModel: "all-MiniLM-L6-v2",
      indexedSymbols: 150,
      totalSymbols: 150,
    }),
    progress: { indexed: 150, total: 150 },
  } as unknown as EmbeddingIndexer;
}

// ── Tests: DiagnosticsCollector ─────────────────────────────────────────────

describe("DiagnosticsCollector", () => {
  let collector: DiagnosticsCollector;

  beforeEach(() => {
    collector = new DiagnosticsCollector();
  });

  it("stores diagnostics from publishDiagnostics", () => {
    const uri = pathToFileURL("/project/src/main.ts").toString();
    collector.onDiagnostics(makeDiagnosticsParams(uri, [
      { line: 5, message: "Type error", severity: 1 },
      { line: 10, message: "Unused variable", severity: 2 },
    ]));

    expect(collector.size).toBe(1);
    const results = collector.query({ severity: "all" });
    expect(results).toHaveLength(2);
    expect(results[0].message).toBe("Type error");
    expect(results[0].severityLabel).toBe("error");
    expect(results[1].message).toBe("Unused variable");
    expect(results[1].severityLabel).toBe("warning");
  });

  it("replaces diagnostics for same URI", () => {
    const uri = pathToFileURL("/project/src/main.ts").toString();
    collector.onDiagnostics(makeDiagnosticsParams(uri, [
      { line: 5, message: "Old error" },
    ]));
    collector.onDiagnostics(makeDiagnosticsParams(uri, [
      { line: 8, message: "New error" },
    ]));

    const results = collector.query({ severity: "all" });
    expect(results).toHaveLength(1);
    expect(results[0].message).toBe("New error");
  });

  it("clears diagnostics when empty array received", () => {
    const uri = pathToFileURL("/project/src/main.ts").toString();
    collector.onDiagnostics(makeDiagnosticsParams(uri, [
      { line: 5, message: "Error" },
    ]));
    collector.onDiagnostics({ uri, diagnostics: [] });

    expect(collector.size).toBe(0);
  });

  it("filters by severity", () => {
    const uri = pathToFileURL("/project/src/main.ts").toString();
    collector.onDiagnostics(makeDiagnosticsParams(uri, [
      { line: 1, message: "Error", severity: 1 },
      { line: 2, message: "Warning", severity: 2 },
      { line: 3, message: "Info", severity: 3 },
      { line: 4, message: "Hint", severity: 4 },
    ]));

    expect(collector.query({ severity: "error" })).toHaveLength(1);
    expect(collector.query({ severity: "warning" })).toHaveLength(2);
    expect(collector.query({ severity: "info" })).toHaveLength(3);
    expect(collector.query({ severity: "all" })).toHaveLength(4);
  });

  it("filters by file", () => {
    collector.onDiagnostics(makeDiagnosticsParams(
      pathToFileURL("/project/src/a.ts").toString(),
      [{ line: 1, message: "Error A" }],
    ));
    collector.onDiagnostics(makeDiagnosticsParams(
      pathToFileURL("/project/src/b.ts").toString(),
      [{ line: 1, message: "Error B" }],
    ));

    const results = collector.query({ file: "a.ts", severity: "all" });
    expect(results).toHaveLength(1);
    expect(results[0].message).toBe("Error A");
  });

  it("filters by directory", () => {
    collector.onDiagnostics(makeDiagnosticsParams(
      pathToFileURL("/project/src/auth/login.ts").toString(),
      [{ line: 1, message: "Auth error" }],
    ));
    collector.onDiagnostics(makeDiagnosticsParams(
      pathToFileURL("/project/src/db/connect.ts").toString(),
      [{ line: 1, message: "DB error" }],
    ));

    const results = collector.query({ directory: "auth", severity: "all" });
    expect(results).toHaveLength(1);
    expect(results[0].message).toBe("Auth error");
  });

  it("respects limit", () => {
    const uri = pathToFileURL("/project/src/main.ts").toString();
    collector.onDiagnostics(makeDiagnosticsParams(uri, [
      { line: 1, message: "E1", severity: 1 },
      { line: 2, message: "E2", severity: 1 },
      { line: 3, message: "E3", severity: 1 },
    ]));

    const results = collector.query({ severity: "all", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("sorts errors before warnings before info", () => {
    const uri = pathToFileURL("/project/src/main.ts").toString();
    collector.onDiagnostics(makeDiagnosticsParams(uri, [
      { line: 3, message: "Info", severity: 3 },
      { line: 1, message: "Error", severity: 1 },
      { line: 2, message: "Warning", severity: 2 },
    ]));

    const results = collector.query({ severity: "all" });
    expect(results[0].severityLabel).toBe("error");
    expect(results[1].severityLabel).toBe("warning");
    expect(results[2].severityLabel).toBe("info");
  });

  it("provides summary", () => {
    collector.onDiagnostics(makeDiagnosticsParams(
      pathToFileURL("/project/src/a.ts").toString(),
      [{ line: 1, message: "E", severity: 1 }, { line: 2, message: "W", severity: 2 }],
    ));
    collector.onDiagnostics(makeDiagnosticsParams(
      pathToFileURL("/project/src/b.ts").toString(),
      [{ line: 1, message: "I", severity: 3 }],
    ));

    const summary = collector.getSummary();
    expect(summary.total).toBe(3);
    expect(summary.errors).toBe(1);
    expect(summary.warnings).toBe(1);
    expect(summary.info).toBe(1);
    expect(summary.fileCount).toBe(2);
  });

  it("clear() removes all diagnostics", () => {
    collector.onDiagnostics(makeDiagnosticsParams(
      pathToFileURL("/project/src/a.ts").toString(),
      [{ line: 1, message: "Error" }],
    ));
    collector.clear();

    expect(collector.size).toBe(0);
    expect(collector.query({ severity: "all" })).toHaveLength(0);
  });

  it("converts 0-indexed lines to 1-indexed", () => {
    collector.onDiagnostics(makeDiagnosticsParams(
      pathToFileURL("/project/src/a.ts").toString(),
      [{ line: 0, message: "First line error" }],
    ));

    const results = collector.query({ severity: "all" });
    expect(results[0].line).toBe(1); // 0 → 1
  });
});

// ── Tests: code_diagnose tool ───────────────────────────────────────────────

describe("code_diagnose", () => {
  let ctx: ToolContext;
  let index: SymbolIndex;

  beforeEach(() => {
    ctx = makeCtx();
    index = new SymbolIndex();
    index.insert({
      qualifiedName: "main",
      kind: "function",
      filePath: "/project/src/main.ts",
      lines: [1, 10] as [number, number],
      signature: "function main()",
      docs: null,
    });
  });

  describe("diagnostics action", () => {
    it("returns diagnostics from collector", async () => {
      const collector = new DiagnosticsCollector();
      collector.onDiagnostics(makeDiagnosticsParams(
        pathToFileURL("/project/src/main.ts").toString(),
        [
          { line: 5, message: "Type 'string' is not assignable to type 'number'", severity: 1, source: "typescript", code: 2322 },
          { line: 12, message: "Unused variable 'x'", severity: 2, source: "typescript", code: 6133 },
        ],
      ));

      const manager = createMockLspManager(collector, [
        { key: "typescript:/project", language: "typescript", root: "/project", state: "running", pid: 123, uptime: 60, lastRequestTime: null, restartCount: 0, lastError: null },
      ]);

      const result = await codeDiagnose({}, ctx, index, manager, null);

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.action).toBe("diagnostics");
      expect(data.diagnostics).toHaveLength(2);
      expect(data.diagnostics[0].file).toBe("src/main.ts");
      expect(data.diagnostics[0].severity).toBe("error");
      expect(data.diagnostics[0].code).toBe(2322);
      expect(data.summary.errors).toBe(1);
      expect(data.summary.warnings).toBe(1);
      expect(data.lspRunning).toBe(true);
    });

    it("returns empty when no LSP available", async () => {
      const result = await codeDiagnose({}, ctx, index, null, null);

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.diagnostics).toHaveLength(0);
      expect(data.lspRunning).toBe(false);
    });

    it("filters by severity", async () => {
      const collector = new DiagnosticsCollector();
      collector.onDiagnostics(makeDiagnosticsParams(
        pathToFileURL("/project/src/main.ts").toString(),
        [
          { line: 1, message: "Error", severity: 1 },
          { line: 2, message: "Warning", severity: 2 },
          { line: 3, message: "Info", severity: 3 },
        ],
      ));

      const manager = createMockLspManager(collector);
      const result = await codeDiagnose(
        { action: "diagnostics", severity: "error" },
        ctx, index, manager, null,
      );

      const data = result.data as any;
      expect(data.diagnostics).toHaveLength(1);
      expect(data.diagnostics[0].severity).toBe("error");
    });
  });

  describe("health action", () => {
    it("returns engine statuses", async () => {
      const collector = new DiagnosticsCollector();
      const manager = createMockLspManager(collector, [
        { key: "typescript:/project", language: "typescript", root: "/project", state: "running", pid: 123, uptime: 60, lastRequestTime: null, restartCount: 0, lastError: null },
      ]);
      const embeddings = createMockEmbeddingIndexer("ready");

      const result = await codeDiagnose(
        { action: "health" },
        ctx, index, manager, embeddings,
      );

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.action).toBe("health");
      expect(data.engines.treeSitter.status).toBe("ready");
      expect(data.engines.embeddings.status).toBe("ready");
      expect(data.engines.embeddings.model).toBe("all-MiniLM-L6-v2");
      expect(data.engines.lsp.status).toBe("available");
      expect(data.engines.lsp.runningServers).toBe(1);
      expect(data.symbolIndex.symbolCount).toBe(1);
    });

    it("reports unavailable when no managers", async () => {
      const result = await codeDiagnose(
        { action: "health" },
        ctx, index, null, null,
      );

      const data = result.data as any;
      expect(data.engines.embeddings.status).toBe("unavailable");
      expect(data.engines.lsp.status).toBe("unavailable");
    });
  });

  describe("lsp_status action", () => {
    it("returns per-server status", async () => {
      const collector = new DiagnosticsCollector();
      collector.onDiagnostics(makeDiagnosticsParams(
        pathToFileURL("/project/src/a.ts").toString(),
        [{ line: 1, message: "Error", severity: 1 }],
      ));

      const statuses: ServerStatus[] = [
        { key: "typescript:/project", language: "typescript", root: "/project", state: "running", pid: 99999, uptime: 120, lastRequestTime: Date.now(), restartCount: 1, lastError: null },
      ];
      const manager = createMockLspManager(collector, statuses);

      const result = await codeDiagnose(
        { action: "lsp_status" },
        ctx, index, manager, null,
      );

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.action).toBe("lsp_status");
      expect(data.servers).toHaveLength(1);
      expect(data.servers[0].language).toBe("typescript");
      expect(data.servers[0].state).toBe("running");
      expect(data.servers[0].pid).toBe(99999);
      expect(data.servers[0].restartCount).toBe(1);
      expect(data.diagnosticsSummary.errors).toBe(1);
    });

    it("returns empty when no LSP", async () => {
      const result = await codeDiagnose(
        { action: "lsp_status" },
        ctx, index, null, null,
      );

      const data = result.data as any;
      expect(data.servers).toHaveLength(0);
    });
  });

  describe("reload action", () => {
    it("restarts all servers and clears diagnostics", async () => {
      const collector = new DiagnosticsCollector();
      collector.onDiagnostics(makeDiagnosticsParams(
        pathToFileURL("/project/src/a.ts").toString(),
        [{ line: 1, message: "Error" }],
      ));

      const statuses: ServerStatus[] = [
        { key: "typescript:/project", language: "typescript", root: "/project", state: "running", pid: 123, uptime: 60, lastRequestTime: null, restartCount: 0, lastError: null },
      ];
      const manager = createMockLspManager(collector, statuses);

      const result = await codeDiagnose(
        { action: "reload" },
        ctx, index, manager, null,
      );

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.action).toBe("reload");
      expect(data.restarted).toContain("typescript:/project");
      expect(collector.size).toBe(0); // diagnostics cleared
      expect(manager.restartAll).toHaveBeenCalled();
    });

    it("handles no LSP gracefully", async () => {
      const result = await codeDiagnose(
        { action: "reload" },
        ctx, index, null, null,
      );

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.restarted).toHaveLength(0);
    });
  });
});
