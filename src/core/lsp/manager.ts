/**
 * LSP Server Lifecycle Manager — manages multiple LSP server instances.
 *
 * One server per language root. Lazy boot on first LSP tool call.
 * Tracks state, handles crash recovery, health checks, and prerequisite detection.
 */

import * as path from "node:path";
import { LspClient } from "./client.js";
import { getLspServerConfig, type LspServerDefinition } from "./servers.js";
import { DiagnosticsCollector } from "./diagnostics.js";
import type { Logger, DevToolsConfig, WorkspaceInfo } from "../types.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type ServerState = "available" | "booting" | "running" | "crashed" | "unavailable";

export interface ServerInstance {
  /** Unique key: `{language}:{root}` */
  key: string;
  language: string;
  root: string;
  state: ServerState;
  client: LspClient | null;
  pid: number | undefined;
  bootCount: number;
  lastError: string | null;
  lastRequestTime: number | null;
  startedAt: number | null;
}

export interface ServerStatus {
  key: string;
  language: string;
  root: string;
  state: ServerState;
  pid: number | undefined;
  uptime: number | null;
  lastRequestTime: number | null;
  restartCount: number;
  lastError: string | null;
}

export interface LspManagerOptions {
  config: DevToolsConfig;
  logger: Logger;
  workspace: WorkspaceInfo;
}

/**
 * Structured result from getClientWithReason — tells the caller WHY
 * a client is unavailable so tools can return actionable errors.
 */
export interface ClientResult {
  client: LspClient | null;
  reason?: ClientUnavailableReason;
}

export type ClientUnavailableReason =
  | { kind: "no_server_configured"; language: string }
  | { kind: "server_disabled"; language: string }
  | { kind: "prerequisite_missing"; language: string; command: string; installHint?: string }
  | { kind: "crash_limit_exceeded"; language: string; attempts: number; lastError: string }
  | { kind: "disposed" }
  | { kind: "no_matching_root"; filePath: string };

// ── File extension → language mapping (for language-aware routing) ───────────

const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",   // typescript server handles JS
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".swift": "swift",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
};

// ── LSP Manager ─────────────────────────────────────────────────────────────

export class LspManager {
  private instances = new Map<string, ServerInstance>();
  private bootPromises = new Map<string, Promise<LspClient | null>>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private prereqCache = new Map<string, boolean>(); // language → binary exists
  private shellCommandsSincePrereqCheck = false;
  private _disposed = false;

  private readonly config: DevToolsConfig;
  private readonly logger: Logger;
  private readonly workspace: WorkspaceInfo;
  private readonly maxRestartAttempts: number;
  private readonly healthCheckIntervalMs: number;

  /** Shared diagnostics collector — receives notifications from all LSP servers */
  readonly diagnostics: DiagnosticsCollector;

