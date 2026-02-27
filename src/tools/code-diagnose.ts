/**
 * code_diagnose tool — diagnostics, health, LSP status, and reload.
 *
 * Actions:
 * - "diagnostics" (default): LSP errors/warnings with optional fixes
 * - "health": engine statuses (tree-sitter, embeddings, LSP per language)
 * - "lsp_status": per-server debug info (PID, uptime, restart count, etc.)
 * - "reload": full engine reinitialization
 */

import * as path from "node:path";
import type { ToolContext, ToolResult } from "../core/types.js";
import type { LspManager } from "../core/lsp/manager.js";
import type { SeverityFilter, DiagnosticsSummary } from "../core/lsp/diagnostics.js";
import type { SymbolIndex } from "../core/index/symbol-index.js";
import type { EmbeddingIndexer } from "../core/search/indexer.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CodeDiagnoseParams {
  action?: "diagnostics" | "health" | "lsp_status" | "reload";
  /** For diagnostics: filter by file path (relative to workspace) */
  file?: string;
  /** For diagnostics: filter by directory */
  directory?: string;
  /** For diagnostics: filter by language root (relative to workspace, e.g. "packages/backend") */
  root?: string;
  /** For diagnostics: minimum severity (default: "warning") */
  severity?: SeverityFilter;
  /** For diagnostics: max results (default: 50) */
  limit?: number;
}

// ── Result types per action ─────────────────────────────────────────────────

export interface DiagnosticsResult {
  action: "diagnostics";
  diagnostics: DiagnosticEntry[];
  /** Present when multiple language roots have diagnostics (monorepo) */
  groups?: DiagnosticsGroupEntry[];
  summary: { total: number; errors: number; warnings: number; info: number; hints: number; fileCount: number };
  lspRunning: boolean;
}

export interface DiagnosticEntry {
  file: string;
  line: number;
  character: number;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  source?: string;
  code?: string | number;
  /** Language root that produced this diagnostic (shown in monorepo mode) */
  root?: string;
}

export interface DiagnosticsGroupEntry {
  root: string;
  language?: string;
  summary: { errors: number; warnings: number };
  diagnostics: DiagnosticEntry[];
}

export interface HealthResult {
  action: "health";
  engines: {
    treeSitter: { status: "ready" | "unavailable" };
    embeddings: {
      status: "ready" | "indexing" | "unavailable";
      model?: string;
      indexedSymbols?: number;
      totalSymbols?: number;
    };
    lsp: {
      status: "available" | "unavailable";
      languages: string[];
      runningServers: number;
    };
  };
  symbolIndex: {
    symbolCount: number;
  };
  workspace: string;
}

export interface LspStatusResult {
  action: "lsp_status";
  servers: Array<{
    key: string;
    language: string;
    root: string;
    state: string;
    pid?: number;
    uptime: number | null;
    lastRequestTime: number | null;
    restartCount: number;
    lastError: string | null;
  }>;
  diagnosticsSummary: { total: number; errors: number; warnings: number; fileCount: number };
}

export interface ReloadResult {
  action: "reload";
  message: string;
  restarted: string[];
}

type CodeDiagnoseResult = DiagnosticsResult | HealthResult | LspStatusResult | ReloadResult;

// ── Tool Implementation ─────────────────────────────────────────────────────

export async function codeDiagnose(
  params: CodeDiagnoseParams,
  ctx: ToolContext,
  symbolIndex: SymbolIndex,
  lspManager: LspManager | null,
  embeddingIndexer: EmbeddingIndexer | null,
): Promise<ToolResult<CodeDiagnoseResult>> {
  const action = params.action ?? "diagnostics";

  switch (action) {
    case "diagnostics":
      return handleDiagnostics(params, ctx, lspManager);
    case "health":
      return handleHealth(ctx, symbolIndex, lspManager, embeddingIndexer);
    case "lsp_status":
      return handleLspStatus(lspManager);
    case "reload":
      return handleReload(lspManager);
    default:
      return {
        success: false,
        error: `Unknown action: ${action}. Valid actions: diagnostics, health, lsp_status, reload`,
      };
  }
}

// ── Action: diagnostics ─────────────────────────────────────────────────────

