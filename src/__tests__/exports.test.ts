import { describe, it, expect, beforeAll } from "vitest";
import Parser from "web-tree-sitter";
import { TreeSitterEngine } from "../core/tree-sitter/engine.js";
import { extractExports } from "../core/tree-sitter/imports.js";

describe("extractExports", () => {
  let engine: TreeSitterEngine;

  beforeAll(async () => {
    engine = new TreeSitterEngine();
    await engine.init();
  });

  async function parseAndExtract(language: string, source: string) {
    const parser = await engine.createParser(language);
    if (!parser) throw new Error(`No parser for ${language}`);
    const tree = parser.parse(source);
    return extractExports(tree, language, "/test/file");
  }

  describe("Python", () => {
    it("extracts top-level functions and classes", async () => {
      const exports = await parseAndExtract("python", `
class MyClass:
    def method(self):
        pass

def top_level_func():
    pass

PUBLIC_CONST = 42
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("MyClass");
      expect(names).toContain("top_level_func");
      expect(names).toContain("PUBLIC_CONST");
    });

    it("excludes underscore-prefixed names", async () => {
      const exports = await parseAndExtract("python", `
def public_func(): pass
def _private_func(): pass
_internal = 1
PUBLIC = 2
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("public_func");
      expect(names).toContain("PUBLIC");
      expect(names).not.toContain("_private_func");
      expect(names).not.toContain("_internal");
    });

    it("extracts decorated definitions", async () => {
      const exports = await parseAndExtract("python", `
@decorator
def decorated_func(): pass

@app.route("/")
class DecoratedClass: pass
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("decorated_func");
      expect(names).toContain("DecoratedClass");
    });
  });

  describe("Go", () => {
    it("extracts uppercase (exported) declarations", async () => {
      const exports = await parseAndExtract("go", `
package main

func FetchAll() {}
func helper() {}
type User struct {}
type internal struct {}
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("FetchAll");
      expect(names).toContain("User");
      expect(names).not.toContain("helper");
      expect(names).not.toContain("internal");
    });

    it("extracts exported vars and consts", async () => {
      const exports = await parseAndExtract("go", `
package main
var GlobalConfig = 1
var localVar = 2
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("GlobalConfig");
      expect(names).not.toContain("localVar");
    });
  });

  describe("Rust", () => {
    it("extracts pub declarations only", async () => {
      const exports = await parseAndExtract("rust", `
pub fn public_fn() {}
fn private_fn() {}
pub struct User {}
struct Internal {}
pub enum Status { Active }
pub trait Repository {}
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("public_fn");
      expect(names).toContain("User");
      expect(names).toContain("Status");
      expect(names).toContain("Repository");
      expect(names).not.toContain("private_fn");
      expect(names).not.toContain("Internal");
    });

    it("extracts pub methods from impl blocks", async () => {
      const exports = await parseAndExtract("rust", `
struct Foo {}
impl Foo {
    pub fn public_method(&self) {}
    fn private_method(&self) {}
}
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("public_method");
      expect(names).not.toContain("private_method");
    });
  });

  describe("Swift", () => {
    it("extracts top-level declarations (default internal visibility)", async () => {
      const exports = await parseAndExtract("swift", `
struct Country {
    let id: Int
    func formatted() -> String { return "" }
}
class Service {
    func fetch() {}
}
protocol DataProvider {
    func load()
}
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("Country");
      expect(names).toContain("id");
      expect(names).toContain("formatted");
      expect(names).toContain("Service");
      expect(names).toContain("fetch");
      expect(names).toContain("DataProvider");
    });

    it("excludes private declarations", async () => {
      const exports = await parseAndExtract("swift", `
public class PublicClass {}
private class PrivateClass {}
struct DefaultStruct {
    private var secret: Int
    var visible: String
}
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("PublicClass");
      expect(names).toContain("DefaultStruct");
      expect(names).toContain("visible");
      expect(names).not.toContain("PrivateClass");
      expect(names).not.toContain("secret");
    });
  });

  describe("Java", () => {
    it("extracts public class and public methods", async () => {
      const exports = await parseAndExtract("java", `
public class UserService {
    public User getUser(String id) { return null; }
    private void internal() {}
}
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("UserService");
      expect(names).toContain("getUser");
      expect(names).not.toContain("internal");
    });

    it("skips non-public classes", async () => {
      const exports = await parseAndExtract("java", `
class PackagePrivate {
    public void method() {}
}
public class Public {}
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("Public");
      expect(names).not.toContain("PackagePrivate");
    });
  });

  describe("TypeScript (existing)", () => {
    it("extracts named exports", async () => {
      const exports = await parseAndExtract("typescript", `
export function helper() {}
export const VALUE = 1;
export class MyClass {}
export interface MyInterface {}
export type MyType = string;
`);
      const names = exports.map(e => e.name);
      expect(names).toContain("helper");
      expect(names).toContain("VALUE");
      expect(names).toContain("MyClass");
      expect(names).toContain("MyInterface");
      expect(names).toContain("MyType");
    });
  });
});
