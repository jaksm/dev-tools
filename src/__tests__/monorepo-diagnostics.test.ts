/**
 * Tests for 4.3.2 — Aggregated diagnostics in monorepo scenarios.
 *
 * Verifies:
 * - code_diagnose aggregates from all LSP servers
 * - root filter parameter works
 * - Groups by root in output when multiple roots have diagnostics
 * - Filtered summary when root filter is applied
 * - Directory queries trigger appropriate servers
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { codeDiagnose, type CodeDiagnoseParams } from "../tools/code-diagnose.js";
import { LspManager } from "../core/lsp/manager.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import type { ToolContext, WorkspaceInfo, DevToolsConfig } from "../core/types.js";

let tmpDir: string;

function makeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeWorkspace(languages: { language: string; root: string }[]): WorkspaceInfo {
  return {
    root: tmpDir,
    hasGit: false,
    languages: languages.map(l => ({
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
    workspace: makeWorkspace([]),
    logger: makeLogger(),
  };
}

function makeManager(languages: { language: string; root: string }[]): LspManager {
  return new LspManager({
    config: { lsp: { maxRestartAttempts: 3, healthCheckIntervalMs: 60_000 } },
    logger: makeLogger(),
    workspace: makeWorkspace(languages),
  });
}

function pushDiagnostic(manager: LspManager, file: string, root: string, lang: string, msg: string, severity: number = 1) {
  manager.diagnostics.onDiagnostics({
    uri: `file://${file}`,
    diagnostics: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      message: msg,
      severity,
    }],
  }, root, lang);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "monorepo-diag-test-"));
  await fs.mkdir(path.join(tmpDir, "packages/frontend/src"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "packages/backend/src"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "services/auth"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Aggregated diagnostics ────────────────────────────────────────────────

describe("code_diagnose — monorepo aggregation", () => {
  it("aggregates diagnostics from multiple roots", async () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");

    const manager = makeManager([
      { language: "typescript", root: frontendRoot },
      { language: "typescript", root: backendRoot },
    ]);

    pushDiagnostic(manager, `${frontendRoot}/src/app.tsx`, frontendRoot, "typescript", "Frontend error");
    pushDiagnostic(manager, `${backendRoot}/src/server.ts`, backendRoot, "typescript", "Backend error");

    const result = await codeDiagnose(
      { action: "diagnostics", severity: "all" },
      makeCtx(),
      new SymbolIndex(),
      manager,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.data!.diagnostics).toHaveLength(2);
    expect(result.data!.summary.errors).toBe(2);

    manager.dispose();
  });

  it("groups diagnostics by root when multiple roots present", async () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");
    const goRoot = path.join(tmpDir, "services/auth");

    const manager = makeManager([
      { language: "typescript", root: frontendRoot },
      { language: "typescript", root: backendRoot },
      { language: "go", root: goRoot },
    ]);

    pushDiagnostic(manager, `${frontendRoot}/src/app.tsx`, frontendRoot, "typescript", "FE err 1");
    pushDiagnostic(manager, `${frontendRoot}/src/utils.ts`, frontendRoot, "typescript", "FE err 2");
    pushDiagnostic(manager, `${backendRoot}/src/server.ts`, backendRoot, "typescript", "BE warn", 2);
    pushDiagnostic(manager, `${goRoot}/main.go`, goRoot, "go", "Go err");

    const result = await codeDiagnose(
      { action: "diagnostics", severity: "all" },
      makeCtx(),
      new SymbolIndex(),
      manager,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.data!.groups).toBeDefined();
    expect(result.data!.groups!.length).toBe(3);

    // Check each group
    const groups = result.data!.groups!;
    const feGroup = groups.find(g => g.root === "packages/frontend");
    expect(feGroup).toBeDefined();
    expect(feGroup!.summary.errors).toBe(2);
    expect(feGroup!.language).toBe("typescript");

    const beGroup = groups.find(g => g.root === "packages/backend");
    expect(beGroup).toBeDefined();
    expect(beGroup!.summary.warnings).toBe(1);

    const goGroup = groups.find(g => g.root === "services/auth");
    expect(goGroup).toBeDefined();
    expect(goGroup!.summary.errors).toBe(1);
    expect(goGroup!.language).toBe("go");

    manager.dispose();
  });
});

// ── Root filter ───────────────────────────────────────────────────────────

describe("code_diagnose — root filter", () => {
  it("filters diagnostics by root (relative path)", async () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");

    const manager = makeManager([
      { language: "typescript", root: frontendRoot },
      { language: "typescript", root: backendRoot },
    ]);

    pushDiagnostic(manager, `${frontendRoot}/src/app.tsx`, frontendRoot, "typescript", "FE error");
    pushDiagnostic(manager, `${backendRoot}/src/server.ts`, backendRoot, "typescript", "BE error");

    const result = await codeDiagnose(
      { action: "diagnostics", root: "packages/frontend", severity: "all" },
      makeCtx(),
      new SymbolIndex(),
      manager,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.data!.diagnostics).toHaveLength(1);
    expect(result.data!.diagnostics[0].message).toBe("FE error");

    // Filtered summary should reflect only the filtered results
    expect(result.data!.summary.errors).toBe(1);
    expect(result.data!.summary.fileCount).toBe(1);

    manager.dispose();
  });

  it("filters diagnostics by root (absolute path)", async () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");

    const manager = makeManager([
      { language: "typescript", root: frontendRoot },
      { language: "typescript", root: backendRoot },
    ]);

    pushDiagnostic(manager, `${frontendRoot}/src/app.tsx`, frontendRoot, "typescript", "FE error");
    pushDiagnostic(manager, `${backendRoot}/src/server.ts`, backendRoot, "typescript", "BE error");

    const result = await codeDiagnose(
      { action: "diagnostics", root: frontendRoot, severity: "all" },
      makeCtx(),
      new SymbolIndex(),
      manager,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.data!.diagnostics).toHaveLength(1);
    expect(result.data!.diagnostics[0].message).toBe("FE error");

    manager.dispose();
  });

  it("returns empty when root filter matches no diagnostics", async () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");

    const manager = makeManager([
      { language: "typescript", root: frontendRoot },
    ]);

    pushDiagnostic(manager, `${frontendRoot}/src/app.tsx`, frontendRoot, "typescript", "FE error");

    const result = await codeDiagnose(
      { action: "diagnostics", root: "services/nonexistent", severity: "all" },
      makeCtx(),
      new SymbolIndex(),
      manager,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.data!.diagnostics).toHaveLength(0);
    expect(result.data!.summary.total).toBe(0);

    manager.dispose();
  });
});

// ── No groups for single root ─────────────────────────────────────────────

describe("code_diagnose — single root", () => {
  it("does not include groups when only one root has diagnostics", async () => {
    const root = path.join(tmpDir, "packages/frontend");

    const manager = makeManager([
      { language: "typescript", root },
    ]);

    pushDiagnostic(manager, `${root}/src/app.tsx`, root, "typescript", "Error 1");
    pushDiagnostic(manager, `${root}/src/utils.ts`, root, "typescript", "Error 2");

    const result = await codeDiagnose(
      { action: "diagnostics", severity: "all" },
      makeCtx(),
      new SymbolIndex(),
      manager,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.data!.diagnostics).toHaveLength(2);
    expect(result.data!.groups).toBeUndefined();

    manager.dispose();
  });
});

// ── lsp_status shows all monorepo servers ─────────────────────────────────

describe("code_diagnose — lsp_status monorepo", () => {
  it("lists all registered servers across roots", async () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");
    const goRoot = path.join(tmpDir, "services/auth");

    const manager = makeManager([
      { language: "typescript", root: frontendRoot },
      { language: "typescript", root: backendRoot },
      { language: "go", root: goRoot },
    ]);

    const result = await codeDiagnose(
      { action: "lsp_status" },
      makeCtx(),
      new SymbolIndex(),
      manager,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.servers).toHaveLength(3);

    const serverLanguages = data.servers.map((s: any) => s.language).sort();
    expect(serverLanguages).toEqual(["go", "typescript", "typescript"]);

    manager.dispose();
  });
});

// ── Combined root + severity filter ───────────────────────────────────────

describe("code_diagnose — combined filters", () => {
  it("root + severity filter work together", async () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");

    const manager = makeManager([
      { language: "typescript", root: frontendRoot },
      { language: "typescript", root: backendRoot },
    ]);

    pushDiagnostic(manager, `${frontendRoot}/src/a.tsx`, frontendRoot, "typescript", "FE error", 1);
    pushDiagnostic(manager, `${frontendRoot}/src/b.tsx`, frontendRoot, "typescript", "FE warning", 2);
    pushDiagnostic(manager, `${frontendRoot}/src/c.tsx`, frontendRoot, "typescript", "FE info", 3);
    pushDiagnostic(manager, `${backendRoot}/src/d.ts`, backendRoot, "typescript", "BE error", 1);

    // Root=frontend, severity=error → only FE errors
    const result = await codeDiagnose(
      { action: "diagnostics", root: "packages/frontend", severity: "error" },
      makeCtx(),
      new SymbolIndex(),
      manager,
      null,
    );

    expect(result.success).toBe(true);
    expect(result.data!.diagnostics).toHaveLength(1);
    expect(result.data!.diagnostics[0].message).toBe("FE error");
    expect(result.data!.summary.errors).toBe(1);
    expect(result.data!.summary.warnings).toBe(0);

    manager.dispose();
  });
});