  constructor(options: LspManagerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.workspace = options.workspace;
    this.maxRestartAttempts = options.config.lsp?.maxRestartAttempts ?? 3;
    this.healthCheckIntervalMs = options.config.lsp?.healthCheckIntervalMs ?? 30_000;
    this.diagnostics = new DiagnosticsCollector();

    // Register available language roots
    for (const lang of options.workspace.languages) {
      const key = this.makeKey(lang.language, lang.root);
      this.instances.set(key, {
        key,
        language: lang.language,
        root: lang.root,
        state: "available",
        client: null,
        pid: undefined,
        bootCount: 0,
        lastError: null,
        lastRequestTime: null,
        startedAt: null,
      });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Get a running LSP client for a file. Boots lazily if not running.
   * Returns null if:
   * - No LSP server configured for this language
   * - Server binary not found (structured error in lastError)
   * - Server crashed and exceeded max restarts
   */
  async getClient(filePath: string): Promise<LspClient | null> {
    if (this._disposed) return null;

    const instance = this.findInstanceForFile(filePath);
    if (!instance) return null;

    if (instance.state === "running" && instance.client?.state === "ready") {
      instance.lastRequestTime = Date.now();
      return instance.client;
    }

    if (instance.state === "unavailable") {
      return null;
    }

    if (instance.state === "booting") {
      // Wait for existing boot
      const promise = this.bootPromises.get(instance.key);
      if (promise) return promise;
    }

    return this.bootServer(instance);
  }

  /**
   * Get a running LSP client with a structured reason if unavailable.
   * Use this from tools that need to return actionable errors to agents.
   */
  async getClientWithReason(filePath: string): Promise<ClientResult> {
    if (this._disposed) return { client: null, reason: { kind: "disposed" } };

    const instance = this.findInstanceForFile(filePath);
    if (!instance) {
      return { client: null, reason: { kind: "no_matching_root", filePath } };
    }

    if (instance.state === "running" && instance.client?.state === "ready") {
      instance.lastRequestTime = Date.now();
      return { client: instance.client };
    }

    if (instance.state === "unavailable") {
      return { client: null, reason: this.buildUnavailableReason(instance) };
    }

    if (instance.state === "booting") {
      const promise = this.bootPromises.get(instance.key);
      if (promise) {
        const client = await promise;
        return client ? { client } : { client: null, reason: this.buildUnavailableReason(instance) };
      }
    }

    const client = await this.bootServer(instance);
    return client ? { client } : { client: null, reason: this.buildUnavailableReason(instance) };
  }

  /**
   * Build a structured reason from a server instance's state.
   */
  private buildUnavailableReason(instance: ServerInstance): ClientUnavailableReason {
    const lastError = instance.lastError ?? "";

    if (lastError.includes("not found")) {
      const serverDef = getLspServerConfig(instance.language, this.config);
      return {
        kind: "prerequisite_missing",
        language: instance.language,
        command: serverDef?.command ?? instance.language,
        installHint: serverDef?.installHint,
      };
    }

    if (lastError.includes("No LSP server configured")) {
      return { kind: "no_server_configured", language: instance.language };
    }

    if (lastError.includes("disabled")) {
      return { kind: "server_disabled", language: instance.language };
    }

    if (instance.bootCount > 0) {
      return {
        kind: "crash_limit_exceeded",
        language: instance.language,
        attempts: instance.bootCount,
        lastError,
      };
    }

    return { kind: "no_server_configured", language: instance.language };
  }

  /**
   * Get a running LSP client for a specific language and root.
   * Boots lazily if not running.
   */
  async getClientForLanguage(language: string, root: string): Promise<LspClient | null> {
    if (this._disposed) return null;

    const key = this.makeKey(language, root);
    const instance = this.instances.get(key);
    if (!instance) return null;

    if (instance.state === "running" && instance.client?.state === "ready") {
      instance.lastRequestTime = Date.now();
      return instance.client;
    }

    if (instance.state === "unavailable") return null;

    if (instance.state === "booting") {
      const promise = this.bootPromises.get(instance.key);
      if (promise) return promise;
    }

    return this.bootServer(instance);
  }

  /**
   * Notify the manager that a shell command was run.
   * Invalidates prereq cache so next LSP call re-checks binary existence.
   */
  notifyShellCommand(): void {
    this.shellCommandsSincePrereqCheck = true;
  }

  /**
   * Start health check pings for all running servers.
   */
  startHealthChecks(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      if (this._disposed) return;

      for (const instance of this.instances.values()) {
        if (instance.state !== "running" || !instance.client) continue;

        const healthy = await instance.client.ping(5_000);
        if (!healthy && !this._disposed) {
          this.logger.warn(`[lsp] Health check failed for ${instance.key}, restarting...`);
          await this.restartServer(instance);
        }
      }
    }, this.healthCheckIntervalMs);
  }

