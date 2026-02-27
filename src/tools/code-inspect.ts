/**
 * code_inspect tool — complete symbol inspection in one call.
 *
 * Combines LSP hover + definition + references into a single tool call.
 * Falls back to symbol index data when LSP is unavailable.
 * One call = complete picture of any symbol.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import type {
  Location,
  Hover,
  MarkupContent,
} from "vscode-languageserver-protocol";
import type { SymbolInfo, ToolContext, ToolResult } from "../core/types.js";
import type { LspManager, ClientUnavailableReason } from "../core/lsp/manager.js";
import type { LspResolver } from "../core/lsp/resolver.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { resolveSymbol } from "../core/index/resolver.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CodeInspectParams {
  symbol: string;
  file?: string;
  scope?: string;
  line?: number;
  includeReferences?: boolean; // default true, can disable for speed
  maxReferences?: number;      // default 20
}

export interface DefinitionLocation {
  file: string;
  line: number;
  character: number;
  preview?: string;
}

export interface ReferenceLocation {
  file: string;
  line: number;
  character: number;
  preview?: string;
}

export interface CodeInspectResult {
  symbol: {
    qualifiedName: string;
    kind: string;
    file: string;
    lines: [number, number];
    signature: string;
    docs: string | null;
  };
  type?: string;
  documentation?: string;
  definition?: DefinitionLocation;
  references?: ReferenceLocation[];
  referenceCount?: number;
  drifted?: boolean;
  lspAvailable: boolean;
  /** When LSP is unavailable, explains why and how to fix */
  lspUnavailableReason?: LspUnavailableInfo;
}

export interface LspUnavailableInfo {
  reason: string;
  install?: string;
  fallback: string;
}

// ── Tool Implementation ─────────────────────────────────────────────────────

export async function codeInspect(
  params: CodeInspectParams,
  ctx: ToolContext,
  symbolIndex: SymbolIndex,
  lspManager: LspManager | null,
  lspResolver: LspResolver | null,
): Promise<ToolResult<CodeInspectResult>> {
  const includeRefs = params.includeReferences !== false;
  const maxRefs = params.maxReferences ?? 20;

  // Step 1: Resolve symbol from index
  const resolution = resolveSymbol(
    {
      symbol: params.symbol,
      file: params.file ? resolvePath(params.file, ctx.workspaceDir) : undefined,
      scope: params.scope,
      line: params.line,
    },
    symbolIndex,
  );

  if (resolution.symbols.length === 0) {
    return {
      success: false,
      error: `Symbol not found: ${params.symbol}`,
      summary: `Could not find symbol "${params.symbol}" in the index. Try code_search to find it.`,
    };
  }

  if (resolution.ambiguous && !params.file) {
    const locations = resolution.symbols.map(s =>
      `  ${s.qualifiedName} in ${path.relative(ctx.workspaceDir, s.filePath)}:${s.lines[0]}`,
    );
    return {
      success: false,
      error: `Ambiguous symbol "${params.symbol}" found in ${resolution.symbols.length} locations:\n${locations.join("\n")}\nSpecify a file to disambiguate.`,
    };
  }

  const symbol = resolution.symbols[0];

  // Step 2: Try LSP-powered inspection
  if (lspManager && lspResolver) {
    const lspResult = await inspectWithLsp(
      symbol, ctx, lspManager, lspResolver, includeRefs, maxRefs,
    );
    if (lspResult) return lspResult;
  }

  // Step 3: Fallback to index-only inspection, with reason why LSP is unavailable
  let lspUnavailableReason: LspUnavailableInfo | undefined;
  if (lspManager) {
    const { reason } = await lspManager.getClientWithReason(symbol.filePath);
    if (reason) {
      lspUnavailableReason = formatUnavailableReason(reason);
    }
  }
  return indexOnlyInspect(symbol, ctx, lspUnavailableReason);
}

// ── LSP-Powered Inspection ──────────────────────────────────────────────────

