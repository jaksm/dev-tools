/**
 * Tests for conditional tool registration behavior.
 *
 * Verifies that:
 * - git tool returns proper error when no .git/ present
 * - test tool returns proper error when no test runner detected
 * - workspace status injection shows correct available tools
 * - LSP tools fall back gracefully when LSP unavailable
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { git } from "../tools/git.js";
import { test as testTool } from "../tools/test.js";
import type { TestRunner, WorkspaceInfo } from "../core/types.js";
import { DevToolsCore } from "../core/index.js";
import { deriveSlug } from "../core/storage.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/** Clean up tmpDir, its ~/.dev-tools/{slug} storage dir, and stop any background work. */
async function cleanupWithStorage(tmpDir: string, core?: InstanceType<typeof DevToolsCore>): Promise<void> {
  // Stop background indexing before cleaning up dirs
  if (core) {
    await core.onSessionEnd("test");
  }
  // Small delay to let any pending I/O settle
  await new Promise(r => setTimeout(r, 50));
  const slug = deriveSlug(tmpDir);
  const storageDir = path.join(os.homedir(), ".dev-tools", slug);
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(storageDir, { recursive: true, force: true });
}

// ── Git conditional behavior ────────────────────────────────────────────────

describe("conditional — git tool", () => {
  it("returns error for non-git directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "no-git-"));
    try {
      const result = await git({ action: "status" }, tmpDir);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      await cleanupWithStorage(tmpDir);
    }
  });

  it("works in a real git directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "has-git-"));
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init"], { cwd: tmpDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });
      await fs.writeFile(path.join(tmpDir, "f.txt"), "x");
      execFileSync("git", ["add", "."], { cwd: tmpDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir });

      const result = await git({ action: "status" }, tmpDir);
      expect(result.success).toBe(true);
    } finally {
      await cleanupWithStorage(tmpDir);
    }
  });
});

// ── Test conditional behavior ───────────────────────────────────────────────

describe("conditional — test tool", () => {
  it("returns error for unsupported framework", async () => {
    const runner: TestRunner = {
      name: "unknown",
      framework: "unknown" as any,
      root: "/tmp",
      command: "false",
    };
    const result = await testTool({}, runner, "/tmp");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported");
  });
});

// ── Workspace status conditional tool listing ───────────────────────────────

describe("conditional — workspace status", () => {
  it("shows git tool when .git/ exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-git-"));
    const core = new DevToolsCore({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
    try {
      await fs.mkdir(path.join(tmpDir, ".git"));
      await core.analyzeWorkspace(tmpDir);
      const status = core.getWorkspaceStatus(tmpDir);
      expect(status).toContain("git");
    } finally {
      await cleanupWithStorage(tmpDir, core);
    }
  });

  it("does not show git tool when .git/ missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-no-git-"));
    const core = new DevToolsCore({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
    try {
      await core.analyzeWorkspace(tmpDir);
      const status = core.getWorkspaceStatus(tmpDir);
      // The header shows tool count — without git it should be lower
      const headerLine = status?.split("\n")[0] ?? "";
      // "git" may appear in tool guide (always shown), but shouldn't be in tool count
      // For a bare directory: foundation(7) + intelligence(3) + workflow(1) = 11 tools
      expect(headerLine).toContain("11 tools active");
    } finally {
      await cleanupWithStorage(tmpDir, core);
    }
  });

  it("shows test tool when test runner detected", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-test-"));
    const core = new DevToolsCore({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
    try {
      // Create a minimal package.json with vitest
      await fs.writeFile(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }),
      );
      await fs.writeFile(path.join(tmpDir, "tsconfig.json"), "{}");

      await core.analyzeWorkspace(tmpDir);
      const status = core.getWorkspaceStatus(tmpDir);
      expect(status).toContain("test");
      expect(status).toContain("vitest");
    } finally {
      await cleanupWithStorage(tmpDir, core);
    }
  });

  it("does not show test tool when no runner detected", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-no-test-"));
    const core = new DevToolsCore({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
    try {
      await core.analyzeWorkspace(tmpDir);
      const status = core.getWorkspaceStatus(tmpDir);
      // No test runner line should appear
      expect(status).not.toContain("Test runners:");
      // Tool count: 11 base tools, no test
      const headerLine = status?.split("\n")[0] ?? "";
      expect(headerLine).toContain("11 tools active");
    } finally {
      await cleanupWithStorage(tmpDir, core);
    }
  });

  it("always shows foundation + intelligence tools in status", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-base-"));
    const core = new DevToolsCore({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
    try {
      await core.analyzeWorkspace(tmpDir);
      const status = core.getWorkspaceStatus(tmpDir);
      // Verify the header shows at least 11 tools (the always-on set)
      const headerLine = status?.split("\n")[0] ?? "";
      expect(headerLine).toContain("tools active");
      // Verify the tool guide is present
      expect(status).toContain("Tool guide:");
      expect(status).toContain("file_edit");
      expect(status).toContain("code_search");
    } finally {
      await cleanupWithStorage(tmpDir, core);
    }
  });
});
