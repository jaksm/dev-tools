import { describe, it, expect, beforeAll } from "vitest";
import { TreeSitterEngine } from "../core/tree-sitter/engine.js";
import { FileParser } from "../core/tree-sitter/parser.js";
import { extractSymbols } from "../core/tree-sitter/extractor.js";
import { extractImports, extractExports } from "../core/tree-sitter/imports.js";

let engine: TreeSitterEngine;
let parser: FileParser;

beforeAll(async () => {
  engine = new TreeSitterEngine();
  await engine.init();
  parser = new FileParser(engine);
});

describe("TreeSitterEngine", () => {
  it("initializes WASM runtime", async () => {
    const e = new TreeSitterEngine();
    await e.init();
    expect(e.loadedGrammarCount).toBe(0);
  });

  it("maps file extensions to languages", () => {
    expect(TreeSitterEngine.languageForFile("foo.ts")).toBe("typescript");
    expect(TreeSitterEngine.languageForFile("foo.tsx")).toBe("tsx");
    expect(TreeSitterEngine.languageForFile("foo.js")).toBe("javascript");
    expect(TreeSitterEngine.languageForFile("foo.py")).toBe("python");
    expect(TreeSitterEngine.languageForFile("foo.swift")).toBe("swift");
    expect(TreeSitterEngine.languageForFile("foo.rs")).toBe("rust");
    expect(TreeSitterEngine.languageForFile("foo.go")).toBe("go");
    expect(TreeSitterEngine.languageForFile("foo.java")).toBe("java");
    expect(TreeSitterEngine.languageForFile("foo.unknown")).toBeNull();
  });

  it("loads TypeScript grammar", async () => {
    const lang = await engine.loadGrammar("typescript");
    expect(lang).not.toBeNull();
    expect(engine.isGrammarLoaded("typescript")).toBe(true);
  });

  it("loads JavaScript grammar", async () => {
    const lang = await engine.loadGrammar("javascript");
    expect(lang).not.toBeNull();
  });

  it("loads Python grammar", async () => {
    const lang = await engine.loadGrammar("python");
    expect(lang).not.toBeNull();
  });

  it("returns null for unknown grammar", async () => {
    const lang = await engine.loadGrammar("nonexistent_language");
    expect(lang).toBeNull();
  });

  it("creates parser with language", async () => {
    const p = await engine.createParser("typescript");
    expect(p).not.toBeNull();
  });

  it("caches loaded grammars", async () => {
    await engine.loadGrammar("typescript");
    await engine.loadGrammar("typescript");
    // Should load from cache — no error
    expect(engine.isGrammarLoaded("typescript")).toBe(true);
  });
});

describe("FileParser", () => {
  it("parses TypeScript source", async () => {
    const result = await parser.parseString("const x = 1;", "typescript");
    expect(result).not.toBeNull();
    expect(result!.rootNode.type).toBe("program");
  });

  it("parses JavaScript source", async () => {
    const result = await parser.parseString("function foo() {}", "javascript");
    expect(result).not.toBeNull();
  });

  it("caches parsed files by content hash", async () => {
    const result1 = await parser.parseFile("/tmp/test-cache.ts", "const a = 1;");
    const result2 = await parser.parseFile("/tmp/test-cache.ts", "const a = 1;");
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    // Same content = same tree (cached)
    expect(result1!.tree).toBe(result2!.tree);
  });

  it("invalidates cache", async () => {
    await parser.parseFile("/tmp/test-inv.ts", "const a = 1;");
    expect(parser.isCached("/tmp/test-inv.ts")).toBe(true);
    parser.invalidate("/tmp/test-inv.ts");
    expect(parser.isCached("/tmp/test-inv.ts")).toBe(false);
  });
});