async function inspectWithLsp(
  symbol: SymbolInfo,
  ctx: ToolContext,
  lspManager: LspManager,
  lspResolver: LspResolver,
  includeRefs: boolean,
  maxRefs: number,
): Promise<ToolResult<CodeInspectResult> | null> {
  // Resolve symbol to LSP position
  const posResult = await lspResolver.resolve({
    symbol: symbol.qualifiedName,
    file: symbol.filePath,
  });

  if (!posResult.position) return null;

  const pos = posResult.position;

  // Get LSP client for this file
  const client = await lspManager.getClient(pos.filePath);
  if (!client) return null;

  // Ensure document is open in LSP server
  await client.ensureDocumentOpen(pos.filePath);

  // Fire LSP requests in parallel
  const lspPosition = { line: pos.line, character: pos.character };

  const [hoverResult, definitionResult, referencesResult] = await Promise.allSettled([
    client.hover(pos.uri, lspPosition),
    client.definition(pos.uri, lspPosition),
    includeRefs
      ? client.references(pos.uri, lspPosition, false) // exclude declaration
      : Promise.resolve(null),
  ]);

  // Parse hover → type + docs
  const hover = hoverResult.status === "fulfilled" ? hoverResult.value : null;
  const { type, documentation } = parseHover(hover);

  // Parse definition
  const definition = definitionResult.status === "fulfilled"
    ? await parseDefinition(definitionResult.value, ctx.workspaceDir)
    : undefined;

  // Parse references
  let references: ReferenceLocation[] | undefined;
  let referenceCount: number | undefined;

  if (includeRefs && referencesResult.status === "fulfilled" && referencesResult.value) {
    const allRefs = referencesResult.value as Location[];
    referenceCount = allRefs.length;
    const capped = allRefs.slice(0, maxRefs);
    references = await Promise.all(
      capped.map(ref => parseLocation(ref, ctx.workspaceDir)),
    );
  }

  return {
    success: true,
    data: {
      symbol: {
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        file: path.relative(ctx.workspaceDir, symbol.filePath),
        lines: symbol.lines,
        signature: symbol.signature,
        docs: symbol.docs,
      },
      type: type ?? undefined,
      documentation: documentation ?? undefined,
      definition,
      references,
      referenceCount,
      drifted: pos.drifted,
      lspAvailable: true,
    },
    summary: buildSummary(symbol, type, definition, referenceCount, true),
  };
}

// ── Index-Only Fallback ─────────────────────────────────────────────────────

function indexOnlyInspect(
  symbol: SymbolInfo,
  ctx: ToolContext,
  lspUnavailableReason?: LspUnavailableInfo,
): ToolResult<CodeInspectResult> {
  return {
    success: true,
    data: {
      symbol: {
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        file: path.relative(ctx.workspaceDir, symbol.filePath),
        lines: symbol.lines,
        signature: symbol.signature,
        docs: symbol.docs,
      },
      definition: {
        file: path.relative(ctx.workspaceDir, symbol.filePath),
        line: symbol.lines[0],
        character: 0,
      },
      lspAvailable: false,
      ...(lspUnavailableReason ? { lspUnavailableReason } : {}),
    },
    summary: buildSummary(symbol, null, null, null, false),
  };
}

// ── Parsers ─────────────────────────────────────────────────────────────────

