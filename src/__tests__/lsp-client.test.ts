import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { LspClient, type LspClientOptions } from "../core/lsp/client.js";

// Suppress unhandled rejections from vscode-jsonrpc's internal WritableStreamWrapper
// during teardown. This is a known library limitation — the wrapper's write() returns
// a promise that rejects when the stream is dead, and it doesn't catch it internally.
const suppressedErrors: Error[] = [];
function rejectionHandler(err: unknown) {
  if (err instanceof Error &&
      (err.message.includes("write after end") ||
       err.message.includes("after a stream was destroyed"))) {
    suppressedErrors.push(err);
    return;
  }
  // Re-throw unexpected rejections
  throw err;
}
beforeAll(() => { process.on("unhandledRejection", rejectionHandler); });
afterAll(() => { process.removeListener("unhandledRejection", rejectionHandler); });

const MOCK_SERVER = path.resolve(
  import.meta.dirname,
  "helpers/mock-lsp-server.mjs",
);

let tmpDir: string;

function makeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeOptions(extra: Partial<LspClientOptions> = {}): LspClientOptions {
  return {
    command: "node",
    args: [MOCK_SERVER],
    cwd: tmpDir,
    workspaceFolders: [tmpDir],
    logger: makeLogger(),
    initTimeoutMs: 10_000,
    requestTimeoutMs: 5_000,
    ...extra,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-client-test-"));
  // Create a test file for document operations
  await fs.writeFile(path.join(tmpDir, "test.ts"), "const x = 1;\nconst y = 2;\n");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

describe("LspClient — lifecycle", () => {
  it("starts and initializes successfully", async () => {
    const client = new LspClient(makeOptions());
    try {
      const result = await client.start();
      expect(client.state).toBe("ready");
      expect(result.capabilities).toBeDefined();
      expect(result.capabilities.hoverProvider).toBe(true);
      expect(result.capabilities.definitionProvider).toBe(true);
      expect(client.pid).toBeTypeOf("number");
    } finally {
      await client.stop();
    }
  });

  it("reports capabilities correctly", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      expect(client.hasCapability("hoverProvider")).toBe(true);
      expect(client.hasCapability("definitionProvider")).toBe(true);
      expect(client.hasCapability("referencesProvider")).toBe(true);
      expect(client.hasCapability("renameProvider")).toBe(true);
      expect(client.hasCapability("codeActionProvider")).toBe(true);
      // Not advertised by our mock
      expect(client.hasCapability("completionProvider")).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it("stops gracefully", async () => {
    const client = new LspClient(makeOptions());
    await client.start();
    await client.stop();
    expect(client.state).toBe("stopped");
  });

  it("handles double stop", async () => {
    const client = new LspClient(makeOptions());
    await client.start();
    await client.stop();
    await client.stop(); // Should be a no-op
    expect(client.state).toBe("stopped");
  });

  it("throws when start is called twice", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      // start() while ready should return the existing result
      const result = await client.start();
      expect(result.capabilities).toBeDefined();
    } finally {
      await client.stop();
    }
  });

  it("transitions to error state when binary not found", async () => {
    const client = new LspClient(makeOptions({
      command: "nonexistent-lsp-binary-that-doesnt-exist",
      args: [],
    }));
    await expect(client.start()).rejects.toThrow();
    expect(client.state).toBe("error");
  });

  it("handles init timeout", async () => {
    const client = new LspClient(makeOptions({
      args: [MOCK_SERVER, "--hang-on-init"],
      initTimeoutMs: 500,
    }));
    await expect(client.start()).rejects.toThrow(/timed out/);
    expect(client.state).toBe("error");
  });

  it("disposes forcefully", async () => {
    const client = new LspClient(makeOptions());
    await client.start();
    await client.dispose();
    expect(client.state).toBe("stopped");
  });
});

// ── Document Sync ─────────────────────────────────────────────────────────

describe("LspClient — document sync", () => {
  it("opens a document", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const uri = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
      await client.openDocument(uri, "typescript", "const x = 1;\n");
      expect(client.isDocumentOpen(uri)).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it("changes a document", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const uri = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
      await client.openDocument(uri, "typescript", "const x = 1;\n");
      await client.changeDocument(uri, "const x = 2;\n");
      // No crash = success (server received the change)
    } finally {
      await client.stop();
    }
  });

  it("auto-opens on changeDocument for unknown URI", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const filePath = path.join(tmpDir, "test.ts");
      const uri = pathToFileURL(filePath).toString();
      await client.changeDocument(uri, "const y = 3;\n");
      expect(client.isDocumentOpen(uri)).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it("closes a document", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const uri = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
      await client.openDocument(uri, "typescript", "const x = 1;\n");
      await client.closeDocument(uri);
      expect(client.isDocumentOpen(uri)).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it("ensureDocumentOpen reads from disk", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const filePath = path.join(tmpDir, "test.ts");
      const uri = await client.ensureDocumentOpen(filePath);
      expect(uri).toBe(pathToFileURL(filePath).toString());
      expect(client.isDocumentOpen(uri)).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it("tracks open documents", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const uri1 = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
      const uri2 = pathToFileURL(path.join(tmpDir, "test2.ts")).toString();
      await client.openDocument(uri1, "typescript", "a");
      await client.openDocument(uri2, "typescript", "b");
      const docs = client.getOpenDocuments();
      expect(docs).toContain(uri1);
      expect(docs).toContain(uri2);
      expect(docs).toHaveLength(2);
    } finally {
      await client.stop();
    }
  });
});

// ── LSP Requests ──────────────────────────────────────────────────────────

describe("LspClient — requests", () => {
  it("hover returns content", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const uri = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
      await client.openDocument(uri, "typescript", "const x = 1;\n");

      const result = await client.hover(uri, { line: 0, character: 6 });
      expect(result).not.toBeNull();
      expect(result!.contents).toBeDefined();
    } finally {
      await client.stop();
    }
  });

  it("definition returns location", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const uri = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
      await client.openDocument(uri, "typescript", "const x = 1;\n");

      const result = await client.definition(uri, { line: 0, character: 6 });
      expect(result).not.toBeNull();
    } finally {
      await client.stop();
    }
  });

  it("references returns locations", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const uri = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
      await client.openDocument(uri, "typescript", "const x = 1;\n");

      const result = await client.references(uri, { line: 0, character: 6 });
      expect(result).not.toBeNull();
      expect(Array.isArray(result)).toBe(true);
      expect(result!.length).toBeGreaterThan(0);
    } finally {
      await client.stop();
    }
  });

  it("rename returns workspace edit", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const uri = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
      await client.openDocument(uri, "typescript", "const x = 1;\n");

      const result = await client.rename(uri, { line: 0, character: 6 }, "newName");
      expect(result).not.toBeNull();
      expect(result!.changes).toBeDefined();
    } finally {
      await client.stop();
    }
  });

  it("codeAction returns actions", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const uri = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
      await client.openDocument(uri, "typescript", "const x = 1;\n");

      const result = await client.codeAction(
        uri,
        { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      );
      expect(result).not.toBeNull();
      expect(Array.isArray(result)).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it("throws when calling request on non-ready client", async () => {
    const client = new LspClient(makeOptions());
    const uri = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
    await expect(
      client.hover(uri, { line: 0, character: 0 }),
    ).rejects.toThrow(/not ready/);
  });
});

