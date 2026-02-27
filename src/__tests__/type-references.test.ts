import { describe, it, expect, beforeAll } from "vitest";
import Parser from "web-tree-sitter";
import { TreeSitterEngine } from "../core/tree-sitter/engine.js";
import { extractTypeReferences } from "../core/tree-sitter/references.js";

describe("extractTypeReferences", () => {
  let engine: TreeSitterEngine;

  beforeAll(async () => {
    engine = new TreeSitterEngine();
    await engine.init();
  });

  async function parseAndExtract(language: string, source: string): Promise<string[]> {
    const parser = await engine.createParser(language);
    if (!parser) throw new Error(`No parser for ${language}`);
    const tree = parser.parse(source);
    return extractTypeReferences(tree, language);
  }

  describe("Swift", () => {
    it("extracts type references from struct fields and functions", async () => {
      const refs = await parseAndExtract("swift", `
        struct ViewModel {
          let user: User
          let items: [TaskItem]
          func save(_ item: TaskItem) -> Result<Bool, AppError> {}
        }
      `);

      expect(refs).toContain("User");
      expect(refs).toContain("TaskItem");
      expect(refs).toContain("AppError");
      expect(refs).toContain("Result");
      expect(refs).toContain("Bool");
    });

    it("extracts inheritance references", async () => {
      const refs = await parseAndExtract("swift", `
        class Service: ObservableObject {
          @Published var state: LoadingState
        }
      `);

      expect(refs).toContain("ObservableObject");
      expect(refs).toContain("LoadingState");
    });

    it("returns deduplicated results", async () => {
      const refs = await parseAndExtract("swift", `
        struct X {
          let a: User
          let b: User
          func get() -> User {}
        }
      `);

      const userCount = refs.filter(r => r === "User").length;
      expect(userCount).toBe(1);
    });
  });

  describe("TypeScript", () => {
    it("extracts type references from annotations and generics", async () => {
      const refs = await parseAndExtract("typescript", `
        interface Config { timeout: number; }
        class Service {
          private cache: Map<string, User>;
          async getUser(id: string): Promise<User> { return {} as User; }
        }
        type Result<T> = { data: T; error: AppError | null };
      `);

      expect(refs).toContain("Config");
      expect(refs).toContain("Map");
      expect(refs).toContain("User");
      expect(refs).toContain("Promise");
      expect(refs).toContain("AppError");
      expect(refs).toContain("Result");
    });
  });

  describe("Go", () => {
    it("extracts type references from struct fields and signatures", async () => {
      const refs = await parseAndExtract("go", `
        package main
        type Service struct {
          cache map[string]User
        }
        func (s *Service) GetUser(id string) (*User, error) {
          return nil, nil
        }
      `);

      expect(refs).toContain("User");
      expect(refs).toContain("Service");
    });
  });

  describe("Rust", () => {
    it("extracts type references from struct fields and impl blocks", async () => {
      const refs = await parseAndExtract("rust", `
        struct Service { cache: HashMap<String, User> }
        impl Service {
          fn get_user(&self, id: &str) -> Option<User> { None }
        }
        trait Repository { fn get_all(&self) -> Vec<User>; }
      `);

      expect(refs).toContain("HashMap");
      expect(refs).toContain("User");
      expect(refs).toContain("Option");
      expect(refs).toContain("Vec");
      expect(refs).toContain("Service");
      expect(refs).toContain("Repository");
    });
  });

  describe("Python", () => {
    it("extracts type references from annotations", async () => {
      const refs = await parseAndExtract("python", `
class UserService:
    cache: dict[str, User]
    
    def get_user(self, id: str) -> Optional[User]:
        return None
      `);

      expect(refs).toContain("User");
      expect(refs).toContain("str");
    });
  });

  describe("Java", () => {
    it("extracts type references from fields and methods", async () => {
      const refs = await parseAndExtract("java", `
        public class UserController {
          private UserService service;
          private Logger logger;
          
          public Response getUser(Request request) {
            User user = service.findById(request.getId());
            return Response.ok(user);
          }
        }
      `);

      expect(refs).toContain("UserService");
      expect(refs).toContain("Logger");
      expect(refs).toContain("Response");
      expect(refs).toContain("Request");
      expect(refs).toContain("User");
    });
  });

  describe("unsupported language", () => {
    it("returns empty array", async () => {
      // Simulate by calling with a language we don't have queries for
      const parser = await engine.createParser("html");
      if (parser) {
        const tree = parser.parse("<div>hello</div>");
        const refs = extractTypeReferences(tree, "html");
        expect(refs).toEqual([]);
      }
    });
  });
});