async function handleDiagnostics(
  params: CodeDiagnoseParams,
  ctx: ToolContext,
  lspManager: LspManager | null,
): Promise<ToolResult<DiagnosticsResult>> {
  if (!lspManager) {
    return {
      success: true,
      data: {
        action: "diagnostics",
        diagnostics: [],
        summary: { total: 0, errors: 0, warnings: 0, info: 0, hints: 0, fileCount: 0 },
        lspRunning: false,
      },
      summary: "No LSP servers available. Install a language server and retry.",
    };
  }

  const collector = lspManager.diagnostics;

  // Resolve root filter to absolute path for collector query
  let absRootFilter: string | undefined;
  if (params.root) {
    absRootFilter = path.isAbsolute(params.root)
      ? params.root
      : path.resolve(ctx.workspaceDir, params.root);
  }

  // If a specific file is requested, ensure it's open in the LSP server
  // to trigger fresh diagnostics
  if (params.file) {
    const absPath = path.isAbsolute(params.file)
      ? params.file
      : path.resolve(ctx.workspaceDir, params.file);

    // In monorepo, a file might be served by multiple LSP instances (rare, but handle it)
    const client = await lspManager.getClient(absPath);
    if (client) {
      await client.ensureDocumentOpen(absPath);
      // Brief wait for diagnostics to arrive
      await sleep(500);
    }
  } else if (params.directory) {
    // For directory queries, trigger diagnostics from all servers whose roots overlap with the directory.
    // This ensures monorepo sub-packages get their diagnostics refreshed.
    const absDir = path.isAbsolute(params.directory)
      ? params.directory
      : path.resolve(ctx.workspaceDir, params.directory);

    const statuses = lspManager.getStatus();
    for (const s of statuses) {
      // Server root is within the queried directory, or the directory is within the server root
      if (s.root.startsWith(absDir) || absDir.startsWith(s.root)) {
        // Trigger a client boot if needed (lazy boot will start the server)
        await lspManager.getClientForLanguage(s.language, s.root);
      }
    }
  }

  const results = collector.query({
    file: params.file,
    directory: params.directory,
    root: absRootFilter,
    severity: params.severity ?? "warning",
    limit: params.limit ?? 50,
  });

  const summary = collector.getSummary();

  const diagnostics: DiagnosticEntry[] = results.map(d => ({
    file: path.relative(ctx.workspaceDir, d.file),
    line: d.line,
    character: d.character,
    message: d.message,
    severity: d.severityLabel,
    source: d.source,
    code: d.code,
    ...(d.root ? { root: path.relative(ctx.workspaceDir, d.root) || "." } : {}),
  }));

  const statuses = lspManager.getStatus();
  const running = statuses.filter(s => s.state === "running").length > 0;

  // Build per-root groups when multiple roots have diagnostics
  let groups: DiagnosticsGroupEntry[] | undefined;
  const rootSummaries = collector.getSummaryByRoot();
  if (rootSummaries.size > 1) {
    groups = [];
    for (const [root, rootSummary] of rootSummaries) {
      const rootDiags = diagnostics.filter(d => {
        const absRoot = root === "(unknown)" ? undefined : root;
        if (!absRoot) return !d.root;
        const relRoot = path.relative(ctx.workspaceDir, absRoot) || ".";
        return d.root === relRoot;
      });
      if (rootDiags.length > 0) {
        // Determine language from the first diagnostic or from LSP status
        const rootStatus = statuses.find(s => s.root === root);
        groups.push({
          root: root === "(unknown)" ? root : (path.relative(ctx.workspaceDir, root) || "."),
          language: rootStatus?.language,
          summary: { errors: rootSummary.errors, warnings: rootSummary.warnings },
          diagnostics: rootDiags,
        });
      }
    }
  }

  // Compute filtered summary when root filter is applied
  const filteredSummary = absRootFilter ? computeFilteredSummary(results) : summary;

  return {
    success: true,
    data: {
      action: "diagnostics",
      diagnostics,
      ...(groups ? { groups } : {}),
      summary: filteredSummary,
      lspRunning: running,
    },
    summary: filteredSummary.total === 0
      ? "No diagnostics. Clean!"
      : `${filteredSummary.errors} error${filteredSummary.errors !== 1 ? "s" : ""}, ${filteredSummary.warnings} warning${filteredSummary.warnings !== 1 ? "s" : ""} across ${filteredSummary.fileCount} file${filteredSummary.fileCount !== 1 ? "s" : ""}`,
  };
}

/** Compute summary from a filtered result set (vs global summary from collector). */
function computeFilteredSummary(diagnostics: { severityLabel: string; file: string }[]): DiagnosticsSummary {
  let errors = 0, warnings = 0, info = 0, hints = 0;
  const files = new Set<string>();

  for (const d of diagnostics) {
    files.add(d.file);
    switch (d.severityLabel) {
      case "error": errors++; break;
      case "warning": warnings++; break;
      case "info": info++; break;
      case "hint": hints++; break;
    }
  }

  return {
    total: errors + warnings + info + hints,
    errors,
    warnings,
    info,
    hints,
    fileCount: files.size,
  };
}