function parseHover(hover: Hover | null): { type: string | null; documentation: string | null } {
  if (!hover || !hover.contents) return { type: null, documentation: null };

  let raw: string;

  if (typeof hover.contents === "string") {
    raw = hover.contents;
  } else if (Array.isArray(hover.contents)) {
    raw = hover.contents
      .map(c => typeof c === "string" ? c : (c as { value: string }).value)
      .join("\n\n");
  } else if ("value" in hover.contents) {
    raw = (hover.contents as MarkupContent).value;
  } else {
    return { type: null, documentation: null };
  }

  if (!raw) return { type: null, documentation: null };

  // Try to separate type signature from documentation.
  // Many LSP servers return a code block first (type), then prose (docs).
  const codeBlockMatch = raw.match(/^```\w*\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    const type = codeBlockMatch[1].trim();
    const rest = raw.slice(codeBlockMatch[0].length).trim();
    return {
      type,
      documentation: rest || null,
    };
  }

  // No code block — treat the whole thing as type info
  return { type: raw.trim(), documentation: null };
}

async function parseDefinition(
  defResult: unknown,
  workspaceDir: string,
): Promise<DefinitionLocation | undefined> {
  if (!defResult) return undefined;

  let location: Location | undefined;

  if (Array.isArray(defResult)) {
    // LocationLink[] or Location[]
    const first = defResult[0];
    if (!first) return undefined;

    if ("targetUri" in first) {
      // LocationLink
      location = {
        uri: (first as { targetUri: string }).targetUri,
        range: (first as { targetSelectionRange: Location["range"] }).targetSelectionRange
          ?? (first as { targetRange: Location["range"] }).targetRange,
      };
    } else if ("uri" in first) {
      location = first as Location;
    }
  } else if (typeof defResult === "object" && defResult !== null && "uri" in defResult) {
    location = defResult as Location;
  }

  if (!location) return undefined;
  return parseLocation(location, workspaceDir);
}

async function parseLocation(
  location: Location,
  workspaceDir: string,
): Promise<ReferenceLocation> {
  let filePath: string;
  try {
    filePath = fileURLToPath(location.uri);
  } catch {
    filePath = location.uri;
  }

  const relFile = path.relative(workspaceDir, filePath);
  const line = location.range.start.line + 1; // 0-indexed → 1-indexed
  const character = location.range.start.character;

  // Try to get a preview line
  let preview: string | undefined;
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const lineIdx = location.range.start.line;
    if (lineIdx >= 0 && lineIdx < lines.length) {
      preview = lines[lineIdx].trim();
      if (preview.length > 120) {
        preview = preview.slice(0, 117) + "...";
      }
    }
  } catch {
    // File not readable — skip preview
  }

  return { file: relFile, line, character, preview };
}

// ── Summary Builder ─────────────────────────────────────────────────────────

function buildSummary(
  symbol: SymbolInfo,
  type: string | null | undefined,
  _definition: DefinitionLocation | null | undefined,
  referenceCount: number | null | undefined,
  lspUsed: boolean,
): string {
  const parts: string[] = [`${symbol.kind} ${symbol.qualifiedName}`];

  if (type) {
    parts.push(`Type: ${type.length > 80 ? type.slice(0, 77) + "..." : type}`);
  }

  if (referenceCount !== null && referenceCount !== undefined) {
    parts.push(`${referenceCount} reference${referenceCount !== 1 ? "s" : ""}`);
  }

  if (!lspUsed) {
    parts.push("(index only — LSP not available)");
  }

  return parts.join(" | ");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolvePath(filePath: string, workspaceDir: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceDir, filePath);
}

/**
 * Format a ClientUnavailableReason into an agent-friendly info object.
 */
function formatUnavailableReason(reason: ClientUnavailableReason): LspUnavailableInfo {
  switch (reason.kind) {
    case "prerequisite_missing":
      return {
        reason: `LSP server binary '${reason.command}' not found for ${reason.language}`,
        install: reason.installHint,
        fallback: `Install the language server, then retry. Use shell to run: ${reason.installHint ?? reason.command}`,
      };
    case "no_server_configured":
      return {
        reason: `No LSP server configured for ${reason.language}`,
        fallback: "Use tree-sitter tools (code_search, code_read, code_outline) and shell for analysis.",
      };
    case "server_disabled":
      return {
        reason: `LSP server disabled for ${reason.language}`,
        fallback: "Use tree-sitter tools (code_search, code_read, code_outline) and shell for analysis.",
      };
    case "crash_limit_exceeded":
      return {
        reason: `${reason.language} LSP server crashed ${reason.attempts} times: ${reason.lastError}`,
        fallback: "Use tree-sitter tools for navigation. Run type checker via shell (e.g., 'npx tsc --noEmit' for TypeScript).",
      };
    case "no_matching_root":
      return {
        reason: `File not in any registered language root: ${reason.filePath}`,
        fallback: "Use tree-sitter tools (code_search, code_read, code_outline) for analysis.",
      };
    case "disposed":
      return {
        reason: "LSP manager disposed (session ending)",
        fallback: "Session is ending. No further LSP operations available.",
      };
  }
}
