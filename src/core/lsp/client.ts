/**
 * LSP Client Wrapper — Generic LSP client for any language server.
 *
 * Spawns an LSP server process, handles JSON-RPC communication via stdio,
 * manages the initialize handshake, and provides typed request/notification
 * methods. Zero OpenClaw dependencies — pure Node.js + vscode-languageserver-protocol.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type ProtocolConnection,
  type InitializeParams,
  type InitializeResult,
  type ServerCapabilities,
  type RequestType,
  type NotificationType,
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
  ExitNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  HoverRequest,
  DefinitionRequest,
  ReferencesRequest,
  RenameRequest,
  CodeActionRequest,
  PublishDiagnosticsNotification,
  LogMessageNotification,
  type Diagnostic,
  type PublishDiagnosticsParams,
  type Position,
} from "vscode-languageserver-protocol";

// Import node-specific transport + createProtocolConnection from the node entry point
// which re-exports vscode-jsonrpc/node with StreamMessageReader/Writer + node-aware factory
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node.js";
import type { Logger } from "../types.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type LspClientState = "idle" | "starting" | "ready" | "shutting_down" | "stopped" | "error";

export interface LspClientOptions {
  /** Language server command (e.g., "typescript-language-server") */
  command: string;
  /** Command arguments (e.g., ["--stdio"]) */
  args: string[];
  /** Working directory for the server process */
  cwd: string;
  /** Workspace root folders (for LSP initialize) */
  workspaceFolders: string[];
  /** Environment variables for the server process */
  env?: Record<string, string>;
  /** Logger */
  logger: Logger;
  /** Callback for diagnostics pushed by the server */
  onDiagnostics?: (params: PublishDiagnosticsParams) => void;
  /** Callback for server log messages */
  onLogMessage?: (type: number, message: string) => void;
  /** Callback when the server process exits */
  onExit?: (code: number | null, signal: string | null) => void;
  /** Initialize timeout in ms (default: 30000) */
  initTimeoutMs?: number;
  /** Request timeout in ms (default: 15000) */
  requestTimeoutMs?: number;
}

export interface OpenDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

// ── LSP Client ──────────────────────────────────────────────────────────────

export class LspClient {
  private process: ChildProcess | null = null;
  private connection: ProtocolConnection | null = null;
  private _state: LspClientState = "idle";
  private _capabilities: ServerCapabilities | null = null;
  private _initResult: InitializeResult | null = null;
  private openDocuments = new Map<string, OpenDocument>();
  private readonly options: Required<
    Pick<LspClientOptions, "initTimeoutMs" | "requestTimeoutMs">
  > & LspClientOptions;
  private stderrChunks: string[] = [];

  constructor(options: LspClientOptions) {
    this.options = {
      initTimeoutMs: 30_000,
      requestTimeoutMs: 15_000,
      ...options,
    };
  }

  // ── Getters ─────────────────────────────────────────────────────────────

  get state(): LspClientState { return this._state; }
  get capabilities(): ServerCapabilities | null { return this._capabilities; }
  get initResult(): InitializeResult | null { return this._initResult; }
  get pid(): number | undefined { return this.process?.pid; }

