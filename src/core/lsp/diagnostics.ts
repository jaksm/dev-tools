/**
 * LSP Diagnostics Collector — accumulates diagnostics pushed by LSP servers.
 *
 * LSP diagnostics are push-based: servers send textDocument/publishDiagnostics
 * notifications whenever they detect issues. This collector stores them per-file
 * and provides query methods for the code_diagnose tool.
 */

import { fileURLToPath } from "node:url";
import type { PublishDiagnosticsParams, Diagnostic } from "vscode-languageserver-protocol";

// ── Types ───────────────────────────────────────────────────────────────────

export interface StoredDiagnostic {
  /** Absolute file path */
  file: string;
  /** File URI */
  uri: string;
  /** 1-indexed line */
  line: number;
  /** 0-indexed character */
  character: number;
  /** Diagnostic message */
  message: string;
  /** Severity: 1=Error, 2=Warning, 3=Info, 4=Hint */
  severity: number;
  /** Severity label */
  severityLabel: "error" | "warning" | "info" | "hint";
  /** Diagnostic source (e.g., "typescript", "pyright") */
  source?: string;
  /** Diagnostic code */
  code?: string | number;
  /** Language root that produced this diagnostic */
  root?: string;
  /** Language of the server that produced this diagnostic */
  language?: string;
  /** Raw diagnostic for code action requests */
  raw: Diagnostic;
}

export type SeverityFilter = "error" | "warning" | "info" | "hint" | "all";

export interface DiagnosticsQuery {
  /** Filter by file path (absolute or relative to workspace) */
  file?: string;
  /** Filter by directory (all files under this path) */
  directory?: string;
  /** Filter by language root */
  root?: string;
  /** Minimum severity (default: "warning" — shows errors + warnings) */
  severity?: SeverityFilter;
  /** Max diagnostics to return */
  limit?: number;
}

export interface DiagnosticsSummary {
  total: number;
  errors: number;
  warnings: number;
  info: number;
  hints: number;
  fileCount: number;
}

// ── Severity helpers ────────────────────────────────────────────────────────

const SEVERITY_MAP: Record<number, StoredDiagnostic["severityLabel"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

const SEVERITY_RANK: Record<string, number> = {
  error: 1,
  warning: 2,
  info: 3,
  hint: 4,
  all: 5,
};

// ── Diagnostics Collector ───────────────────────────────────────────────────

export class DiagnosticsCollector {
  /** file URI → diagnostics */
  private store = new Map<string, StoredDiagnostic[]>();
  private lastUpdate = 0;

  /**
   * Handle a publishDiagnostics notification from an LSP server.
   * Replaces all diagnostics for the given URI (standard LSP behavior).
   * Optionally tracks which language root and language produced the diagnostics.
   */
  onDiagnostics(params: PublishDiagnosticsParams, root?: string, language?: string): void {
    const uri = params.uri;
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      filePath = uri;
    }

    if (params.diagnostics.length === 0) {
      this.store.delete(uri);
    } else {
      const stored = params.diagnostics.map(d => ({
        file: filePath,
        uri,
        line: d.range.start.line + 1, // 0-indexed → 1-indexed
        character: d.range.start.character,
        message: d.message,
        severity: d.severity ?? 1,
        severityLabel: SEVERITY_MAP[d.severity ?? 1] ?? "error",
        source: d.source ?? undefined,
        code: d.code !== undefined ? d.code : undefined,
        root,
        language,
        raw: d,
      } satisfies StoredDiagnostic));

      this.store.set(uri, stored);
    }

    this.lastUpdate = Date.now();
  }

  /**
   * Query diagnostics with filters.
   */
  query(q: DiagnosticsQuery = {}): StoredDiagnostic[] {
    const severityThreshold = SEVERITY_RANK[q.severity ?? "warning"] ?? 2;
    let results: StoredDiagnostic[] = [];

    for (const diagnostics of this.store.values()) {
      for (const d of diagnostics) {
        // Severity filter
        if (SEVERITY_RANK[d.severityLabel] > severityThreshold) continue;

        // File filter
        if (q.file && !d.file.endsWith(q.file) && d.file !== q.file) continue;

        // Directory filter
        if (q.directory && !d.file.includes(q.directory)) continue;

        // Root filter
        if (q.root && d.root !== q.root) continue;

        results.push(d);
      }
    }

    // Sort: errors first, then warnings, then by file, then by line
    results.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity - b.severity;
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    });

    if (q.limit && results.length > q.limit) {
      results = results.slice(0, q.limit);
    }

    return results;
  }

  /**
   * Get a summary of all collected diagnostics.
   */
  getSummary(): DiagnosticsSummary {
    let errors = 0, warnings = 0, info = 0, hints = 0;
    const files = new Set<string>();

    for (const diagnostics of this.store.values()) {
      for (const d of diagnostics) {
        files.add(d.file);
        switch (d.severity) {
          case 1: errors++; break;
          case 2: warnings++; break;
          case 3: info++; break;
          case 4: hints++; break;
        }
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

  /**
   * Get summary grouped by language root.
   */
  getSummaryByRoot(): Map<string, DiagnosticsSummary> {
    const rootMap = new Map<string, { errors: number; warnings: number; info: number; hints: number; files: Set<string> }>();

    for (const diagnostics of this.store.values()) {
      for (const d of diagnostics) {
        const rootKey = d.root ?? "(unknown)";
        let entry = rootMap.get(rootKey);
        if (!entry) {
          entry = { errors: 0, warnings: 0, info: 0, hints: 0, files: new Set() };
          rootMap.set(rootKey, entry);
        }
        entry.files.add(d.file);
        switch (d.severity) {
          case 1: entry.errors++; break;
          case 2: entry.warnings++; break;
          case 3: entry.info++; break;
          case 4: entry.hints++; break;
        }
      }
    }

    const result = new Map<string, DiagnosticsSummary>();
    for (const [root, entry] of rootMap) {
      result.set(root, {
        total: entry.errors + entry.warnings + entry.info + entry.hints,
        errors: entry.errors,
        warnings: entry.warnings,
        info: entry.info,
        hints: entry.hints,
        fileCount: entry.files.size,
      });
    }
    return result;
  }

  /**
   * Get diagnostics for a specific file URI (for code action requests).
   */
  getForUri(uri: string): StoredDiagnostic[] {
    return this.store.get(uri) ?? [];
  }

  /**
   * Get the timestamp of the last diagnostics update.
   */
  get lastUpdateTime(): number {
    return this.lastUpdate;
  }

  /**
   * Clear all stored diagnostics.
   */
  clear(): void {
    this.store.clear();
    this.lastUpdate = 0;
  }

  /**
   * Clear diagnostics for a specific file URI.
   */
  clearUri(uri: string): void {
    this.store.delete(uri);
  }

  /**
   * Get the number of files with diagnostics.
   */
  get size(): number {
    return this.store.size;
  }
}
