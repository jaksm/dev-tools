/**
 * INDEX.json generator — produces the workspace index file.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { SymbolIndex } from "./symbol-index.js";
import { ImportGraph } from "./import-graph.js";
import { computeRanks, type FileRank } from "./ranking.js";
import type { FileImportsExports } from "./indexer.js";

export interface IndexJsonEntry {
  file: string; // relative path
  lines: number;
  rank: number;
  exports: string[];
  imports: string[];
  symbols: number;
}

export interface IndexJson {
  version: 1;
  workspace: string;
  generatedAt: string;
  files: IndexJsonEntry[];
  totalSymbols: number;
  totalFiles: number;
}

/**
 * Generate INDEX.json data from symbol index + import graph.
 */
export function generateIndexJson(opts: {
  symbolIndex: SymbolIndex;
  importGraph: ImportGraph;
  fileImports: Map<string, FileImportsExports>;
  workspaceDir: string;
  fileLineCounts?: Map<string, number>;
}): IndexJson {
  const { symbolIndex, importGraph, workspaceDir, fileImports } = opts;
  const fileLineCounts = opts.fileLineCounts ?? new Map();

  const ranks = computeRanks(importGraph, workspaceDir);
  const rankMap = new Map<string, FileRank>();
  for (const r of ranks) rankMap.set(r.filePath, r);

  const entries: IndexJsonEntry[] = [];
  const allFiles = new Set([...symbolIndex.files, ...importGraph.files]);

  for (const filePath of allFiles) {
    const relativePath = path.relative(workspaceDir, filePath);
    const symbols = symbolIndex.lookupByFile(filePath);
    const rank = rankMap.get(filePath)?.rank ?? 0;
    const ie = fileImports.get(filePath);

    // Count lines from symbol data (max end line across symbols)
    const lineCount = fileLineCounts.get(filePath)
      ?? symbols.reduce((max, s) => Math.max(max, s.lines[1]), 0);

    entries.push({
      file: relativePath,
      lines: lineCount,
      rank,
      exports: ie?.exports.map(e => e.name) ?? [],
      imports: [
        // Resolved relative imports → actual file paths (from import graph)
        ...importGraph.dependencies(filePath).map(dep => path.relative(workspaceDir, dep)),
        // Non-relative (package) imports — as-is
        ...(ie?.imports.filter(i => !i.isRelative).map(i => i.source) ?? []),
      ],
      symbols: symbols.length,
    });
  }

  // Sort by rank descending
  entries.sort((a, b) => b.rank - a.rank);

  return {
    version: 1,
    workspace: workspaceDir,
    generatedAt: new Date().toISOString(),
    files: entries,
    totalSymbols: symbolIndex.size,
    totalFiles: entries.length,
  };
}

/**
 * Write INDEX.json to disk.
 */
export async function writeIndexJson(
  indexJson: IndexJson,
  storageDir: string,
): Promise<void> {
  const indexPath = path.join(storageDir, "INDEX.json");
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(indexJson, null, 2), "utf-8");
}
