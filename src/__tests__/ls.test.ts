import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ls } from "../tools/ls.js";
import type { ToolContext } from "../core/types.js";

let tmpDir: string;
let storageDir: string;

function makeCtx(gitignoreFilter?: (p: string) => boolean): ToolContext {
  return {
    workspaceDir: tmpDir,
    storageDir,
    config: { shell: { jail: true } },
    workspace: { root: tmpDir, hasGit: false, languages: [], testRunners: [], gitignoreFilter: gitignoreFilter ?? (() => false) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ls-test-"));
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ls-storage-"));
  await fs.mkdir(path.join(tmpDir, "src/components"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "src/index.ts"), "x");
  await fs.writeFile(path.join(tmpDir, "src/components/Button.tsx"), "y");
  await fs.writeFile(path.join(tmpDir, "README.md"), "z");
});

describe("ls", () => {
  it("lists root directory", async () => {
    const result = await ls({}, makeCtx()) as Record<string, unknown>;
    const entries = result.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    const names = entries.map((e) => e.name);
    expect(names).toContain("src/");
    expect(names).toContain("README.md");
  });

  it("shows file sizes", async () => {
    const result = await ls({}, makeCtx()) as Record<string, unknown>;
    const entries = result.entries as Array<Record<string, unknown>>;
    const readme = entries.find((e) => e.name === "README.md");
    expect(readme).toBeTruthy();
    expect(readme!.size).toBe(1);
  });

  it("shows child counts for directories", async () => {
    const result = await ls({}, makeCtx()) as Record<string, unknown>;
    const entries = result.entries as Array<Record<string, unknown>>;
    const src = entries.find((e) => e.name === "src/");
    expect(src).toBeTruthy();
    expect(src!.children).toBeGreaterThan(0);
  });

  it("depth limiting works", async () => {
    const result = await ls({ depth: 1 }, makeCtx()) as Record<string, unknown>;
    const entries = result.entries as Array<Record<string, unknown>>;
    const src = entries.find((e) => e.name === "src/");
    // At depth 1, src/ should not have nested entries
    expect(src!.entries).toBeUndefined();
  });

  it("depth 2 shows nested content", async () => {
    const result = await ls({ depth: 2 }, makeCtx()) as Record<string, unknown>;
    const entries = result.entries as Array<Record<string, unknown>>;
    const src = entries.find((e) => e.name === "src/");
    expect(src!.entries).toBeTruthy();
  });

  it("filters by gitignore", async () => {
    await fs.mkdir(path.join(tmpDir, "dist"));
    await fs.writeFile(path.join(tmpDir, "dist/bundle.js"), "x");
    const filter = (p: string) => p.startsWith("dist");
    const result = await ls({}, makeCtx(filter)) as Record<string, unknown>;
    const entries = result.entries as Array<Record<string, unknown>>;
    const names = entries.map((e) => e.name);
    expect(names).not.toContain("dist/");
  });

  it("handles absolute paths", async () => {
    // With jail removed, absolute paths are allowed but may not exist in workspace
    const result = await ls({ path: "/nonexistent-path-xyz" }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBeTruthy();
  });

  it("returns error for non-directory", async () => {
    const result = await ls({ path: "README.md" }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBe("not_a_directory");
  });
});
