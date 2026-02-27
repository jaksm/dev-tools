/**
 * INDEX.json renderer — render into compact text for context injection.
 * Token budget scaling based on project size.
 */

import path from "node:path";
import type { IndexJson, IndexJsonEntry } from "./index-json.js";

export interface RenderOptions {
  maxFiles?: number; // Override automatic scaling
}

/**
 * Render INDEX.json into compact text for agent context.
 * 
 * Scaling strategy:
 * - ≤100 files → full detail (all files with symbols + exports)
 * - ≤500 files → top 200 by rank + directory summaries
 * - ≤2000 files → directory summaries + top 100 files
 * - >2000 files → directory summaries only + top 50 files
 */
export function renderIndex(index: IndexJson, opts?: RenderOptions): string {
  const totalFiles = index.files.length;
  const lines: string[] = [];

  lines.push(`# Project Index — ${totalFiles} files, ${index.totalSymbols} symbols`);
  lines.push("");

  if (totalFiles === 0) {
    lines.push("(no indexed files)");
    return lines.join("\n");
  }

  // Determine strategy
  let maxFileEntries: number;
  let showDirSummaries: boolean;

  if (opts?.maxFiles !== undefined) {
    maxFileEntries = opts.maxFiles;
    showDirSummaries = totalFiles > 100;
  } else if (totalFiles <= 100) {
    maxFileEntries = totalFiles;
    showDirSummaries = false;
  } else if (totalFiles <= 500) {
    maxFileEntries = 200;
    showDirSummaries = true;
  } else if (totalFiles <= 2000) {
    maxFileEntries = 100;
    showDirSummaries = true;
  } else {
    maxFileEntries = 50;
    showDirSummaries = true;
  }

  if (showDirSummaries) {
    // Group by top-level directory
    const dirGroups = groupByDirectory(index.files);
    lines.push("## Directories");
    for (const [dir, entries] of dirGroups) {
      const totalLines = entries.reduce((s, e) => s + e.lines, 0);
      const totalSymbols = entries.reduce((s, e) => s + e.symbols, 0);
      lines.push(`  ${dir}/ — ${entries.length} files, ${totalSymbols} symbols, ${formatLines(totalLines)}`);
    }
    lines.push("");
  }

  // Top files by rank
  const topFiles = index.files.slice(0, maxFileEntries);
  if (topFiles.length > 0) {
    lines.push(showDirSummaries ? `## Top ${topFiles.length} files by importance` : "## Files");
    for (const entry of topFiles) {
      const exports = entry.exports.length > 0 ? ` → ${entry.exports.join(", ")}` : "";
      const rank = entry.rank > 0 ? ` [rank: ${entry.rank.toFixed(2)}]` : "";
      lines.push(`  ${entry.file} (${entry.symbols} symbols, ${formatLines(entry.lines)})${exports}${rank}`);
    }
  }

  if (totalFiles > maxFileEntries) {
    lines.push(`  ... and ${totalFiles - maxFileEntries} more files`);
  }

  return lines.join("\n");
}

function groupByDirectory(entries: IndexJsonEntry[]): Map<string, IndexJsonEntry[]> {
  const groups = new Map<string, IndexJsonEntry[]>();

  for (const entry of entries) {
    const parts = entry.file.split(path.sep);
    const topDir = parts.length > 1 ? parts[0] : ".";

    if (!groups.has(topDir)) {
      groups.set(topDir, []);
    }
    groups.get(topDir)!.push(entry);
  }

  // Sort by total symbols descending
  return new Map(
    [...groups.entries()].sort((a, b) => {
      const aSyms = a[1].reduce((s, e) => s + e.symbols, 0);
      const bSyms = b[1].reduce((s, e) => s + e.symbols, 0);
      return bSyms - aSyms;
    }),
  );
}

function formatLines(lines: number): string {
  if (lines >= 1000) return `${(lines / 1000).toFixed(1)}K lines`;
  return `${lines} lines`;
}