  /** Returns true if the server supports a given capability */
  hasCapability(cap: keyof ServerCapabilities): boolean {
    return this._capabilities != null && this._capabilities[cap] != null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start the LSP server, perform initialize handshake, send initialized.
   * Throws on failure (binary not found, init timeout, etc.).
   */
  async start(): Promise<InitializeResult> {
    if (this._state === "ready") {
      return this._initResult!;
    }
    if (this._state === "starting") {
      throw new Error("LSP client is already starting");
    }

    this._state = "starting";
    this.stderrChunks = [];

    try {
      // Spawn server process
      this.process = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Collect stderr for diagnostics
      this.process.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.stderrChunks.push(text);
        // Keep last 50 lines
        if (this.stderrChunks.length > 50) {
          this.stderrChunks.shift();
        }
        this.options.logger.debug?.(`[lsp:${this.options.command}:stderr] ${text.trim()}`);
      });

      // Handle process exit
      this.process.on("exit", (code, signal) => {
        if (this._state !== "shutting_down" && this._state !== "stopped") {
          this._state = "error";
          this.options.logger.warn(
            `[lsp] ${this.options.command} exited unexpectedly (code=${code}, signal=${signal})`,
          );
        }
        this.options.onExit?.(code, signal);
      });

      this.process.on("error", (err) => {
        this._state = "error";
        this.options.logger.error(`[lsp] ${this.options.command} process error: ${err.message}`);
      });

      // Create JSON-RPC connection
      if (!this.process.stdout || !this.process.stdin) {
        throw new Error("LSP server process has no stdio");
      }

      // Suppress unhandled stream errors (write-after-end races during teardown)
      this.process.stdin.on("error", () => { /* handled at higher level */ });
      this.process.stdout.on("error", () => { /* handled at higher level */ });

      this.connection = createProtocolConnection(
        new StreamMessageReader(this.process.stdout),
        new StreamMessageWriter(this.process.stdin),
      );

      // Wire up notifications
      this.connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
        this.options.onDiagnostics?.(params);
      });

      this.connection.onNotification(LogMessageNotification.type, (params) => {
        this.options.onLogMessage?.(params.type, params.message);
      });

      // Handle connection errors/close
      this.connection.onError(([error]) => {
        this.options.logger.warn(`[lsp] Connection error: ${error.message}`);
      });

      this.connection.onClose(() => {
        if (this._state !== "shutting_down" && this._state !== "stopped") {
          this._state = "error";
        }
      });

      // Start listening
      this.connection.listen();

      // Initialize handshake
      const rootUri = pathToFileURL(this.options.workspaceFolders[0]).toString();

      const initParams: InitializeParams = {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ["markdown", "plaintext"],
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: false,
            },
            references: {
              dynamicRegistration: false,
            },
            rename: {
              dynamicRegistration: false,
              prepareSupport: true,
            },
            codeAction: {
              dynamicRegistration: false,
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    "quickfix",
                    "refactor",
                    "source.organizeImports",
                    "source.fixAll",
                  ],
                },
              },
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
            },
          },
          workspace: {
            workspaceFolders: true,
            applyEdit: true,
          },
        },
        workspaceFolders: this.options.workspaceFolders.map(f => ({
          uri: pathToFileURL(f).toString(),
          name: path.basename(f),
        })),
      };

      const result = await this.withTimeout(
        this.connection.sendRequest(InitializeRequest.type, initParams),
        this.options.initTimeoutMs,
        "LSP initialize timed out",
      );

      this._capabilities = result.capabilities;
      this._initResult = result;

      // Send initialized notification
      this.connection.sendNotification(InitializedNotification.type, {});

      this._state = "ready";
      this.options.logger.info(
        `[lsp] ${this.options.command} initialized (pid=${this.process.pid})`,
      );

      return result;
    } catch (err) {
      this._state = "error";
      // Suppress write-after-end errors during error teardown
      if (this.connection) {
        this.connection.onError(() => { /* swallow during error teardown */ });
        try { this.connection.end(); } catch { /* noop */ }
        try { this.connection.dispose(); } catch { /* noop */ }
        this.connection = null;
      }
      await this.killProcess();
      throw err;
    }
  }

  /**
   * Graceful shutdown: send shutdown request, then exit notification.
   */
  async stop(): Promise<void> {
    if (this._state === "stopped" || this._state === "shutting_down") return;

    this._state = "shutting_down";

    try {
      if (this.connection) {
        // Suppress write-after-end errors during shutdown (JSON-RPC writer race)
        this.connection.onError(() => { /* swallow during shutdown */ });

        // Try graceful shutdown with timeout
        try {
          await this.withTimeout(
            this.connection.sendRequest(ShutdownRequest.type),
            5_000,
            "LSP shutdown timed out",
          );
          this.connection.sendNotification(ExitNotification.type);
        } catch {
          // Shutdown failed — kill process
          this.options.logger.warn(`[lsp] Graceful shutdown failed, killing process`);
        }

        // Wait briefly for the exit notification to be written before closing
        await new Promise(resolve => setTimeout(resolve, 50));

        this.connection.end();
        this.connection.dispose();
        this.connection = null;
      }
    } finally {
      await this.killProcess();
      this._state = "stopped";
      this.openDocuments.clear();
    }
  }

  /**
   * Force kill the server process.
   */
  async dispose(): Promise<void> {
    this._state = "stopped";
    if (this.connection) {
      // Suppress write-after-end errors during disposal
      this.connection.onError(() => { /* swallow during disposal */ });
      try { this.connection.end(); } catch { /* noop */ }
      // Brief wait to let pending writes drain before disposing
      await new Promise(resolve => setTimeout(resolve, 50));
      try { this.connection.dispose(); } catch { /* noop */ }
      this.connection = null;
    }
    await this.killProcess();
    this.openDocuments.clear();
  }

  // ── Document Sync ─────────────────────────────────────────────────────

  /**
   * Notify server that a document was opened.
   */
  async openDocument(uri: string, languageId: string, text: string): Promise<void> {
    this.ensureReady();

    const doc: OpenDocument = { uri, languageId, version: 1, text };
    this.openDocuments.set(uri, doc);

    this.connection!.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri,
        languageId,
        version: doc.version,
        text,
      },
    });
  }

  /**
   * Notify server that a document was changed (full sync).
   */
  async changeDocument(uri: string, text: string): Promise<void> {
    this.ensureReady();

    const doc = this.openDocuments.get(uri);
    if (!doc) {
      // Auto-open if not tracked
      const langId = this.inferLanguageId(uri);
      await this.openDocument(uri, langId, text);
      return;
    }

    doc.version += 1;
    doc.text = text;

    this.connection!.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: {
        uri,
        version: doc.version,
      },
      contentChanges: [{ text }],
    });
  }

  /**
   * Notify server that a document was closed.
   */
  async closeDocument(uri: string): Promise<void> {
    this.ensureReady();

    this.openDocuments.delete(uri);

    this.connection!.sendNotification(DidCloseTextDocumentNotification.type, {
      textDocument: { uri },
    });
  }

  /**
   * Ensure a file is open in the server. Reads from disk if not already open.
   * Returns the document URI.
   */
  async ensureDocumentOpen(filePath: string): Promise<string> {
    const uri = pathToFileURL(filePath).toString();
    if (this.openDocuments.has(uri)) return uri;

    const fs = await import("node:fs/promises");
    const text = await fs.readFile(filePath, "utf-8");
    const langId = this.inferLanguageId(filePath);
    await this.openDocument(uri, langId, text);
    return uri;
  }

  // ── LSP Requests ──────────────────────────────────────────────────────

  /**
   * Send a typed LSP request. Throws on timeout or server error.
   */
  async sendRequest<P, R>(
    type: RequestType<P, R, unknown>,
    params: P,
  ): Promise<R> {
    this.ensureReady();
    return this.withTimeout(
      this.connection!.sendRequest(type, params),
      this.options.requestTimeoutMs,
      `LSP request ${type.method} timed out`,
    );
  }

  /**
   * Send a typed LSP notification (fire-and-forget).
   */
  sendNotification<P>(
    type: NotificationType<P>,
    params: P,
  ): void {
    this.ensureReady();
    this.connection!.sendNotification(type, params);
  }

  // ── Convenience Methods (common LSP requests) ─────────────────────────

  /**
   * textDocument/hover
   */
  async hover(uri: string, position: Position) {
    return this.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position,
    });
  }

  /**
   * textDocument/definition
   */
  async definition(uri: string, position: Position) {
    return this.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position,
    });
  }

  /**
   * textDocument/references
   */
  async references(uri: string, position: Position, includeDeclaration = true) {
    return this.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
  }

  /**
   * textDocument/rename
   */
  async rename(uri: string, position: Position, newName: string) {
    return this.sendRequest(RenameRequest.type, {
      textDocument: { uri },
      position,
      newName,
    });
  }

  /**
   * textDocument/codeAction
   */
  async codeAction(uri: string, range: { start: Position; end: Position }, diagnostics: Diagnostic[] = []) {
    return this.sendRequest(CodeActionRequest.type, {
      textDocument: { uri },
      range,
      context: { diagnostics },
    });
  }

  /**
   * A simple ping: sends a hover request at position 0:0 of a known open document.
   * Returns true if the server responds within the timeout, false otherwise.
   */
  async ping(timeoutMs: number = 5_000): Promise<boolean> {
    if (this._state !== "ready" || !this.connection) return false;

    // Find any open document or return false
    const firstDoc = this.openDocuments.values().next();
    if (firstDoc.done) return false;

    try {
      await this.withTimeout(
        this.connection.sendRequest(HoverRequest.type, {
          textDocument: { uri: firstDoc.value.uri },
          position: { line: 0, character: 0 },
        }),
        timeoutMs,
        "ping timed out",
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the stderr output collected from the server process (for diagnostics).
   */
  getStderr(): string {
    return this.stderrChunks.join("");
  }

  /**
   * Check if a document is currently open in the server.
   */
  isDocumentOpen(uri: string): boolean {
    return this.openDocuments.has(uri);
  }

  /**
   * Get all currently open document URIs.
   */
  getOpenDocuments(): string[] {
    return Array.from(this.openDocuments.keys());
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private ensureReady(): void {
    if (this._state !== "ready") {
      throw new Error(`LSP client is not ready (state=${this._state})`);
    }
    if (!this.connection) {
      throw new Error("LSP connection not established");
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  private async killProcess(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    this.process = null;

    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");

      // Wait up to 3s for graceful exit, then SIGKILL
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* already dead */ }
          resolve();
        }, 3_000);

        proc.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private inferLanguageId(uriOrPath: string): string {
    let filePath: string;
    try {
      filePath = uriOrPath.startsWith("file://") ? fileURLToPath(uriOrPath) : uriOrPath;
    } catch {
      filePath = uriOrPath;
    }

    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".py": "python",
      ".rs": "rust",
      ".go": "go",
      ".swift": "swift",
      ".java": "java",
      ".kt": "kotlin",
      ".cs": "csharp",
      ".c": "c",
      ".cpp": "cpp",
      ".h": "c",
      ".hpp": "cpp",
      ".json": "json",
      ".html": "html",
      ".css": "css",
      ".scss": "scss",
      ".yaml": "yaml",
      ".yml": "yaml",
      ".md": "markdown",
      ".sh": "shellscript",
      ".bash": "shellscript",
    };

    return langMap[ext] ?? "plaintext";
  }
}
