import { describe, it, expect } from "vitest";
import { renderIndex } from "../core/index/index-renderer.js";
import type { IndexJson } from "../core/index/index-json.js";

function makeIndex(fileCount: number): IndexJson {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    file: `src/file${i}.ts`,
    lines: 100,
    rank: (fileCount - i) / fileCount,
    exports: [`export${i}`],
    imports: i > 0 ? [`./file${i - 1}`] : [],
    symbols: 5,
  }));

  return {
    version: 1,
    workspace: "/project",
    generatedAt: new Date().toISOString(),
    files,
    totalSymbols: fileCount * 5,
    totalFiles: fileCount,
  };
}

describe("renderIndex", () => {
  it("renders small project (≤100 files) with full detail", () => {
    const index = makeIndex(50);
    const text = renderIndex(index);
    expect(text).toContain("50 files");
    expect(text).toContain("250 symbols");
    expect(text).toContain("src/file0.ts");
    expect(text).not.toContain("Directories");
  });

  it("renders medium project (≤500) with dir summaries + top files", () => {
    const index = makeIndex(300);
    const text = renderIndex(index);
    expect(text).toContain("Directories");
    expect(text).toContain("Top 200 files");
    expect(text).toContain("and 100 more files");
  });

  it("renders large project (≤2000) with compact view", () => {
    const index = makeIndex(1500);
    const text = renderIndex(index);
    expect(text).toContain("Directories");
    expect(text).toContain("Top 100 files");
  });

  it("renders empty project", () => {
    const index = makeIndex(0);
    const text = renderIndex(index);
    expect(text).toContain("no indexed files");
  });

  it("respects maxFiles override", () => {
    const index = makeIndex(50);
    const text = renderIndex(index, { maxFiles: 10 });
    expect(text).toContain("and 40 more files");
  });
});
