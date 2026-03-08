import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DevToolsCore } from "../core/index.js";
import type { IndexJson } from "../core/index/index-json.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Helper: create a mock INDEX.json
function makeIndexJson(fileCount: number, symbolsPerFile = 5): IndexJson {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    file: `src/file${i}.ts`,
    lines: 100,
    rank: (fileCount - i) / fileCount,
    exports: [`export${i}`],
    imports: i > 0 ? [`./file${i - 1}`] : [],
    symbols: symbolsPerFile,
  }));

  return {
    version: 1,
    workspace: "/project",
    generatedAt: new Date().toISOString(),
    files,
    totalSymbols: fileCount * symbolsPerFile,
    totalFiles: fileCount,
  };
}

// Helper: derive slug (matches storage.ts logic)
function deriveSlug(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  const basename = path.basename(resolved);
  return basename
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "default";
}

describe("INDEX.json context injection", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let storageDir: string;
  let core: DevToolsCore;

  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "idx-ctx-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });

    // Create minimal workspace structure for analyzeWorkspace
    await fsp.writeFile(
      path.join(workspaceDir, "package.json"),
      JSON.stringify({ name: "test", devDependencies: { vitest: "^1.0.0" } }),
    );
    await fsp.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await fsp.writeFile(path.join(workspaceDir, "src", "index.ts"), "export const x = 1;");

    // Derive storage location (matches createStorageManager)
    const slug = deriveSlug(workspaceDir);
    storageDir = path.join(os.homedir(), ".dev-tools", slug);
    await fsp.mkdir(path.join(storageDir, "index"), { recursive: true });
  });

  afterEach(async () => {
    // Clean up temp workspace
    await fsp.rm(tmpDir, { recursive: true, force: true });
    // Clean up storage dir
    await fsp.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  });

  it("includes INDEX.json in getWorkspaceStatus when index is available", async () => {
    core = new DevToolsCore({ logger });
    await core.analyzeWorkspace(workspaceDir);

    // Write INDEX.json to storage
    const indexJson = makeIndexJson(10);
    await fsp.writeFile(
      path.join(storageDir, "index", "INDEX.json"),
      JSON.stringify(indexJson),
    );

    const status = core.getWorkspaceStatus(workspaceDir);
    expect(status).not.toBeNull();
    expect(status).toContain("Project Index");
    expect(status).toContain("10 files");
    expect(status).toContain("50 symbols");
  });

  it("returns status without index section when no INDEX.json exists", async () => {
    core = new DevToolsCore({ logger });
    await core.analyzeWorkspace(workspaceDir);

    // Don't write INDEX.json
    const status = core.getWorkspaceStatus(workspaceDir);
    expect(status).not.toBeNull();
    expect(status).toContain("tools active");
    expect(status).toContain("Tool guide");
    expect(status).not.toContain("Project Index");
  });

  it("truncates large index to fit token budget", async () => {
    core = new DevToolsCore({
      config: { contextInjection: { maxTokens: 200 } },
      logger,
    });
    await core.analyzeWorkspace(workspaceDir);

    // Write a large INDEX.json (500 files)
    const indexJson = makeIndexJson(500);
    await fsp.writeFile(
      path.join(storageDir, "index", "INDEX.json"),
      JSON.stringify(indexJson),
    );

    const status = core.getWorkspaceStatus(workspaceDir);
    expect(status).not.toBeNull();
    // With 200 token budget (~800 chars), the rendered output should be truncated
    // It should still contain the header
    expect(status).toContain("Project Index");
    // The full 500-file render would be much larger, so it must have been trimmed
    // Count the approximate token size of the index portion
    const indexStart = status!.indexOf("# Project Index");
    if (indexStart >= 0) {
      // Extract only the INDEX.json portion (stop before AGENTS.md or end)
      const agentsMdStart = status!.indexOf("# AGENTS.md", indexStart);
      const indexPortion = agentsMdStart >= 0
        ? status!.substring(indexStart, agentsMdStart).trimEnd()
        : status!.substring(indexStart);
      const approxTokens = Math.ceil(indexPortion.length / 4);
      expect(approxTokens).toBeLessThanOrEqual(200);
    }
  });

  it("skips index injection when contextInjection.indexJson is false", async () => {
    core = new DevToolsCore({
      config: { contextInjection: { indexJson: false } },
      logger,
    });
    await core.analyzeWorkspace(workspaceDir);

    // Write INDEX.json
    const indexJson = makeIndexJson(10);
    await fsp.writeFile(
      path.join(storageDir, "index", "INDEX.json"),
      JSON.stringify(indexJson),
    );

    const status = core.getWorkspaceStatus(workspaceDir);
    expect(status).not.toBeNull();
    expect(status).toContain("tools active");
    expect(status).not.toContain("Project Index");
  });

  it("preserves existing status line content (regression)", async () => {
    core = new DevToolsCore({ logger });
    await core.analyzeWorkspace(workspaceDir);

    const status = core.getWorkspaceStatus(workspaceDir);
    expect(status).not.toBeNull();

    // Core status lines must be present
    expect(status).toContain("[dev-tools]");
    expect(status).toContain("tools active");
    expect(status).toContain("Languages:");
    expect(status).toContain("Tool guide:");
  });
});
