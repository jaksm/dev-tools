import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { TreeSitterEngine } from "../core/tree-sitter/engine.js";
import { FileParser } from "../core/tree-sitter/parser.js";
import { extractSymbols } from "../core/tree-sitter/extractor.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { codeRead } from "../tools/code-read.js";
import type { ToolContext } from "../core/types.js";

let engine: TreeSitterEngine;
let parser: FileParser;
let symbolIndex: SymbolIndex;

const WORKSPACE = "/tmp/test-code-read";
const TEST_FILE = `${WORKSPACE}/src/auth.ts`;

const TEST_CODE = `import { hash } from 'bcrypt';
import { sign } from 'jsonwebtoken';

class AuthService {
  private secret: string;
  private db: any;

  constructor(secret: string, db: any) {
    this.secret = secret;
    this.db = db;
  }

  async login(email: string, password: string): Promise<string> {
    const user = this.db.findByEmail(email);
    const valid = this.validatePassword(password, user.hash);
    if (!valid) throw new Error('Invalid');
    return this.generateToken(user.id);
  }

  private validatePassword(password: string, hash: string): boolean {
    return password === hash;
  }

  private generateToken(userId: string): string {
    return sign({ userId }, this.secret);
  }
}

const helper = (x: number) => x * 2;

export default AuthService;
`;

function makeCtx(): ToolContext {
  return {
    workspaceDir: WORKSPACE,
    storageDir: "/tmp/test-code-read-storage",
    config: {},
    workspace: {
      root: WORKSPACE,
      hasGit: false,
      languages: [],
      testRunners: [],
      gitignoreFilter: () => false,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

beforeAll(async () => {
  engine = new TreeSitterEngine();
  await engine.init();
  parser = new FileParser(engine);
  symbolIndex = new SymbolIndex();

  // Write test file to disk so code_read can read it
  await fs.mkdir(path.dirname(TEST_FILE), { recursive: true });
  await fs.writeFile(TEST_FILE, TEST_CODE, "utf-8");

  // Index it
  const tree = await parser.parseString(TEST_CODE, "typescript");
  if (tree) {
    const symbols = extractSymbols(tree, "typescript", TEST_FILE, TEST_CODE);
    symbolIndex.bulkInsertForFile(TEST_FILE, symbols);
  }
});

describe("codeRead", () => {
  it("reads a symbol by qualified name", async () => {
    const result = await codeRead(
      { symbol: "AuthService.login" },
      makeCtx(),
      symbolIndex,
    );
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.code).toContain("async login");
    expect(result.data!.code).toContain("findByEmail");
    expect(result.data!.language).toBe("typescript");
  });

  it("reads a class by name", async () => {
    const result = await codeRead(
      { symbol: "AuthService" },
      makeCtx(),
      symbolIndex,
    );
    expect(result.success).toBe(true);
    expect(result.data!.code).toContain("class AuthService");
  });

  it("reads standalone function", async () => {
    const result = await codeRead(
      { symbol: "helper" },
      makeCtx(),
      symbolIndex,
    );
    expect(result.success).toBe(true);
    expect(result.data!.code).toContain("helper");
  });

  it("returns error for non-existent symbol", async () => {
    const result = await codeRead(
      { symbol: "NonExistent" },
      makeCtx(),
      symbolIndex,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns siblings context", async () => {
    const result = await codeRead(
      { symbol: "AuthService.login", context: "siblings" },
      makeCtx(),
      symbolIndex,
    );
    expect(result.success).toBe(true);
    expect(result.data!.siblings).toBeDefined();
    expect(result.data!.siblings!.length).toBeGreaterThan(0);
  });

  it("returns class context", async () => {
    const result = await codeRead(
      { symbol: "AuthService.login", context: "class" },
      makeCtx(),
      symbolIndex,
    );
    expect(result.success).toBe(true);
    expect(result.data!.classOutline).toBeDefined();
    expect(result.data!.classOutline!.length).toBeGreaterThan(1);

    // The target method should be marked as expanded
    const loginEntry = result.data!.classOutline!.find(s => s.name === "AuthService.login");
    expect(loginEntry?.expanded).toBe(true);
  });

  it("returns dependencies context with this.xxx references", async () => {
    const result = await codeRead(
      { symbol: "AuthService.login", context: "dependencies" },
      makeCtx(),
      symbolIndex,
    );
    expect(result.success).toBe(true);
    expect(result.data!.dependencies).toBeDefined();
    expect(result.data!.dependencies!.length).toBeGreaterThan(0);

    const depNames = result.data!.dependencies!.map(d => d.symbol);
    expect(depNames).toContain("AuthService.validatePassword");
    expect(depNames).toContain("AuthService.generateToken");
  });

  it("includes file imports", async () => {
    const result = await codeRead(
      { symbol: "AuthService.login" },
      makeCtx(),
      symbolIndex,
    );
    expect(result.success).toBe(true);
    expect(result.data!.imports).toBeDefined();
    expect(result.data!.imports.length).toBeGreaterThan(0);
  });
});
