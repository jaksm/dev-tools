/**
 * DevToolsCore — the pure TS core with zero OpenClaw dependencies.
 * Contains all business logic, tool implementations, and workspace analysis.
 */

import path from "node:path";
import type {
  DevToolsConfig,
  Logger,
  ToolContext,
  WorkspaceInfo,
} from "./types.js";
import { createStorageManager } from "./storage.js";
import { createGitignoreFilter } from "./gitignore.js";
import { detectLanguages } from "./languages.js";
import { detectTestRunners } from "./test-detection.js";
import { createToolCallLogger, summarizeInput, summarizeOutput } from "./logging.js";
import { appendErrorLog, shouldLogError } from "./error-log.js";
import { cleanToolOutput } from "./token-budget.js";
import type { ToolCallLogger } from "./logging.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";

// Phase 2 imports
import { TreeSitterEngine } from "./tree-sitter/engine.js";
import { FileParser } from "./tree-sitter/parser.js";
import { SymbolIndex } from "./index/symbol-index.js";
import { WorkspaceIndexer } from "./index/indexer.js";
import { ImportGraph } from "./index/import-graph.js";
import { FileWatcher } from "./index/watcher.js";
import { generateIndexJson, writeIndexJson, type IndexJson } from "./index/index-json.js";
import { renderIndexWithBudget } from "./index/index-renderer.js";
import { generateAgentsMd, writeAgentsMd, readAgentsMd } from "./agents-md.js";

// Phase 3 imports
import { createEmbeddingProvider, type EmbeddingProvider } from "./search/embeddings.js";
import { EmbeddingIndexer } from "./search/indexer.js";

// Phase 4 imports
import { LspManager } from "./lsp/manager.js";
import { LspResolver } from "./lsp/resolver.js";

// Phase 5 imports
import { createTaskStorage, type TaskStorage } from "./task/storage.js";

// Project registry
import { registerProject, findProjectForDir, markProjectIndexed } from "./project-registry.js";

// Manifest path for incremental re-indexing
function manifestPath(storageDir: string): string {
  return path.join(storageDir, "index", "manifest.json");
}

export class DevToolsCore {
  private config: DevToolsConfig;
  private logger: Logger;
  private workspaceCache = new Map<string, WorkspaceInfo>();
  private loggerCache = new Map<string, ToolCallLogger>();

  // Phase 2: tree-sitter + symbol index
  private engine: TreeSitterEngine;
  private fileParser: FileParser;
  private symbolIndexes = new Map<string, SymbolIndex>();
  private indexers = new Map<string, WorkspaceIndexer>();
  private importGraphs = new Map<string, ImportGraph>();
  private watchers = new Map<string, FileWatcher>();
  private indexTimestamps = new Map<string, number>();

  // Phase 3: semantic search
  private embeddingProviders = new Map<string, EmbeddingProvider>();
  private embeddingIndexers = new Map<string, EmbeddingIndexer>();

  // Phase 4: LSP intelligence
  private lspManagers = new Map<string, LspManager>();
  private lspResolvers = new Map<string, LspResolver>();

  // Phase 5: task storage
  private taskStorages = new Map<string, TaskStorage>();

  // Project mapping: agentWorkspace → projectDir
  // Allows agents to work on projects at any path, independent of their workspace.
  private activeProjects = new Map<string, string>();

  constructor(opts: { config?: Record<string, unknown>; logger: Logger }) {
    this.config = (opts.config ?? {}) as DevToolsConfig;
    this.logger = opts.logger;
    this.engine = new TreeSitterEngine();
    this.fileParser = new FileParser(this.engine);
  }

  /** Get the current config. */
  getConfig(): DevToolsConfig {
    return this.config;
  }

  /**
   * Set the active project for an agent workspace.
   * This decouples the agent's workspace (~/.openclaw/workspace-X/) from the
   * project being worked on (e.g., ~/Projects/myapp/).
   */
  setActiveProject(agentWorkspace: string, projectDir: string): void {
    this.activeProjects.set(agentWorkspace, projectDir);
    this.logger.info(`[dev-tools] Active project set: ${projectDir} (agent workspace: ${agentWorkspace})`);
    // Persist to registry for cross-session recall
    const slug = createStorageManager(projectDir).slug;
    registerProject(projectDir, slug).catch(e => {
      this.logger.warn(`[dev-tools] Failed to persist project to registry: ${e}`);
    });
  }