  /**
   * Stop health checks.
   */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Get status of all registered servers.
   */
  getStatus(): ServerStatus[] {
    const now = Date.now();
    return Array.from(this.instances.values()).map(inst => ({
      key: inst.key,
      language: inst.language,
      root: inst.root,
      state: inst.state,
      pid: inst.client?.pid,
      uptime: inst.startedAt ? Math.round((now - inst.startedAt) / 1000) : null,
      lastRequestTime: inst.lastRequestTime,
      restartCount: Math.max(0, inst.bootCount - 1),
      lastError: inst.lastError,
    }));
  }

  /**
   * Get status of a specific server.
   */
  getServerStatus(language: string, root: string): ServerStatus | null {
    const key = this.makeKey(language, root);
    const inst = this.instances.get(key);
    if (!inst) return null;

    const now = Date.now();
    return {
      key: inst.key,
      language: inst.language,
      root: inst.root,
      state: inst.state,
      pid: inst.client?.pid,
      uptime: inst.startedAt ? Math.round((now - inst.startedAt) / 1000) : null,
      lastRequestTime: inst.lastRequestTime,
      restartCount: Math.max(0, inst.bootCount - 1),
      lastError: inst.lastError,
    };
  }

  /**
   * Check which languages have LSP support available.
   */
  getAvailableLanguages(): string[] {
    return Array.from(
      new Set(
        Array.from(this.instances.values())
          .filter(i => i.state !== "unavailable")
          .map(i => i.language),
      ),
    );
  }

  /**
   * Find the correct server instance for a given file path.
   * Language-aware: prefers instances whose language matches the file extension.
   * Among language matches, picks the most specific (deepest) root.
   * Falls back to most-specific root regardless of language if no language match.
   */
  findInstanceForFile(filePath: string): ServerInstance | null {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.workspace.root, filePath);
    const ext = path.extname(absPath).toLowerCase();
    const fileLanguage = EXT_TO_LANGUAGE[ext] ?? null;

    // Collect all instances whose root contains this file
    const candidates: Array<{ instance: ServerInstance; rootLen: number; langMatch: boolean }> = [];

    for (const instance of this.instances.values()) {
      if (absPath.startsWith(instance.root + path.sep) || absPath.startsWith(instance.root + "/")) {
        const langMatch = fileLanguage !== null && instance.language === fileLanguage;
        candidates.push({ instance, rootLen: instance.root.length, langMatch });
      }
    }

    if (candidates.length === 0) return null;

    // Sort: language match first, then most specific root (longest path)
    candidates.sort((a, b) => {
      if (a.langMatch !== b.langMatch) return a.langMatch ? -1 : 1;
      return b.rootLen - a.rootLen;
    });

