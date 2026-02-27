/**
 * LSP Position Resolver — bridge between symbol index and LSP protocol.
 *
 * Given a symbol (from the symbol index), resolves to a concrete LSP position
 * { uri, line, character } suitable for hover/definition/references requests.
 *
 * Handles position drift: if the file was edited since last index, verifies
 * the symbol still lives at the expected location by scanning current file
 * content. Falls back to text search when the indexed position is stale.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { SymbolInfo } from "../types.js";
import { SymbolIndex } from "../index/symbol-index.js";
import { resolveSymbol, type ResolveInput } from "../index/resolver.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface LspPosition {
  /** file:// URI for the LSP request */
  uri: string;
  /** Absolute file path */
  filePath: string;
  /** 0-indexed line */
  line: number;
  /** 0-indexed character offset */
  character: number;
  /** The symbol that was resolved (from the index) */
  symbol: SymbolInfo;
  /** Whether the position was adjusted due to drift */
  drifted: boolean;
}

export interface LspResolveResult {
  /** Resolved position, or null if resolution failed */
  position: LspPosition | null;
  /** All candidate symbols (for ambiguity reporting) */
  candidates: SymbolInfo[];
  /** Whether the input was ambiguous (multiple symbols matched) */
  ambiguous: boolean;
  /** Error message if resolution failed */
  error?: string;
}

export interface LspResolverOptions {
  /** The symbol index to resolve from */
  symbolIndex: SymbolIndex;
  /** Workspace root (for relative path resolution) */
  workspaceRoot: string;
  /** Optional file reader for testing (defaults to fs.readFile) */
  readFile?: (filePath: string) => Promise<string>;
}

// ── LSP Resolver ────────────────────────────────────────────────────────────

export class LspResolver {
  private readonly symbolIndex: SymbolIndex;
  private readonly workspaceRoot: string;
  private readonly readFile: (filePath: string) => Promise<string>;

  constructor(options: LspResolverOptions) {
    this.symbolIndex = options.symbolIndex;
    this.workspaceRoot = options.workspaceRoot;
    this.readFile = options.readFile ?? (async (p) => fs.readFile(p, "utf-8"));
  }

  /**
   * Resolve a symbol input to an LSP position.
   *
   * Accepts the same input formats as the symbol resolver:
   * - { symbol: "UserService.authenticate" }
   * - { symbol: "authenticate", file: "user.ts" }
   * - { symbol: "authenticate", scope: "UserService" }
   * - { file: "user.ts", line: 15 }
   *
   * Returns a position pointing to the symbol's name identifier,
   * suitable for LSP hover/definition/references requests.
   */
  async resolve(input: ResolveInput): Promise<LspResolveResult> {
    // Step 1: Resolve symbol from index
    const resolved = resolveSymbol(input, this.symbolIndex);

    if (resolved.symbols.length === 0) {
      return {
        position: null,
        candidates: [],
        ambiguous: false,
        error: `No symbol found for ${formatInput(input)}`,
      };
    }

    // If ambiguous and no way to disambiguate, report it
    if (resolved.ambiguous && resolved.symbols.length > 1) {
      // Still try to resolve the first one — caller can inspect `ambiguous` flag
    }

    // Step 2: Pick the best symbol (first match — resolver already prioritizes)
    const symbol = resolved.symbols[0];

    // Step 3: Resolve to LSP position with drift detection
    const position = await this.symbolToPosition(symbol);

    if (!position) {
      return {
        position: null,
        candidates: resolved.symbols,
        ambiguous: resolved.ambiguous,
        error: `Could not resolve position for ${symbol.qualifiedName} in ${symbol.filePath}`,
      };
    }

    return {
      position,
      candidates: resolved.symbols,
      ambiguous: resolved.ambiguous,
    };
  }