  /**
   * Get the active project directory for an agent workspace.
   * Returns the project dir if set, otherwise falls back to the agent workspace itself.
   */
  getActiveProject(agentWorkspace: string): string {
    return this.activeProjects.get(agentWorkspace) ?? agentWorkspace;
  }

  /**
   * Check if an explicit project has been set for this agent workspace.
   */
  hasActiveProject(agentWorkspace: string): boolean {
    return this.activeProjects.has(agentWorkspace);
  }

  /**
   * Try to auto-activate a project for this agent workspace by checking the registry.
   * Returns the project dir if found, null otherwise.
   */
  async tryAutoActivate(agentWorkspace: string): Promise<string | null> {
    if (this.activeProjects.has(agentWorkspace)) {
      return this.activeProjects.get(agentWorkspace)!;
    }
    const entry = await findProjectForDir(agentWorkspace);
    if (entry) {
      this.activeProjects.set(agentWorkspace, entry.root);
      this.logger.info(`[dev-tools] Auto-activated project: ${entry.root} (matched from registry)`);
      return entry.root;
    }
    return null;
  }

  /**
   * Get the symbol index for a workspace.
   */
  getSymbolIndex(workspaceDir: string): SymbolIndex {
    let idx = this.symbolIndexes.get(workspaceDir);
    if (!idx) {
      idx = new SymbolIndex();
      this.symbolIndexes.set(workspaceDir, idx);
    }
    return idx;
  }

  /**
   * Get the import graph for a workspace.
   */
  getImportGraph(workspaceDir: string): ImportGraph {
    let graph = this.importGraphs.get(workspaceDir);
    if (!graph) {
      graph = new ImportGraph();
      this.importGraphs.set(workspaceDir, graph);
    }
    return graph;
  }

  /**
   * Get the embedding indexer for a workspace (null if not initialized).
   */
  getEmbeddingIndexer(workspaceDir: string): EmbeddingIndexer | null {
    return this.embeddingIndexers.get(workspaceDir) ?? null;
  }

  /**
   * Get (or create) the LSP manager for a workspace.
   * Returns null if workspace hasn't been analyzed yet.
   */
  getLspManager(workspaceDir: string): LspManager | null {
    const existing = this.lspManagers.get(workspaceDir);
    if (existing) return existing;

    const workspace = this.workspaceCache.get(workspaceDir);
    if (!workspace) return null;

    const manager = new LspManager({
      config: this.config,
      logger: this.logger,
      workspace,
    });
    this.lspManagers.set(workspaceDir, manager);
    manager.startHealthChecks();
    return manager;
  }

  /**
   * Get (or create) the LSP resolver for a workspace.
   * Returns null if workspace hasn't been analyzed yet.
   */
  getLspResolver(workspaceDir: string): LspResolver | null {
    const existing = this.lspResolvers.get(workspaceDir);
    if (existing) return existing;

    const workspace = this.workspaceCache.get(workspaceDir);
    if (!workspace) return null;

    const symbolIndex = this.getSymbolIndex(workspaceDir);
    const resolver = new LspResolver({
      symbolIndex,
      workspaceRoot: workspaceDir,
    });
    this.lspResolvers.set(workspaceDir, resolver);
    return resolver;
  }

  /**
   * Get (or create) the task storage for a workspace.
   */
  getTaskStorage(workspaceDir: string): TaskStorage {
    const existing = this.taskStorages.get(workspaceDir);
    if (existing) return existing;

    const storage = createStorageManager(workspaceDir);
    const taskStorage = createTaskStorage(storage.plansDir(), storage.completedPlansDir());
    this.taskStorages.set(workspaceDir, taskStorage);
    return taskStorage;
  }

  /**
   * Notify the LSP manager that a shell command was run.
   * This invalidates the prereq cache so next LSP call re-checks binary existence.
   */
  notifyShellCommand(workspaceDir: string): void {
    const manager = this.lspManagers.get(workspaceDir);
    if (manager) {
      manager.notifyShellCommand();
    }
  }

