/**
 * Tests for symbol-to-text serializer.
 */
import { describe, it, expect } from "vitest";
import { serializeSymbol, serializeSymbols, symbolId } from "../core/search/serializer.js";
import type { SymbolInfo } from "../core/types.js";

const makeSymbol = (partial: Partial<SymbolInfo> & { qualifiedName: string }): SymbolInfo => ({
  kind: "function",
  filePath: "/project/src/auth/service.ts",
  lines: [10, 30] as [number, number],
  signature: "",
  docs: null,
  ...partial,
});

describe("serializeSymbol", () => {
  it("includes kind and qualified name", () => {
    const sym = makeSymbol({ qualifiedName: "AuthService.login" });
    const text = serializeSymbol(sym);
    expect(text).toContain("function");
    expect(text).toContain("AuthService.login");
  });

  it("includes signature when present", () => {
    const sym = makeSymbol({
      qualifiedName: "AuthService.login",
      signature: "login(email: string, password: string): Promise<User>",
    });
    const text = serializeSymbol(sym);
    expect(text).toContain("login(email: string, password: string): Promise<User>");
  });

  it("includes docs when present", () => {
    const sym = makeSymbol({
      qualifiedName: "AuthService.login",
      docs: "Authenticate a user with email and password",
    });
    const text = serializeSymbol(sym);
    expect(text).toContain("Authenticate a user with email and password");
  });

  it("includes relative file path when workspaceDir provided", () => {
    const sym = makeSymbol({
      qualifiedName: "AuthService.login",
      filePath: "/project/src/auth/service.ts",
    });
    const text = serializeSymbol(sym, "/project");
    expect(text).toContain("src/auth/service.ts");
    expect(text).not.toContain("/project/src/auth/service.ts");
  });

  it("includes absolute path when no workspaceDir", () => {
    const sym = makeSymbol({
      qualifiedName: "AuthService.login",
      filePath: "/project/src/auth/service.ts",
    });
    const text = serializeSymbol(sym);
    expect(text).toContain("/project/src/auth/service.ts");
  });

  it("produces a comprehensive string for a full symbol", () => {
    const sym = makeSymbol({
      qualifiedName: "UserService.authenticate",
      kind: "method",
      signature: "authenticate(email: string, password: string): Promise<User>",
      docs: "Verify credentials and return JWT token",
      filePath: "/project/src/services/user.ts",
    });
    const text = serializeSymbol(sym, "/project");
    expect(text).toContain("method");
    expect(text).toContain("UserService.authenticate");
    expect(text).toContain("authenticate(email: string, password: string): Promise<User>");
    expect(text).toContain("Verify credentials and return JWT token");
    expect(text).toContain("src/services/user.ts");
  });
});

describe("serializeSymbols", () => {
  it("returns parallel ids and texts arrays", () => {
    const symbols = [
      makeSymbol({ qualifiedName: "foo", filePath: "/p/a.ts", lines: [1, 5] }),
      makeSymbol({ qualifiedName: "bar", filePath: "/p/b.ts", lines: [10, 20] }),
    ];
    const { ids, texts } = serializeSymbols(symbols, "/p");
    expect(ids).toHaveLength(2);
    expect(texts).toHaveLength(2);
    expect(ids[0]).toContain("foo");
    expect(ids[1]).toContain("bar");
    expect(texts[0]).toContain("foo");
    expect(texts[1]).toContain("bar");
  });
});

describe("symbolId", () => {
  it("generates stable ID from filePath + qualifiedName + line", () => {
    const sym = makeSymbol({
      qualifiedName: "MyClass.method",
      filePath: "/project/src/file.ts",
      lines: [42, 60],
    });
    const id = symbolId(sym);
    expect(id).toBe("/project/src/file.ts::MyClass.method::42");
  });

  it("different lines produce different IDs", () => {
    const sym1 = makeSymbol({ qualifiedName: "foo", lines: [1, 5] });
    const sym2 = makeSymbol({ qualifiedName: "foo", lines: [10, 15] });
    expect(symbolId(sym1)).not.toBe(symbolId(sym2));
  });
});
