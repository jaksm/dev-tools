import { describe, it, expect, beforeEach } from "vitest";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { resolveSymbol } from "../core/index/resolver.js";
import type { SymbolInfo } from "../core/types.js";

function makeSymbol(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    qualifiedName: "testFunc",
    kind: "function",
    filePath: "/project/src/test.ts",
    lines: [1, 5] as [number, number],
    signature: "function testFunc(): void",
    docs: null,
    ...overrides,
  };
}

describe("resolveSymbol", () => {
  let index: SymbolIndex;

  beforeEach(() => {
    index = new SymbolIndex();
    index.insert(makeSymbol({ qualifiedName: "UserService", kind: "class", filePath: "/project/src/user.ts", lines: [1, 100] }));
    index.insert(makeSymbol({ qualifiedName: "UserService.authenticate", kind: "method", filePath: "/project/src/user.ts", lines: [10, 30] }));
    index.insert(makeSymbol({ qualifiedName: "UserService.register", kind: "method", filePath: "/project/src/user.ts", lines: [35, 60] }));
    index.insert(makeSymbol({ qualifiedName: "helper", kind: "function", filePath: "/project/src/utils.ts", lines: [1, 10] }));
    index.insert(makeSymbol({ qualifiedName: "helper", kind: "function", filePath: "/project/src/other.ts", lines: [1, 5] }));
  });

  it("resolves exact qualified name", () => {
    const result = resolveSymbol({ symbol: "UserService.authenticate" }, index);
    expect(result.symbols.length).toBe(1);
    expect(result.ambiguous).toBe(false);
  });

  it("resolves with file hint", () => {
    const result = resolveSymbol({ symbol: "helper", file: "/project/src/utils.ts" }, index);
    expect(result.symbols.length).toBe(1);
    expect(result.symbols[0].filePath).toBe("/project/src/utils.ts");
  });

  it("flags ambiguous results", () => {
    const result = resolveSymbol({ symbol: "helper" }, index);
    expect(result.symbols.length).toBe(2);
    expect(result.ambiguous).toBe(true);
  });

  it("resolves with scope", () => {
    const result = resolveSymbol({ symbol: "authenticate", scope: "UserService" }, index);
    expect(result.symbols.length).toBe(1);
    expect(result.symbols[0].qualifiedName).toBe("UserService.authenticate");
  });

  it("resolves by file and line", () => {
    const result = resolveSymbol({ file: "/project/src/user.ts", line: 15 }, index);
    expect(result.symbols.length).toBe(1);
    expect(result.symbols[0].qualifiedName).toBe("UserService.authenticate");
  });

  it("returns empty for no match", () => {
    const result = resolveSymbol({ symbol: "nonexistent" }, index);
    expect(result.symbols.length).toBe(0);
  });
});
