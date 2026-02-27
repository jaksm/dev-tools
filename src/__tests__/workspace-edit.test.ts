/**
 * Workspace Edit Application Tests — verifies applyTextEdits correctness.
 *
 * Tests the core edit application logic from code_refactor with:
 * - Multiple edits on the same file (bottom-up ordering)
 * - Edits that change line count (insertions/deletions)
 * - Multi-line replacements
 * - Edge cases: empty files, single character edits, overlapping ranges
 * - Resource operations: create, rename, delete
 * - documentChanges format vs changes format
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { codeRefactor } from "../tools/code-refactor.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import type { ToolContext, DevToolsConfig, WorkspaceInfo, SymbolInfo } from "../core/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-edit-test-"));
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
  return {
    workspaceDir: tmpDir,
    storageDir: path.join(tmpDir, ".dev-tools"),
    config: {} as DevToolsConfig,
    workspace: {
      root: tmpDir,
      hasGit: false,
      languages: [],
      testRunners: [],
      gitignoreFilter: () => false,
    } as WorkspaceInfo,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
}

// We test applyWorkspaceEdit indirectly through code_refactor's rename
// by providing a mock LspManager that returns pre-built WorkspaceEdits.

function createMockLspManager(workspaceEdit: any) {
  const mockClient = {
    ensureDocumentOpen: async () => "file:///mock",
    rename: async () => workspaceEdit,
    state: "ready",
    pid: 99999,
  };
  return {
    getClient: async () => mockClient,
    getClientWithReason: async () => ({ client: mockClient }),
    getStatus: () => [],
    diagnostics: { getSummary: () => ({ total: 0, errors: 0, warnings: 0, info: 0, hints: 0, fileCount: 0 }), getSummaryByRoot: () => new Map() },
  } as any;
}

function createMockResolver(position: { uri: string; filePath: string; line: number; character: number }) {
  return {
    resolve: async () => ({
      position: { ...position, symbol: { qualifiedName: "test" } as SymbolInfo, drifted: false },
      candidates: [],
      ambiguous: false,
    }),
  } as any;
}

// ── Multi-edit same file ──────────────────────────────────────────────────

describe("Workspace Edit — multi-edit same file", () => {
  it("applies 3 edits bottom-up correctly", async () => {
    const file = path.join(tmpDir, "src/multi.ts");
    await fs.writeFile(file, [
      "const alpha = 1;",    // line 0
      "const beta = 2;",     // line 1
      "const gamma = 3;",    // line 2
      "export { alpha, beta, gamma };", // line 3
    ].join("\n"));

    const uri = pathToFileURL(file).toString();

    // Rename 'alpha' at 3 locations
    const edit = {
      changes: {
        [uri]: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" },
          { range: { start: { line: 3, character: 9 }, end: { line: 3, character: 14 } }, newText: "ALPHA" },
        ],
      },
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "alpha", newName: "ALPHA" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri, filePath: file, line: 0, character: 6 }),
    );

    expect(result.success).toBe(true);

    const content = await fs.readFile(file, "utf-8");
    const lines = content.split("\n");
    expect(lines[0]).toBe("const ALPHA = 1;");
    expect(lines[1]).toBe("const beta = 2;"); // untouched
    expect(lines[2]).toBe("const gamma = 3;"); // untouched
    expect(lines[3]).toBe("export { ALPHA, beta, gamma };");
  });

  it("handles edit that inserts new lines", async () => {
    const file = path.join(tmpDir, "src/insert.ts");
    await fs.writeFile(file, [
      "function hello() {",
      "  return 1;",
      "}",
    ].join("\n"));

    const uri = pathToFileURL(file).toString();

    // Replace single line with multiple lines
    const edit = {
      changes: {
        [uri]: [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 12 } },
            newText: "  const x = 1;\n  const y = 2;\n  return x + y;",
          },
        ],
      },
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "x", newName: "x" }, // dummy rename
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri, filePath: file, line: 1, character: 0 }),
    );

    expect(result.success).toBe(true);

    const content = await fs.readFile(file, "utf-8");
    const lines = content.split("\n");
    expect(lines).toHaveLength(5); // was 3, now 5
    expect(lines[0]).toBe("function hello() {");
    expect(lines[1]).toBe("  const x = 1;");
    expect(lines[2]).toBe("  const y = 2;");
    expect(lines[3]).toBe("  return x + y;");
    expect(lines[4]).toBe("}");
  });

  it("handles edit that deletes lines", async () => {
    const file = path.join(tmpDir, "src/delete.ts");
    await fs.writeFile(file, [
      "line 1",
      "line 2 to delete",
      "line 3 to delete",
      "line 4",
    ].join("\n"));

    const uri = pathToFileURL(file).toString();

    // Delete lines 1-2 (0-indexed)
    const edit = {
      changes: {
        [uri]: [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } },
            newText: "",
          },
        ],
      },
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "x", newName: "x" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri, filePath: file, line: 1, character: 0 }),
    );

    expect(result.success).toBe(true);

    const content = await fs.readFile(file, "utf-8");
    expect(content).toBe("line 1\nline 4");
  });

  it("handles two edits that change line count", async () => {
    const file = path.join(tmpDir, "src/complex.ts");
    await fs.writeFile(file, [
      "const a = 1;",      // line 0
      "const b = 2;",      // line 1
      "const c = 3;",      // line 2
      "const d = 4;",      // line 3
    ].join("\n"));

    const uri = pathToFileURL(file).toString();

    // Edit 1 (line 3): replace "const d = 4;" with two lines
    // Edit 2 (line 1): replace "const b = 2;" with nothing (delete)
    // Bottom-up: edit 1 applied first, then edit 2
    const edit = {
      changes: {
        [uri]: [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
            newText: "", // delete line 1
          },
          {
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 12 } },
            newText: "const d = 4;\nconst e = 5;", // expand line 3
          },
        ],
      },
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "x", newName: "x" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri, filePath: file, line: 1, character: 0 }),
    );

    expect(result.success).toBe(true);

    const content = await fs.readFile(file, "utf-8");
    const lines = content.split("\n");
    // Original: a, b, c, d (4 lines)
    // After: a, c, d, e (4 lines) — deleted b, expanded d into d+e
    expect(lines[0]).toBe("const a = 1;");
    expect(lines[1]).toBe("const c = 3;");
    expect(lines[2]).toBe("const d = 4;");
    expect(lines[3]).toBe("const e = 5;");
  });
});

// ── documentChanges format ────────────────────────────────────────────────

describe("Workspace Edit — documentChanges format", () => {
  it("applies TextDocumentEdit from documentChanges", async () => {
    const file = path.join(tmpDir, "src/docchange.ts");
    await fs.writeFile(file, "const old = true;\n");

    const uri = pathToFileURL(file).toString();

    const edit = {
      documentChanges: [
        {
          textDocument: { uri, version: 1 },
          edits: [
            { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "NEW" },
          ],
        },
      ],
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "old", newName: "NEW" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri, filePath: file, line: 0, character: 6 }),
    );

    expect(result.success).toBe(true);
    const content = await fs.readFile(file, "utf-8");
    expect(content).toBe("const NEW = true;\n");
  });

  it("handles create resource operation", async () => {
    const newFile = path.join(tmpDir, "src/deep/new.ts");

    const edit = {
      documentChanges: [
        { kind: "create", uri: pathToFileURL(newFile).toString() },
      ],
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "x", newName: "y" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri: "file:///mock", filePath: path.join(tmpDir, "src/test.ts"), line: 0, character: 0 }),
    );

    expect(result.success).toBe(true);
    const exists = await fs.access(newFile).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("handles rename resource operation", async () => {
    const oldFile = path.join(tmpDir, "src/old-name.ts");
    const newFile = path.join(tmpDir, "src/new-name.ts");
    await fs.writeFile(oldFile, "content\n");

    const edit = {
      documentChanges: [
        { kind: "rename", oldUri: pathToFileURL(oldFile).toString(), newUri: pathToFileURL(newFile).toString() },
      ],
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "x", newName: "y" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri: "file:///mock", filePath: path.join(tmpDir, "src/test.ts"), line: 0, character: 0 }),
    );

    expect(result.success).toBe(true);

    const oldExists = await fs.access(oldFile).then(() => true).catch(() => false);
    const newExists = await fs.access(newFile).then(() => true).catch(() => false);
    expect(oldExists).toBe(false);
    expect(newExists).toBe(true);

    const content = await fs.readFile(newFile, "utf-8");
    expect(content).toBe("content\n");
  });

  it("handles delete resource operation", async () => {
    const file = path.join(tmpDir, "src/to-delete.ts");
    await fs.writeFile(file, "bye\n");

    const edit = {
      documentChanges: [
        { kind: "delete", uri: pathToFileURL(file).toString() },
      ],
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "x", newName: "y" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri: "file:///mock", filePath: path.join(tmpDir, "src/test.ts"), line: 0, character: 0 }),
    );

    expect(result.success).toBe(true);

    const exists = await fs.access(file).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────

describe("Workspace Edit — edge cases", () => {
  it("handles edit at start of file (line 0, char 0)", async () => {
    const file = path.join(tmpDir, "src/edge.ts");
    await fs.writeFile(file, "hello world\n");

    const uri = pathToFileURL(file).toString();

    const edit = {
      changes: {
        [uri]: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "HELLO" },
        ],
      },
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "x", newName: "y" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri, filePath: file, line: 0, character: 0 }),
    );

    expect(result.success).toBe(true);
    const content = await fs.readFile(file, "utf-8");
    expect(content).toBe("HELLO world\n");
  });

  it("handles edit at end of file", async () => {
    const file = path.join(tmpDir, "src/end.ts");
    await fs.writeFile(file, "const x = 1;");

    const uri = pathToFileURL(file).toString();

    const edit = {
      changes: {
        [uri]: [
          { range: { start: { line: 0, character: 12 }, end: { line: 0, character: 12 } }, newText: "\nconst y = 2;" },
        ],
      },
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "x", newName: "y" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri, filePath: file, line: 0, character: 0 }),
    );

    expect(result.success).toBe(true);
    const content = await fs.readFile(file, "utf-8");
    expect(content).toBe("const x = 1;\nconst y = 2;");
  });

  it("handles empty edit list (no-op)", async () => {
    const edit = { changes: {} };

    const result = await codeRefactor(
      { action: "rename", symbol: "x", newName: "y" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri: "file:///mock", filePath: path.join(tmpDir, "src/test.ts"), line: 0, character: 0 }),
    );

    expect(result.success).toBe(true);
    expect(result.data!.changes).toHaveLength(0);
    expect(result.data!.totalEdits).toBe(0);
  });

  it("handles multi-file workspace edit", async () => {
    const file1 = path.join(tmpDir, "src/file1.ts");
    const file2 = path.join(tmpDir, "src/file2.ts");
    await fs.writeFile(file1, "const foo = 1;\n");
    await fs.writeFile(file2, "import { foo } from './file1';\n");
    // file1: "const foo = 1;\n"  — foo at chars 6-9
    //         0123456789
    // file2: "import { foo } from './file1';\n"  — foo at chars 9-12
    //         0123456789012

    const edit = {
      changes: {
        [pathToFileURL(file1).toString()]: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "bar" },
        ],
        [pathToFileURL(file2).toString()]: [
          { range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, newText: "bar" },
        ],
      },
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "foo", newName: "bar" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri: pathToFileURL(file1).toString(), filePath: file1, line: 0, character: 6 }),
    );

    expect(result.success).toBe(true);
    expect(result.data!.changes).toHaveLength(2);

    const content1 = await fs.readFile(file1, "utf-8");
    const content2 = await fs.readFile(file2, "utf-8");
    expect(content1).toBe("const bar = 1;\n");
    expect(content2).toBe("import { bar } from './file1';\n");
  });

  it("handles single character replacement", async () => {
    const file = path.join(tmpDir, "src/char.ts");
    await fs.writeFile(file, "x = 1;\n");

    const uri = pathToFileURL(file).toString();

    const edit = {
      changes: {
        [uri]: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" },
        ],
      },
    };

    const result = await codeRefactor(
      { action: "rename", symbol: "x", newName: "y" },
      makeCtx(),
      new SymbolIndex(),
      createMockLspManager(edit),
      createMockResolver({ uri, filePath: file, line: 0, character: 0 }),
    );

    expect(result.success).toBe(true);
    const content = await fs.readFile(file, "utf-8");
    expect(content).toBe("y = 1;\n");
  });
});
