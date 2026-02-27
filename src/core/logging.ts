/**
 * Structured JSONL tool call logger.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ToolCallLogEntry } from "./types.js";

export interface ToolCallLogger {
  log(entry: ToolCallLogEntry): void;
  flush(): Promise<void>;
}

export function createToolCallLogger(logsDir: string): ToolCallLogger {
  const buffer: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function getLogFile(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return path.join(logsDir, `${date}.jsonl`);
  }

  async function doFlush(): Promise<void> {
    if (buffer.length === 0) return;
    const lines = buffer.splice(0, buffer.length);
    const logFile = getLogFile();
    try {
      await fs.mkdir(path.dirname(logFile), { recursive: true });
      await fs.appendFile(logFile, lines.join("\n") + "\n", "utf-8");
    } catch {
      // Logging should never crash the tool
    }
  }

  return {
    log(entry: ToolCallLogEntry): void {
      buffer.push(JSON.stringify(entry));
      // Debounce flush to 1 second
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { void doFlush(); }, 1000);
    },

    async flush(): Promise<void> {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await doFlush();
    },
  };
}

/**
 * Summarize tool call input for logging — strip large content fields.
 */
export function summarizeInput(_toolName: string, params: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "content" && typeof value === "string" && value.length > 200) {
      summary[key] = `[${value.length} chars]`;
    } else if (key === "edits" && Array.isArray(value)) {
      summary.editCount = value.length;
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

/**
 * Summarize tool call output for logging.
 */
export function summarizeOutput(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(r)) {
      if (key === "content" && typeof value === "string" && value.length > 200) {
        summary[key] = `[${value.length} chars]`;
      } else if (Array.isArray(value)) {
        summary[key] = `[${value.length} items]`;
      } else {
        summary[key] = value;
      }
    }
    return summary;
  }
  return { result };
}