// ── Action: health ──────────────────────────────────────────────────────────

async function handleHealth(
  ctx: ToolContext,
  symbolIndex: SymbolIndex,
  lspManager: LspManager | null,
  embeddingIndexer: EmbeddingIndexer | null,
): Promise<ToolResult<HealthResult>> {
  // Embeddings status
  let embeddingsStatus: HealthResult["engines"]["embeddings"];
  if (embeddingIndexer) {
    const stats = embeddingIndexer.getStats();
    embeddingsStatus = {
      status: stats.state === "ready" ? "ready" : stats.state === "indexing" ? "indexing" : "unavailable",
      model: stats.embeddingModel,
      indexedSymbols: stats.indexedSymbols,
      totalSymbols: stats.totalSymbols,
    };
  } else {
    embeddingsStatus = { status: "unavailable" };
  }

  // LSP status
  let lspStatus: HealthResult["engines"]["lsp"];
  if (lspManager) {
    const available = lspManager.getAvailableLanguages();
    const statuses = lspManager.getStatus();
    const running = statuses.filter(s => s.state === "running").length;
    lspStatus = {
      status: available.length > 0 ? "available" : "unavailable",
      languages: available,
      runningServers: running,
    };
  } else {
    lspStatus = { status: "unavailable", languages: [], runningServers: 0 };
  }

  return {
    success: true,
    data: {
      action: "health",
      engines: {
        treeSitter: { status: "ready" }, // Always ready once initialized
        embeddings: embeddingsStatus,
        lsp: lspStatus,
      },
      symbolIndex: {
        symbolCount: symbolIndex.size,
      },
      workspace: ctx.workspaceDir,
    },
    summary: `Engines: tree-sitter=ready, embeddings=${embeddingsStatus.status}, LSP=${lspStatus.status} (${lspStatus.runningServers} running) | ${symbolIndex.size} symbols indexed`,
  };
}

// ── Action: lsp_status ──────────────────────────────────────────────────────

async function handleLspStatus(
  lspManager: LspManager | null,
): Promise<ToolResult<LspStatusResult>> {
  if (!lspManager) {
    return {
      success: true,
      data: {
        action: "lsp_status",
        servers: [],
        diagnosticsSummary: { total: 0, errors: 0, warnings: 0, fileCount: 0 },
      },
      summary: "No LSP manager available.",
    };
  }

  const statuses = lspManager.getStatus();
  const diagSummary = lspManager.diagnostics.getSummary();

  return {
    success: true,
    data: {
      action: "lsp_status",
      servers: statuses.map(s => ({
        key: s.key,
        language: s.language,
        root: s.root,
        state: s.state,
        pid: s.pid,
        uptime: s.uptime,
        lastRequestTime: s.lastRequestTime,
        restartCount: s.restartCount,
        lastError: s.lastError,
      })),
      diagnosticsSummary: {
        total: diagSummary.total,
        errors: diagSummary.errors,
        warnings: diagSummary.warnings,
        fileCount: diagSummary.fileCount,
      },
    },
    summary: `${statuses.length} server${statuses.length !== 1 ? "s" : ""} registered, ${statuses.filter(s => s.state === "running").length} running | ${diagSummary.total} diagnostics`,
  };
}

// ── Action: reload ──────────────────────────────────────────────────────────

async function handleReload(
  lspManager: LspManager | null,
): Promise<ToolResult<ReloadResult>> {
  if (!lspManager) {
    return {
      success: true,
      data: {
        action: "reload",
        message: "No LSP manager available. Nothing to reload.",
        restarted: [],
      },
    };
  }

  // Clear diagnostics
  lspManager.diagnostics.clear();

  // Restart all servers
  const statusBefore = lspManager.getStatus();
  const activeServers = statusBefore
    .filter(s => s.state === "running" || s.state === "crashed")
    .map(s => s.key);

  await lspManager.restartAll();

  return {
    success: true,
    data: {
      action: "reload",
      message: `Restarted ${activeServers.length} LSP server${activeServers.length !== 1 ? "s" : ""}. Diagnostics cleared.`,
      restarted: activeServers,
    },
    summary: `Reloaded ${activeServers.length} server${activeServers.length !== 1 ? "s" : ""}`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