  /**
   * Resolve a SymbolInfo directly to an LSP position.
   * Use when you already have the symbol and just need coordinates.
   */
  async symbolToPosition(symbol: SymbolInfo): Promise<LspPosition | null> {
    const filePath = this.resolveFilePath(symbol.filePath);

    // Read current file content
    let content: string;
    try {
      content = await this.readFile(filePath);
    } catch {
      return null; // File doesn't exist or can't be read
    }

    const lines = content.split("\n");

    // Extract the short name from the qualified name (e.g., "authenticate" from "UserService.authenticate")
    const shortName = extractShortName(symbol.qualifiedName);

    // Step 1: Try indexed position (1-indexed → 0-indexed)
    const indexedLine = symbol.lines[0] - 1;

    if (indexedLine >= 0 && indexedLine < lines.length) {
      const col = findIdentifierInLine(lines[indexedLine], shortName);
      if (col !== -1) {
        return {
          uri: pathToFileURL(filePath).toString(),
          filePath,
          line: indexedLine,
          character: col,
          symbol,
          drifted: false,
        };
      }
    }

    // Step 2: Position drift — search nearby lines (±10)
    const driftResult = searchNearby(lines, indexedLine, shortName, 10);
    if (driftResult !== null) {
      return {
        uri: pathToFileURL(filePath).toString(),
        filePath,
        line: driftResult.line,
        character: driftResult.character,
        symbol,
        drifted: true,
      };
    }

    // Step 3: Full file scan — symbol might have moved significantly
    const fullScanResult = findSymbolDeclaration(lines, shortName, symbol.kind);
    if (fullScanResult !== null) {
      return {
        uri: pathToFileURL(filePath).toString(),
        filePath,
        line: fullScanResult.line,
        character: fullScanResult.character,
        symbol,
        drifted: true,
      };
    }

    return null;
  }

  /**
   * Resolve multiple symbols to LSP positions (batch).
   */
  async resolveMany(inputs: ResolveInput[]): Promise<LspResolveResult[]> {
    return Promise.all(inputs.map(input => this.resolve(input)));
  }

  /**
   * Resolve an absolute or relative file path against the workspace root.
   */
  private resolveFilePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(this.workspaceRoot, filePath);
  }
}

// ── Helper Functions ────────────────────────────────────────────────────────

/**
 * Extract the short (unqualified) name from a qualified symbol name.
 * "UserService.authenticate" → "authenticate"
 * "helper" → "helper"
 * "Namespace.Class.method" → "method"
 */
export function extractShortName(qualifiedName: string): string {
  const lastDot = qualifiedName.lastIndexOf(".");
  return lastDot >= 0 ? qualifiedName.slice(lastDot + 1) : qualifiedName;
}

/**
 * Find an identifier in a line of source code.
 * Returns the 0-indexed character offset, or -1 if not found.
 *
 * Matches whole words only (bounded by non-identifier characters).
 */
export function findIdentifierInLine(line: string, identifier: string): number {
  if (!identifier || !line) return -1;

  const escaped = escapeRegex(identifier);

  // Use word boundary matching. If the identifier starts/ends with non-word chars
  // (like $), use lookaround for non-identifier characters instead.
  const startsWithWord = /^\w/.test(identifier);
  const endsWithWord = /\w$/.test(identifier);

  const prefix = startsWithWord ? "\\b" : "(?<![\\w$])";
  const suffix = endsWithWord ? "\\b" : "(?![\\w$])";

  const regex = new RegExp(`${prefix}${escaped}${suffix}`);
  const match = regex.exec(line);
  if (!match) return -1;
  return match.index;
}

/**
 * Search lines near the indexed position for the identifier.
 * Returns the first match within ±radius lines.
 */
export function searchNearby(
  lines: string[],
  centerLine: number,
  identifier: string,
  radius: number,
): { line: number; character: number } | null {
  // Search outward from center, alternating above and below
  for (let offset = 1; offset <= radius; offset++) {
    for (const dir of [-1, 1]) {
      const lineIdx = centerLine + (offset * dir);
      if (lineIdx < 0 || lineIdx >= lines.length) continue;

      const col = findIdentifierInLine(lines[lineIdx], identifier);
      if (col !== -1) {
        return { line: lineIdx, character: col };
      }
    }
  }
  return null;
}

/**
 * Find a symbol declaration in the full file.
 * Uses keyword heuristics to prefer declaration sites over usage sites.
 *
 * For example, "function foo" is preferred over just "foo" appearing in an expression.
 */
