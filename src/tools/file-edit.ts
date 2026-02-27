/**
 * file_edit — Search and replace with 7-strategy cascading replacement.
 * Strict ambiguity resolution. Multiple edits per call.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "../core/types.js";
import { resolvePath } from "../core/security.js";
import { withFileLock } from "../core/file-mutex.js";

export interface EditOperation {
  oldText: string;
  newText: string;
  lineHint?: number;
}

export interface FileEditParams {
  path: string;
  edits: EditOperation[];
}

interface MatchResult {
  index: number;
  line: number;
  strategy: string;
}

// ── Cascading Replacement Strategies ────────────────────────────────────────

function findExactMatches(content: string, oldText: string): MatchResult[] {
  const results: MatchResult[] = [];
  let idx = 0;
  while (true) {
    const found = content.indexOf(oldText, idx);
    if (found === -1) break;
    results.push({ index: found, line: lineAt(content, found), strategy: "exact" });
    idx = found + 1;
  }
  return results;
}

function findLineTrimmedMatches(content: string, oldText: string): MatchResult[] {
  return findNormalizedMatches(content, oldText, trimLines, "line-trimmed");
}

function findBlockAnchorMatches(content: string, oldText: string): MatchResult[] {
  const oldLines = oldText.split("\n");
  if (oldLines.length < 3) return [];

  const firstLine = oldLines[0]!.trim();
  const lastLine = oldLines[oldLines.length - 1]!.trim();
  if (!firstLine || !lastLine) return [];

  const contentLines = content.split("\n");
  const results: MatchResult[] = [];

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i]!.trim() !== firstLine) continue;

    // Search for matching last line within reasonable range
    const maxEnd = Math.min(i + oldLines.length + 5, contentLines.length);
    for (let j = i + oldLines.length - 2; j < maxEnd; j++) {
      if (j >= contentLines.length) break;
      if (contentLines[j]!.trim() !== lastLine) continue;

      // Found anchor pair — check edit distance of middle
      const candidateBlock = contentLines.slice(i, j + 1).join("\n");
      const distance = levenshteinDistance(
        normalizeWhitespace(oldText),
        normalizeWhitespace(candidateBlock),
      );
      const threshold = Math.floor(oldText.length * 0.15);
      if (distance <= threshold) {
        const charIdx = contentLines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
        results.push({ index: charIdx, line: i + 1, strategy: "block-anchor" });
      }
    }
  }

  return results;
}

function findWhitespaceNormalizedMatches(content: string, oldText: string): MatchResult[] {
  return findNormalizedMatches(content, oldText, normalizeWhitespace, "whitespace-normalized");
}

function findIndentationFlexibleMatches(content: string, oldText: string): MatchResult[] {
  return findNormalizedMatches(content, oldText, stripMinIndent, "indentation-flexible");
}

function findEscapeNormalizedMatches(content: string, oldText: string): MatchResult[] {
  return findNormalizedMatches(content, oldText, normalizeEscapes, "escape-normalized");
}

function findUnicodeNormalizedMatches(content: string, oldText: string): MatchResult[] {
  return findNormalizedMatches(content, oldText, normalizeUnicode, "unicode-normalized");
}

// ── Normalization Functions ─────────────────────────────────────────────────

function trimLines(text: string): string {
  return text.split("\n").map((l) => l.trim()).join("\n");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripMinIndent(text: string): string {
  const lines = text.split("\n");
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  if (nonEmptyLines.length === 0) return text;
  const minIndent = Math.min(
    ...nonEmptyLines.map((l) => l.match(/^(\s*)/)?.[1]?.length ?? 0),
  );
  return lines.map((l) => l.slice(minIndent)).join("\n");
}

function normalizeEscapes(text: string): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"');
}

function normalizeUnicode(text: string): string {
  return text
    // Smart quotes → ASCII
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    // Unicode dashes → ASCII hyphen
    .replace(/[\u2013\u2014\u2015\u2212]/g, "-")
    // Special spaces → regular space
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F]/g, " ");
}

// ── Helper: Find matches using a normalization function ─────────────────────

function findNormalizedMatches(
  content: string,
  oldText: string,
  normalize: (s: string) => string,
  strategy: string,
): MatchResult[] {
  const normOld = normalize(oldText);
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  const results: MatchResult[] = [];

  // Slide window of oldLines.length over contentLines
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const window = contentLines.slice(i, i + oldLines.length).join("\n");
    if (normalize(window) === normOld) {
      const charIdx = contentLines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
      results.push({ index: charIdx, line: i + 1, strategy });
    }
  }

  return results;
}

// ── Helper: line number at char index ───────────────────────────────────────

function lineAt(content: string, charIdx: number): number {
  let line = 1;
  for (let i = 0; i < charIdx; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// ── Helper: Levenshtein distance (for block-anchor) ─────────────────────────

function levenshteinDistance(a: string, b: string): number {
  if (a.length > 500 || b.length > 500) {
    // For long strings, use a simple character diff ratio
    const maxLen = Math.max(a.length, b.length);
    let diffs = 0;
    for (let i = 0; i < maxLen; i++) {
      if (a[i] !== b[i]) diffs++;
    }
    return diffs;
  }

  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0) as number[]);
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }

  return dp[a.length]![b.length]!;
}

// ── Resolve match with ambiguity rules ──────────────────────────────────────

function resolveMatch(
  matches: MatchResult[],
  lineHint: number | undefined,
  content: string,
  oldText: string,
): { match: MatchResult } | { error: string; locations?: Array<{ line: number; context: string }> } {
  if (matches.length === 0) {
    // No match found — find closest fuzzy suggestion
    const normContent = normalizeWhitespace(content);
    const normOld = normalizeWhitespace(oldText);
    // Simple check: is the normalized version found?
    if (normContent.includes(normOld)) {
      return { error: "no_exact_match", locations: [{ line: 0, context: "Content exists but differs in whitespace/formatting. Check indentation." }] };
    }
    return { error: "no_match_found" };
  }

  if (matches.length === 1) {
    return { match: matches[0]! };
  }

  // Multiple matches
  if (lineHint !== undefined) {
    // Find nearest within ±5 lines
    const nearby = matches
      .map((m) => ({ ...m, distance: Math.abs(m.line - lineHint) }))
      .filter((m) => m.distance <= 5)
      .sort((a, b) => a.distance - b.distance);

    if (nearby.length >= 1) {
      return { match: nearby[0]! };
    }
  }

  // Ambiguous — return all locations
  const contentLines = content.split("\n");
  const locations = matches.map((m) => {
    const contextStart = Math.max(0, m.line - 2);
    const contextEnd = Math.min(contentLines.length, m.line + 2);
    const context = contentLines.slice(contextStart, contextEnd).join("\n");
    return { line: m.line, context };
  });

  return {
    error: `Ambiguous: found ${matches.length} matches. Provide lineHint to disambiguate.`,
    locations,
  };
}

// ── Main: Apply cascading replacement ───────────────────────────────────────

const STRATEGIES = [
  findExactMatches,
  findLineTrimmedMatches,
  findBlockAnchorMatches,
  findWhitespaceNormalizedMatches,
  findIndentationFlexibleMatches,
  findEscapeNormalizedMatches,
  findUnicodeNormalizedMatches,
];

function findMatchCascading(
  content: string,
  oldText: string,
  lineHint: number | undefined,
): { match: MatchResult; replaceText: string } | { error: string; locations?: Array<{ line: number; context: string }> } {
  // Collect all matches from all strategies
  let allMatches: MatchResult[] = [];

  for (const strategy of STRATEGIES) {
    const matches = strategy(content, oldText);
    if (matches.length > 0) {
      // First strategy with matches — try to resolve
      const resolved = resolveMatch(matches, lineHint, content, oldText);
      if ("match" in resolved) {
        // We need to figure out the actual text to replace in the original content
        const match = resolved.match;
        const replaceText = extractOriginalText(content, match, oldText);
        return { match, replaceText };
      }
      // If ambiguous at this strategy level, collect and continue
      allMatches = allMatches.concat(matches);
    }
  }

  // No strategy produced a unique match — deduplicate by line number
  if (allMatches.length > 0) {
    const contentLines = content.split("\n");
    const seenLines = new Set<number>();
    const uniqueMatches = allMatches.filter((m) => {
      if (seenLines.has(m.line)) return false;
      seenLines.add(m.line);
      return true;
    });
    const locations = uniqueMatches.map((m) => {
      const contextStart = Math.max(0, m.line - 2);
      const contextEnd = Math.min(contentLines.length, m.line + 2);
      const context = contentLines.slice(contextStart, contextEnd).join("\n");
      return { line: m.line, context };
    });

    // If deduplication resolves to a single match, use it
    if (uniqueMatches.length === 1) {
      const match = uniqueMatches[0]!;
      const replaceText = extractOriginalText(content, match, oldText);
      return { match, replaceText };
    }

    return {
      error: `Ambiguous: found ${uniqueMatches.length} locations. Provide lineHint to disambiguate.`,
      locations,
    };
  }

  return { error: "no_match_found" };
}

function extractOriginalText(content: string, match: MatchResult, oldText: string): string {
  if (match.strategy === "exact") {
    return oldText;
  }
  // For fuzzy strategies, extract the actual text from content at the match position
  const oldLineCount = oldText.split("\n").length;
  const contentLines = content.split("\n");
  const startLine = match.line - 1;
  const endLine = Math.min(startLine + oldLineCount, contentLines.length);
  return contentLines.slice(startLine, endLine).join("\n");
}

// ── Exported Tool Function ──────────────────────────────────────────────────

export interface FileEditLspOptions {
  lspManager?: import("../core/lsp/manager.js").LspManager | null;
}

export async function fileEdit(params: FileEditParams, ctx: ToolContext, lspOptions?: FileEditLspOptions): Promise<unknown> {
  const { workspaceDir } = ctx;
  const resolvedPath = resolvePath(params.path, workspaceDir);

  return withFileLock(resolvedPath, async () => {
  // Read file
  let content: string;
  try {
    content = await fs.readFile(resolvedPath, "utf-8");
  } catch {
    return { error: "file_not_found", path: params.path };
  }

  if (!params.edits || params.edits.length === 0) {
    return { error: "no_edits_provided" };
  }

  // Apply edits sequentially
  const results: Array<{ status: string; strategy?: string; error?: string; locations?: unknown }> = [];
  let applied = 0;

  for (const edit of params.edits) {
    const matchResult = findMatchCascading(content, edit.oldText, edit.lineHint);

    if ("error" in matchResult) {
      results.push({
        status: "failed",
        error: matchResult.error,
        locations: matchResult.locations,
      });
      continue;
    }

    // Apply the replacement
    const { match, replaceText } = matchResult;
    const idx = content.indexOf(replaceText, match.index > 0 ? match.index - 10 : 0);
    if (idx !== -1) {
      content = content.slice(0, idx) + edit.newText + content.slice(idx + replaceText.length);
      applied++;
      results.push({ status: "applied", strategy: match.strategy });
    } else {
      // Fallback: try direct replacement at the matched position
      content = content.slice(0, match.index) + edit.newText + content.slice(match.index + replaceText.length);
      applied++;
      results.push({ status: "applied", strategy: match.strategy });
    }
  }

  // Write back
  if (applied > 0) {
    await fs.writeFile(resolvedPath, content, "utf-8");
  }

  const response: Record<string, unknown> = {
    applied,
    path: path.relative(workspaceDir, resolvedPath),
  };

  // Include details if any failed
  const failures = results.filter((r) => r.status === "failed");
  if (failures.length > 0) {
    response.failures = failures;
  }

  // Include strategies used
  const strategies = results
    .filter((r) => r.status === "applied" && r.strategy !== "exact")
    .map((r) => r.strategy);
  if (strategies.length > 0) {
    response.strategies = [...new Set(strategies)];
  }

  // Post-edit LSP diagnostics: if LSP is running, notify it of the change
  // and include any new diagnostics in the response
  if (applied > 0 && lspOptions?.lspManager) {
    const lspManager = lspOptions.lspManager;
    const client = await lspManager.getClient(resolvedPath);
    if (client) {
      try {
        // Send the updated content to the LSP server
        await client.changeDocument(
          (await import("node:url")).pathToFileURL(resolvedPath).toString(),
          content,
        );

        // Wait briefly for diagnostics to arrive
        await new Promise(resolve => setTimeout(resolve, 2_000));

        // Check for new diagnostics
        const uri = (await import("node:url")).pathToFileURL(resolvedPath).toString();
        const fileDiags = lspManager.diagnostics.getForUri(uri);
        const errors = fileDiags.filter(d => d.severity === 1);
        const warnings = fileDiags.filter(d => d.severity === 2);

        if (errors.length > 0 || warnings.length > 0) {
          response.lspDiagnostics = {
            errors: errors.length,
            warnings: warnings.length,
            items: [...errors, ...warnings].slice(0, 5).map(d => ({
              line: d.line,
              severity: d.severityLabel,
              message: d.message,
            })),
          };
        }
      } catch {
        // LSP diagnostics are best-effort — don't fail the edit
      }
    }
  }

  return response;
  }); // end withFileLock
}
