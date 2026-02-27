import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTokenBudget, truncateIfNeeded, cleanToolOutput } from "../core/token-budget.js";

describe("createTokenBudget", () => {
  it("uses default maxResponseTokens when not specified", () => {
    const b = createTokenBudget({ toolOutputDir: "/tmp/test" });
    expect(b.maxResponseTokens).toBe(4000);
  });

  it("respects custom maxResponseTokens", () => {
    const b = createTokenBudget({ maxResponseTokens: 8000, toolOutputDir: "/tmp/test" });
    expect(b.maxResponseTokens).toBe(8000);
  });
});

describe("truncateIfNeeded", () => {
  let tmpDir: string;
  let budget: ReturnType<typeof createTokenBudget>;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "token-budget-test-"));
    budget = createTokenBudget({ maxResponseTokens: 10, toolOutputDir: tmpDir });
    // 10 tokens * 4 chars = 40 chars max
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not truncate content within budget", async () => {
    const result = await truncateIfNeeded("short", "tail", budget);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("short");
  });

  it("content exactly at limit is not truncated", async () => {
    const content = "a".repeat(40); // exactly 40 chars = 10 tokens
    const result = await truncateIfNeeded(content, "tail", budget);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it("content 1 char over limit is truncated", async () => {
    const content = "a".repeat(41);
    const result = await truncateIfNeeded(content, "tail", budget);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(41);
    expect(result.savedPath).toBeTruthy();
  });

  it("tail direction keeps start of content", async () => {
    const content = "START" + "x".repeat(100) + "END";
    const result = await truncateIfNeeded(content, "tail", budget);
    expect(result.truncated).toBe(true);
    expect(result.content.startsWith("START")).toBe(true);
    expect(result.content).toContain("[truncated]");
    expect(result.content).not.toContain("END");
  });

  it("head direction keeps end of content", async () => {
    const content = "START" + "x".repeat(100) + "END";
    const result = await truncateIfNeeded(content, "head", budget);
    expect(result.truncated).toBe(true);
    expect(result.content.endsWith("END")).toBe(true);
    expect(result.content).toContain("[truncated]");
  });

  it("saves full content to file on truncation", async () => {
    const content = "a".repeat(100);
    const result = await truncateIfNeeded(content, "tail", budget);
    expect(result.savedPath).toBeTruthy();
    const saved = await fs.readFile(result.savedPath!, "utf-8");
    expect(saved).toBe(content);
  });

  it("hint mentions task tool when hasTaskTool=true", async () => {
    const content = "a".repeat(100);
    const result = await truncateIfNeeded(content, "tail", budget, true);
    expect(result.hint).toContain("Task tool");
  });

  it("hint mentions grep/file_read when hasTaskTool=false", async () => {
    const content = "a".repeat(100);
    const result = await truncateIfNeeded(content, "tail", budget, false);
    expect(result.hint).toContain("grep");
    expect(result.hint).toContain("file_read");
  });
});

describe("cleanToolOutput", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clean-output-test-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 for empty directory", async () => {
    const count = await cleanToolOutput(tmpDir);
    expect(count).toBe(0);
  });

  it("returns 0 for non-existent directory", async () => {
    const count = await cleanToolOutput("/tmp/nonexistent-dir-xyz");
    expect(count).toBe(0);
  });

  it("does not clean recent files", async () => {
    await fs.writeFile(path.join(tmpDir, "output-recent.txt"), "data");
    const count = await cleanToolOutput(tmpDir);
    expect(count).toBe(0);
  });

  it("cleans old files (simulated via mtime)", async () => {
    const oldFile = path.join(tmpDir, "output-old.txt");
    await fs.writeFile(oldFile, "data");
    // Set mtime to 8 days ago
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldFile, oldTime, oldTime);
    const count = await cleanToolOutput(tmpDir);
    expect(count).toBe(1);
  });

  it("ignores non-output files", async () => {
    const otherFile = path.join(tmpDir, "other-file.txt");
    await fs.writeFile(otherFile, "data");
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(otherFile, oldTime, oldTime);
    const count = await cleanToolOutput(tmpDir);
    expect(count).toBe(0);
  });
});