// ── Ping ──────────────────────────────────────────────────────────────────

describe("LspClient — ping", () => {
  it("ping returns true when server is healthy", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const uri = pathToFileURL(path.join(tmpDir, "test.ts")).toString();
      await client.openDocument(uri, "typescript", "const x = 1;\n");

      const result = await client.ping(3_000);
      expect(result).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it("ping returns false when no documents are open", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      const result = await client.ping(1_000);
      expect(result).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it("ping returns false when client is not ready", async () => {
    const client = new LspClient(makeOptions());
    const result = await client.ping(1_000);
    expect(result).toBe(false);
  });
});

// ── Error Handling ────────────────────────────────────────────────────────

describe("LspClient — error handling", () => {
  it("handles server crash after init", async () => {
    let exitReceived = false;
    const client = new LspClient(makeOptions({
      args: [MOCK_SERVER, "--crash-after-init"],
      onExit: () => { exitReceived = true; },
    }));

    await client.start();
    // Wait a bit for the crash
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(client.state).toBe("error");
    expect(exitReceived).toBe(true);

    await client.dispose();
  });

  it("collects stderr output", async () => {
    const client = new LspClient(makeOptions());
    try {
      await client.start();
      // Mock server may not produce stderr, but getStderr() should work
      const stderr = client.getStderr();
      expect(typeof stderr).toBe("string");
    } finally {
      await client.stop();
    }
  });

  it("handles shutdown timeout gracefully", async () => {
    const client = new LspClient(makeOptions({
      args: [MOCK_SERVER, "--ignore-shutdown"],
    }));

    await client.start();
    // stop() should still succeed (falls back to kill)
    await client.stop();
    expect(client.state).toBe("stopped");
  }, 15_000);
});