export function findSymbolDeclaration(
  lines: string[],
  name: string,
  kind: string,
): { line: number; character: number } | null {
  const declarationPatterns = getDeclarationPatterns(name, kind);

  // First pass: look for declaration patterns
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of declarationPatterns) {
      const match = pattern.exec(lines[i]);
      if (match) {
        // Find the identifier within the matched region
        const col = findIdentifierInLine(lines[i], name);
        if (col !== -1) {
          return { line: i, character: col };
        }
      }
    }
  }

  // Second pass: any occurrence (word-bounded)
  for (let i = 0; i < lines.length; i++) {
    const col = findIdentifierInLine(lines[i], name);
    if (col !== -1) {
      return { line: i, character: col };
    }
  }

  return null;
}

/**
 * Get regex patterns that match declaration sites for a symbol kind.
 */
function getDeclarationPatterns(name: string, kind: string): RegExp[] {
  const escaped = escapeRegex(name);
  const patterns: RegExp[] = [];

  switch (kind) {
    case "function":
      patterns.push(
        new RegExp(`\\bfunction\\s+${escaped}\\b`),
        new RegExp(`\\bconst\\s+${escaped}\\s*=`),
        new RegExp(`\\blet\\s+${escaped}\\s*=`),
        new RegExp(`\\bvar\\s+${escaped}\\s*=`),
        new RegExp(`\\bdef\\s+${escaped}\\b`),         // Python
        new RegExp(`\\bfn\\s+${escaped}\\b`),          // Rust
        new RegExp(`\\bfunc\\s+${escaped}\\b`),         // Go/Swift
      );
      break;
    case "class":
      patterns.push(
        new RegExp(`\\bclass\\s+${escaped}\\b`),
        new RegExp(`\\bstruct\\s+${escaped}\\b`),       // Rust/Go/Swift
      );
      break;
    case "method":
      patterns.push(
        new RegExp(`\\b${escaped}\\s*\\(`),              // method call/definition
        new RegExp(`\\basync\\s+${escaped}\\s*\\(`),
        new RegExp(`\\bdef\\s+${escaped}\\b`),           // Python
        new RegExp(`\\bfn\\s+${escaped}\\b`),            // Rust
        new RegExp(`\\bfunc\\s+${escaped}\\b`),           // Go/Swift
      );
      break;
    case "interface":
      patterns.push(
        new RegExp(`\\binterface\\s+${escaped}\\b`),
        new RegExp(`\\btrait\\s+${escaped}\\b`),         // Rust
        new RegExp(`\\bprotocol\\s+${escaped}\\b`),      // Swift
      );
      break;
    case "type":
      patterns.push(
        new RegExp(`\\btype\\s+${escaped}\\b`),
        new RegExp(`\\btypealias\\s+${escaped}\\b`),     // Swift
      );
      break;
    case "enum":
      patterns.push(
        new RegExp(`\\benum\\s+${escaped}\\b`),
      );
      break;
    case "variable":
      patterns.push(
        new RegExp(`\\bconst\\s+${escaped}\\b`),
        new RegExp(`\\blet\\s+${escaped}\\b`),
        new RegExp(`\\bvar\\s+${escaped}\\b`),
        new RegExp(`\\b${escaped}\\s*=`),
      );
      break;
    case "property":
      patterns.push(
        new RegExp(`\\b${escaped}\\s*[=:]`),
        new RegExp(`\\breadonly\\s+${escaped}\\b`),
        new RegExp(`\\bprivate\\s+${escaped}\\b`),
        new RegExp(`\\bpublic\\s+${escaped}\\b`),
        new RegExp(`\\bprotected\\s+${escaped}\\b`),
      );
      break;
  }

  return patterns;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Format a ResolveInput for error messages.
 */
function formatInput(input: ResolveInput): string {
  const parts: string[] = [];
  if (input.symbol) parts.push(`symbol="${input.symbol}"`);
  if (input.file) parts.push(`file="${input.file}"`);
  if (input.scope) parts.push(`scope="${input.scope}"`);
  if (input.line !== undefined) parts.push(`line=${input.line}`);
  return parts.join(", ") || "(empty input)";
}
