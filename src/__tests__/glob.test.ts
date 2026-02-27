import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { glob } from "../tools/glob.js";
import type { ToolContext } from "../core/types.js";

let tmpDir: string;
let storageDir: string;

function makeCtx(gitignoreFilter?: (p: string) => boolean): ToolContext {
  return {
    workspaceDir: tmpDir,
    storageDir,
    config: {},
    workspace: { root: tmpDir, hasGit: false, languages: [], testRunners: [], gitignoreFilter: gitignoreFilter ?? (() => false) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-test-"));
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-storage-"));
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "src/a.ts"), "x");
  await fs.writeFile(path.join(tmpDir, "src/b.ts"), "y");
  await fs.writeFile(path.join(tmpDir, "src/c.js"), "z");
});

describe("glob", () => {
  it("finds files matching pattern", async () => {
    const result = await glob({ pattern: "**/*.ts" }, makeCtx()) as Record<string, unknown>;
    const files = result.files as Array<Record<string, unknown>>;
    expect(files.length).toBe(2);
    expect(result.total).toBe(2);
  });

  it("filters by gitignore", async () => {
    const filter = (p: string) => p.includes("a.ts");
    const result = await glob({ pattern: "**/*.ts" }, makeCtx(filter)) as Record<string, unknown>;
    const files = result.files as Array<Record<string, unknown>>;
    expect(files.length).toBe(1);
    expect((files[0]!.path as string)).toContain("b.ts");
  });

  it("sorts by mtime (most recent first)", async () => {
    // Touch b.ts to make it more recent
    await new Promise((r) => setTimeout(r, 50));
    await fs.writeFile(path.join(tmpDir, "src/b.ts"), "updated");
    const result = await glob({ pattern: "**/*.ts" }, makeCtx()) as Record<string, unknown>;
    const files = result.files as Array<Record<string, unknown>>;
    expect((files[0]!.path as string)).toContain("b.ts");
  });

  it("includes size and modified fields", async () => {
    const result = await glob({ pattern: "**/*.ts" }, makeCtx()) as Record<string, unknown>;
    const files = result.files as Array<Record<string, unknown>>;
    expect(files[0]!.size).toBeTypeOf("number");
    expect(files[0]!.modified).toBeTypeOf("string");
  });
});
