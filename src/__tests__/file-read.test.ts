import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileRead } from "../tools/file-read.js";
import type { ToolContext } from "../core/types.js";

let tmpDir: string;
let storageDir: string;

function makeCtx(gitignoreFilter?: (p: string) => boolean): ToolContext {
  return {
    workspaceDir: tmpDir,
    storageDir,
    config: { shell: { jail: true }, tokenBudget: { maxResponseTokens: 100000 } },
    workspace: {
      root: tmpDir,
      hasGit: false,
      languages: [],
      testRunners: [],
      gitignoreFilter: gitignoreFilter ?? (() => false),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-read-test-"));
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-read-storage-"));
  await fs.mkdir(path.join(storageDir, "tool-output"), { recursive: true });
});

describe("fileRead — basic", () => {
  it("reads a text file with line numbers", async () => {
    await fs.writeFile(path.join(tmpDir, "test.ts"), "line1\nline2\nline3\n");
    const result = await fileRead({ path: "test.ts" }, makeCtx()) as Record<string, unknown>;
    expect(result.content).toContain("1│ line1");
    expect(result.content).toContain("2│ line2");
    expect(result.lines).toBe(4); // trailing newline = empty line
    expect(result.language).toBe("typescript");
  });

  it("offset/limit pagination", async () => {
    await fs.writeFile(path.join(tmpDir, "pag.ts"), "a\nb\nc\nd\ne\n");
    const result = await fileRead({ path: "pag.ts", offset: 2, limit: 2 }, makeCtx()) as Record<string, unknown>;
    expect(result.content).toContain("2│ b");
    expect(result.content).toContain("3│ c");
    expect(result.content).not.toContain("1│ a");
    const showing = result.showing as Record<string, number>;
    expect(showing.from).toBe(2);
    expect(showing.to).toBe(3);
  });
});

describe("fileRead — binary detection", () => {
  it("detects binary by extension (.zip)", async () => {
    await fs.writeFile(path.join(tmpDir, "archive.zip"), "fake");
    const result = await fileRead({ path: "archive.zip" }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBe("binary_file");
  });

  it("detects binary by extension (.wasm)", async () => {
    await fs.writeFile(path.join(tmpDir, "module.wasm"), "fake");
    const result = await fileRead({ path: "module.wasm" }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBe("binary_file");
  });

  it("detects image files specially", async () => {
    await fs.writeFile(path.join(tmpDir, "pic.png"), "fake");
    const result = await fileRead({ path: "pic.png" }, makeCtx()) as Record<string, unknown>;
    expect(result.type).toBe("image");
  });

  it("detects binary by content (null bytes)", async () => {
    const buf = Buffer.alloc(100);
    buf[0] = 0; // null byte
    buf.write("hello", 1);
    await fs.writeFile(path.join(tmpDir, "binary.txt"), buf);
    const result = await fileRead({ path: "binary.txt" }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBe("binary_file");
  });

  it("detects binary by high non-printable ratio", async () => {
    const buf = Buffer.alloc(100);
    for (let i = 0; i < 100; i++) buf[i] = i < 50 ? 1 : 65; // 50% non-printable
    await fs.writeFile(path.join(tmpDir, "mostly-bin.txt"), buf);
    const result = await fileRead({ path: "mostly-bin.txt" }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBe("binary_file");
  });
});

describe("fileRead — did you mean suggestions", () => {
  it("suggests similar files on not found", async () => {
    await fs.writeFile(path.join(tmpDir, "index.ts"), "x");
    await fs.writeFile(path.join(tmpDir, "index.js"), "y");
    // "index" substring matches "index.ts" / "index.js"
    const result = await fileRead({ path: "index.tsx" }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBe("file_not_found");
    const suggestions = result.suggestions as string[] | undefined;
    expect(suggestions).toBeTruthy();
    expect(suggestions!.length).toBeGreaterThan(0);
  });
});

describe("fileRead — gitignore filtering", () => {
  it("returns error for gitignored files", async () => {
    await fs.writeFile(path.join(tmpDir, "dist.js"), "x");
    const filter = (p: string) => p.startsWith("dist");
    const result = await fileRead({ path: "dist.js" }, makeCtx(filter)) as Record<string, unknown>;
    expect(result.error).toBe("file_ignored");
  });
});

describe("fileRead — error cases", () => {
  it("non-existent file returns error", async () => {
    const result = await fileRead({ path: "does-not-exist.ts" }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBeTruthy();
  });
});