  /**
   * Re-index specific files immediately (bypasses watcher debounce).
   * Used by code_refactor after rename/fix to keep the symbol index fresh.
   */
  async reindexFiles(workspaceDir: string, filePaths: string[]): Promise<void> {
    const indexer = this.indexers.get(workspaceDir);
    if (!indexer) return;
    for (const fp of filePaths) {
      try {
        await indexer.reindexFile(fp);
      } catch {
        // Best-effort — watcher will catch up later
      }
    }
  }

  /**
   * Initialize and start embedding indexing for a workspace.
   * Called after symbol indexing completes.
   */
  private async startEmbeddingIndex(workspaceDir: string): Promise<void> {
    try {
      const symbolIndex = this.getSymbolIndex(workspaceDir);
      const storage = createStorageManager(workspaceDir);

      // Create embedding provider if not exists
      let provider = this.embeddingProviders.get(workspaceDir);
      if (!provider) {
        provider = await createEmbeddingProvider(this.config, this.logger);
        this.embeddingProviders.set(workspaceDir, provider);
      }

      // Create embedding indexer if not exists
      let indexer = this.embeddingIndexers.get(workspaceDir);
      if (!indexer) {
        indexer = new EmbeddingIndexer({
          embeddingProvider: provider,
          symbolIndex,
          workspaceDir,
          storageDir: storage.indexDir(),
          logger: this.logger,
        });
        this.embeddingIndexers.set(workspaceDir, indexer);
      }

      // Init (loads persisted HNSW if available)
      await indexer.init();

      // Run full embedding pass (skips already-embedded symbols)
      await indexer.indexAll((indexed, total) => {
        this.logger.info(`[dev-tools] Embedding progress: ${indexed}/${total}`);
      });
    } catch (e) {
      this.logger.warn(`[dev-tools] Embedding indexing failed: ${e}`);
      // Non-fatal — semantic search will be unavailable, text fallback works
    }
  }

  /**
   * Analyze workspace: .gitignore, languages, test runners, git detection.
   * Also triggers initial symbol indexing.
   */
  async analyzeWorkspace(workspaceDir: string | undefined): Promise<WorkspaceInfo | null> {
    if (!workspaceDir) return null;

    const cached = this.workspaceCache.get(workspaceDir);
    if (cached) return cached;

    this.logger.info(`[dev-tools] Analyzing workspace: ${workspaceDir}`);

    const gitignoreFilter = await createGitignoreFilter(workspaceDir);
    const languages = await detectLanguages(workspaceDir, gitignoreFilter);
    const testRunners = await detectTestRunners(workspaceDir, languages);

    let hasGit = false;
    try {
      await fs.access(path.join(workspaceDir, ".git"));
      hasGit = true;
    } catch {
      // No .git
    }

    const workspace: WorkspaceInfo = {
      root: workspaceDir,
      hasGit,
      languages,
      testRunners,
      gitignoreFilter,
    };

    this.workspaceCache.set(workspaceDir, workspace);
    this.logger.info(
      `[dev-tools] Workspace analyzed: ${languages.length} languages, ${testRunners.length} test runners, git=${hasGit}`,
    );

    // Trigger initial indexing in background (don't await — let it run)
    this.indexWorkspace(workspaceDir, gitignoreFilter).then(() => {
      // After indexing completes, auto-generate AGENTS.md if not present
      this.autoGenerateAgentsMd(workspaceDir).catch(e => {
        this.logger.warn(`[dev-tools] AGENTS.md auto-generation failed: ${e}`);
      });
    }).catch(e => {
      this.logger.warn(`[dev-tools] Initial indexing failed: ${e}`);
    });

    return workspace;
  }

