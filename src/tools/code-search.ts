/**
 * code_search tool — semantic + text search across the codebase.
 * 
 * Actions:
 * - search (default): Find code by concept (semantic) or text (ripgrep)
 * - stats: Workspace index statistics
 * - index: Filtered INDEX.json slice with graph proximity boost
 */

import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import type { ToolContext, SymbolInfo } from "../core/types.js";
import type { SymbolIndex } from "../core/index/symbol-index.js";
import type { EmbeddingIndexer } from "../core/search/indexer.js";

export interface CodeSearchParams {
  action?: "search" | "stats" | "index";
  /** Search query (for action=search) */
  query?: string;
  /** Search mode (default: semantic) */
  mode?: "semantic" | "text";
  /** Scope search to a directory */
  scope?: string;
  /** Max results (default: 10) */
  limit?: number;
  /** Filter pattern for index action (glob-style) */
  filter?: string;
}

interface SearchResult {
  symbol: string;
  kind: string;
  file: string;
  lines: [number, number];
  signature: string;
  docs: string | null;
  snippet: string;
  score: number;
}

/**
 * Execute code_search.
 */
export async function codeSearch(
  params: CodeSearchParams,
  ctx: ToolContext,
  symbolIndex: SymbolIndex,
  embeddingIndexer: EmbeddingIndexer | null,
): Promise<unknown> {
  const action = params.action ?? "search";

  switch (action) {
    case "search":
      return handleSearch(params, ctx, symbolIndex, embeddingIndexer);
    case "stats":
      return handleStats(ctx, symbolIndex, embeddingIndexer);
    case "index":
      return handleIndex(params, ctx, symbolIndex);
    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

// ── Search ──────────────────────────────────────────────────────────────────

async function handleSearch(
  params: CodeSearchParams,
  ctx: ToolContext,
  symbolIndex: SymbolIndex,
  embeddingIndexer: EmbeddingIndexer | null,
): Promise<unknown> {
  const query = params.query;
  if (!query) {
    return { success: false, error: "query is required for search action" };
  }

  const limit = params.limit ?? 10;
  const mode = params.mode ?? "semantic";
  const scope = params.scope
    ? path.resolve(ctx.workspaceDir, params.scope)
    : undefined;

  // Cold-start fallback: if embeddings aren't ready, use text mode
  if (mode === "semantic" && embeddingIndexer) {
    const state = embeddingIndexer.state;

    if (state === "indexing") {
      const progress = embeddingIndexer.progress;
      // Fall back to text mode, inform agent
      const textResults = await textSearch(query, ctx, symbolIndex, limit, scope);
      return {
        success: true,
        indexing: true,
        progress: `${progress.indexed}/${progress.total}`,
        fallback: "text",
        note: "Semantic index is building. Results are from text search. Will upgrade automatically.",
        ...textResults,
      };
    }

    if (state === "ready") {
      return semanticSearch(query, embeddingIndexer, limit, scope, ctx.workspaceDir);
    }
  }

  // Text mode (explicit or fallback)
  const textResults = await textSearch(query, ctx, symbolIndex, limit, scope);
  return {
    success: true,
    mode: "text",
    ...textResults,
  };
}

async function semanticSearch(
  query: string,
  embeddingIndexer: EmbeddingIndexer,
  limit: number,
  scope: string | undefined,
  workspaceDir: string,
): Promise<unknown> {
  const scopeRelative = scope
    ? path.relative(workspaceDir, scope)
    : undefined;

  const results = await embeddingIndexer.search(query, limit, scopeRelative);

  const mapped: SearchResult[] = results.map(r => ({
    symbol: r.symbol.qualifiedName,
    kind: r.symbol.kind,
    file: path.relative(workspaceDir, r.symbol.filePath),
    lines: r.symbol.lines,
    signature: r.symbol.signature,
    docs: r.symbol.docs,
    snippet: getSnippet(r.symbol),
    score: Math.round(r.score * 1000) / 1000,
  }));

  return {
    success: true,
    mode: "semantic",
    results: mapped,
    totalMatches: mapped.length,
    indexAge: embeddingIndexer.getStats().indexAge,
  };
}

async function textSearch(
  query: string,
  ctx: ToolContext,
  symbolIndex: SymbolIndex,
  limit: number,
  scope?: string,
): Promise<{ results: SearchResult[]; totalMatches: number }> {
  const searchDir = scope ?? ctx.workspaceDir;

  // Use ripgrep for text search
  let rgOutput: string;
  try {
    const escapedQuery = query.replace(/"/g, '\\"');
    rgOutput = execSync(
      `rg --json -i -m 100 "${escapedQuery}" "${searchDir}"`,
      { encoding: "utf-8", timeout: 10_000, maxBuffer: 5_000_000 },
    );
  } catch (e: any) {
    if (e.status === 1) {
      // No matches
      return { results: [], totalMatches: 0 };
    }
    rgOutput = e.stdout ?? "";
    if (!rgOutput) {
      return { results: [], totalMatches: 0 };
    }
  }

  // Parse ripgrep JSON output → map to nearest symbols
  const fileMatches = new Map<string, number[]>(); // file → matching line numbers
  for (const line of rgOutput.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "match") {
        const file = obj.data?.path?.text;
        const lineNum = obj.data?.line_number;
        if (file && lineNum) {
          const absFile = path.isAbsolute(file) ? file : path.resolve(searchDir, file);
          const lines = fileMatches.get(absFile) ?? [];
          lines.push(lineNum);
          fileMatches.set(absFile, lines);
        }
      }
    } catch {
      // Skip malformed JSON lines
    }
  }

  // Map matches to nearest symbols
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const [filePath, lineNums] of fileMatches) {
    const fileSymbols = symbolIndex.lookupByFile(filePath);

    for (const lineNum of lineNums) {
      // Find the symbol that contains this line
      const matchingSymbol = fileSymbols.find(
        s => lineNum >= s.lines[0] && lineNum <= s.lines[1],
      );

      // Or nearest symbol above
      let nearestAbove: SymbolInfo | undefined;
      if (!matchingSymbol) {
        for (let si = fileSymbols.length - 1; si >= 0; si--) {
          if (fileSymbols[si].lines[0] <= lineNum) {
            nearestAbove = fileSymbols[si];
            break;
          }
        }
      }
      const symbol = matchingSymbol ?? nearestAbove;

      if (!symbol) continue;

      const key = `${symbol.filePath}::${symbol.qualifiedName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        symbol: symbol.qualifiedName,
        kind: symbol.kind,
        file: path.relative(ctx.workspaceDir, symbol.filePath),
        lines: symbol.lines,
        signature: symbol.signature,
        docs: symbol.docs,
        snippet: getSnippet(symbol),
        score: 1.0, // Text match — binary relevance
      });

      if (results.length >= limit) break;
    }

    if (results.length >= limit) break;
  }

  return { results, totalMatches: results.length };
}

// ── Stats ───────────────────────────────────────────────────────────────────

async function handleStats(
  ctx: ToolContext,
  symbolIndex: SymbolIndex,
  embeddingIndexer: EmbeddingIndexer | null,
): Promise<unknown> {
  // Per-language breakdown from symbol index
  const languageCounts: Record<string, { files: Set<string>; symbols: number }> = {};

  for (const symbol of symbolIndex.allSymbols()) {
    const ext = path.extname(symbol.filePath).toLowerCase();
    const lang = extToLanguage(ext);

    if (!languageCounts[lang]) {
      languageCounts[lang] = { files: new Set(), symbols: 0 };
    }
    languageCounts[lang].files.add(symbol.filePath);
    languageCounts[lang].symbols++;
  }

  const languages: Record<string, { files: number; symbols: number }> = {};
  for (const [lang, data] of Object.entries(languageCounts)) {
    languages[lang] = { files: data.files.size, symbols: data.symbols };
  }

  const embeddingStats = embeddingIndexer?.getStats();

  // Storage size
  let storageSize = "N/A";
  try {
    const indexDir = path.join(ctx.storageDir, "index");
    const files = await fs.readdir(indexDir);
    let totalBytes = 0;
    for (const f of files) {
      const stat = await fs.stat(path.join(indexDir, f));
      totalBytes += stat.size;
    }
    storageSize = formatBytes(totalBytes);
  } catch {
    // Index dir may not exist yet
  }

  return {
    success: true,
    indexedFiles: symbolIndex.files.length,
    totalSymbols: symbolIndex.size,
    languages,
    indexAge: embeddingStats?.indexAge ?? "N/A",
    storageSize,
    embeddingModel: embeddingStats?.embeddingModel ?? "not loaded",
    embeddingState: embeddingStats?.state ?? "idle",
    embeddingDimension: embeddingStats?.embeddingDimension ?? 0,
    indexedEmbeddings: embeddingStats?.indexedSymbols ?? 0,
  };
}

// ── Index Query ─────────────────────────────────────────────────────────────

async function handleIndex(
  params: CodeSearchParams,
  ctx: ToolContext,
  _symbolIndex: SymbolIndex,
): Promise<unknown> {
  const filter = params.filter;

  // Read INDEX.json
  const indexPath = path.join(ctx.storageDir, "index", "INDEX.json");
  let indexData: Record<string, unknown>;
  try {
    indexData = JSON.parse(await fs.readFile(indexPath, "utf-8"));
  } catch {
    return { success: false, error: "INDEX.json not found — workspace not yet indexed" };
  }

  if (!filter) {
    return { success: true, index: indexData };
  }

  // Filter entries by glob-like pattern
  const filtered: Record<string, unknown> = {};
  const filterNormalized = filter.replace(/\*\*/g, "").replace(/\*/g, "");

  for (const [key, value] of Object.entries(indexData)) {
    if (key.includes(filterNormalized) || matchSimpleGlob(key, filter)) {
      filtered[key] = value;
    }
  }

  return {
    success: true,
    filter,
    matchedFiles: Object.keys(filtered).length,
    index: filtered,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getSnippet(symbol: SymbolInfo): string {
  if (!symbol.code) return "";
  const lines = symbol.code.split("\n");
  return lines.slice(0, 3).join("\n") + (lines.length > 3 ? "\n..." : "");
}

function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".swift": "swift",
    ".java": "java",
    ".kt": "kotlin", ".kts": "kotlin",
    ".cs": "csharp",
    ".rb": "ruby",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".h": "cpp", ".hpp": "cpp",
    ".c": "c",
    ".json": "json",
    ".html": "html", ".htm": "html",
    ".css": "css", ".scss": "css",
    ".sh": "bash", ".bash": "bash",
  };
  return map[ext] ?? ext.replace(".", "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function matchSimpleGlob(path: string, pattern: string): boolean {
  // Simple glob matching — covers dir/** patterns
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path.startsWith(prefix);
  }
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    return path.includes(suffix);
  }
  return path.includes(pattern.replace(/\*/g, ""));
}
