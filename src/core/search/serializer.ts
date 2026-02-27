/**
 * Symbol-to-text serializer — converts symbol metadata into embedding-friendly text.
 * 
 * The serialized text should capture:
 * - What the symbol IS (kind + qualified name)
 * - What it DOES (signature + docs)
 * - Where it LIVES (file path context)
 * 
 * Format: "kind qualifiedName(signature) — docs | filePath"
 * Example: "method UserService.authenticate(email: string, password: string): Promise<User> — Verify credentials and return JWT | src/services/user.ts"
 */

import type { SymbolInfo } from "../types.js";

/**
 * Serialize a symbol into embedding-friendly text.
 * Designed for semantic relevance — captures concept, not just syntax.
 */
export function serializeSymbol(symbol: SymbolInfo, workspaceDir?: string): string {
  const parts: string[] = [];

  // Kind + qualified name — what it IS
  parts.push(`${symbol.kind} ${symbol.qualifiedName}`);

  // Signature — what it DOES structurally
  if (symbol.signature && symbol.signature !== symbol.qualifiedName) {
    // Clean up signature — remove the qualified name prefix if it's repeated
    let sig = symbol.signature;
    // If signature starts with the symbol name, it's likely "name(params): type"
    // which is already captured in qualifiedName, so we just want params+return
    if (!sig.includes("(") && !sig.includes(":")) {
      // Simple signature (just a type annotation) — skip if not informative
    } else {
      parts.push(sig);
    }
  }

  // Documentation — what it DOES semantically
  if (symbol.docs) {
    parts.push(`— ${symbol.docs}`);
  }

  // File path context — WHERE it lives (relative to workspace)
  let filePath = symbol.filePath;
  if (workspaceDir && filePath.startsWith(workspaceDir)) {
    filePath = filePath.slice(workspaceDir.length + 1);
  }
  parts.push(`| ${filePath}`);

  return parts.join(" ");
}

/**
 * Serialize multiple symbols, returning parallel arrays of IDs and texts.
 */
export function serializeSymbols(
  symbols: SymbolInfo[],
  workspaceDir?: string,
): { ids: string[]; texts: string[] } {
  const ids: string[] = [];
  const texts: string[] = [];

  for (const symbol of symbols) {
    // Use qualifiedName + filePath as a stable ID
    ids.push(symbolId(symbol));
    texts.push(serializeSymbol(symbol, workspaceDir));
  }

  return { ids, texts };
}

/**
 * Generate a stable ID for a symbol (used as HNSW label mapping key).
 */
export function symbolId(symbol: SymbolInfo): string {
  return `${symbol.filePath}::${symbol.qualifiedName}::${symbol.lines[0]}`;
}
