import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { grep } from "../tools/grep.js";
import type { ToolContext } from "../core/types.js";

let tmpDir: string;
let storageDir: string;
let hasRipgrep = false;

// Check if rg is installed
try {
  execFile("rg", ["--version"], (err) => { if (!err) hasRipgrep = true; });
  // Give it a moment
  await new Promise((r) => setTimeout(r, 200));
} catch { /* no rg */ }

function makeCtx(): ToolContext {
  return {
    workspaceDir: tmpDir,
    storageDir,
    config: { tokenBudget: { maxResponseTokens: 100000 } },
    workspace: { root: tmpDir, hasGit: false, languages: [], testRunners: [], gitignoreFilter: () => false },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-test-"));
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-storage-"));
  await fs.mkdir(path.join(storageDir, "tool-output"), { recursive: true });
  // Create test files
  await fs.writeFile(path.join(tmpDir, "a.ts"), "function hello() {\n  return 'world';\n}\n");
  await fs.writeFile(path.join(tmpDir, "b.ts"), "const HELLO = 'hi';\n");
});

describe("grep", () => {
  it.skipIf(!hasRipgrep)("content mode returns matches", async () => {
    const result = await grep({ pattern: "hello" }, makeCtx()) as Record<string, unknown>;
    expect(result.totalMatches).toBeGreaterThan(0);
    const matches = result.matches as Array<Record<string, unknown>>;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.file).toBeTruthy();
    expect(matches[0]!.line).toBeTruthy();
  });

  it.skipIf(!hasRipgrep)("files mode returns results", async () => {
    const result = await grep({ pattern: "hello", mode: "files" }, makeCtx()) as Record<string, unknown>;
    const files = result.files as string[];
    expect(files).toBeTruthy();
    expect(files.length).toBeGreaterThan(0);
    expect(result.totalMatches).toBeGreaterThan(0);
  });

  it.skipIf(!hasRipgrep)("count mode returns results", async () => {
    const result = await grep({ pattern: "hello", mode: "count" }, makeCtx()) as Record<string, unknown>;
    const counts = result.counts as Array<{ file: string; count: number }>;
    expect(counts).toBeTruthy();
    expect(counts.length).toBeGreaterThan(0);
    expect(counts[0]!.count).toBeGreaterThan(0);
    expect(result.totalMatches).toBeGreaterThan(0);
  });

  it.skipIf(!hasRipgrep)("case insensitive flag", async () => {
    const result = await grep({ pattern: "HELLO", caseInsensitive: true }, makeCtx()) as Record<string, unknown>;
    expect(result.totalMatches).toBeGreaterThanOrEqual(2); // matches both files
  });

  it.skipIf(!hasRipgrep)("no matches returns empty", async () => {
    const result = await grep({ pattern: "ZZZZNOTHERE" }, makeCtx()) as Record<string, unknown>;
    expect(result.totalMatches).toBe(0);
    expect((result.matches as unknown[]).length).toBe(0);
  });
});
