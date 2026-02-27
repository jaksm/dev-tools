import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createToolCallLogger, summarizeInput, summarizeOutput } from "../core/logging.js";

describe("summarizeInput", () => {
  it("passes through small values unchanged", () => {
    const result = summarizeInput("file_read", { path: "src/index.ts", offset: 1 });
    expect(result).toEqual({ path: "src/index.ts", offset: 1 });
  });

  it("redacts large content fields", () => {
    const result = summarizeInput("file_write", { path: "f.ts", content: "x".repeat(300) });
    expect(result.content).toBe("[300 chars]");
  });

  it("content under 200 chars is not redacted", () => {
    const content = "x".repeat(100);
    const result = summarizeInput("file_write", { path: "f.ts", content });
    expect(result.content).toBe(content);
  });

  it("counts edits array", () => {
    const edits = [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }];
    const result = summarizeInput("file_edit", { path: "f.ts", edits });
    expect(result.editCount).toBe(2);
    expect(result.edits).toBeUndefined();
  });
});

describe("summarizeOutput", () => {
  it("passes through simple values", () => {
    const result = summarizeOutput({ applied: 1, path: "f.ts" });
    expect(result).toEqual({ applied: 1, path: "f.ts" });
  });

  it("redacts large content in output", () => {
    const result = summarizeOutput({ content: "x".repeat(300), lines: 10 });
    expect(result.content).toBe("[300 chars]");
    expect(result.lines).toBe(10);
  });

  it("counts arrays", () => {
    const result = summarizeOutput({ matches: [1, 2, 3], totalMatches: 3 });
    expect(result.matches).toBe("[3 items]");
    expect(result.totalMatches).toBe(3);
  });

  it("wraps non-object result", () => {
    const result = summarizeOutput("hello");
    expect(result).toEqual({ result: "hello" });
  });

  it("wraps null", () => {
    const result = summarizeOutput(null);
    expect(result).toEqual({ result: null });
  });
});

describe("createToolCallLogger", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logger-test-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes JSONL on flush", async () => {
    const logger = createToolCallLogger(tmpDir);
    logger.log({
      ts: "2026-01-01T00:00:00Z",
      tool: "file_read",
      input: { path: "f.ts" },
      output: { content: "..." },
      durationMs: 5,
      status: "ok",
    });
    await logger.flush();

    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpDir, `${date}.jsonl`);
    const content = await fs.readFile(logFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.tool).toBe("file_read");
    expect(parsed.status).toBe("ok");
  });

  it("multiple logs produce multiple JSONL lines", async () => {
    const logger = createToolCallLogger(tmpDir);
    logger.log({ ts: "t1", tool: "a", input: {}, output: {}, durationMs: 1, status: "ok" });
    logger.log({ ts: "t2", tool: "b", input: {}, output: {}, durationMs: 2, status: "error" });
    await logger.flush();

    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmpDir, `${date}.jsonl`);
    const content = await fs.readFile(logFile, "utf-8");
    const lines = content.trim().split("\n");
    // Previous test also wrote 1 line
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});
