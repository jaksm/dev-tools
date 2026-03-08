import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DevToolsCore } from "../core/index.js";
import { generateAgentsMd, writeAgentsMd, readAgentsMd } from "../core/agents-md.js";
import type { IndexJson } from "../core/index/index-json.js";
import type { StorageManager } from "../core/types.js";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Helper: derive slug (matches storage.ts logic)
function deriveSlug(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  const basename = path.basename(resolved);
  return basename
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "default";
}

// Helper: mock storage manager
function mockStorage(dir: string): StorageManager {
  return {
    storageDir: dir,
    slug: deriveSlug(dir),
    async ensureDirs() {
      await fsp.mkdir(dir, { recursive: true });
    },
    plansDir: () => path.join(dir, "plans"),
    completedPlansDir: () => path.join(dir, "plans", ".completed"),
    indexDir: () => path.join(dir, "index"),
    logsDir: () => path.join(dir, "logs"),
    toolOutputDir: () => path.join(dir, "tool-output"),
  };
}

// Helper: create a mock INDEX.json
function makeIndexJson(fileCount: number, symbolsPerFile = 5): IndexJson {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    file: `src/file${i}.ts`,
    lines: 100,
    rank: (fileCount - i) / fileCount,
    exports: [`export${i}A`, `export${i}B`],
    imports: i > 0 ? [`./file${i - 1}`] : [],
    symbols: symbolsPerFile,
  }));

  return {
    version: 1,
    workspace: "/project",
    generatedAt: new Date().toISOString(),
    files,
    totalSymbols: fileCount * symbolsPerFile,
    totalFiles: fileCount,
  };
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("AGENTS.md generation", () => {
  let tmpDir: string;
  let projectDir: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agents-md-test-"));
    projectDir = path.join(tmpDir, "project");
    storageDir = path.join(tmpDir, "storage");
    await fsp.mkdir(projectDir, { recursive: true });
    await fsp.mkdir(storageDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("generates full AGENTS.md from package.json + tsconfig", async () => {
    await fsp.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        name: "my-app",
        version: "1.0.0",
        description: "A cool application",
        scripts: {
          build: "tsc",
          test: "vitest run",
          dev: "tsx watch src/index.ts",
          lint: "eslint .",
        },
        dependencies: {
          express: "^4.18.0",
          prisma: "^5.0.0",
        },
        devDependencies: {
          typescript: "^5.3.0",
          vitest: "^1.0.0",
          eslint: "^8.0.0",
        },
      }),
    );

    await fsp.writeFile(
      path.join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          strict: true,
          outDir: "dist",
        },
      }),
    );

    const storage = mockStorage(storageDir);
    const result = await generateAgentsMd(projectDir, storage);

    expect(result).toContain("# AGENTS.md — my-app");
    expect(result).toContain("## Overview");
    expect(result).toContain("A cool application");
    expect(result).toContain("## Tech Stack");
    expect(result).toContain("TypeScript");
    expect(result).toContain("strict: yes");
    expect(result).toContain("Express");
    expect(result).toContain("Vitest");
    expect(result).toContain("## Commands");
    expect(result).toContain("npm run build");
    expect(result).toContain("npm test");
    expect(result).toContain("## Dependencies");
    expect(result).toContain("express");
    expect(result).toContain("web framework");
    expect(result).toContain("prisma");
    expect(result).toContain("ORM");
  });

  it("detects Next.js framework from deps", async () => {
    await fsp.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        name: "nextjs-app",
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
      }),
    );

    const storage = mockStorage(storageDir);
    const result = await generateAgentsMd(projectDir, storage);

    expect(result).toContain("Next.js");
    // Should NOT also list React as a separate framework since Next.js is detected
    const frameworkLine = result.split("\n").find(l => l.includes("**Framework:**"));
    expect(frameworkLine).toBeDefined();
    expect(frameworkLine).toContain("Next.js");
  });

  it("produces valid minimal markdown when no package.json exists", async () => {
    const storage = mockStorage(storageDir);
    const result = await generateAgentsMd(projectDir, storage);

    // Should still produce valid markdown with project name from dir
    expect(result).toContain("# AGENTS.md");
    expect(result).not.toContain("## Overview");
    expect(result).not.toContain("## Commands");
    expect(result).not.toContain("## Dependencies");
    // Should not throw or produce empty string
    expect(result.length).toBeGreaterThan(10);
  });

  it("omits Environment Variables section when no .env.example exists", async () => {
    await fsp.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "no-env-app" }),
    );

    const storage = mockStorage(storageDir);
    const result = await generateAgentsMd(projectDir, storage);

    expect(result).not.toContain("## Environment Variables");
  });

  it("includes env var names from .env.example (never values)", async () => {
    await fsp.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "env-app" }),
    );
    await fsp.writeFile(
      path.join(projectDir, ".env.example"),
      [
        "# Database connection",
        "DATABASE_URL=postgresql://localhost:5432/mydb",
        "",
        "# API Keys",
        "STRIPE_SECRET_KEY=sk_test_xxx",
        "OPENAI_API_KEY=",
      ].join("\n"),
    );

    const storage = mockStorage(storageDir);
    const result = await generateAgentsMd(projectDir, storage);

    expect(result).toContain("## Environment Variables");
    expect(result).toContain("`DATABASE_URL`");
    expect(result).toContain("Database connection");
    expect(result).toContain("`STRIPE_SECRET_KEY`");
    expect(result).toContain("`OPENAI_API_KEY`");
    // NEVER expose values
    expect(result).not.toContain("postgresql://");
    expect(result).not.toContain("sk_test_xxx");
  });

  it("renders INDEX.json directory structure correctly", async () => {
    const indexJson: IndexJson = {
      version: 1,
      workspace: projectDir,
      generatedAt: new Date().toISOString(),
      files: [
        { file: "src/index.ts", lines: 50, rank: 1.0, exports: ["main"], imports: [], symbols: 3 },
        { file: "src/utils.ts", lines: 30, rank: 0.8, exports: ["helper"], imports: ["./index"], symbols: 2 },
        { file: "src/types.ts", lines: 20, rank: 0.5, exports: ["Config"], imports: [], symbols: 4 },
        { file: "tests/index.test.ts", lines: 40, rank: 0.3, exports: [], imports: ["../src/index"], symbols: 1 },
      ],
      totalSymbols: 10,
      totalFiles: 4,
    };

    await fsp.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "structured-app" }),
    );

    const storage = mockStorage(storageDir);
    const result = await generateAgentsMd(projectDir, storage, indexJson);

    expect(result).toContain("## Project Structure");
    expect(result).toContain("`src/`");
    expect(result).toContain("3 files");
    expect(result).toContain("`tests/`");
    expect(result).toContain("1 files");

    expect(result).toContain("## Key Files");
    expect(result).toContain("`src/index.ts`");
    expect(result).toContain("exports: main");
  });

  it("detects Bun runtime from lockfile", async () => {
    await fsp.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "bun-app" }),
    );
    await fsp.writeFile(path.join(projectDir, "bun.lockb"), "");

    const storage = mockStorage(storageDir);
    const result = await generateAgentsMd(projectDir, storage);

    expect(result).toContain("**Runtime:** Bun");
  });

  it("detects strict: no when strict is false in tsconfig", async () => {
    await fsp.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        name: "loose-app",
        devDependencies: { typescript: "^5.0.0" },
      }),
    );
    await fsp.writeFile(
      path.join(projectDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: false } }),
    );

    const storage = mockStorage(storageDir);
    const result = await generateAgentsMd(projectDir, storage);

    expect(result).toContain("strict: no");
  });
});

