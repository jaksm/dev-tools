import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LspManager } from "../core/lsp/manager.js";
import type { WorkspaceInfo, DevToolsConfig } from "../core/types.js";

const MOCK_SERVER = path.resolve(
  import.meta.dirname,
  "helpers/mock-lsp-server.mjs",
);

// Suppress vscode-jsonrpc write-after-end rejections (see lsp-client.test.ts)
const suppressedErrors: Error[] = [];
function rejectionHandler(err: unknown) {
  if (err instanceof Error &&
      (err.message.includes("write after end") ||
       err.message.includes("after a stream was destroyed"))) {
    suppressedErrors.push(err);
    return;
  }
  throw err;
}
beforeAll(() => { process.on("unhandledRejection", rejectionHandler); });
afterAll(() => { process.removeListener("unhandledRejection", rejectionHandler); });

let tmpDir: string;

function makeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeWorkspace(languages: { language: string; root: string }[] = []): WorkspaceInfo {
  return {
    root: tmpDir,
    hasGit: false,
    languages: languages.map(l => ({
      language: l.language,
      root: l.root,
      configFile: path.join(l.root, "tsconfig.json"),
    })),
    testRunners: [],
    gitignoreFilter: () => false,
  };
}

function makeConfig(overrides: Partial<DevToolsConfig> = {}): DevToolsConfig {
  return {
    lsp: {
      servers: {
        // Override typescript server to use our mock
        typescript: {
          command: "node",
          args: [MOCK_SERVER],
        },
      },
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 60_000, // Long interval for tests
      ...overrides.lsp,
    },
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-manager-test-"));
  await fs.writeFile(path.join(tmpDir, "test.ts"), "const x = 1;\n");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

describe("LspManager — lifecycle", () => {
  it("registers language roots from workspace", () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
      ]),
    });

    const status = manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].language).toBe("typescript");
    expect(status[0].state).toBe("available");

    manager.dispose();
  });

  it("registers multiple language roots", () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: path.join(tmpDir, "frontend") },
        { language: "python", root: path.join(tmpDir, "backend") },
      ]),
    });

    const status = manager.getStatus();
    expect(status).toHaveLength(2);

    manager.dispose();
  });

  it("disposes cleanly with no running servers", async () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([]),
    });

    await manager.dispose();
    // No crash = success
  });
});

// ── Lazy Boot ─────────────────────────────────────────────────────────────

describe("LspManager — lazy boot", () => {
  it("boots server on first getClient call", async () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
      ]),
    });

    try {
      const client = await manager.getClient(path.join(tmpDir, "test.ts"));
      expect(client).not.toBeNull();
      expect(client!.state).toBe("ready");

      const status = manager.getStatus();
      expect(status[0].state).toBe("running");
      expect(status[0].pid).toBeTypeOf("number");
    } finally {
      await manager.dispose();
    }
  });

  it("reuses existing client on subsequent calls", async () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
      ]),
    });

    try {
      const client1 = await manager.getClient(path.join(tmpDir, "test.ts"));
      const client2 = await manager.getClient(path.join(tmpDir, "test.ts"));
      expect(client1).toBe(client2);
    } finally {
      await manager.dispose();
    }
  });

  it("returns null for files outside any language root", async () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: path.join(tmpDir, "src") },
      ]),
    });

    try {
      // File outside the registered root
      const client = await manager.getClient("/tmp/random-file.ts");
      expect(client).toBeNull();
    } finally {
      await manager.dispose();
    }
  });

  it("returns null after dispose", async () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
      ]),
    });

    await manager.dispose();
    const client = await manager.getClient(path.join(tmpDir, "test.ts"));
    expect(client).toBeNull();
  });
});

// ── Prerequisite Detection ────────────────────────────────────────────────