  /**
   * Index the workspace — parse all source files, extract symbols, build import graph.
   * Uses incremental re-indexing when a manifest exists from a previous run.
   */
  async indexWorkspace(workspaceDir: string, gitignoreFilter: (path: string) => boolean): Promise<void> {
    await this.engine.init();

    const symbolIndex = this.getSymbolIndex(workspaceDir);
    const importGraph = this.getImportGraph(workspaceDir);
    const storage = createStorageManager(workspaceDir);

    let indexer = this.indexers.get(workspaceDir);
    if (!indexer) {
      indexer = new WorkspaceIndexer({
        engine: this.engine,
        parser: this.fileParser,
        symbolIndex,
        logger: this.logger,
      });
      this.indexers.set(workspaceDir, indexer);
    }

    // Try incremental re-index if manifest exists
    const mPath = manifestPath(storage.storageDir);
    let oldManifest: Record<string, number> | null = null;
    try {
      const raw = await fs.readFile(mPath, "utf-8");
      oldManifest = JSON.parse(raw);
    } catch {
      // No manifest — full index needed
    }

    let newManifest: Record<string, number>;

    // Incremental re-index only valid if in-memory symbol index already has data.
    // After gateway restart, symbol index is empty — must do full re-index regardless of manifest.
    const canIncremental = oldManifest && Object.keys(oldManifest).length > 0 && symbolIndex.size > 0;

    if (canIncremental) {
      // Incremental re-index
      const { result, manifest } = await indexer.incrementalIndex(
        workspaceDir,
        gitignoreFilter,
        oldManifest!,
      );
      newManifest = manifest;

      const changed = result.added + result.updated + result.removed;
      if (changed === 0) {
        this.logger.info(
          `[dev-tools] Index unchanged: ${result.unchanged} files, ${result.symbolCount} symbols (incremental, 0 changes)`,
        );
      } else {
        this.logger.info(
          `[dev-tools] Incremental index: +${result.added} -${result.removed} ~${result.updated} files (${result.unchanged} unchanged), ${result.symbolCount} symbols in ${result.durationMs}ms`,
        );
      }
    } else {
      // Full index
      const result = await indexer.indexWorkspace(workspaceDir, gitignoreFilter);
      this.logger.info(
        `[dev-tools] Full index: ${result.symbolCount} symbols from ${result.filesIndexed} files in ${result.durationMs}ms`,
      );
      newManifest = await indexer.buildManifest(workspaceDir, gitignoreFilter);
    }

    // Build import graph (explicit imports + type references)
    importGraph.build(indexer.getAllImportsExports(), workspaceDir);
    importGraph.addTypeReferenceEdges(indexer.getFileTypeRefs(), symbolIndex);

    // Generate INDEX.json
    const indexJson = generateIndexJson({
      symbolIndex,
      importGraph,
      fileImports: indexer.getAllImportsExports(),
      workspaceDir,
      fileLineCounts: indexer.getFileLineCounts(),
    });
    await writeIndexJson(indexJson, storage.indexDir());

    // Save manifest for next incremental run
    await fs.mkdir(path.dirname(mPath), { recursive: true });
    await fs.writeFile(mPath, JSON.stringify(newManifest), "utf-8");

    // Update registry
    markProjectIndexed(workspaceDir).catch(() => {});

    this.indexTimestamps.set(workspaceDir, Date.now());

    // Phase 3: trigger embedding indexing in background
    this.startEmbeddingIndex(workspaceDir).catch(e => {
      this.logger.warn(`[dev-tools] Background embedding indexing failed: ${e}`);
    });
  }

  /**
   * Create tool context for a workspace.
   */
  createToolContext(workspaceDir: string, workspace: WorkspaceInfo): ToolContext {
    const storage = createStorageManager(workspaceDir);
    return {
      workspaceDir,
      storageDir: storage.storageDir,
      config: this.config,
      workspace,
      logger: this.logger,
    };
  }

