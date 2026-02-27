/**
 * Tests for LSP error propagation — structured reasons when LSP is unavailable.
 *
 * Verifies:
 * - getClientWithReason returns structured reasons
 * - code_inspect includes lspUnavailableReason in fallback output
 * - code_refactor includes actionable error messages
 * - Prerequisite missing → install hint
 * - Crash limit exceeded → reload suggestion
 * - Clean state on restart attempt 2
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LspManager } from "../core/lsp/manager.js";
import { LspResolver } from "../core/lsp/resolver.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { codeInspect } from "../tools/code-inspect.js";
import { codeRefactor } from "../tools/code-refactor.js";
import type { WorkspaceInfo, DevToolsConfig, ToolContext, SymbolInfo } from "../core/types.js";

const MOCK_SERVER = path.resolve(
  import.meta.dirname,
  "helpers/mock-lsp-server.mjs",
);

// Suppress vscode-jsonrpc write-after-end rejections
const suppressedErrors: Error[] = [];
function rejectionHandler(err: unknown) {
  if (err instanceof Error &&
      (err.message.includes("write after end") ||
       err.message.includes("after a stream was destroyed"))) {
    suppressedErrors.push(err);
    return;
  }
  throw err;
}
beforeAll(() => { process.on("unhandledRejection", rejectionHandler); });
afterAll(() => { process.removeListener("unhandledRejection", rejectionHandler); });

let tmpDir: string;

function makeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeWorkspace(languages?: { language: string; root: string }[]): WorkspaceInfo {
  return {
    root: tmpDir,
    hasGit: false,
    languages: (languages ?? [{ language: "typescript", root: tmpDir }]).map(l => ({
      language: l.language,
      root: l.root,
      configFile: path.join(l.root, "tsconfig.json"),
    })),
    testRunners: [],
    gitignoreFilter: () => false,
  };
}

function makeCtx(): ToolContext {
  return {
    workspaceDir: tmpDir,
    storageDir: path.join(tmpDir, ".dev-tools"),
    config: {} as DevToolsConfig,
    workspace: makeWorkspace(),
    logger: makeLogger(),
  };
}

function sym(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    qualifiedName: "testFunc",
    kind: "function",
    filePath: path.join(tmpDir, "src/test.ts"),
    lines: [1, 5] as [number, number],
    signature: "function testFunc(): void",
    docs: null,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-error-test-"));
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "src/test.ts"),
    "function testFunc(): void {\n  console.log('hello');\n}\n",
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── getClientWithReason ───────────────────────────────────────────────────

describe("LspManager.getClientWithReason", () => {
  it("returns prerequisite_missing when binary not found", async () => {
    const manager = new LspManager({
      config: {
        lsp: {
          servers: {
            typescript: {
              command: "nonexistent-lsp-server-xyz",
              args: [],
            },
          },
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace(),
    });

    try {
      const { client, reason } = await manager.getClientWithReason(path.join(tmpDir, "src/test.ts"));
      expect(client).toBeNull();
      expect(reason).toBeDefined();
      expect(reason!.kind).toBe("prerequisite_missing");
      if (reason!.kind === "prerequisite_missing") {
        expect(reason!.command).toBe("nonexistent-lsp-server-xyz");
        expect(reason!.language).toBe("typescript");
      }
    } finally {
      await manager.dispose();
    }
  });

  it("returns no_matching_root for files outside roots", async () => {
    const manager = new LspManager({
      config: { lsp: {} },
      logger: makeLogger(),
      workspace: makeWorkspace([{ language: "typescript", root: path.join(tmpDir, "src") }]),
    });

    try {
      const { client, reason } = await manager.getClientWithReason("/tmp/random-file.ts");
      expect(client).toBeNull();
      expect(reason).toBeDefined();
      expect(reason!.kind).toBe("no_matching_root");
    } finally {
      await manager.dispose();
    }
  });

  it("returns client when server boots successfully", async () => {
    const manager = new LspManager({
      config: {
        lsp: {
          servers: { typescript: { command: "node", args: [MOCK_SERVER] } },
          healthCheckIntervalMs: 60_000,
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace(),
    });

    try {
      const { client, reason } = await manager.getClientWithReason(path.join(tmpDir, "src/test.ts"));
      expect(client).not.toBeNull();
      expect(reason).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it("returns crash_limit_exceeded after all attempts fail", async () => {
    const manager = new LspManager({
      config: {
        lsp: {
          servers: { typescript: { command: "node", args: [MOCK_SERVER, "--crash-after-init"] } },
          maxRestartAttempts: 2,
          healthCheckIntervalMs: 60_000,
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace(),
    });

    try {
      // First call boots, then crashes
      await manager.getClient(path.join(tmpDir, "src/test.ts"));
      await sleep(800); // Wait for all crash+recovery cycles

      const { client, reason } = await manager.getClientWithReason(path.join(tmpDir, "src/test.ts"));
      expect(client).toBeNull();
      expect(reason).toBeDefined();
      expect(reason!.kind).toBe("crash_limit_exceeded");
      if (reason!.kind === "crash_limit_exceeded") {
        expect(reason!.attempts).toBeGreaterThanOrEqual(2);
        expect(reason!.language).toBe("typescript");
      }
    } finally {
      await manager.dispose();
    }
  });

  it("returns disposed when manager is disposed", async () => {
    const manager = new LspManager({
      config: { lsp: {} },
      logger: makeLogger(),
      workspace: makeWorkspace(),
    });

    await manager.dispose();

    const { client, reason } = await manager.getClientWithReason(path.join(tmpDir, "src/test.ts"));
    expect(client).toBeNull();
    expect(reason).toBeDefined();
    expect(reason!.kind).toBe("disposed");
  });
});

// ── code_inspect error propagation ────────────────────────────────────────

describe("code_inspect — LSP unavailable reason", () => {
  it("includes lspUnavailableReason when binary missing", async () => {
    const index = new SymbolIndex();
    index.insert(sym());

    const manager = new LspManager({
      config: {
        lsp: {
          servers: { typescript: { command: "nonexistent-server-abc", args: [] } },
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace(),
    });

    const resolver = new LspResolver({
      symbolIndex: index,
      workspaceRoot: tmpDir,
    });

    try {
      const result = await codeInspect(
        { symbol: "testFunc" },
        makeCtx(),
        index,
        manager,
        resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.lspAvailable).toBe(false);
      expect(result.data!.lspUnavailableReason).toBeDefined();
      expect(result.data!.lspUnavailableReason!.reason).toContain("not found");
      expect(result.data!.lspUnavailableReason!.install).toBeDefined();
      expect(result.data!.lspUnavailableReason!.fallback).toContain("Install");
    } finally {
      await manager.dispose();
    }
  });

  it("omits lspUnavailableReason when LSP is available", async () => {
    const index = new SymbolIndex();
    index.insert(sym());

    const manager = new LspManager({
      config: {
        lsp: {
          servers: { typescript: { command: "node", args: [MOCK_SERVER] } },
          healthCheckIntervalMs: 60_000,
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace(),
    });

    const resolver = new LspResolver({
      symbolIndex: index,
      workspaceRoot: tmpDir,
    });

    try {
      const result = await codeInspect(
        { symbol: "testFunc" },
        makeCtx(),
        index,
        manager,
        resolver,
      );

      expect(result.success).toBe(true);
      expect(result.data!.lspAvailable).toBe(true);
      expect(result.data!.lspUnavailableReason).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it("omits lspUnavailableReason when no LspManager at all", async () => {
    const index = new SymbolIndex();
    index.insert(sym());

    const result = await codeInspect(
      { symbol: "testFunc" },
      makeCtx(),
      index,
      null,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.data!.lspAvailable).toBe(false);
    expect(result.data!.lspUnavailableReason).toBeUndefined();
  });
});

// ── code_refactor error propagation ───────────────────────────────────────

describe("code_refactor — structured error messages", () => {
  it("returns install hint when binary missing", async () => {
    const index = new SymbolIndex();
    index.insert(sym());

    const manager = new LspManager({
      config: {
        lsp: {
          servers: { typescript: { command: "nonexistent-server-def", args: [] } },
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace(),
    });

    const resolver = new LspResolver({
      symbolIndex: index,
      workspaceRoot: tmpDir,
    });

    try {
      const result = await codeRefactor(
        { action: "rename", symbol: "testFunc", newName: "newName" },
        makeCtx(),
        index,
        manager,
        resolver,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
      expect(result.error).toContain("Install");
    } finally {
      await manager.dispose();
    }
  });

  it("returns crash info after server exhausted attempts", async () => {
    const index = new SymbolIndex();
    index.insert(sym());

    const manager = new LspManager({
      config: {
        lsp: {
          servers: { typescript: { command: "node", args: [MOCK_SERVER, "--crash-after-init"] } },
          maxRestartAttempts: 2,
          healthCheckIntervalMs: 60_000,
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace(),
    });

    const resolver = new LspResolver({
      symbolIndex: index,
      workspaceRoot: tmpDir,
    });

    try {
      // Trigger crash cycle
      await manager.getClient(path.join(tmpDir, "src/test.ts"));
      await sleep(800);

      const result = await codeRefactor(
        { action: "rename", symbol: "testFunc", newName: "newName" },
        makeCtx(),
        index,
        manager,
        resolver,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("crashed");
      expect(result.error).toContain("reload");
    } finally {
      await manager.dispose();
    }
  });

  it("returns structured error for organize_imports without LSP", async () => {
    const manager = new LspManager({
      config: {
        lsp: {
          servers: { typescript: { command: "nonexistent-lsp-xyz", args: [] } },
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace(),
    });

    try {
      const result = await codeRefactor(
        { action: "organize_imports", path: "src/test.ts" },
        makeCtx(),
        new SymbolIndex(),
        manager,
        null,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
      expect(result.error).toContain("Install");
    } finally {
      await manager.dispose();
    }
  });
});

// ── Clean state on attempt 2 ─────────────────────────────────────────────

describe("LspManager — clean state on restart attempt 2", () => {
  it("cleans TypeScript cache on second boot attempt", async () => {
    // Create fake TS cache
    const cacheDir = path.join(tmpDir, "node_modules/.cache/typescript");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "tsconfig.tsbuildinfo"), "stale");

    // Also create a .tsbuildinfo file in root
    await fs.writeFile(path.join(tmpDir, "tsconfig.tsbuildinfo"), "stale-root");

    // Use a server that will fail to boot (nonexistent binary won't trigger this).
    // Use --crash-after-init to trigger actual boot + crash cycle.
    const manager = new LspManager({
      config: {
        lsp: {
          servers: { typescript: { command: "node", args: [MOCK_SERVER, "--crash-after-init"] } },
          maxRestartAttempts: 3,
          healthCheckIntervalMs: 60_000,
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace(),
    });

    try {
      // First boot succeeds but crashes after init. Recovery cycle begins.
      await manager.getClient(path.join(tmpDir, "src/test.ts"));
      // Wait for all cycles (attempt 2 should clean cache)
      await sleep(1200);

      // Check that caches were cleaned
      const cacheExists = await fs.access(cacheDir).then(() => true).catch(() => false);
      expect(cacheExists).toBe(false);

      const buildInfoExists = await fs.access(path.join(tmpDir, "tsconfig.tsbuildinfo")).then(() => true).catch(() => false);
      expect(buildInfoExists).toBe(false);
    } finally {
      await manager.dispose();
    }
  });
});

// ── Helper ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
