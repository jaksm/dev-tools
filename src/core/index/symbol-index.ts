/**
 * Symbol index — in-memory hash map of symbols keyed by qualified name.
 */

import type { SymbolInfo } from "../types.js";

export class SymbolIndex {
  // Primary index: qualifiedName → SymbolInfo[]  (array for ambiguous names across files)
  private byName = new Map<string, SymbolInfo[]>();
  // Secondary index: filePath → SymbolInfo[]
  private byFile = new Map<string, SymbolInfo[]>();
  // Total count
  private _size = 0;

  /**
   * Insert a symbol. Replaces existing symbol with same qualifiedName+filePath.
   */
  insert(symbol: SymbolInfo): void {
    // By name
    const existing = this.byName.get(symbol.qualifiedName);
    if (existing) {
      const idx = existing.findIndex(s => s.filePath === symbol.filePath && s.lines[0] === symbol.lines[0]);
      if (idx >= 0) {
        existing[idx] = symbol;
      } else {
        existing.push(symbol);
        this._size++;
      }
    } else {
      this.byName.set(symbol.qualifiedName, [symbol]);
      this._size++;
    }

    // By file
    const fileSymbols = this.byFile.get(symbol.filePath);
    if (fileSymbols) {
      const idx = fileSymbols.findIndex(s => s.qualifiedName === symbol.qualifiedName && s.lines[0] === symbol.lines[0]);
      if (idx >= 0) {
        fileSymbols[idx] = symbol;
      } else {
        fileSymbols.push(symbol);
      }
    } else {
      this.byFile.set(symbol.filePath, [symbol]);
    }
  }

  /**
   * Bulk insert symbols for a file, replacing all existing symbols for that file.
   */
  bulkInsertForFile(filePath: string, symbols: SymbolInfo[]): void {
    this.removeByFile(filePath);
    for (const s of symbols) {
      this.insert(s);
    }
  }

  /**
   * Lookup by exact qualified name.
   */
  lookupExact(qualifiedName: string): SymbolInfo[] {
    return this.byName.get(qualifiedName) ?? [];
  }

  /**
   * Lookup by partial name (case-insensitive substring match).
   */
  lookupPartial(query: string): SymbolInfo[] {
    const lower = query.toLowerCase();
    const results: SymbolInfo[] = [];
    for (const [name, symbols] of this.byName) {
      if (name.toLowerCase().includes(lower)) {
        results.push(...symbols);
      }
    }
    return results;
  }

  /**
   * Lookup all symbols in a file, ordered by line number.
   */
  lookupByFile(filePath: string): SymbolInfo[] {
    const symbols = this.byFile.get(filePath) ?? [];
    return symbols.slice().sort((a, b) => a.lines[0] - b.lines[0]);
  }

  /**
   * Remove all symbols for a file.
   */
  removeByFile(filePath: string): void {
    const symbols = this.byFile.get(filePath);
    if (!symbols) return;

    for (const s of symbols) {
      const nameEntries = this.byName.get(s.qualifiedName);
      if (nameEntries) {
        const idx = nameEntries.findIndex(e => e.filePath === filePath);
        if (idx >= 0) {
          nameEntries.splice(idx, 1);
          this._size--;
          if (nameEntries.length === 0) {
            this.byName.delete(s.qualifiedName);
          }
        }
      }
    }

    this.byFile.delete(filePath);
  }

  /**
   * Get all indexed file paths.
   */
  get files(): string[] {
    return [...this.byFile.keys()];
  }

  /**
   * Get total symbol count.
   */
  get size(): number {
    return this._size;
  }

  /**
   * Iterate all symbols.
   */
  *allSymbols(): IterableIterator<SymbolInfo> {
    for (const symbols of this.byName.values()) {
      yield* symbols;
    }
  }

  /**
   * Clear all data.
   */
  clear(): void {
    this.byName.clear();
    this.byFile.clear();
    this._size = 0;
  }
}
