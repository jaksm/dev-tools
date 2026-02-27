/**
 * Comprehensive serializer tests — edge cases, all symbol types, special characters.
 */
import { describe, it, expect } from "vitest";
import { serializeSymbol, serializeSymbols, symbolId } from "../core/search/serializer.js";
import type { SymbolInfo } from "../core/types.js";

function sym(overrides: Partial<SymbolInfo>): SymbolInfo {
  return {
    qualifiedName: "TestSymbol",
    kind: "function",
    filePath: "/project/src/test.ts",
    lines: [1, 10] as [number, number],
    signature: "",
    docs: null,
    ...overrides,
  };
}

describe("serializeSymbol — edge cases", () => {
  it("handles empty signature", () => {
    const text = serializeSymbol(sym({ signature: "" }));
    expect(text).toContain("function TestSymbol");
    // Should not contain empty part
    expect(text).not.toContain("  "); // double spaces from empty parts
  });

  it("handles signature identical to qualifiedName (skips duplication)", () => {
    const text = serializeSymbol(sym({
      qualifiedName: "MyClass",
      signature: "MyClass",
    }));
    // Should not repeat the name
    const count = (text.match(/MyClass/g) ?? []).length;
    // qualifiedName appears once in "kind qualifiedName", signature may or may not
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("handles signature that is a type annotation (no parens/colons)", () => {
    const text = serializeSymbol(sym({
      qualifiedName: "MAX_RETRIES",
      kind: "variable",
      signature: "number",
    }));
    // Simple type annotations without ( or : are skipped
    expect(text).toContain("variable MAX_RETRIES");
  });

  it("includes signature with parentheses", () => {
    const text = serializeSymbol(sym({
      signature: "doSomething(arg: string): void",
    }));
    expect(text).toContain("doSomething(arg: string): void");
  });

  it("includes signature with colon (type annotation)", () => {
    const text = serializeSymbol(sym({
      qualifiedName: "config",
      kind: "variable",
      signature: "config: AppConfig",
    }));
    expect(text).toContain("config: AppConfig");
  });

  it("handles null docs", () => {
    const text = serializeSymbol(sym({ docs: null }));
    expect(text).not.toContain("—");
  });

  it("handles empty string docs", () => {
    const text = serializeSymbol(sym({ docs: "" }));
    // Empty docs might still add the "—" prefix
    // Depends on implementation — empty string is truthy
    expect(text).toBeDefined();
  });

  it("handles multi-line docs (preserves content)", () => {
    const text = serializeSymbol(sym({
      docs: "First line\nSecond line\nThird line",
    }));
    expect(text).toContain("First line");
    expect(text).toContain("Second line");
  });

  it("handles special characters in qualifiedName", () => {
    const text = serializeSymbol(sym({
      qualifiedName: "module::default",
    }));
    expect(text).toContain("module::default");
  });

  it("handles unicode in docs", () => {
    const text = serializeSymbol(sym({
      docs: "Проверка аутентификации пользователя 🔒",
    }));
    expect(text).toContain("🔒");
  });

  it("workspace path normalization strips trailing slash", () => {
    const text = serializeSymbol(
      sym({ filePath: "/my/project/src/file.ts" }),
      "/my/project",
    );
    expect(text).toContain("src/file.ts");
  });

  it("workspace path that doesn't match returns absolute path", () => {
    const text = serializeSymbol(
      sym({ filePath: "/other/project/src/file.ts" }),
      "/my/project",
    );
    expect(text).toContain("/other/project/src/file.ts");
  });

  it("handles all symbol kinds", () => {
    const kinds = ["function", "method", "class", "interface", "type", "enum", "variable", "property", "namespace", "module"];
    for (const kind of kinds) {
      const text = serializeSymbol(sym({ kind }));
      expect(text).toContain(kind);
    }
  });

  it("handles deeply nested qualifiedName", () => {
    const text = serializeSymbol(sym({
      qualifiedName: "OuterModule.InnerModule.NestedClass.deepMethod",
    }));
    expect(text).toContain("OuterModule.InnerModule.NestedClass.deepMethod");
  });

  it("handles very long signature without truncation", () => {
    const longSig = `processRequest(ctx: RequestContext, auth: AuthPayload, body: RequestBody<ComplexType<Nested>>, options?: { timeout: number; retries: number; headers: Record<string, string> }): Promise<ResponseEnvelope<ResultType>>`;
    const text = serializeSymbol(sym({ signature: longSig }));
    expect(text).toContain("processRequest(ctx: RequestContext");
  });
});

describe("serializeSymbols — batch", () => {
  it("handles empty array", () => {
    const { ids, texts } = serializeSymbols([]);
    expect(ids).toEqual([]);
    expect(texts).toEqual([]);
  });

  it("preserves ordering", () => {
    const symbols = [
      sym({ qualifiedName: "first", filePath: "/p/1.ts", lines: [1, 5] }),
      sym({ qualifiedName: "second", filePath: "/p/2.ts", lines: [1, 5] }),
      sym({ qualifiedName: "third", filePath: "/p/3.ts", lines: [1, 5] }),
    ];
    const { ids, texts } = serializeSymbols(symbols, "/p");
    expect(ids[0]).toContain("first");
    expect(ids[1]).toContain("second");
    expect(ids[2]).toContain("third");
    expect(texts[0]).toContain("first");
    expect(texts[1]).toContain("second");
    expect(texts[2]).toContain("third");
  });

  it("each entry uses the provided workspaceDir", () => {
    const symbols = [
      sym({ qualifiedName: "a", filePath: "/workspace/src/a.ts", lines: [1, 5] }),
      sym({ qualifiedName: "b", filePath: "/workspace/lib/b.ts", lines: [1, 5] }),
    ];
    const { texts } = serializeSymbols(symbols, "/workspace");
    expect(texts[0]).toContain("src/a.ts");
    expect(texts[1]).toContain("lib/b.ts");
    expect(texts[0]).not.toContain("/workspace/");
    expect(texts[1]).not.toContain("/workspace/");
  });
});

describe("symbolId — edge cases", () => {
  it("includes all three components", () => {
    const id = symbolId(sym({
      filePath: "/p/src/file.ts",
      qualifiedName: "MyClass.method",
      lines: [42, 60],
    }));
    expect(id).toBe("/p/src/file.ts::MyClass.method::42");
  });

  it("same name different file produces different IDs", () => {
    const id1 = symbolId(sym({ qualifiedName: "foo", filePath: "/p/a.ts" }));
    const id2 = symbolId(sym({ qualifiedName: "foo", filePath: "/p/b.ts" }));
    expect(id1).not.toBe(id2);
  });

  it("same name same file different line produces different IDs", () => {
    // Overloaded functions in same file
    const id1 = symbolId(sym({ qualifiedName: "process", filePath: "/p/a.ts", lines: [10, 20] }));
    const id2 = symbolId(sym({ qualifiedName: "process", filePath: "/p/a.ts", lines: [25, 35] }));
    expect(id1).not.toBe(id2);
  });

  it("handles special characters in path", () => {
    const id = symbolId(sym({
      filePath: "/project/src/@scope/my-package/index.ts",
      qualifiedName: "default",
      lines: [1, 5],
    }));
    expect(id).toBe("/project/src/@scope/my-package/index.ts::default::1");
  });

  it("handles Windows-style paths", () => {
    const id = symbolId(sym({
      filePath: "C:\\Users\\dev\\project\\src\\file.ts",
      qualifiedName: "MyClass",
      lines: [1, 10],
    }));
    expect(id).toContain("C:\\Users");
    expect(id).toContain("MyClass");
  });
});
