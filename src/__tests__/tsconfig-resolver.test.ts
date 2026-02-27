import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAliasResolver } from "../core/tree-sitter/tsconfig-resolver.js";

describe("tsconfig-resolver", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dt-tsconfig-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFiles(files: Record<string, string>) {
    for (const [filePath, content] of Object.entries(files)) {
      const full = path.join(tmpDir, filePath);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, content, "utf-8");
    }
  }

  it("returns null when no tsconfig.json exists", async () => {
    const resolver = await createAliasResolver(tmpDir);
    expect(resolver).toBeNull();
  });

  it("returns null when tsconfig has no paths or baseUrl", async () => {
    await writeFiles({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    });
    const resolver = await createAliasResolver(tmpDir);
    expect(resolver).toBeNull();
  });

  it("resolves wildcard path alias @/* → src/*", async () => {
    await writeFiles({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["./src/*"] },
        },
      }),
      "src/lib/utils.ts": "export const x = 1;",
      "src/components/Button.tsx": "export default function Button() {}",
    });

    const resolver = await createAliasResolver(tmpDir);
    expect(resolver).not.toBeNull();

    const utils = resolver!("@/lib/utils");
    expect(utils).toBe(path.join(tmpDir, "src/lib/utils.ts"));

    const button = resolver!("@/components/Button");
    expect(button).toBe(path.join(tmpDir, "src/components/Button.tsx"));
  });

  it("resolves index files", async () => {
    await writeFiles({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
      "src/lib/index.ts": "export const x = 1;",
    });

    const resolver = await createAliasResolver(tmpDir);
    const result = resolver!("@/lib");
    expect(result).toBe(path.join(tmpDir, "src/lib/index.ts"));
  });

  it("returns null for unmatched imports (package imports)", async () => {
    await writeFiles({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
    });

    const resolver = await createAliasResolver(tmpDir);
    expect(resolver!("react")).toBeNull();
    expect(resolver!("next/navigation")).toBeNull();
  });

  it("handles multiple targets — tries each, returns first match", async () => {
    await writeFiles({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["./src/*", "./lib/*"] },
        },
      }),
      "lib/shared.ts": "export const y = 2;",
    });

    const resolver = await createAliasResolver(tmpDir);
    // Not in src/, but in lib/
    const result = resolver!("@/shared");
    expect(result).toBe(path.join(tmpDir, "lib/shared.ts"));
  });

  it("handles exact (non-wildcard) path alias", async () => {
    await writeFiles({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@utils": ["src/utils/index"] },
        },
      }),
      "src/utils/index.ts": "export const z = 3;",
    });

    const resolver = await createAliasResolver(tmpDir);
    const result = resolver!("@utils");
    expect(result).toBe(path.join(tmpDir, "src/utils/index.ts"));
  });

  it("handles baseUrl without paths", async () => {
    await writeFiles({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: "src" },
      }),
      "src/lib/foo.ts": "export const a = 1;",
    });

    const resolver = await createAliasResolver(tmpDir);
    expect(resolver).not.toBeNull();
    const result = resolver!("lib/foo");
    expect(result).toBe(path.join(tmpDir, "src/lib/foo.ts"));
  });

  it("handles multiple alias patterns", async () => {
    await writeFiles({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["./src/*"],
            "@components/*": ["./src/components/*"],
            "~/*": ["./*"],
          },
        },
      }),
      "src/lib/a.ts": "export const a = 1;",
      "src/components/B.tsx": "export default function B() {}",
      "config/c.ts": "export const c = 3;",
    });

    const resolver = await createAliasResolver(tmpDir);
    expect(resolver!("@/lib/a")).toBe(path.join(tmpDir, "src/lib/a.ts"));
    expect(resolver!("@components/B")).toBe(path.join(tmpDir, "src/components/B.tsx"));
    expect(resolver!("~/config/c")).toBe(path.join(tmpDir, "config/c.ts"));
  });

  it("handles tsconfig with extends (relative path)", async () => {
    await writeFiles({
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["./src/*"] },
        },
      }),
      "tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { strict: true },
      }),
      "src/foo.ts": "export const f = 1;",
    });

    const resolver = await createAliasResolver(tmpDir);
    expect(resolver).not.toBeNull();
    expect(resolver!("@/foo")).toBe(path.join(tmpDir, "src/foo.ts"));
  });

  it("child paths override parent paths from extends", async () => {
    await writeFiles({
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["./lib/*"] },
        },
      }),
      "tsconfig.json": JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: {
          paths: { "@/*": ["./src/*"] },
        },
      }),
      "src/bar.ts": "export const b = 1;",
    });

    const resolver = await createAliasResolver(tmpDir);
    // Should use child's paths (src/*), not parent's (lib/*)
    expect(resolver!("@/bar")).toBe(path.join(tmpDir, "src/bar.ts"));
  });

  it("handles tsconfig with JSON comments", async () => {
    await writeFiles({
      "tsconfig.json": `{
        // This is a comment
        "compilerOptions": {
          "baseUrl": ".",
          /* multi-line
             comment */
          "paths": {
            "@/*": ["./src/*"]
          }
        }
      }`,
      "src/x.ts": "export const x = 1;",
    });

    const resolver = await createAliasResolver(tmpDir);
    expect(resolver).not.toBeNull();
    expect(resolver!("@/x")).toBe(path.join(tmpDir, "src/x.ts"));
  });

  it("returns null for alias that matches pattern but file doesn't exist", async () => {
    await writeFiles({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
    });

    const resolver = await createAliasResolver(tmpDir);
    expect(resolver!("@/nonexistent/file")).toBeNull();
  });
});
