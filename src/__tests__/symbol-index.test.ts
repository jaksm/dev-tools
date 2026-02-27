import { describe, it, expect, beforeEach } from "vitest";
import { SymbolIndex } from "../core/index/symbol-index.js";
import type { SymbolInfo } from "../core/types.js";

function makeSymbol(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    qualifiedName: "testFunc",
    kind: "function",
    filePath: "/project/src/test.ts",
    lines: [1, 5] as [number, number],
    signature: "function testFunc(): void",
    docs: null,
    code: "function testFunc() {}",
    ...overrides,
  };
}

describe("SymbolIndex", () => {
  let index: SymbolIndex;

  beforeEach(() => {
    index = new SymbolIndex();
  });

  it("inserts and looks up by exact name", () => {
    index.insert(makeSymbol({ qualifiedName: "greet" }));
    const result = index.lookupExact("greet");
    expect(result.length).toBe(1);
    expect(result[0].qualifiedName).toBe("greet");
  });

  it("returns empty for unknown name", () => {
    expect(index.lookupExact("nonexistent")).toEqual([]);
  });

  it("supports partial name lookup", () => {
    index.insert(makeSymbol({ qualifiedName: "UserService.authenticate" }));
    index.insert(makeSymbol({ qualifiedName: "UserService.register", lines: [10, 20] }));
    index.insert(makeSymbol({ qualifiedName: "AuthHelper.validate", lines: [30, 40] }));

    const results = index.lookupPartial("auth");
    expect(results.length).toBe(2);
  });

  it("looks up by file", () => {
    index.insert(makeSymbol({ qualifiedName: "a", filePath: "/src/a.ts" }));
    index.insert(makeSymbol({ qualifiedName: "b", filePath: "/src/a.ts", lines: [10, 20] }));
    index.insert(makeSymbol({ qualifiedName: "c", filePath: "/src/b.ts" }));

    const results = index.lookupByFile("/src/a.ts");
    expect(results.length).toBe(2);
  });

  it("removes all symbols for a file", () => {
    index.insert(makeSymbol({ qualifiedName: "a", filePath: "/src/a.ts" }));
    index.insert(makeSymbol({ qualifiedName: "b", filePath: "/src/a.ts", lines: [10, 20] }));
    index.insert(makeSymbol({ qualifiedName: "c", filePath: "/src/b.ts" }));

    index.removeByFile("/src/a.ts");
    expect(index.lookupByFile("/src/a.ts")).toEqual([]);
    expect(index.lookupExact("a")).toEqual([]);
    expect(index.size).toBe(1);
  });

  it("bulk insert replaces existing file symbols", () => {
    index.insert(makeSymbol({ qualifiedName: "old", filePath: "/src/a.ts" }));
    expect(index.size).toBe(1);

    index.bulkInsertForFile("/src/a.ts", [
      makeSymbol({ qualifiedName: "new1", filePath: "/src/a.ts" }),
      makeSymbol({ qualifiedName: "new2", filePath: "/src/a.ts", lines: [10, 20] }),
    ]);

    expect(index.lookupExact("old")).toEqual([]);
    expect(index.lookupExact("new1").length).toBe(1);
    expect(index.lookupExact("new2").length).toBe(1);
    expect(index.size).toBe(2);
  });

  it("handles same qualified name in different files", () => {
    index.insert(makeSymbol({ qualifiedName: "helper", filePath: "/src/a.ts" }));
    index.insert(makeSymbol({ qualifiedName: "helper", filePath: "/src/b.ts" }));

    const results = index.lookupExact("helper");
    expect(results.length).toBe(2);
    expect(index.size).toBe(2);
  });

  it("iterates all symbols", () => {
    index.insert(makeSymbol({ qualifiedName: "a" }));
    index.insert(makeSymbol({ qualifiedName: "b", lines: [10, 20] }));

    const all = [...index.allSymbols()];
    expect(all.length).toBe(2);
  });

  it("clears all data", () => {
    index.insert(makeSymbol({ qualifiedName: "a" }));
    index.insert(makeSymbol({ qualifiedName: "b", lines: [10, 20] }));
    index.clear();
    expect(index.size).toBe(0);
    expect(index.files).toEqual([]);
  });

  it("returns sorted symbols by line number", () => {
    index.insert(makeSymbol({ qualifiedName: "c", lines: [30, 40] }));
    index.insert(makeSymbol({ qualifiedName: "a", lines: [1, 5] }));
    index.insert(makeSymbol({ qualifiedName: "b", lines: [10, 20] }));

    const results = index.lookupByFile("/project/src/test.ts");
    expect(results[0].qualifiedName).toBe("a");
    expect(results[1].qualifiedName).toBe("b");
    expect(results[2].qualifiedName).toBe("c");
  });
});
