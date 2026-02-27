import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileWrite } from "../tools/file-write.js";
import type { ToolContext } from "../core/types.js";

let tmpDir: string;
let storageDir: string;

function makeCtx(): ToolContext {
  return {
    workspaceDir: tmpDir,
    storageDir,
    config: { shell: { jail: true } },
    workspace: { root: tmpDir, hasGit: false, languages: [], testRunners: [], gitignoreFilter: () => false },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-write-test-"));
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-write-storage-"));
});

describe("fileWrite", () => {
  it("reports created for new file", async () => {
    const result = await fileWrite({ path: "new.ts", content: "hello" }, makeCtx()) as Record<string, unknown>;
    expect(result.created).toBe(true);
    expect(result.overwritten).toBeUndefined();
    expect(result.bytes).toBe(5);
  });

  it("reports overwritten for existing file", async () => {
    await fs.writeFile(path.join(tmpDir, "existing.ts"), "old");
    const result = await fileWrite({ path: "existing.ts", content: "new" }, makeCtx()) as Record<string, unknown>;
    expect(result.overwritten).toBe(true);
    expect(result.created).toBeUndefined();
  });

  it("auto-creates parent directories", async () => {
    const result = await fileWrite({ path: "deep/nested/file.ts", content: "x" }, makeCtx()) as Record<string, unknown>;
    expect(result.created).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, "deep/nested/file.ts"), "utf-8");
    expect(content).toBe("x");
  });

  it("resolves relative paths within workspace", async () => {
    const result = await fileWrite({ path: "subdir/test.txt", content: "hello" }, makeCtx()) as Record<string, unknown>;
    expect(result.created).toBe(true);
  });
});
