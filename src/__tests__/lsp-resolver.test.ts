import { describe, it, expect, beforeEach } from "vitest";
import { SymbolIndex } from "../core/index/symbol-index.js";
import {
  LspResolver,
  extractShortName,
  findIdentifierInLine,
  searchNearby,
  findSymbolDeclaration,
} from "../core/lsp/resolver.js";
import type { SymbolInfo } from "../core/types.js";
import { pathToFileURL } from "node:url";

// ── Helpers ─────────────────────────────────────────────────────────────────

function sym(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
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

// ── Unit Tests: extractShortName ────────────────────────────────────────────

describe("extractShortName", () => {
  it("extracts from simple name", () => {
    expect(extractShortName("helper")).toBe("helper");
  });

  it("extracts from qualified name", () => {
    expect(extractShortName("UserService.authenticate")).toBe("authenticate");
  });

  it("extracts from deeply nested name", () => {
    expect(extractShortName("Namespace.Class.method")).toBe("method");
  });

  it("handles empty string", () => {
    expect(extractShortName("")).toBe("");
  });

  it("handles single dot", () => {
    expect(extractShortName(".method")).toBe("method");
  });
});

// ── Unit Tests: findIdentifierInLine ────────────────────────────────────────

describe("findIdentifierInLine", () => {
  it("finds identifier at start of line", () => {
    expect(findIdentifierInLine("function hello() {", "function")).toBe(0);
  });

  it("finds identifier in the middle", () => {
    expect(findIdentifierInLine("  function authenticate() {", "authenticate")).toBe(11);
  });

  it("returns -1 for no match", () => {
    expect(findIdentifierInLine("function hello() {", "goodbye")).toBe(-1);
  });

  it("uses word boundaries (no partial match)", () => {
    expect(findIdentifierInLine("const isAuthenticated = true", "auth")).toBe(-1);
  });

  it("matches word at end of line", () => {
    expect(findIdentifierInLine("export default helper", "helper")).toBe(15);
  });

  it("handles empty identifier", () => {
    expect(findIdentifierInLine("some code", "")).toBe(-1);
  });

  it("handles empty line", () => {
    expect(findIdentifierInLine("", "test")).toBe(-1);
  });

  it("handles regex special chars in identifier", () => {
    // Unlikely but defensive
    expect(findIdentifierInLine("const $value = 1", "$value")).toBe(6);
  });

  it("finds first occurrence when multiple exist", () => {
    expect(findIdentifierInLine("foo = foo + foo", "foo")).toBe(0);
  });
});

// ── Unit Tests: searchNearby ────────────────────────────────────────────────

describe("searchNearby", () => {
  const lines = [
    "// line 0",           // 0
    "function hello() {",  // 1
    "  return 42;",        // 2
    "}",                   // 3
    "",                    // 4
    "function target() {", // 5
    "  return 99;",        // 6
    "}",                   // 7
  ];

  it("finds identifier one line below", () => {
    const result = searchNearby(lines, 4, "target", 3);
    expect(result).toEqual({ line: 5, character: 9 });
  });

  it("finds identifier one line above", () => {
    const result = searchNearby(lines, 2, "hello", 3);
    expect(result).toEqual({ line: 1, character: 9 });
  });

  it("returns null when not within radius", () => {
    const result = searchNearby(lines, 0, "target", 2);
    expect(result).toBeNull();
  });

  it("prefers closer lines", () => {
    // "return" exists on lines 2 and 6. Center is 4, radius 5.
    // Offset 2 checked first: line 2 (above) and line 6 (below).
    // Line 2 is checked before line 6 because direction -1 is checked first.
    const result = searchNearby(lines, 4, "return", 5);
    expect(result).toEqual({ line: 2, character: 2 });
  });

  it("handles center at 0", () => {
    const result = searchNearby(lines, 0, "hello", 5);
    expect(result).toEqual({ line: 1, character: 9 });
  });

  it("handles center at end", () => {
    const result = searchNearby(lines, 7, "target", 5);
    expect(result).toEqual({ line: 5, character: 9 });
  });

  it("returns null for empty lines array", () => {
    const result = searchNearby([], 0, "test", 5);
    expect(result).toBeNull();
  });
});

// ── Unit Tests: findSymbolDeclaration ───────────────────────────────────────

describe("findSymbolDeclaration", () => {
  it("finds function declaration", () => {
    const lines = [
      "import { something } from 'lib';",
      "",
      "export function authenticate(user: User) {",
      "  return user.isValid;",
      "}",
    ];
    const result = findSymbolDeclaration(lines, "authenticate", "function");
    expect(result).toEqual({ line: 2, character: 16 });
  });

  it("finds class declaration", () => {
    const lines = [
      "import stuff from 'lib';",
      "",
      "export class UserService {",
      "  constructor() {}",
      "}",
    ];
    const result = findSymbolDeclaration(lines, "UserService", "class");
    expect(result).toEqual({ line: 2, character: 13 });
  });

  it("finds const function (arrow)", () => {
    const lines = [
      "const helper = () => {",
      "  return 42;",
      "};",
    ];
    const result = findSymbolDeclaration(lines, "helper", "function");
    expect(result).toEqual({ line: 0, character: 6 });
  });

  it("finds interface declaration", () => {
    const lines = [
      "export interface Config {",
      "  debug: boolean;",
      "}",
    ];
    const result = findSymbolDeclaration(lines, "Config", "interface");
    expect(result).toEqual({ line: 0, character: 17 });
  });

  it("finds type alias", () => {
    const lines = [
      "export type UserId = string;",
    ];
    const result = findSymbolDeclaration(lines, "UserId", "type");
    expect(result).toEqual({ line: 0, character: 12 });
  });

  it("finds enum declaration", () => {
    const lines = [
      "enum Status {",
      "  Active,",
      "  Inactive,",
      "}",
    ];
    const result = findSymbolDeclaration(lines, "Status", "enum");
    expect(result).toEqual({ line: 0, character: 5 });
  });

  it("finds Python function (def)", () => {
    const lines = [
      "def process_data(input):",
      "    return input * 2",
    ];
    const result = findSymbolDeclaration(lines, "process_data", "function");
    expect(result).toEqual({ line: 0, character: 4 });
  });

  it("finds Rust function (fn)", () => {
    const lines = [
      "pub fn calculate(x: i32) -> i32 {",
      "    x * 2",
      "}",
    ];
    const result = findSymbolDeclaration(lines, "calculate", "function");
    expect(result).toEqual({ line: 0, character: 7 });
  });

  it("finds Go function (func)", () => {
    const lines = [
      "func handleRequest(w http.ResponseWriter, r *http.Request) {",
      "    // ...",
      "}",
    ];
    const result = findSymbolDeclaration(lines, "handleRequest", "function");
    expect(result).toEqual({ line: 0, character: 5 });
  });

  it("prefers declaration over usage", () => {
    const lines = [
      "const x = helper();",       // usage
      "console.log(helper);",      // usage
      "function helper() {",       // declaration
      "  return 42;",
      "}",
    ];
    const result = findSymbolDeclaration(lines, "helper", "function");
    expect(result).toEqual({ line: 2, character: 9 });
  });

  it("falls back to any occurrence if no declaration pattern matches", () => {
    const lines = [
      "// This calls someObscureThing",
      "doSomething(someObscureThing);",
    ];
    const result = findSymbolDeclaration(lines, "someObscureThing", "variable");
    // "variable" patterns: "someObscureThing =" doesn't appear anywhere,
    // but "someObscureThing" on its own triggers the `name =` pattern match... no.
    // Actually the first pass checks declaration patterns. The variable patterns include
    // `\b${name}\s*=` which won't match. Falls back to second pass: first occurrence.
    // "someObscureThing" appears first in the comment on line 0 at char 14.
    expect(result).toEqual({ line: 0, character: 14 });
  });

  it("returns null when symbol not in file", () => {
    const lines = [
      "function other() {}",
    ];
    const result = findSymbolDeclaration(lines, "missing", "function");
    expect(result).toBeNull();
  });

  it("finds struct (class kind)", () => {
    const lines = [
      "pub struct Config {",
      "    debug: bool,",
      "}",
    ];
    const result = findSymbolDeclaration(lines, "Config", "class");
    expect(result).toEqual({ line: 0, character: 11 });
  });

  it("finds method declaration", () => {
    const lines = [
      "class Service {",
      "  async authenticate(user: User) {",
      "    return true;",
      "  }",
      "}",
    ];
    const result = findSymbolDeclaration(lines, "authenticate", "method");
    expect(result).toEqual({ line: 1, character: 8 });
  });

  it("finds property", () => {
    const lines = [
      "class Config {",
      "  readonly debug: boolean = false;",
      "}",
    ];
    const result = findSymbolDeclaration(lines, "debug", "property");
    expect(result).toEqual({ line: 1, character: 11 });
  });
});

// ── Integration Tests: LspResolver ──────────────────────────────────────────

describe("LspResolver", () => {
  let index: SymbolIndex;
  let resolver: LspResolver;
  const workspaceRoot = "/project";

  const mockFiles = new Map<string, string>();

  const mockReadFile = async (filePath: string): Promise<string> => {
    const content = mockFiles.get(filePath);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }
    return content;
  };

  beforeEach(() => {
    index = new SymbolIndex();
    resolver = new LspResolver({ symbolIndex: index, workspaceRoot, readFile: mockReadFile });
    mockFiles.clear();

    // Default file content matching the symbols
    mockFiles.set("/project/src/user.ts", [
      "import { DB } from './db';",                    // line 1
      "",                                              // line 2
      "export class UserService {",                    // line 3
      "  private db: DB;",                             // line 4
      "",                                              // line 5
      "  constructor(db: DB) {",                       // line 6
      "    this.db = db;",                             // line 7
      "  }",                                           // line 8
      "",                                              // line 9
      "  async authenticate(user: string) {",          // line 10
      "    return this.db.check(user);",               // line 11
      "  }",                                           // line 12
      "",                                              // line 13
      "  async register(user: string) {",              // line 14
      "    return this.db.create(user);",              // line 15
      "  }",                                           // line 16
      "}",                                             // line 17
    ].join("\n"));

    mockFiles.set("/project/src/utils.ts", [
      "export function helper() {",                    // line 1
      "  return 42;",                                  // line 2
      "}",                                             // line 3
    ].join("\n"));

    // Populate index
    index.insert(sym({
      qualifiedName: "UserService",
      kind: "class",
      filePath: "/project/src/user.ts",
      lines: [3, 17],
      signature: "class UserService",
    }));
    index.insert(sym({
      qualifiedName: "UserService.authenticate",
      kind: "method",
      filePath: "/project/src/user.ts",
      lines: [10, 12],
      signature: "async authenticate(user: string)",
    }));
    index.insert(sym({
      qualifiedName: "UserService.register",
      kind: "method",
      filePath: "/project/src/user.ts",
      lines: [14, 16],
      signature: "async register(user: string)",
    }));
    index.insert(sym({
      qualifiedName: "helper",
      kind: "function",
      filePath: "/project/src/utils.ts",
      lines: [1, 3],
      signature: "function helper()",
    }));

  });

  it("resolves qualified name to position", async () => {
    const result = await resolver.resolve({ symbol: "UserService.authenticate" });
    expect(result.position).not.toBeNull();
    expect(result.position!.line).toBe(9); // 0-indexed: line 10 → 9
    expect(result.position!.character).toBe(8); // "  async authenticate" → col 8
    expect(result.position!.filePath).toBe("/project/src/user.ts");
    expect(result.position!.uri).toBe(pathToFileURL("/project/src/user.ts").toString());
    expect(result.position!.drifted).toBe(false);
    expect(result.ambiguous).toBe(false);
  });

  it("resolves class name to position", async () => {
    const result = await resolver.resolve({ symbol: "UserService" });
    expect(result.position).not.toBeNull();
    expect(result.position!.line).toBe(2); // line 3 → 0-indexed: 2
    expect(result.position!.character).toBe(13); // "export class UserService"
    expect(result.position!.drifted).toBe(false);
  });

  it("resolves simple function name", async () => {
    const result = await resolver.resolve({ symbol: "helper" });
    expect(result.position).not.toBeNull();
    expect(result.position!.line).toBe(0);
    expect(result.position!.character).toBe(16); // "export function helper"
    expect(result.position!.filePath).toBe("/project/src/utils.ts");
  });

  it("resolves with file hint", async () => {
    const result = await resolver.resolve({ symbol: "helper", file: "/project/src/utils.ts" });
    expect(result.position).not.toBeNull();
    expect(result.position!.filePath).toBe("/project/src/utils.ts");
  });

  it("resolves with scope", async () => {
    const result = await resolver.resolve({ symbol: "register", scope: "UserService" });
    expect(result.position).not.toBeNull();
    expect(result.position!.line).toBe(13); // line 14 → 0-indexed: 13
  });

  it("resolves by file and line", async () => {
    const result = await resolver.resolve({ file: "/project/src/user.ts", line: 11 });
    expect(result.position).not.toBeNull();
    expect(result.position!.symbol.qualifiedName).toBe("UserService.authenticate");
  });

  it("returns error for nonexistent symbol", async () => {
    const result = await resolver.resolve({ symbol: "nonexistent" });
    expect(result.position).toBeNull();
    expect(result.error).toContain("No symbol found");
  });

  it("returns error when file doesn't exist", async () => {
    index.insert(sym({
      qualifiedName: "ghost",
      kind: "function",
      filePath: "/project/src/ghost.ts",
      lines: [1, 3],
    }));
    const result = await resolver.resolve({ symbol: "ghost" });
    expect(result.position).toBeNull();
    expect(result.error).toContain("Could not resolve position");
  });

  it("handles position drift (symbol moved down)", async () => {
    // The index says "authenticate" starts at line 10, but the file was edited
    // and it's now at line 12
    mockFiles.set("/project/src/user.ts", [
      "import { DB } from './db';",
      "",
      "// Added comment 1",              // new line
      "// Added comment 2",              // new line
      "export class UserService {",
      "  private db: DB;",
      "",
      "  constructor(db: DB) {",
      "    this.db = db;",
      "  }",
      "",
      "  async authenticate(user: string) {",  // now line 12 (was 10)
      "    return this.db.check(user);",
      "  }",
      "}",
    ].join("\n"));

    const result = await resolver.resolve({ symbol: "UserService.authenticate" });
    expect(result.position).not.toBeNull();
    expect(result.position!.line).toBe(11); // 0-indexed line 12
    expect(result.position!.character).toBe(8);
    expect(result.position!.drifted).toBe(true);
  });

  it("handles position drift (symbol moved up)", async () => {
    // Index says "authenticate" starts at line 10, but file was simplified
    mockFiles.set("/project/src/user.ts", [
      "export class UserService {",
      "  async authenticate(user: string) {",  // now line 2 (was 10)
      "    return true;",
      "  }",
      "}",
    ].join("\n"));

    const result = await resolver.resolve({ symbol: "UserService.authenticate" });
    expect(result.position).not.toBeNull();
    expect(result.position!.line).toBe(1); // 0-indexed
    expect(result.position!.drifted).toBe(true);
  });

  it("reports ambiguous symbols", async () => {
    // Add a duplicate "helper" in another file
    index.insert(sym({
      qualifiedName: "helper",
      kind: "function",
      filePath: "/project/src/other.ts",
      lines: [1, 3],
    }));
    mockFiles.set("/project/src/other.ts", "function helper() { return 99; }");

    const result = await resolver.resolve({ symbol: "helper" });
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.length).toBe(2);
    // Should still resolve the first one
    expect(result.position).not.toBeNull();
  });

  it("symbolToPosition works directly", async () => {
    const symbol = index.lookupExact("UserService.authenticate")[0];
    const pos = await resolver.symbolToPosition(symbol);
    expect(pos).not.toBeNull();
    expect(pos!.line).toBe(9);
    expect(pos!.character).toBe(8);
    expect(pos!.symbol).toBe(symbol);
  });

  it("resolveMany resolves batch", async () => {
    const results = await resolver.resolveMany([
      { symbol: "UserService" },
      { symbol: "helper" },
      { symbol: "nonexistent" },
    ]);
    expect(results.length).toBe(3);
    expect(results[0].position).not.toBeNull();
    expect(results[1].position).not.toBeNull();
    expect(results[2].position).toBeNull();
  });

  it("handles relative file paths in symbols", async () => {
    mockFiles.set("/project/src/relative.ts", [
      "export function relativeFunc() {",
      "  return true;",
      "}",
    ].join("\n"));

    index.insert(sym({
      qualifiedName: "relativeFunc",
      kind: "function",
      filePath: "src/relative.ts", // relative
      lines: [1, 3],
    }));

    // The resolver should resolve against workspaceRoot
    const result = await resolver.resolve({ symbol: "relativeFunc" });
    expect(result.position).not.toBeNull();
    expect(result.position!.filePath).toBe("/project/src/relative.ts");
  });

  it("full-file scan finds declaration when drift radius exceeded", async () => {
    // Symbol was at line 10 in index, but file is totally different now
    mockFiles.set("/project/src/user.ts", [
      "// lots of stuff",
      "// more stuff",
      "// even more",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "// padding",
      "async authenticate(user: string) {",  // line 26 — way beyond ±10 drift
      "  return true;",
      "}",
    ].join("\n"));

    const result = await resolver.resolve({ symbol: "UserService.authenticate" });
    expect(result.position).not.toBeNull();
    expect(result.position!.line).toBe(25); // 0-indexed
    expect(result.position!.drifted).toBe(true);
  });
});
