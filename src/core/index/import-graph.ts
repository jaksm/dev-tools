/**
 * Import graph — directed graph of file import relationships.
 * Combines explicit import edges with type-reference edges for languages
 * that don't have file-level imports (e.g., Swift).
 */

import type { FileImportsExports } from "./indexer.js";
import type { SymbolIndex } from "./symbol-index.js";
import fs from "node:fs";

export class ImportGraph {
  // file → files it imports
  private edges = new Map<string, Set<string>>();
  // file → files that import it (reverse edges)
  private reverseEdges = new Map<string, Set<string>>();

  /**
   * Build graph from indexer's import/export data.
   */
  build(
    fileImports: Map<string, FileImportsExports>,
    workspaceDir: string,
  ): void {
    this.edges.clear();
    this.reverseEdges.clear();

    const allFiles = new Set(fileImports.keys());

    for (const [filePath, data] of fileImports) {
      const deps = new Set<string>();

      for (const imp of data.imports) {
        if (!imp.isRelative || !imp.resolved) continue;

        // Resolve to actual file (try with extensions, checking against known files)
        const resolved = resolveToFile(imp.resolved, workspaceDir, allFiles);
        if (resolved) {
          deps.add(resolved);

          // Add reverse edge
          if (!this.reverseEdges.has(resolved)) {
            this.reverseEdges.set(resolved, new Set());
          }
          this.reverseEdges.get(resolved)!.add(filePath);
        }
      }

      this.edges.set(filePath, deps);
    }
  }

  /**
   * Add edges from type-reference analysis.
   * For each file, resolves referenced type names to their defining files
   * via the symbol index, creating cross-file dependency edges.
   * This is critical for languages like Swift where files in the same module
   * reference each other without explicit import statements.
   */
  addTypeReferenceEdges(
    fileTypeRefs: Map<string, string[]>,
    symbolIndex: SymbolIndex,
  ): void {
    // Build a map: type/class name → all defining file paths
    // A type name may be defined in multiple files (e.g., Environment in both
    // httpie/context.py and extras/profiling/run.py)
    const typeToFiles = new Map<string, Set<string>>();
    for (const filePath of symbolIndex.files) {
      for (const sym of symbolIndex.lookupByFile(filePath)) {
        if (["class", "interface", "enum", "type"].includes(sym.kind)) {
          const baseName = sym.qualifiedName.includes(".")
            ? sym.qualifiedName.split(".").pop()!
            : sym.qualifiedName;
          if (!typeToFiles.has(baseName)) {
            typeToFiles.set(baseName, new Set());
          }
          typeToFiles.get(baseName)!.add(filePath);
        }
      }
    }

    // For each file's type references, create edges to all defining files.
    // When a type name is ambiguous (defined in multiple files), all definitions
    // get edges — we don't know which one the reference means.
    for (const [filePath, refs] of fileTypeRefs) {
      if (!this.edges.has(filePath)) {
        this.edges.set(filePath, new Set());
      }
      const deps = this.edges.get(filePath)!;

      for (const ref of refs) {
        const defFiles = typeToFiles.get(ref);
        if (!defFiles) continue;

        for (const defFile of defFiles) {
          if (defFile === filePath) continue;

          deps.add(defFile);

          if (!this.reverseEdges.has(defFile)) {
            this.reverseEdges.set(defFile, new Set());
          }
          this.reverseEdges.get(defFile)!.add(filePath);
        }
      }
    }
  }

  /**
   * Get files imported by a given file.
   */
  dependencies(filePath: string): string[] {
    return [...(this.edges.get(filePath) ?? [])];
  }

  /**
   * Get files that import a given file.
   */
  importers(filePath: string): string[] {
    return [...(this.reverseEdges.get(filePath) ?? [])];
  }

  /**
   * Get in-degree (how many files import this file).
   */
  inDegree(filePath: string): number {
    return this.reverseEdges.get(filePath)?.size ?? 0;
  }

  /**
   * Get all files in the graph.
   */
  get files(): string[] {
    return [...new Set([...this.edges.keys(), ...this.reverseEdges.keys()])];
  }

  /**
   * Get total edge count.
   */
  get edgeCount(): number {
    let count = 0;
    for (const deps of this.edges.values()) {
      count += deps.size;
    }
    return count;
  }

  /**
   * Clear all data.
   */
  clear(): void {
    this.edges.clear();
    this.reverseEdges.clear();
  }
}

/**
 * Resolve an import path to an actual file.
 * First checks against known files set, then falls back to disk.
 */
function resolveToFile(resolved: string, _workspaceDir: string, knownFiles: Set<string>): string | null {
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
  const indexFiles = extensions.map(e => "/index" + e);

  // Strip existing extension for re-resolution (ESM .js → .ts)
  const stripped = resolved.replace(/\.[jt]sx?$/, "");

  const candidates = [
    resolved,
    ...extensions.map(e => resolved + e),
    ...extensions.map(e => stripped + e),
    ...indexFiles.map(idx => resolved + idx),
    ...indexFiles.map(idx => stripped + idx),
  ];

  // Check against known files first (fast, no I/O)
  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }

  // Fall back to disk
  for (const c of candidates) {
    try {
      fs.accessSync(c);
      return c;
    } catch {
      // continue
    }
  }

  return null;
}