describe("Symbol Extraction — TypeScript", () => {
  async function extractTS(code: string, filename = "test.ts") {
    const tree = await parser.parseString(code, "typescript");
    expect(tree).not.toBeNull();
    return extractSymbols(tree!, "typescript", filename, code);
  }

  it("extracts named function declarations", async () => {
    const symbols = await extractTS("function greet(name: string): string { return name; }");
    expect(symbols.length).toBeGreaterThanOrEqual(1);
    const fn = symbols.find(s => s.qualifiedName === "greet");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("extracts class declarations and methods", async () => {
    const code = `
class UserService {
  constructor(private db: Database) {}
  async authenticate(email: string): Promise<User> { return {} as User; }
  getById(id: string): User { return {} as User; }
}`;
    const symbols = await extractTS(code);
    const cls = symbols.find(s => s.qualifiedName === "UserService");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");

    const auth = symbols.find(s => s.qualifiedName === "UserService.authenticate");
    expect(auth).toBeDefined();
    expect(auth!.kind).toBe("method");

    const getById = symbols.find(s => s.qualifiedName === "UserService.getById");
    expect(getById).toBeDefined();
  });

  it("extracts interfaces", async () => {
    const symbols = await extractTS("interface IUser { name: string; email: string; }");
    const iface = symbols.find(s => s.qualifiedName === "IUser");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("interface");
  });

  it("extracts type aliases", async () => {
    const symbols = await extractTS("type UserId = string;");
    const t = symbols.find(s => s.qualifiedName === "UserId");
    expect(t).toBeDefined();
    expect(t!.kind).toBe("type");
  });

  it("extracts enums", async () => {
    const symbols = await extractTS("enum Role { Admin, User, Guest }");
    const e = symbols.find(s => s.qualifiedName === "Role");
    expect(e).toBeDefined();
    expect(e!.kind).toBe("enum");
  });

  it("extracts arrow functions assigned to const", async () => {
    const symbols = await extractTS("const handler = (req: Request) => { return res; };");
    const fn = symbols.find(s => s.qualifiedName === "handler");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("extracts function expressions assigned to const", async () => {
    const symbols = await extractTS("const handler = function(req: Request) { return res; };");
    const fn = symbols.find(s => s.qualifiedName === "handler");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("extracts HOC/factory patterns", async () => {
    const symbols = await extractTS("const Button = React.forwardRef((props, ref) => { return null; });");
    const fn = symbols.find(s => s.qualifiedName === "Button");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("extracts anonymous default exports as {filename}::default", async () => {
    const symbols = await extractTS("export default () => { return 42; };", "handler.ts");
    const def = symbols.find(s => s.qualifiedName === "handler::default");
    expect(def).toBeDefined();
  });

  it("extracts JSDoc comments", async () => {
    const code = `
/**
 * Authenticate user credentials
 */
function authenticate(email: string, password: string): boolean { return true; }`;
    const symbols = await extractTS(code);
    const fn = symbols.find(s => s.qualifiedName === "authenticate");
    expect(fn).toBeDefined();
    expect(fn!.docs).toContain("Authenticate user credentials");
  });

  it("extracts exported const variables", async () => {
    const symbols = await extractTS("export const API_URL = 'https://api.example.com';");
    const v = symbols.find(s => s.qualifiedName === "API_URL");
    expect(v).toBeDefined();
    expect(v!.kind).toBe("variable");
  });

  it("handles complex real-world file with multiple patterns", async () => {
    const code = `
import { Router } from 'express';

interface AuthConfig {
  secret: string;
  expiresIn: number;
}

type TokenPayload = { userId: string; role: string };

enum UserRole { Admin = 'admin', User = 'user' }

class AuthService {
  private config: AuthConfig;

  constructor(config: AuthConfig) {
    this.config = config;
  }

  async login(email: string, password: string): Promise<string> {
    return 'token';
  }

  verify(token: string): TokenPayload {
    return { userId: '1', role: 'admin' };
  }
}

const createMiddleware = (service: AuthService) => {
  return (req: any, res: any, next: any) => { next(); };
};

export const useAuth = () => {
  return { isAuthenticated: true };
};

export default AuthService;
`;
    const symbols = await extractTS(code, "auth.ts");
    const names = symbols.map(s => s.qualifiedName);

    expect(names).toContain("AuthConfig");
    expect(names).toContain("TokenPayload");
    expect(names).toContain("UserRole");
    expect(names).toContain("AuthService");
    expect(names).toContain("AuthService.login");
    expect(names).toContain("AuthService.verify");
    expect(names).toContain("createMiddleware");
    expect(names).toContain("useAuth");
  });
});

describe("Symbol Extraction — JavaScript", () => {
  async function extractJS(code: string, filename = "test.js") {
    const tree = await parser.parseString(code, "javascript");
    expect(tree).not.toBeNull();
    return extractSymbols(tree!, "javascript", filename, code);
  }

  it("extracts function declarations", async () => {
    const symbols = await extractJS("function greet(name) { return name; }");
    expect(symbols.find(s => s.qualifiedName === "greet")).toBeDefined();
  });

  it("extracts class declarations", async () => {
    const symbols = await extractJS("class Animal { speak() { return 'woof'; } }");
    expect(symbols.find(s => s.qualifiedName === "Animal")).toBeDefined();
    expect(symbols.find(s => s.qualifiedName === "Animal.speak")).toBeDefined();
  });
});

describe("Symbol Extraction — Python", () => {
  async function extractPy(code: string, filename = "test.py") {
    const tree = await parser.parseString(code, "python");
    expect(tree).not.toBeNull();
    return extractSymbols(tree!, "python", filename, code);
  }

  it("extracts function definitions", async () => {
    const symbols = await extractPy("def greet(name):\n    return name");
    const fn = symbols.find(s => s.qualifiedName === "greet");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("extracts class definitions", async () => {
    const symbols = await extractPy("class User:\n    pass");
    expect(symbols.find(s => s.qualifiedName === "User")).toBeDefined();
  });
});

describe("Import Extraction — TypeScript", () => {
  async function extractTSImports(code: string, filename = "/project/src/test.ts") {
    const tree = await parser.parseString(code, "typescript");
    expect(tree).not.toBeNull();
    return extractImports(tree!, "typescript", filename);
  }

  it("extracts named imports", async () => {
    const imports = await extractTSImports("import { Router, Request } from 'express';");
    expect(imports.length).toBe(1);
    expect(imports[0].source).toBe("express");
    expect(imports[0].isRelative).toBe(false);
    expect(imports[0].names).toContain("Router");
  });

  it("extracts relative imports", async () => {
    const imports = await extractTSImports("import { UserService } from './services/user';");
    expect(imports.length).toBe(1);
    expect(imports[0].isRelative).toBe(true);
    expect(imports[0].resolved).not.toBeNull();
  });

  it("extracts multiple imports", async () => {
    const code = `
import { Router } from 'express';
import { UserService } from './services/user';
import path from 'node:path';
`;
    const imports = await extractTSImports(code);
    expect(imports.length).toBe(3);
  });
});

describe("Export Extraction — TypeScript", () => {
  async function extractTSExports(code: string, filename = "/project/src/test.ts") {
    const tree = await parser.parseString(code, "typescript");
    expect(tree).not.toBeNull();
    return extractExports(tree!, "typescript", filename);
  }

  it("extracts named exports", async () => {
    const exports = await extractTSExports("export function greet() {}");
    expect(exports.length).toBeGreaterThanOrEqual(1);
    expect(exports.find(e => e.name === "greet")).toBeDefined();
  });

  it("extracts default exports", async () => {
    const exports = await extractTSExports("export default function greet() {}");
    expect(exports.length).toBeGreaterThanOrEqual(1);
    const def = exports.find(e => e.isDefault);
    expect(def).toBeDefined();
  });

  it("extracts const exports", async () => {
    const exports = await extractTSExports("export const API_URL = 'https://api.example.com';");
    expect(exports.find(e => e.name === "API_URL")).toBeDefined();
  });
});