  /**
   * Get workspace status string for context injection.
   * This is prepended to agent prompts so they know what's available.
   */
  getWorkspaceStatus(workspaceDir: string | undefined): string | null {
    if (!workspaceDir) return null;
    const workspace = this.workspaceCache.get(workspaceDir);
    if (!workspace) return null;

    const langSummary = workspace.languages
      .map((l) => l.language)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(", ");

    // Always-available tools
    const foundationTools = ["file_read", "file_write", "file_edit", "shell", "grep", "glob", "ls"];
    const intelligenceTools = ["code_outline", "code_read", "code_search"];
    const workflowTools = ["task"];

    // Conditionally available
    const conditionalTools: string[] = [];
    if (workspace.hasGit) conditionalTools.push("git");
    if (workspace.testRunners.length > 0) conditionalTools.push("test");

    const hasLsp = this.lspManagers.has(workspaceDir);
    if (hasLsp) {
      conditionalTools.push("code_inspect", "code_diagnose", "code_refactor");
    }

    const allTools = [...foundationTools, ...intelligenceTools, ...workflowTools, ...conditionalTools];

    const lines = [
      `[dev-tools] ${allTools.length} tools active | ${workspaceDir}`,
      `Languages: ${langSummary || "none detected"}`,
    ];

    if (workspace.testRunners.length > 0) {
      lines.push(`Test runners: ${workspace.testRunners.map((t) => `${t.name} (${t.framework})`).join(", ")}`);
    }

    // Symbol index status
    const symbolIndex = this.symbolIndexes.get(workspaceDir);
    const indexTs = this.indexTimestamps.get(workspaceDir);
    if (symbolIndex && indexTs) {
      const age = Math.round((Date.now() - indexTs) / 1000);
      lines.push(`Symbols: ${symbolIndex.size} indexed (${age}s ago)`);
    }

    // Embedding index status
    const embeddingIndexer = this.embeddingIndexers.get(workspaceDir);
    if (embeddingIndexer) {
      const stats = embeddingIndexer.getStats();
      if (stats.state === "ready") {
        lines.push(`Semantic search: ready (${stats.indexedSymbols} embeddings)`);
      } else if (stats.state === "indexing") {
        const prog = embeddingIndexer.progress;
        lines.push(`Semantic search: indexing ${prog.indexed}/${prog.total}...`);
      } else {
        lines.push(`Semantic search: ${stats.state}`);
      }
    }

    // LSP status
    const lspManager = this.lspManagers.get(workspaceDir);
    if (lspManager) {
      const available = lspManager.getAvailableLanguages();
      const statuses = lspManager.getStatus();
      const running = statuses.filter(s => s.state === "running");
      if (running.length > 0) {
        lines.push(`LSP: ${running.map(s => s.language).join(", ")} (active)`);
      } else if (available.length > 0) {
        lines.push(`LSP: ${available.join(", ")} (available, lazy-boot on first use)`);
      }
    }

    // Quick-reference: tool selection guidance (compact)
    lines.push("");
    lines.push("Tool guide: ls/glob to explore → code_outline for structure → code_read for symbols → code_search for concepts → grep for exact text → code_inspect for types/refs → file_edit to modify → test to verify → code_diagnose for errors → git to commit");

    // INDEX.json context injection
    const contextInjection = this.config.contextInjection;
    if (contextInjection?.indexJson !== false) {
      const indexData = this.loadCachedIndexJson(workspaceDir);
      if (indexData) {
        const maxTokens = contextInjection?.maxTokens ?? 2000;
        const rendered = renderIndexWithBudget(indexData, maxTokens);
        if (rendered) {
          lines.push("");
          lines.push(rendered);
        }
      }
    }

    // AGENTS.md context injection
    if (contextInjection?.agentsMd !== false) {
      const agentsMd = this.loadCachedAgentsMd(workspaceDir);
      if (agentsMd) {
        lines.push("");
        lines.push(agentsMd);
      }
    }

    return lines.join("\n");
  }

