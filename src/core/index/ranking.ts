/**
 * PageRank-lite — file importance ranking from import graph centrality.
 */

import path from "node:path";
import { ImportGraph } from "./import-graph.js";

const ENTRY_POINT_PATTERNS = [
  /^index\.[jt]sx?$/,
  /^main\.[jt]sx?$/,
  /^app\.[jt]sx?$/,
  /^server\.[jt]sx?$/,
  /^cli\.[jt]sx?$/,
];

const PENALTY_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.config\.[jt]sx?$/,
  /\.d\.ts$/,
  /__tests__\//,
  /__mocks__\//,
  /\.generated\./,
  /\.gen\./,
];

export interface FileRank {
  filePath: string;
  rank: number; // 0-1 normalized
  inDegree: number;
}

/**
 * Compute static file ranks from import graph centrality.
 * Simple approach: in-degree + entry point boost + penalty patterns.
 */
export function computeRanks(
  graph: ImportGraph,
  workspaceDir: string,
): FileRank[] {
  const files = graph.files;
  if (files.length === 0) return [];

  const rawScores = new Map<string, number>();

  for (const file of files) {
    const inDegree = graph.inDegree(file);
    let score = inDegree;

    const basename = path.basename(file);
    const relativePath = path.relative(workspaceDir, file);

    // Entry point boost
    if (ENTRY_POINT_PATTERNS.some(p => p.test(basename))) {
      score += 5;
    }

    // Penalty for test/config/generated files
    if (PENALTY_PATTERNS.some(p => p.test(relativePath))) {
      score *= 0.3;
    }

    rawScores.set(file, score);
  }

  // Normalize to 0-1
  let maxScore = 0;
  for (const s of rawScores.values()) {
    if (s > maxScore) maxScore = s;
  }

  const ranks: FileRank[] = [];
  for (const file of files) {
    const raw = rawScores.get(file) ?? 0;
    ranks.push({
      filePath: file,
      rank: maxScore > 0 ? raw / maxScore : 0,
      inDegree: graph.inDegree(file),
    });
  }

  // Sort by rank descending
  ranks.sort((a, b) => b.rank - a.rank);

  return ranks;
}
