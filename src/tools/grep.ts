/**
 * grep — Ripgrep wrapper with .gitignore awareness, multiple output modes.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { ToolContext } from "../core/types.js";
import { truncateIfNeeded } from "../core/token-budget.js";

export interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  mode?: "content" | "files" | "count";
  caseInsensitive?: boolean;
  multiline?: boolean;
  contextLines?: number;
}

export async function grep(params: GrepParams, ctx: ToolContext): Promise<unknown> {
  const { workspaceDir, storageDir, config } = ctx;
  const mode = params.mode ?? "content";

  // Build rg args — note: --json is incompatible with --count/--files-with-matches
  const args: string[] = [];

  if (mode === "files") {
    args.push("--files-with-matches");
  } else if (mode === "count") {
    args.push("--count");
  } else {
    args.push("--json");
  }

  if (params.caseInsensitive) args.push("-i");
  if (params.multiline) args.push("--multiline");
  if (params.contextLines !== undefined && mode === "content") {
    args.push("-C", String(params.contextLines));
  } else if (mode === "content") {
    args.push("-C", "2"); // Default 2 lines of context
  }

  if (params.glob) {
    args.push("-g", params.glob);
  }

  args.push("--", params.pattern);

  // Search path
  const searchPath = params.path
    ? path.resolve(workspaceDir, params.path)
    : workspaceDir;
  args.push(searchPath);

  return new Promise((resolve) => {
    execFile(
      "rg",
      args,
      {
        cwd: workspaceDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
      },
      async (error, stdout, stderr) => {
        // rg returns exit code 1 for no matches (not an error)
        if (error && "code" in error && error.code !== 1) {
          // Check if rg is installed
          if ((error.code as unknown) === "ENOENT" || stderr.includes("not found")) {
            resolve({
              error: "ripgrep_not_found",
              message: "ripgrep (rg) is not installed. Install it: brew install ripgrep",
            });
            return;
          }
          resolve({
            error: "grep_error",
            message: stderr || String(error),
          });
          return;
        }

        if (!stdout.trim()) {
          resolve({ matches: [], totalMatches: 0 });
          return;
        }

        const lines = stdout.trim().split("\n");

        // For files/count modes, parse plain text (--json not used)
        if (mode === "files") {
          const files = lines
            .map((l: string) => l.trim())
            .filter((l: string) => l.length > 0)
            .map((l: string) => path.relative(workspaceDir, l));
          resolve({ files, totalMatches: files.length });
          return;
        }

        if (mode === "count") {
          const counts: Array<{ file: string; count: number }> = [];
          let totalMatches = 0;
          for (const line of lines) {
            // rg --count output: /path/to/file:N
            const sep = line.lastIndexOf(":");
            if (sep === -1) continue;
            const filePath = line.slice(0, sep);
            const count = parseInt(line.slice(sep + 1), 10);
            if (isNaN(count)) continue;
            counts.push({ file: path.relative(workspaceDir, filePath), count });
            totalMatches += count;
          }
          resolve({ counts, totalMatches });
          return;
        }

        // Parse rg JSON output (content mode)
        const matches: Array<Record<string, unknown>> = [];
        let totalMatches = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.type === "match") {
              const data = entry.data as Record<string, unknown>;
              const pathData = data.path as Record<string, string>;
              const lineData = data.line_number as number;
              const linesData = data.lines as Record<string, string>;

              matches.push({
                file: path.relative(workspaceDir, pathData.text),
                line: lineData,
                content: linesData.text?.trimEnd(),
              });
              totalMatches++;
            } else if (entry.type === "summary") {
              const data = entry.data as Record<string, unknown>;
              const stats = data.stats as Record<string, number>;
              totalMatches = stats?.matches ?? totalMatches;
            }
          } catch {
            // Skip unparseable lines
          }
        }

        // Token budget truncation (tail — keep first/best matches)
        const budget = {
          maxResponseTokens: config.tokenBudget?.maxResponseTokens ?? 4000,
          toolOutputDir: path.join(storageDir, "tool-output"),
        };

        const formatted = JSON.stringify({ matches, totalMatches });
        const truncated = await truncateIfNeeded(formatted, "tail", budget);

        if (truncated.truncated) {
          resolve({
            matches: matches.slice(0, 50),
            totalMatches,
            truncated: true,
            hint: truncated.hint,
          });
        } else {
          resolve({ matches, totalMatches });
        }
      },
    );
  });
}