  /**
   * Load cached AGENTS.md from disk for a workspace.
   * Returns null if not available.
   */
  private loadCachedAgentsMd(workspaceDir: string): string | null {
    const storage = createStorageManager(workspaceDir);
    const agentsMdPath = path.join(storage.storageDir, "AGENTS.md");
    try {
      return fsSync.readFileSync(agentsMdPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Auto-generate AGENTS.md if it doesn't exist in storage.
   * Fire-and-forget — never blocks workspace activation.
   */
  async autoGenerateAgentsMd(workspaceDir: string): Promise<void> {
    const storage = createStorageManager(workspaceDir);
    const agentsMdPath = path.join(storage.storageDir, "AGENTS.md");

    // Skip if already exists
    try {
      await fs.access(agentsMdPath);
      return;
    } catch {
      // Doesn't exist — generate
    }

    try {
      const indexData = this.loadCachedIndexJson(workspaceDir);
      const content = await generateAgentsMd(workspaceDir, storage, indexData ?? undefined);
      await writeAgentsMd(content, storage.storageDir);
      this.logger.info(`[dev-tools] Auto-generated AGENTS.md for ${workspaceDir}`);
    } catch (e) {
      this.logger.warn(`[dev-tools] Failed to auto-generate AGENTS.md: ${e}`);
    }
  }

  /**
   * Regenerate AGENTS.md for a workspace (force).
   */
  async regenerateAgentsMd(workspaceDir: string): Promise<{ content: string; path: string }> {
    const storage = createStorageManager(workspaceDir);
    const indexData = this.loadCachedIndexJson(workspaceDir);
    const content = await generateAgentsMd(workspaceDir, storage, indexData ?? undefined);
    const filePath = await writeAgentsMd(content, storage.storageDir);
    return { content, path: filePath };
  }

  /**
   * Load cached INDEX.json from disk for a workspace.
   * Returns null if not available.
   */
  private loadCachedIndexJson(workspaceDir: string): IndexJson | null {
    // Try reading synchronously from the storage location
    const storage = createStorageManager(workspaceDir);
    const indexPath = path.join(storage.indexDir(), "INDEX.json");
    try {
      const raw = fsSync.readFileSync(indexPath, "utf-8");
      return JSON.parse(raw) as IndexJson;
    } catch {
      return null;
    }
  }

  /**
   * Log a tool call via the JSONL logger.
   */
  logToolCall(event: {
    toolName: string;
    params: Record<string, unknown>;
    result?: unknown;
    error?: string;
    durationMs?: number;
  }, workspaceDir?: string): void {
    if (!workspaceDir) return;

    const storage = createStorageManager(workspaceDir);
    const loggerKey = storage.logsDir();

    if (!this.loggerCache.has(loggerKey)) {
      this.loggerCache.set(loggerKey, createToolCallLogger(storage.logsDir()));
    }

    const logger = this.loggerCache.get(loggerKey)!;
    logger.log({
      ts: new Date().toISOString(),
      tool: event.toolName,
      input: summarizeInput(event.toolName, event.params),
      output: event.error
        ? { error: event.error }
        : summarizeOutput(event.result),
      durationMs: event.durationMs ?? 0,
      status: event.error ? "error" : "ok",
    });

    // Auto-append tool errors to investigation log (deduplicated)
    if (event.error && shouldLogError(event.toolName, event.error)) {
      void appendErrorLog(storage.storageDir, {
        timestamp: new Date().toISOString(),
        tool: event.toolName,
        params: summarizeInput(event.toolName, event.params),
        error: event.error,
        source: "auto",
        status: "unresolved",
      });
    }
  }

  /**
   * Session start — ensure storage dirs, clean old tool output, start watcher.
   */
  async onSessionStart(workspaceDir: string | undefined, _sessionId: string): Promise<void> {
    if (!workspaceDir) return;
    const storage = createStorageManager(workspaceDir);
    await storage.ensureDirs();

    const cleaned = await cleanToolOutput(storage.toolOutputDir());
    if (cleaned > 0) {
      this.logger.info(`[dev-tools] Cleaned ${cleaned} old tool output files`);
    }

    // Start file watcher for incremental re-indexing
    const workspace = this.workspaceCache.get(workspaceDir);
    const indexer = this.indexers.get(workspaceDir);
    if (workspace && indexer && !this.watchers.has(workspaceDir)) {
      const embeddingIndexer = this.embeddingIndexers.get(workspaceDir);
      const watcher = new FileWatcher({
        workspaceDir,
        indexer,
        logger: this.logger,
        gitignoreFilter: workspace.gitignoreFilter,
        onFileChange: embeddingIndexer ? (fullPath, type) => {
          if (type === "change") {
            embeddingIndexer.updateFile(fullPath).catch(e => {
              this.logger.warn(`[dev-tools] Embedding update failed for ${fullPath}: ${e}`);
            });
          } else {
            embeddingIndexer.removeFile(fullPath);
          }
        } : undefined,
      });
      watcher.start();
      this.watchers.set(workspaceDir, watcher);
    }
  }

  /**
   * Session end — flush log buffers, stop watcher, dispose embeddings.
   */
  async onSessionEnd(_sessionId: string): Promise<void> {
    for (const logger of this.loggerCache.values()) {
      await logger.flush();
    }

    // Stop all watchers
    for (const watcher of this.watchers.values()) {
      await watcher.stop();
    }
    this.watchers.clear();

    // Dispose embedding indexers
    for (const indexer of this.embeddingIndexers.values()) {
      await indexer.dispose();
    }
    this.embeddingIndexers.clear();
    this.embeddingProviders.clear();

    // Dispose LSP managers
    for (const manager of this.lspManagers.values()) {
      await manager.dispose();
    }
    this.lspManagers.clear();
    this.lspResolvers.clear();
  }
}
