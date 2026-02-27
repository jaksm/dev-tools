/**
 * Symbol resolver — resolve various input formats to SymbolInfo.
 */

import type { SymbolInfo } from "../types.js";
import { SymbolIndex } from "./symbol-index.js";

export interface ResolveInput {
  symbol?: string;
  file?: string;
  scope?: string;
  line?: number;
  col?: number;
}

export interface ResolveResult {
  symbols: SymbolInfo[];
  ambiguous: boolean;
}

/**
 * Resolve symbol from various input formats.
 * 
 * Supported inputs:
 * - { symbol: "UserService.authenticate" } → exact lookup
 * - { symbol: "authenticate", file: "user.ts" } → file-scoped lookup
 * - { symbol: "authenticate", scope: "UserService" } → scope-qualified lookup
 * - { file: "...", line: N } → find symbol containing that line
 */
export function resolveSymbol(
  input: ResolveInput,
  index: SymbolIndex,
): ResolveResult {
  // Case 1: Qualified name exact lookup
  if (input.symbol && !input.file && !input.scope) {
    const exact = index.lookupExact(input.symbol);
    if (exact.length > 0) {
      return { symbols: exact, ambiguous: exact.length > 1 };
    }
    // Try partial match
    const partial = index.lookupPartial(input.symbol);
    return { symbols: partial, ambiguous: partial.length > 1 };
  }

  // Case 2: Symbol + file
  if (input.symbol && input.file) {
    const fileSymbols = index.lookupByFile(input.file);
    const matches = fileSymbols.filter(s =>
      s.qualifiedName === input.symbol ||
      s.qualifiedName.endsWith(`.${input.symbol}`) ||
      s.qualifiedName === input.symbol,
    );

    if (matches.length > 0) {
      return { symbols: matches, ambiguous: matches.length > 1 };
    }

    // Fallback: partial match within file
    const partial = fileSymbols.filter(s =>
      s.qualifiedName.toLowerCase().includes(input.symbol!.toLowerCase()),
    );
    return { symbols: partial, ambiguous: partial.length > 1 };
  }

  // Case 3: Symbol + scope
  if (input.symbol && input.scope) {
    const qualifiedName = `${input.scope}.${input.symbol}`;
    const exact = index.lookupExact(qualifiedName);
    if (exact.length > 0) {
      return { symbols: exact, ambiguous: exact.length > 1 };
    }
    // Fallback to partial
    const partial = index.lookupPartial(qualifiedName);
    return { symbols: partial, ambiguous: partial.length > 1 };
  }

  // Case 4: File + line → find symbol at that line
  if (input.file && input.line !== undefined) {
    const fileSymbols = index.lookupByFile(input.file);
    const matches = fileSymbols.filter(s =>
      input.line! >= s.lines[0] && input.line! <= s.lines[1],
    );

    if (matches.length > 0) {
      // Return the most specific (innermost) match
      matches.sort((a, b) => (a.lines[1] - a.lines[0]) - (b.lines[1] - b.lines[0]));
      return { symbols: [matches[0]], ambiguous: false };
    }
  }

  return { symbols: [], ambiguous: false };
}
