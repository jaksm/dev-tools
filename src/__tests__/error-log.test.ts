import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  appendErrorLog,
  readErrorLog,
  errorLogSummary,
  resolveErrorLogEntry,
  shouldLogError,
  errorLogPath,
  type ErrorLogEntry,
} from "../core/error-log.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "error-log-test-"));
});

afterAll(async () => {
  // Best-effort cleanup
});

describe("error-log — append and read", () => {
  it("creates log file with header on first append", async () => {
    await appendErrorLog(tmpDir, {
      timestamp: "2026-02-27T14:00:00Z",
      tool: "code_search",
      error: "Embedding model not loaded",
      source: "auto",
      status: "unresolved",
    });

    const logFile = errorLogPath(tmpDir);
    const content = await fs.readFile(logFile, "utf-8");
    expect(content).toContain("# Error Investigation Log");
    expect(content).toContain("code_search");
    expect(content).toContain("Embedding model not loaded");
    expect(content).toContain("🤖 Auto-captured");
    expect(content).toContain("`unresolved`");
  });

  it("appends multiple entries", async () => {
    await appendErrorLog(tmpDir, {
      timestamp: "2026-02-27T14:00:00Z",
      tool: "shell",
      error: "Command timed out after 120s",
      source: "auto",
      status: "unresolved",
    });
    await appendErrorLog(tmpDir, {
      timestamp: "2026-02-27T14:05:00Z",
      tool: "code_inspect",
      error: "LSP server not running for python",
      source: "agent",
      status: "unresolved",
    });

    const entries = await readErrorLog(tmpDir);
    expect(entries.length).toBe(2);
    expect(entries[0].tool).toBe("shell");
    expect(entries[1].tool).toBe("code_inspect");
    expect(entries[1].source).toBe("agent");
  });

  it("reads empty log as empty array", async () => {
    const entries = await readErrorLog(tmpDir);
    expect(entries).toEqual([]);
  });

  it("filters by status", async () => {
    await appendErrorLog(tmpDir, {
      timestamp: "2026-02-27T14:00:00Z",
      tool: "grep",
      error: "Pattern syntax error",
      source: "auto",
      status: "unresolved",
    });

    const unresolved = await readErrorLog(tmpDir, { status: "unresolved" });
    expect(unresolved.length).toBe(1);

    const resolved = await readErrorLog(tmpDir, { status: "resolved" });
    expect(resolved.length).toBe(0);
  });
});

describe("error-log — summary", () => {
  it("returns 'no entries' for empty log", async () => {
    const summary = await errorLogSummary(tmpDir);
    expect(summary).toContain("No error log entries");
  });

  it("produces summary with counts", async () => {
    await appendErrorLog(tmpDir, {
      timestamp: "2026-02-27T14:00:00Z",
      tool: "shell",
      error: "Timeout",
      source: "auto",
      status: "unresolved",
    });

    const summary = await errorLogSummary(tmpDir);
    expect(summary).toContain("1 total");
    expect(summary).toContain("1 unresolved");
    expect(summary).toContain("shell");
  });
});

describe("error-log — resolve", () => {
  it("resolves an unresolved entry", async () => {
    await appendErrorLog(tmpDir, {
      timestamp: "2026-02-27T14:00:00Z",
      tool: "test",
      error: "Jest not found",
      source: "auto",
      status: "unresolved",
    });

    const resolved = await resolveErrorLogEntry(tmpDir, 0, "Installed jest globally");
    expect(resolved).toBe(true);

    const entries = await readErrorLog(tmpDir);
    expect(entries[0].status).toBe("resolved");
    expect(entries[0].resolution).toContain("Installed jest globally");
  });

  it("returns false for out-of-range index", async () => {
    await appendErrorLog(tmpDir, {
      timestamp: "2026-02-27T14:00:00Z",
      tool: "test",
      error: "Some error",
      source: "auto",
      status: "unresolved",
    });

    const resolved = await resolveErrorLogEntry(tmpDir, 5, "nope");
    expect(resolved).toBe(false);
  });
});

describe("error-log — dedup", () => {
  it("deduplicates same tool+error within window", () => {
    // Reset state - use unique tool names to avoid interference
    const tool = `test_dedup_${Date.now()}`;
    
    expect(shouldLogError(tool, "some error")).toBe(true);
    expect(shouldLogError(tool, "some error")).toBe(false); // duplicate within 1 min
    expect(shouldLogError(tool, "different error")).toBe(true); // different error
  });
});

describe("error-log — params logging", () => {
  it("includes params in entry when provided", async () => {
    await appendErrorLog(tmpDir, {
      timestamp: "2026-02-27T14:00:00Z",
      tool: "shell",
      params: { command: "npm run build", timeout: 120000 },
      error: "Command timed out",
      source: "auto",
      status: "unresolved",
    });

    const logFile = errorLogPath(tmpDir);
    const content = await fs.readFile(logFile, "utf-8");
    expect(content).toContain("npm run build");
  });
});