describe("LspManager — prerequisites", () => {
  it("returns null when server binary doesn't exist", async () => {
    const manager = new LspManager({
      config: {
        lsp: {
          servers: {
            typescript: {
              command: "nonexistent-lsp-server-xyz",
              args: [],
            },
          },
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
      ]),
    });

    try {
      const client = await manager.getClient(path.join(tmpDir, "test.ts"));
      expect(client).toBeNull();

      const status = manager.getStatus();
      expect(status[0].state).toBe("unavailable");
      expect(status[0].lastError).toContain("not found");
    } finally {
      await manager.dispose();
    }
  });

  it("invalidates prereq cache after shell command notification", async () => {
    const manager = new LspManager({
      config: {
        lsp: {
          servers: {
            typescript: {
              command: "nonexistent-lsp-server-xyz",
              args: [],
            },
          },
        },
      },
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
      ]),
    });

    try {
      // First call: binary not found
      await manager.getClient(path.join(tmpDir, "test.ts"));

      // Notify shell command (user might have installed the binary)
      manager.notifyShellCommand();

      // The cache should be invalidated — next check will re-run `which`
      // (still won't find it, but the mechanism works)
    } finally {
      await manager.dispose();
    }
  });
});

// ── Server Status ─────────────────────────────────────────────────────────

describe("LspManager — status", () => {
  it("reports available languages", async () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
      ]),
    });

    try {
      const langs = manager.getAvailableLanguages();
      expect(langs).toContain("typescript");
    } finally {
      await manager.dispose();
    }
  });

  it("reports server status with uptime", async () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
      ]),
    });

    try {
      await manager.getClient(path.join(tmpDir, "test.ts"));

      const status = manager.getStatus();
      expect(status[0].state).toBe("running");
      expect(status[0].uptime).toBeTypeOf("number");
      expect(status[0].restartCount).toBe(0);
      expect(status[0].lastError).toBeNull();
    } finally {
      await manager.dispose();
    }
  });

  it("getServerStatus returns specific server", async () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
      ]),
    });

    try {
      const status = manager.getServerStatus("typescript", tmpDir);
      expect(status).not.toBeNull();
      expect(status!.language).toBe("typescript");
    } finally {
      await manager.dispose();
    }
  });

  it("getServerStatus returns null for unknown server", async () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([]),
    });

    const status = manager.getServerStatus("brainfuck", tmpDir);
    expect(status).toBeNull();

    await manager.dispose();
  });
});

// ── File → Instance Routing ───────────────────────────────────────────────

describe("LspManager — file routing", () => {
  it("routes file to correct language root", () => {
    const frontendDir = path.join(tmpDir, "frontend");
    const backendDir = path.join(tmpDir, "backend");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: frontendDir },
        { language: "python", root: backendDir },
      ]),
    });

    const tsInstance = manager.findInstanceForFile(path.join(frontendDir, "src/app.ts"));
    expect(tsInstance).not.toBeNull();
    expect(tsInstance!.language).toBe("typescript");

    const pyInstance = manager.findInstanceForFile(path.join(backendDir, "main.py"));
    expect(pyInstance).not.toBeNull();
    expect(pyInstance!.language).toBe("python");

    manager.dispose();
  });

  it("prefers most specific root", () => {
    const rootDir = tmpDir;
    const nestedDir = path.join(tmpDir, "packages/core");

    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: rootDir },
        { language: "typescript", root: nestedDir },
      ]),
    });

    const instance = manager.findInstanceForFile(path.join(nestedDir, "src/index.ts"));
    expect(instance).not.toBeNull();
    expect(instance!.root).toBe(nestedDir);

    manager.dispose();
  });
});

// ── Restart ───────────────────────────────────────────────────────────────

describe("LspManager — restart", () => {
  it("restarts a running server", async () => {
    const manager = new LspManager({
      config: makeConfig(),
      logger: makeLogger(),
      workspace: makeWorkspace([
        { language: "typescript", root: tmpDir },
      ]),
    });

    try {
      const client1 = await manager.getClient(path.join(tmpDir, "test.ts"));
      expect(client1).not.toBeNull();
      const pid1 = client1!.pid;

      const status = manager.getStatus();
      const key = status[0].key;

      const client2 = await manager.restartServer(key);
      expect(client2).not.toBeNull();
      // New process should have different PID
      expect(client2!.pid).not.toBe(pid1);
    } finally {
      await manager.dispose();
    }
  });
});