    return candidates[0].instance;
  }

  /**
   * Find all server instances whose root contains the given file.
   * Useful for aggregated operations across language boundaries.
   */
  findAllInstancesForFile(filePath: string): ServerInstance[] {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.workspace.root, filePath);

    const results: ServerInstance[] = [];
    for (const instance of this.instances.values()) {
      if (absPath.startsWith(instance.root + path.sep) || absPath.startsWith(instance.root + "/")) {
        results.push(instance);
      }
    }

    return results;
  }

  /**
   * Force restart a specific server.
   */
  async restartServer(instanceOrKey: ServerInstance | string): Promise<LspClient | null> {
    const instance = typeof instanceOrKey === "string"
      ? this.instances.get(instanceOrKey)
      : instanceOrKey;
    if (!instance) return null;

    // Stop existing
    if (instance.client) {
      await instance.client.stop();
      instance.client = null;
    }

    instance.state = "available";
    instance.startedAt = null;

    return this.bootServer(instance);
  }

  /**
   * Force restart all servers.
   */
  async restartAll(): Promise<void> {
    const promises: Promise<unknown>[] = [];
    for (const instance of this.instances.values()) {
      if (instance.state === "running" || instance.state === "crashed") {
        promises.push(this.restartServer(instance));
      }
    }
    await Promise.allSettled(promises);
  }

  /**
   * Shutdown all servers and clean up.
   */
  async dispose(): Promise<void> {
    this._disposed = true;
    this.stopHealthChecks();

    const promises: Promise<void>[] = [];
    for (const instance of this.instances.values()) {
      if (instance.client) {
        promises.push(instance.client.stop().catch(() => { /* swallow */ }));
      }
    }
    await Promise.allSettled(promises);

    this.instances.clear();
    this.bootPromises.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private makeKey(language: string, root: string): string {
    return `${language}:${root}`;
  }

  /**
   * Boot a server instance. Handles prerequisite detection and crash recovery.
   */
  private async bootServer(instance: ServerInstance): Promise<LspClient | null> {
    // Check if we already have a boot in progress
    const existing = this.bootPromises.get(instance.key);
    if (existing) return existing;

    const promise = this.doBootServer(instance);
    this.bootPromises.set(instance.key, promise);

    try {
      return await promise;
    } finally {
      this.bootPromises.delete(instance.key);
    }
  }

  private async doBootServer(instance: ServerInstance): Promise<LspClient | null> {
    // Get server config for this language
    const serverDef = getLspServerConfig(instance.language, this.config);
    if (!serverDef) {
      instance.state = "unavailable";
      instance.lastError = `No LSP server configured for ${instance.language}`;
      return null;
    }

    // Check if server config is disabled
    if (serverDef.enabled === false) {
      instance.state = "unavailable";
      instance.lastError = `LSP server disabled for ${instance.language}`;
      return null;
    }

    // Prerequisite detection: check if binary exists
    const binaryAvailable = await this.checkPrerequisite(instance.language, serverDef);
    if (!binaryAvailable) {
      instance.state = "unavailable";
      instance.lastError = `LSP server binary '${serverDef.command}' not found. Install: ${serverDef.installHint ?? serverDef.command}`;
      return null;
    }

    // Attempt boot with crash recovery
    instance.state = "booting";
    instance.bootCount += 1;

    try {
      const client = new LspClient({
        command: serverDef.command,
        args: serverDef.args,
        cwd: instance.root,
        workspaceFolders: [instance.root],
        env: serverDef.env,
        logger: this.logger,
        initTimeoutMs: serverDef.initTimeoutMs ?? 30_000,
        requestTimeoutMs: serverDef.requestTimeoutMs ?? 15_000,
        onDiagnostics: (params) => {
          this.diagnostics.onDiagnostics(params, instance.root, instance.language);
          this.logger.debug?.(`[lsp:${instance.key}] Diagnostics for ${params.uri}: ${params.diagnostics.length} items`);
        },
        onExit: (code, signal) => {
          if (instance.state === "running" && !this._disposed) {
            this.logger.warn(`[lsp:${instance.key}] Server exited (code=${code}, signal=${signal})`);
            instance.state = "crashed";
            instance.client = null;
            instance.startedAt = null;

            // Auto-restart if under limit
            if (instance.bootCount < this.maxRestartAttempts) {
              this.logger.info(`[lsp:${instance.key}] Auto-restarting (attempt ${instance.bootCount + 1}/${this.maxRestartAttempts})...`);
              // Clean state on second attempt (attempt 2 = bootCount will be 2 after increment in doBootServer)
              const willBeAttempt2 = instance.bootCount + 1 === 2;
              const cleanPromise = willBeAttempt2
                ? this.cleanServerState(instance)
                : Promise.resolve();
              cleanPromise.then(() => this.bootServer(instance)).catch(e => {
                this.logger.error(`[lsp:${instance.key}] Auto-restart failed: ${e}`);
              });
            } else {
              instance.state = "unavailable";
              instance.lastError = `Server crashed ${instance.bootCount} times, giving up`;
              this.logger.error(`[lsp:${instance.key}] ${instance.lastError}`);
            }
          }
        },
      });

      await client.start();

      instance.client = client;
      instance.state = "running";
      instance.lastError = null;
      instance.startedAt = Date.now();
      instance.lastRequestTime = Date.now();

      this.logger.info(
        `[lsp:${instance.key}] Server running (pid=${client.pid}, attempt ${instance.bootCount})`,
      );

      return client;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      instance.lastError = errorMsg;

      // Crash recovery: try again with different strategies
      if (instance.bootCount < this.maxRestartAttempts) {
        this.logger.warn(
          `[lsp:${instance.key}] Boot failed (attempt ${instance.bootCount}/${this.maxRestartAttempts}): ${errorMsg}`,
        );

        // Attempt 2: clean state (clear caches etc.)
        if (instance.bootCount === 2) {
          this.logger.info(`[lsp:${instance.key}] Retrying with clean state...`);
          await this.cleanServerState(instance);
        }

        instance.state = "available";
        return this.bootServer(instance);
      }

      instance.state = "unavailable";
      instance.lastError = `Failed to start after ${instance.bootCount} attempts: ${errorMsg}`;
      this.logger.error(`[lsp:${instance.key}] ${instance.lastError}`);
      return null;
    }
  }

  /**
   * Clean server state/cache on retry attempt 2.
   * Removes language-specific cache dirs that may be corrupted.
   */
  private async cleanServerState(instance: ServerInstance): Promise<void> {
    const fs = await import("node:fs/promises");

    // Per-language cache directories to clean
    const cacheDirs: string[] = [];

    switch (instance.language) {
      case "typescript":
      case "javascript":
        // tsserver stores state in tsconfig tsbuildinfo files
        cacheDirs.push(path.join(instance.root, "node_modules/.cache/typescript"));
        // Also try .tsbuildinfo files
        try {
          const entries = await fs.readdir(instance.root);
          for (const entry of entries) {
            if (entry.endsWith(".tsbuildinfo")) {
              cacheDirs.push(path.join(instance.root, entry));
            }
          }
        } catch { /* skip */ }
        break;

      case "rust":
        // rust-analyzer stores state in target/
        cacheDirs.push(path.join(instance.root, "target/.rust-analyzer"));
        break;

      case "python":
        // pyright stores caches
        cacheDirs.push(path.join(instance.root, ".pyright"));
        cacheDirs.push(path.join(instance.root, "__pypackages__"));
        break;

      case "go":
        // gopls cache
        cacheDirs.push(path.join(instance.root, ".gopls"));
        break;

      case "java":
        // jdtls workspace
        cacheDirs.push(path.join(instance.root, ".jdtls-workspace"));
        break;
    }

    for (const dir of cacheDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        this.logger.info(`[lsp:${instance.key}] Cleaned cache: ${dir}`);
      } catch {
        // Doesn't exist or can't clean — not fatal
      }
    }
  }

  /**
   * Check if the LSP server binary exists on PATH.
   * Results are cached per session. Cache invalidated when shell commands run.
   */
  private async checkPrerequisite(language: string, serverDef: LspServerDefinition): Promise<boolean> {
    // Check cache (invalidated by shell commands)
    if (!this.shellCommandsSincePrereqCheck && this.prereqCache.has(language)) {
      return this.prereqCache.get(language)!;
    }

    // Reset flag
    this.shellCommandsSincePrereqCheck = false;

    const exists = await this.binaryExists(serverDef.command);
    this.prereqCache.set(language, exists);

    if (!exists) {
      this.logger.info(
        `[lsp] Binary '${serverDef.command}' not found for ${language}. Install: ${serverDef.installHint ?? "N/A"}`,
      );
    }

    return exists;
  }

  /**
   * Check if a binary exists on PATH using `which`.
   */
  private async binaryExists(command: string): Promise<boolean> {
    // Handle absolute paths
    if (path.isAbsolute(command)) {
      try {
        const fs = await import("node:fs/promises");
        await fs.access(command);
        return true;
      } catch {
        return false;
      }
    }

    // Check PATH
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("which", [command]);
      return true;
    } catch {
      return false;
    }
  }
}