describe("AGENTS.md write/read", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agents-md-io-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads AGENTS.md", async () => {
    const content = "# AGENTS.md — test\n\n## Overview\nTest project\n";
    const filePath = await writeAgentsMd(content, tmpDir);

    expect(filePath).toContain("AGENTS.md");
    const read = await readAgentsMd(tmpDir);
    expect(read).toBe(content);
  });

  it("returns null when AGENTS.md does not exist", async () => {
    const read = await readAgentsMd(tmpDir);
    expect(read).toBeNull();
  });
});

describe("AGENTS.md context injection", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agents-ctx-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    await fsp.mkdir(workspaceDir, { recursive: true });

    // Create minimal workspace
    await fsp.writeFile(
      path.join(workspaceDir, "package.json"),
      JSON.stringify({ name: "test", devDependencies: { vitest: "^1.0.0" } }),
    );
    await fsp.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await fsp.writeFile(path.join(workspaceDir, "src", "index.ts"), "export const x = 1;");

    // Derive storage location
    const slug = deriveSlug(workspaceDir);
    storageDir = path.join(os.homedir(), ".dev-tools", slug);
    await fsp.mkdir(storageDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  });

  it("includes AGENTS.md in getWorkspaceStatus when available", async () => {
    const core = new DevToolsCore({ logger });
    await core.analyzeWorkspace(workspaceDir);

    // Write AGENTS.md to storage
    await fsp.writeFile(
      path.join(storageDir, "AGENTS.md"),
      "# AGENTS.md — test\n\n## Overview\nTest project\n",
    );

    const status = core.getWorkspaceStatus(workspaceDir);
    expect(status).not.toBeNull();
    expect(status).toContain("AGENTS.md — test");
    expect(status).toContain("Test project");
  });

  it("skips AGENTS.md injection when contextInjection.agentsMd is false", async () => {
    const core = new DevToolsCore({
      config: { contextInjection: { agentsMd: false } },
      logger,
    });
    await core.analyzeWorkspace(workspaceDir);

    // Write AGENTS.md to storage
    await fsp.writeFile(
      path.join(storageDir, "AGENTS.md"),
      "# AGENTS.md — test\n\n## Overview\nTest project\n",
    );

    const status = core.getWorkspaceStatus(workspaceDir);
    expect(status).not.toBeNull();
    expect(status).toContain("tools active");
    expect(status).not.toContain("AGENTS.md — test");
  });

  it("returns status without AGENTS.md when file does not exist", async () => {
    const core = new DevToolsCore({ logger });
    await core.analyzeWorkspace(workspaceDir);

    const status = core.getWorkspaceStatus(workspaceDir);
    expect(status).not.toBeNull();
    expect(status).toContain("tools active");
    // Should not error out
  });
});
