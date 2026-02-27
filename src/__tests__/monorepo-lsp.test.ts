/**
 * Tests for 4.3.1 — Multi-root LSP management in monorepo scenarios.
 *
 * Verifies:
 * - Multiple same-language roots get separate server instances
 * - Mixed-language roots route correctly
 * - Nested roots prefer most-specific match
 * - Language-aware routing prioritizes file extension match
 * - findAllInstancesForFile returns all candidates
 * - Independent server lifecycle per root
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LspManager } from "../core/lsp/manager.js";
import type { WorkspaceInfo, DevToolsConfig } from "../core/types.js";

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

function makeConfig(): DevToolsConfig {
  return {
    lsp: {
      servers: {
        typescript: { command: "node", args: [MOCK_SERVER] },
        python: { command: "node", args: [MOCK_SERVER] },
        rust: { command: "node", args: [MOCK_SERVER] },
        go: { command: "node", args: [MOCK_SERVER] },
        swift: { command: "node", args: [MOCK_SERVER] },
      },
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 60_000,
    },
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "monorepo-lsp-test-"));

  // Create monorepo structure
  const dirs = [
    "packages/frontend/src",
    "packages/backend/src",
    "packages/shared/src",
    "services/auth",
    "services/api",
    "mobile/ios",
  ];
  for (const dir of dirs) {
    await fs.mkdir(path.join(tmpDir, dir), { recursive: true });
  }

  // Create sample files
  await fs.writeFile(path.join(tmpDir, "packages/frontend/src/app.tsx"), "export const App = () => <div />;\n");
  await fs.writeFile(path.join(tmpDir, "packages/backend/src/server.ts"), "export function startServer() {}\n");
  await fs.writeFile(path.join(tmpDir, "packages/shared/src/utils.ts"), "export function clamp(n: number) { return n; }\n");
  await fs.writeFile(path.join(tmpDir, "services/auth/main.go"), "package main\n");
  await fs.writeFile(path.join(tmpDir, "services/api/main.py"), "def main(): pass\n");
  await fs.writeFile(path.join(tmpDir, "mobile/ios/App.swift"), "import SwiftUI\n");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Multiple same-language roots ──────────────────────────────────────────

describe("Monorepo — multiple same-language roots", () => {
  it("registers separate instances for each TypeScript root", () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: path.join(tmpDir, "packages/frontend") },
        { language: "typescript", root: path.join(tmpDir, "packages/backend") },
        { language: "typescript", root: path.join(tmpDir, "packages/shared") },
      ]),
    });

    const status = manager.getStatus();
    expect(status).toHaveLength(3);
    expect(status.every(s => s.language === "typescript")).toBe(true);
    expect(new Set(status.map(s => s.root))).toHaveProperty("size", 3);

    manager.dispose();
  });

  it("routes frontend file to frontend server", () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: frontendRoot },
        { language: "typescript", root: backendRoot },
      ]),
    });

    const instance = manager.findInstanceForFile(path.join(frontendRoot, "src/app.tsx"));
    expect(instance).not.toBeNull();
    expect(instance!.root).toBe(frontendRoot);

    manager.dispose();
  });

  it("routes backend file to backend server", () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: frontendRoot },
        { language: "typescript", root: backendRoot },
      ]),
    });

    const instance = manager.findInstanceForFile(path.join(backendRoot, "src/server.ts"));
    expect(instance).not.toBeNull();
    expect(instance!.root).toBe(backendRoot);

    manager.dispose();
  });

  it("boots separate server processes for each root", async () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: frontendRoot },
        { language: "typescript", root: backendRoot },
      ]),
    });

    try {
      const client1 = await manager.getClient(path.join(frontendRoot, "src/app.tsx"));
      const client2 = await manager.getClient(path.join(backendRoot, "src/server.ts"));

      expect(client1).not.toBeNull();
      expect(client2).not.toBeNull();
      // Different server processes
      expect(client1).not.toBe(client2);
      expect(client1!.pid).not.toBe(client2!.pid);

      const status = manager.getStatus();
      const running = status.filter(s => s.state === "running");
      expect(running).toHaveLength(2);
    } finally {
      await manager.dispose();
    }
  });
});

// ── Mixed-language monorepo ───────────────────────────────────────────────

describe("Monorepo — mixed languages", () => {
  it("registers instances for all languages", () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: path.join(tmpDir, "packages/frontend") },
        { language: "typescript", root: path.join(tmpDir, "packages/backend") },
        { language: "go", root: path.join(tmpDir, "services/auth") },
        { language: "python", root: path.join(tmpDir, "services/api") },
        { language: "swift", root: path.join(tmpDir, "mobile/ios") },
      ]),
    });

    const status = manager.getStatus();
    expect(status).toHaveLength(5);

    const langs = new Set(status.map(s => s.language));
    expect(langs).toEqual(new Set(["typescript", "go", "python", "swift"]));

    manager.dispose();
  });

  it("routes Go file to Go server, not TypeScript", () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
        { language: "go", root: path.join(tmpDir, "services/auth") },
      ]),
    });

    const instance = manager.findInstanceForFile(path.join(tmpDir, "services/auth/main.go"));
    expect(instance).not.toBeNull();
    expect(instance!.language).toBe("go");

    manager.dispose();
  });

  it("routes Python file to Python server, not root TypeScript", () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
        { language: "python", root: path.join(tmpDir, "services/api") },
      ]),
    });

    const instance = manager.findInstanceForFile(path.join(tmpDir, "services/api/main.py"));
    expect(instance).not.toBeNull();
    expect(instance!.language).toBe("python");

    manager.dispose();
  });

  it("routes Swift file to Swift server", () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
        { language: "swift", root: path.join(tmpDir, "mobile/ios") },
      ]),
    });

    const instance = manager.findInstanceForFile(path.join(tmpDir, "mobile/ios/App.swift"));
    expect(instance).not.toBeNull();
    expect(instance!.language).toBe("swift");

    manager.dispose();
  });

  it("falls back to root TypeScript for .ts files not in a nested language root", () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
        { language: "go", root: path.join(tmpDir, "services/auth") },
        { language: "python", root: path.join(tmpDir, "services/api") },
      ]),
    });

    // A .ts file at root level should go to the root TS instance
    const instance = manager.findInstanceForFile(path.join(tmpDir, "scripts/deploy.ts"));
    expect(instance).not.toBeNull();
    expect(instance!.language).toBe("typescript");
    expect(instance!.root).toBe(tmpDir);

    manager.dispose();
  });
});

// ── Nested roots (same language, different depths) ────────────────────────

describe("Monorepo — nested roots", () => {
  it("prefers deeper (more specific) root", () => {
    const rootTs = tmpDir;
    const nestedTs = path.join(tmpDir, "packages/frontend");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: rootTs },
        { language: "typescript", root: nestedTs },
      ]),
    });

    // File in nested root should match nested, not root
    const instance = manager.findInstanceForFile(path.join(nestedTs, "src/app.tsx"));
    expect(instance).not.toBeNull();
    expect(instance!.root).toBe(nestedTs);

    manager.dispose();
  });

  it("falls back to shallower root for files outside nested root", () => {
    const rootTs = tmpDir;
    const nestedTs = path.join(tmpDir, "packages/frontend");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: rootTs },
        { language: "typescript", root: nestedTs },
      ]),
    });

    // File at root level should match root, not nested
    const instance = manager.findInstanceForFile(path.join(tmpDir, "config/settings.ts"));
    expect(instance).not.toBeNull();
    expect(instance!.root).toBe(rootTs);

    manager.dispose();
  });

  it("language match takes priority over root depth", () => {
    const rootTs = tmpDir;
    const nestedPy = path.join(tmpDir, "services/api");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: rootTs },
        { language: "python", root: nestedPy },
      ]),
    });

    // .py file in nested root should match Python, even though TS root is broader
    const instance = manager.findInstanceForFile(path.join(nestedPy, "main.py"));
    expect(instance).not.toBeNull();
    expect(instance!.language).toBe("python");

    manager.dispose();
  });
});

// ── findAllInstancesForFile ───────────────────────────────────────────────

describe("Monorepo — findAllInstancesForFile", () => {
  it("returns all instances whose root contains the file", () => {
    const rootTs = tmpDir;
    const nestedTs = path.join(tmpDir, "packages/frontend");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: rootTs },
        { language: "typescript", root: nestedTs },
      ]),
    });

    // File in nested root is contained by both the nested root AND the workspace root
    const instances = manager.findAllInstancesForFile(path.join(nestedTs, "src/app.tsx"));
    expect(instances).toHaveLength(2);
    const roots = instances.map(i => i.root);
    expect(roots).toContain(rootTs);
    expect(roots).toContain(nestedTs);

    manager.dispose();
  });

  it("returns only matching instances (not unrelated roots)", () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: path.join(tmpDir, "packages/frontend") },
        { language: "typescript", root: path.join(tmpDir, "packages/backend") },
        { language: "go", root: path.join(tmpDir, "services/auth") },
      ]),
    });

    const instances = manager.findAllInstancesForFile(path.join(tmpDir, "packages/frontend/src/app.tsx"));
    expect(instances).toHaveLength(1);
    expect(instances[0].language).toBe("typescript");
    expect(instances[0].root).toBe(path.join(tmpDir, "packages/frontend"));

    manager.dispose();
  });
});

// ── Diagnostics collector with roots ──────────────────────────────────────

describe("Monorepo — diagnostics per root", () => {
  it("tracks diagnostics with root and language metadata", () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: frontendRoot },
        { language: "typescript", root: backendRoot },
      ]),
    });

    // Simulate diagnostics from two different roots
    manager.diagnostics.onDiagnostics({
      uri: `file://${frontendRoot}/src/app.tsx`,
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        message: "Frontend type error",
        severity: 1,
      }],
    }, frontendRoot, "typescript");

    manager.diagnostics.onDiagnostics({
      uri: `file://${backendRoot}/src/server.ts`,
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        message: "Backend type error",
        severity: 1,
      }],
    }, backendRoot, "typescript");

    // Query all
    const all = manager.diagnostics.query({ severity: "all" });
    expect(all).toHaveLength(2);

    // Query by root
    const frontendOnly = manager.diagnostics.query({ root: frontendRoot, severity: "all" });
    expect(frontendOnly).toHaveLength(1);
    expect(frontendOnly[0].message).toBe("Frontend type error");

    const backendOnly = manager.diagnostics.query({ root: backendRoot, severity: "all" });
    expect(backendOnly).toHaveLength(1);
    expect(backendOnly[0].message).toBe("Backend type error");

    manager.dispose();
  });

  it("getSummaryByRoot groups correctly", () => {
    const frontendRoot = path.join(tmpDir, "packages/frontend");
    const backendRoot = path.join(tmpDir, "packages/backend");
    const goRoot = path.join(tmpDir, "services/auth");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: frontendRoot },
        { language: "typescript", root: backendRoot },
        { language: "go", root: goRoot },
      ]),
    });

    // Frontend: 2 errors
    manager.diagnostics.onDiagnostics({
      uri: `file://${frontendRoot}/src/a.tsx`,
      diagnostics: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "err1", severity: 1 },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, message: "err2", severity: 1 },
      ],
    }, frontendRoot, "typescript");

    // Backend: 1 warning
    manager.diagnostics.onDiagnostics({
      uri: `file://${backendRoot}/src/b.ts`,
      diagnostics: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "warn1", severity: 2 },
      ],
    }, backendRoot, "typescript");

    // Go: 1 error
    manager.diagnostics.onDiagnostics({
      uri: `file://${goRoot}/main.go`,
      diagnostics: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "go-err", severity: 1 },
      ],
    }, goRoot, "go");

    const byRoot = manager.diagnostics.getSummaryByRoot();
    expect(byRoot.size).toBe(3);

    const frontend = byRoot.get(frontendRoot)!;
    expect(frontend.errors).toBe(2);
    expect(frontend.warnings).toBe(0);

    const backend = byRoot.get(backendRoot)!;
    expect(backend.errors).toBe(0);
    expect(backend.warnings).toBe(1);

    const goSummary = byRoot.get(goRoot)!;
    expect(goSummary.errors).toBe(1);

    manager.dispose();
  });
});

// ── Language detection depth ──────────────────────────────────────────────

describe("Monorepo — language detection", () => {
  it("detects languages at depth > 1", async () => {
    // Create a deep monorepo structure
    const deepDir = path.join(tmpDir, "services/auth/internal");
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(path.join(deepDir, "go.mod"), "module auth/internal\n");

    const { detectLanguages } = await import("../core/languages.js");
    const languages = await detectLanguages(tmpDir, () => false, 3);

    const goLangs = languages.filter(l => l.language === "go");
    expect(goLangs.length).toBeGreaterThanOrEqual(1);
    const deepGoRoot = goLangs.find(l => l.root === deepDir);
    expect(deepGoRoot).toBeDefined();
  });

  it("respects maxDepth limit", async () => {
    // Create structure at depth 4 — should NOT be detected with maxDepth=2
    const veryDeep = path.join(tmpDir, "a/b/c/d");
    await fs.mkdir(veryDeep, { recursive: true });
    await fs.writeFile(path.join(veryDeep, "Cargo.toml"), "[package]\nname = \"deep\"\n");

    const { detectLanguages } = await import("../core/languages.js");
    const languages = await detectLanguages(tmpDir, () => false, 2);

    const rustLangs = languages.filter(l => l.language === "rust");
    const deepRust = rustLangs.find(l => l.root === veryDeep);
    expect(deepRust).toBeUndefined();
  });

  it("skips node_modules and other ignored dirs", async () => {
    await fs.mkdir(path.join(tmpDir, "node_modules/some-pkg"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "node_modules/some-pkg/tsconfig.json"), "{}");

    const { detectLanguages } = await import("../core/languages.js");
    const languages = await detectLanguages(tmpDir, () => false, 3);

    const nmLangs = languages.filter(l => l.root.includes("node_modules"));
    expect(nmLangs).toHaveLength(0);
  });

  it("detects typical monorepo structure correctly", async () => {
    // Create config files at expected locations
    await fs.writeFile(path.join(tmpDir, "packages/frontend/tsconfig.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "packages/backend/tsconfig.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "services/auth/go.mod"), "module auth\n");
    await fs.writeFile(path.join(tmpDir, "services/api/pyproject.toml"), "[project]\nname = \"api\"\n");
    await fs.writeFile(path.join(tmpDir, "mobile/ios/Package.swift"), "// swift\n");

    const { detectLanguages } = await import("../core/languages.js");
    const languages = await detectLanguages(tmpDir, () => false, 3);

    const langMap = new Map(languages.map(l => [l.root, l.language]));

    expect(langMap.get(path.join(tmpDir, "packages/frontend"))).toBe("typescript");
    expect(langMap.get(path.join(tmpDir, "packages/backend"))).toBe("typescript");
    expect(langMap.get(path.join(tmpDir, "services/auth"))).toBe("go");
    expect(langMap.get(path.join(tmpDir, "services/api"))).toBe("python");
    expect(langMap.get(path.join(tmpDir, "mobile/ios"))).toBe("swift");
  });
});
