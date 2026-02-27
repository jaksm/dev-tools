/**
 * Token budget framework — truncation with smart hints.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_MAX_TOKENS = 4000;
// Rough estimate: 4 chars per token
const CHARS_PER_TOKEN = 4;

export interface TokenBudgetConfig {
  maxResponseTokens: number;
  toolOutputDir: string;
}

export type TruncationDirection = "head" | "tail";

export interface TruncateResult {
  content: string;
  truncated: boolean;
  originalLength: number;
  savedPath?: string;
  hint?: string;
}

export function createTokenBudget(config: Partial<TokenBudgetConfig> & { toolOutputDir: string }): TokenBudgetConfig {
  return {
    maxResponseTokens: config.maxResponseTokens ?? DEFAULT_MAX_TOKENS,
    toolOutputDir: config.toolOutputDir,
  };
}

/**
 * Truncate content if it exceeds the token budget.
 * 
 * @param content - Raw content to potentially truncate
 * @param direction - "head" = keep end (commands), "tail" = keep start (files)
 * @param budget - Token budget configuration
 * @param hasTaskTool - Whether the agent has the task tool (affects hint)
 */
export async function truncateIfNeeded(
  content: string,
  direction: TruncationDirection,
  budget: TokenBudgetConfig,
  hasTaskTool: boolean = false,
): Promise<TruncateResult> {
  const maxChars = budget.maxResponseTokens * CHARS_PER_TOKEN;

  if (content.length <= maxChars) {
    return { content, truncated: false, originalLength: content.length };
  }

  // Save full content to tool-output
  const savedPath = await saveToolOutput(content, budget.toolOutputDir);

  // Truncate
  let truncatedContent: string;
  if (direction === "tail") {
    // Keep the beginning (imports, declarations)
    truncatedContent = content.slice(0, maxChars);
    truncatedContent += "\n\n... [truncated] ...";
  } else {
    // Keep the end (errors, final results)
    truncatedContent = "... [truncated] ...\n\n";
    truncatedContent += content.slice(content.length - maxChars);
  }

  const hint = hasTaskTool
    ? `Full output saved to ${savedPath}. Use the Task tool to have an explore agent process this file with grep/read.`
    : `Full output saved to ${savedPath}. Use grep to search or file_read with offset/limit to view specific sections.`;

  return {
    content: truncatedContent,
    truncated: true,
    originalLength: content.length,
    savedPath,
    hint,
  };
}

async function saveToolOutput(content: string, dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const id = crypto.randomBytes(4).toString("hex");
  const filename = `output-${Date.now()}-${id}.txt`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

/**
 * Clean up tool output files older than 7 days.
 */
export async function cleanToolOutput(dir: string): Promise<number> {
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  let cleaned = 0;

  try {
    const entries = await fs.readdir(dir);
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.startsWith("output-")) continue;
      const filePath = path.join(dir, entry);
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > maxAge) {
          await fs.unlink(filePath);
          cleaned++;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Directory doesn't exist yet
  }

  return cleaned;
}
