import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileEdit, type FileEditParams } from "../tools/file-edit.js";
import type { ToolContext } from "../core/types.js";

// Create a test context
let tmpDir: string;
let storageDir: string;

function makeCtx(): ToolContext {
  return {
    workspaceDir: tmpDir,
    storageDir,
    config: { shell: { defaultTimeout: 120000 } },
    workspace: {
      root: tmpDir,
      hasGit: false,
      languages: [],
      testRunners: [],
      gitignoreFilter: () => false,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

async function writeTestFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
  return p;
}

async function readTestFile(name: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, name), "utf-8");
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-edit-test-"));
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-edit-storage-"));
  await fs.mkdir(path.join(storageDir, "tool-output"), { recursive: true });
});

afterAll(async () => {
  // Best-effort cleanup
});

describe("file_edit — exact strategy", () => {
  it("replaces exact match", async () => {
    await writeTestFile("a.ts", "const x = 1;\nconst y = 2;\n");
    const result = await fileEdit({ path: "a.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 42;" }] }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
    expect(await readTestFile("a.ts")).toContain("const x = 42;");
  });
});

describe("file_edit — line-trimmed strategy", () => {
  it("matches with different leading/trailing whitespace per line", async () => {
    await writeTestFile("b.ts", "  function foo() {\n    return 1;\n  }\n");
    const result = await fileEdit({
      path: "b.ts",
      edits: [{ oldText: "function foo() {\nreturn 1;\n}", newText: "function bar() {\nreturn 2;\n}" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
    const content = await readTestFile("b.ts");
    expect(content).toContain("bar");
  });
});

describe("file_edit — whitespace-normalized strategy", () => {
  it("matches when extra spaces differ", async () => {
    await writeTestFile("c.ts", "const   x  =  1;\n");
    const result = await fileEdit({
      path: "c.ts",
      edits: [{ oldText: "const x = 1;", newText: "const x = 99;" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
  });
});

describe("file_edit — indentation-flexible strategy", () => {
  it("matches content with different indentation levels", async () => {
    await writeTestFile("d.ts", "        if (true) {\n            return;\n        }\n");
    const result = await fileEdit({
      path: "d.ts",
      edits: [{ oldText: "    if (true) {\n        return;\n    }", newText: "    if (false) {\n        return;\n    }" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
  });
});

describe("file_edit — escape-normalized strategy", () => {
  it("matches when oldText has literal escapes that normalize to file content", async () => {
    // File contains a literal tab character
    await writeTestFile("e.ts", "const msg = \"hello\tworld\";\n");
    const result = await fileEdit({
      path: "e.ts",
      edits: [{ oldText: "const msg = \"hello\\tworld\";", newText: "const msg = \"goodbye\";" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
  });
});

describe("file_edit — unicode-normalized strategy", () => {
  it("matches smart quotes to ASCII quotes", async () => {
    await writeTestFile("f.ts", "const msg = \u201Chello world\u201D;\n");
    const result = await fileEdit({
      path: "f.ts",
      edits: [{ oldText: 'const msg = "hello world";', newText: "const msg = 'hi';" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
  });

  it("matches em dashes to hyphens", async () => {
    await writeTestFile("g.ts", "// section \u2014 intro\n");
    const result = await fileEdit({
      path: "g.ts",
      edits: [{ oldText: "// section - intro", newText: "// section -- intro" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
  });

  it("matches non-breaking spaces", async () => {
    await writeTestFile("h.ts", "const\u00A0x = 1;\n");
    const result = await fileEdit({
      path: "h.ts",
      edits: [{ oldText: "const x = 1;", newText: "const y = 1;" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
  });
});

describe("file_edit — block-anchor strategy", () => {
  it("matches block with same first/last lines but slightly different middle", async () => {
    const original = "function foo() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
    await writeTestFile("ba.ts", original);
    // Same first/last lines, slight middle difference
    const result = await fileEdit({
      path: "ba.ts",
      edits: [{ oldText: "function foo() {\n  const aa = 1;\n  const b = 2;\n  return a + b;\n}", newText: "function bar() {}" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
  });
});

describe("file_edit — ambiguity resolution", () => {
  it("0 matches returns error", async () => {
    await writeTestFile("noMatch.ts", "const x = 1;\n");
    const result = await fileEdit({
      path: "noMatch.ts",
      edits: [{ oldText: "NOT_HERE", newText: "replaced" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(0);
    expect(result.failures).toBeTruthy();
  });

  it("1 match applies", async () => {
    await writeTestFile("oneMatch.ts", "const x = 1;\nconst y = 2;\n");
    const result = await fileEdit({
      path: "oneMatch.ts",
      edits: [{ oldText: "const x = 1;", newText: "const x = 99;" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
  });

  it("N matches without lineHint returns error with locations", async () => {
    await writeTestFile("ambig.ts", "const x = 1;\n\nconst x = 1;\n");
    const result = await fileEdit({
      path: "ambig.ts",
      edits: [{ oldText: "const x = 1;", newText: "const x = 99;" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(0);
    const failures = result.failures as Array<Record<string, unknown>>;
    expect(failures).toBeTruthy();
    expect(failures[0]!.error).toContain("Ambiguous");
    expect(failures[0]!.locations).toBeTruthy();
  });

  it("N matches with lineHint within ±5 resolves", async () => {
    await writeTestFile("hint.ts", "const x = 1;\nline2\nline3\nline4\nline5\nline6\nconst x = 1;\n");
    const result = await fileEdit({
      path: "hint.ts",
      edits: [{ oldText: "const x = 1;", newText: "const x = 99;", lineHint: 7 }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
    const content = await readTestFile("hint.ts");
    // First occurrence should be untouched, second replaced
    const lines = content.split("\n");
    expect(lines[0]).toBe("const x = 1;");
    expect(lines[6]).toBe("const x = 99;");
  });

  it("lineHint at exactly ±5 still resolves", async () => {
    // Match at line 1, lineHint=6 → distance=5, should resolve
    await writeTestFile("exact5.ts", "const x = 1;\nline2\nline3\nline4\nline5\nline6\nconst x = 1;\n");
    const result = await fileEdit({
      path: "exact5.ts",
      edits: [{ oldText: "const x = 1;", newText: "const x = 99;", lineHint: 6 }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(1);
  });

  it("lineHint at ±6 fails to disambiguate when both are too far", async () => {
    // Matches at line 1 and line 20, lineHint=10 → both >5 away
    let content = "const x = 1;\n";
    for (let i = 0; i < 18; i++) content += `line${i + 2}\n`;
    content += "const x = 1;\n";
    await writeTestFile("far.ts", content);
    const result = await fileEdit({
      path: "far.ts",
      edits: [{ oldText: "const x = 1;", newText: "replaced", lineHint: 10 }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(0);
    const failures = result.failures as Array<Record<string, unknown>>;
    expect(failures[0]!.error).toContain("Ambiguous");
  });
});

describe("file_edit — multiple edits per call", () => {
  it("second edit sees result of first", async () => {
    await writeTestFile("multi.ts", "const a = 1;\nconst b = 2;\n");
    const result = await fileEdit({
      path: "multi.ts",
      edits: [
        { oldText: "const a = 1;", newText: "const a = 10;" },
        { oldText: "const a = 10;", newText: "const a = 100;" }, // depends on first edit
      ],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.applied).toBe(2);
    expect(await readTestFile("multi.ts")).toContain("const a = 100;");
  });
});

describe("file_edit — error cases", () => {
  it("file not found", async () => {
    const result = await fileEdit({
      path: "nonexistent.ts",
      edits: [{ oldText: "a", newText: "b" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBe("file_not_found");
  });

  it("no edits provided", async () => {
    await writeTestFile("empty.ts", "content");
    const result = await fileEdit({
      path: "empty.ts",
      edits: [],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBe("no_edits_provided");
  });

  it("non-existent file returns error", async () => {
    const result = await fileEdit({
      path: "does-not-exist.ts",
      edits: [{ oldText: "a", newText: "b" }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.error).toBe("file_not_found");
  });
});

describe("file_edit — ambiguous match dedup", () => {
  it("deduplicates matches on the same line across strategies", async () => {
    // A pattern that matches via exact AND whitespace-normalized on the same line
    // should only report 1 location, not 2
    await writeTestFile("dedup.ts", [
      "function hello() {",
      "  return true;",
      "}",
      "function world() {",
      "  return true;",
      "}",
    ].join("\n"));

    const result = await fileEdit({
      path: "dedup.ts",
      edits: [{ oldText: "return true;", newText: "return false;" }],
    }, makeCtx()) as any;

    // Should fail with ambiguity — 2 distinct locations, not duplicates from multiple strategies
    const resultStr = JSON.stringify(result);
    expect(resultStr.toLowerCase()).toContain("ambiguous");
    
    // Check that reported failures show exactly 2 locations (line 2 and line 5)
    expect(result.failures).toBeDefined();
    expect(result.failures.length).toBe(1);
    const failedEdit = result.failures[0];
    expect(failedEdit.locations).toBeDefined();
    const lines = failedEdit.locations.map((l: any) => l.line);
    const uniqueLines = [...new Set(lines)];
    // Lines should be deduplicated — 2 unique locations, not more from overlapping strategies
    expect(lines.length).toBe(uniqueLines.length);
    expect(uniqueLines.length).toBe(2);
    expect(uniqueLines).toContain(2);
    expect(uniqueLines).toContain(5);
  });

  it("uses lineHint to disambiguate among multiple matches", async () => {
    await writeTestFile("hint.ts", [
      "const a = 1;",
      "const b = 2;",
      "const a = 1;",
      "const c = 3;",
    ].join("\n"));

    const result = await fileEdit({
      path: "hint.ts",
      edits: [{ oldText: "const a = 1;", newText: "const a = 99;", lineHint: 3 }],
    }, makeCtx()) as Record<string, unknown>;

    const content = await readTestFile("hint.ts");
    // Should edit line 3, not line 1
    expect(content).toBe("const a = 1;\nconst b = 2;\nconst a = 99;\nconst c = 3;");
  });
});
