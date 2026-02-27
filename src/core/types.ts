/**
 * Core types for dev-tools plugin.
 * ZERO OpenClaw imports — pure TypeScript contracts.
 */

// ── Logger ──────────────────────────────────────────────────────────────────

export interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// ── Configuration ───────────────────────────────────────────────────────────

export interface DevToolsConfig {
  search?: {
    provider?: "local" | "api";
    model?: string;
    reindexDebounceMs?: number;
  };
  lsp?: {
    servers?: Record<string, LspServerConfig>;
    healthCheckIntervalMs?: number;
    maxRestartAttempts?: number;
    debug?: boolean;
  };
  index?: {
    include?: string[];
    exclude?: string[];
    maxFileSize?: string;
  };
  shell?: {
    // jail removed — agents are trusted to operate within their project
    defaultTimeout?: number;
    blocklist?: string[];
  };
  tokenBudget?: {
    maxResponseTokens?: number;
  };
  roots?: LanguageRootConfig[];
  /** Project roots to auto-initialize on session start. First match wins. */
  projectRoots?: string[];
}

export interface LspServerConfig {
  enabled?: boolean;
  command?: string;
  args?: string[];
}

export interface LanguageRootConfig {
  path: string;
  language: string;
}

// ── Workspace Analysis ──────────────────────────────────────────────────────

export interface WorkspaceInfo {
  root: string;
  hasGit: boolean;
  languages: LanguageInfo[];
  testRunners: TestRunner[];
  gitignoreFilter: (path: string) => boolean;
}

export interface LanguageInfo {
  language: string;
  root: string;
  configFile: string;
}

export interface TestRunner {
  name: string;
  framework: "jest" | "vitest" | "pytest" | "cargo" | "swift" | "go";
  root: string;
  command: string;
}

// ── Tool Interfaces ─────────────────────────────────────────────────────────

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  summary?: string;
  truncated?: boolean;
  continuation?: string;
}

export interface ToolContext {
  workspaceDir: string;
  storageDir: string;
  config: DevToolsConfig;
  workspace: WorkspaceInfo;
  logger: Logger;
}

// ── Storage ─────────────────────────────────────────────────────────────────

export interface StorageManager {
  readonly storageDir: string;
  readonly slug: string;
  ensureDirs(): Promise<void>;
  plansDir(): string;
  completedPlansDir(): string;
  indexDir(): string;
  logsDir(): string;
  toolOutputDir(): string;
}

// ── Symbol Types ────────────────────────────────────────────────────────────

export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "enum" | "variable" | "property";

export interface SymbolInfo {
  qualifiedName: string;
  kind: SymbolKind;
  filePath: string;
  lines: [number, number]; // 1-indexed [start, end]
  signature: string;
  docs: string | null;
  code?: string;
}

export interface ImportInfo {
  source: string;       // Raw import specifier
  resolved: string | null; // Resolved absolute path (null for external packages)
  names: string[];      // Imported names
  line: number;         // 1-indexed
  isRelative: boolean;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  line: number; // 1-indexed
}

// ── Tool Call Logging ───────────────────────────────────────────────────────

export interface ToolCallLogEntry {
  ts: string;
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  durationMs: number;
  status: "ok" | "error";
}
