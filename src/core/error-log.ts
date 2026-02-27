/**
 * Error Investigation Log
 * 
 * Simple markdown-based log for tool errors and agent-reported anomalies.
 * Auto-appended on tool errors, manually appendable by agents.
 * Feeds into reflection/review sessions.
 * 
 * File: ~/.dev-tools/{slug}/error-log.md
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface ErrorLogEntry {
  timestamp: string;
  tool: string;
  params?: Record<string, unknown>;
  error: string;
  source: "auto" | "agent";
  status: "unresolved" | "resolved" | "wontfix";
  resolution?: string;
}

const ERROR_LOG_FILE = "error-log.md";
const HEADER = `# Error Investigation Log

Tool errors and anomalies for review during reflection sessions.
Items are auto-appended on tool errors and can be manually added by agents.

---

`;

/**
 * Get the error log file path for a storage dir.
 */
export function errorLogPath(storageDir: string): string {
  return path.join(storageDir, ERROR_LOG_FILE);
}

/**
 * Append an error entry to the investigation log.
 */
export async function appendErrorLog(
  storageDir: string,
  entry: ErrorLogEntry,
): Promise<void> {
  const logFile = errorLogPath(storageDir);

  // Ensure file exists with header
  try {
    await fs.access(logFile);
  } catch {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.writeFile(logFile, HEADER, "utf-8");
  }

  const block = formatEntry(entry);
  await fs.appendFile(logFile, block, "utf-8");
}

/**
 * Read all entries from the error log (parsed back from markdown).
 */
export async function readErrorLog(
  storageDir: string,
  filter?: { status?: ErrorLogEntry["status"] },
): Promise<ErrorLogEntry[]> {
  const logFile = errorLogPath(storageDir);

  let content: string;
  try {
    content = await fs.readFile(logFile, "utf-8");
  } catch {
    return [];
  }

  return parseEntries(content, filter);
}

/**
 * Get a human-readable summary of the error log.
 */
export async function errorLogSummary(storageDir: string): Promise<string> {
  const all = await readErrorLog(storageDir);
  const unresolved = all.filter(e => e.status === "unresolved");
  const resolved = all.filter(e => e.status === "resolved");
  const wontfix = all.filter(e => e.status === "wontfix");

  if (all.length === 0) {
    return "No error log entries.";
  }

  const lines: string[] = [
    `**Error log:** ${all.length} total — ${unresolved.length} unresolved, ${resolved.length} resolved, ${wontfix.length} won't fix`,
    "",
  ];

  if (unresolved.length > 0) {
    lines.push("**Unresolved items:**");
    for (const entry of unresolved.slice(0, 20)) {
      lines.push(`- \`${entry.tool}\` (${entry.timestamp.slice(0, 16)}): ${entry.error.slice(0, 120)}`);
    }
    if (unresolved.length > 20) {
      lines.push(`- ... and ${unresolved.length - 20} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Resolve an error log entry by index (0-based among unresolved items).
 */
export async function resolveErrorLogEntry(
  storageDir: string,
  index: number,
  resolution: string,
  status: "resolved" | "wontfix" = "resolved",
): Promise<boolean> {
  const logFile = errorLogPath(storageDir);

  let content: string;
  try {
    content = await fs.readFile(logFile, "utf-8");
  } catch {
    return false;
  }

  // Find the Nth unresolved entry and update its status
  const unresolvedPattern = /\*\*Status:\*\* `unresolved`/g;
  let match: RegExpExecArray | null;
  let count = 0;

  while ((match = unresolvedPattern.exec(content)) !== null) {
    if (count === index) {
      const before = content.slice(0, match.index);
      const after = content.slice(match.index + match[0].length);
      content = before + `**Status:** \`${status}\` — ${resolution}` + after;
      await fs.writeFile(logFile, content, "utf-8");
      return true;
    }
    count++;
  }

  return false;
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatEntry(entry: ErrorLogEntry): string {
  const lines: string[] = [
    `### ${entry.timestamp.slice(0, 16)} — \`${entry.tool}\``,
    "",
    `**Source:** ${entry.source === "auto" ? "🤖 Auto-captured" : "👤 Agent-reported"}`,
    `**Status:** \`${entry.status}\``,
    "",
  ];

  if (entry.params && Object.keys(entry.params).length > 0) {
    // Show a compact params summary
    const paramStr = Object.entries(entry.params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v.slice(0, 80) : JSON.stringify(v)}`)
      .join(", ");
    if (paramStr) {
      lines.push(`**Params:** ${paramStr}`);
    }
  }

  lines.push(`**Error:** ${entry.error}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  return lines.join("\n");
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function parseEntries(
  content: string,
  filter?: { status?: ErrorLogEntry["status"] },
): ErrorLogEntry[] {
  const entries: ErrorLogEntry[] = [];
  const entryBlocks = content.split(/^### /m).slice(1); // Skip header

  for (const block of entryBlocks) {
    const timestampMatch = block.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
    const toolMatch = block.match(/`([^`]+)`/);
    const sourceMatch = block.match(/\*\*Source:\*\* (🤖 Auto-captured|👤 Agent-reported)/);
    const statusMatch = block.match(/\*\*Status:\*\* `(\w+)`/);
    const errorMatch = block.match(/\*\*Error:\*\* (.+)/);

    if (!timestampMatch || !toolMatch || !errorMatch) continue;

    const entry: ErrorLogEntry = {
      timestamp: timestampMatch[1],
      tool: toolMatch[1],
      error: errorMatch[1],
      source: sourceMatch?.[1]?.includes("Auto") ? "auto" : "agent",
      status: (statusMatch?.[1] as ErrorLogEntry["status"]) ?? "unresolved",
    };

    // Check resolution
    const resolutionMatch = block.match(/\*\*Status:\*\* `(?:resolved|wontfix)` — (.+)/);
    if (resolutionMatch) {
      entry.resolution = resolutionMatch[1];
    }

    if (filter?.status && entry.status !== filter.status) continue;
    entries.push(entry);
  }

  return entries;
}

/**
 * Deduplicate: don't log the same tool+error combo within a short window.
 * Returns true if the entry should be logged (not a duplicate).
 */
const recentErrors = new Map<string, number>();
const DEDUP_WINDOW_MS = 60_000; // 1 minute

export function shouldLogError(tool: string, error: string): boolean {
  const key = `${tool}:${error.slice(0, 100)}`;
  const now = Date.now();
  const last = recentErrors.get(key);

  if (last && now - last < DEDUP_WINDOW_MS) {
    return false;
  }

  recentErrors.set(key, now);

  // Prune old entries periodically
  if (recentErrors.size > 100) {
    for (const [k, t] of recentErrors) {
      if (now - t > DEDUP_WINDOW_MS) recentErrors.delete(k);
    }
  }

  return true;
}
