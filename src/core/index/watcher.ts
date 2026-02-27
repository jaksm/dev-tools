/**
 * File watcher — incremental re-indexing on file changes.
 */

import { watch, type FSWatcher } from "chokidar";
import { TreeSitterEngine } from "../tree-sitter/engine.js";
import { WorkspaceIndexer } from "./indexer.js";
import type { Logger } from "../types.js";

export type FileChangeCallback = (fullPath: string, type: "change" | "delete") => void;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;
  private indexer: WorkspaceIndexer;
  private logger: Logger;
  private workspaceDir: string;
  private gitignoreFilter: (path: string) => boolean;
  private onFileChange?: FileChangeCallback;

  constructor(opts: {
    workspaceDir: string;
    indexer: WorkspaceIndexer;
    logger: Logger;
    gitignoreFilter: (path: string) => boolean;
    debounceMs?: number;
    onFileChange?: FileChangeCallback;
  }) {
    this.workspaceDir = opts.workspaceDir;
    this.indexer = opts.indexer;
    this.logger = opts.logger;
    this.gitignoreFilter = opts.gitignoreFilter;
    this.debounceMs = opts.debounceMs ?? 500;
    this.onFileChange = opts.onFileChange;
  }

  /**
   * Start watching the workspace for file changes.
   */
  start(): void {
    if (this.watcher) return;

    // Build glob for supported extensions
    const exts = TreeSitterEngine.supportedExtensions.map(e => e.replace(".", ""));
    const pattern = `**/*.{${exts.join(",")}}`;

    this.watcher = watch(pattern, {
      cwd: this.workspaceDir,
      ignored: (filePath: string) => this.gitignoreFilter(filePath),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
    });

    this.watcher.on("change", (filePath) => this.handleChange(filePath));
    this.watcher.on("add", (filePath) => this.handleChange(filePath));
    this.watcher.on("unlink", (filePath) => this.handleDelete(filePath));

    this.logger.info(`[dev-tools] File watcher started for ${this.workspaceDir}`);
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (!this.watcher) return;

    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    await this.watcher.close();
    this.watcher = null;
    this.logger.info(`[dev-tools] File watcher stopped`);
  }

  /**
   * Is the watcher running?
   */
  get isWatching(): boolean {
    return this.watcher !== null;
  }

  private handleChange(relativePath: string): void {
    // Debounce — batch rapid saves
    const existing = this.debounceTimers.get(relativePath);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(relativePath, setTimeout(async () => {
      this.debounceTimers.delete(relativePath);
      try {
        const fullPath = `${this.workspaceDir}/${relativePath}`;
        await this.indexer.reindexFile(fullPath);
        this.logger.debug?.(`[dev-tools] Re-indexed: ${relativePath}`);
        // Notify callback (e.g., for embedding re-indexing)
        this.onFileChange?.(fullPath, "change");
      } catch (e) {
        this.logger.warn(`[dev-tools] Failed to re-index ${relativePath}: ${e}`);
      }
    }, this.debounceMs));
  }

  private handleDelete(relativePath: string): void {
    const existing = this.debounceTimers.get(relativePath);
    if (existing) clearTimeout(existing);

    const fullPath = `${this.workspaceDir}/${relativePath}`;
    this.indexer.removeFile(fullPath);
    this.logger.debug?.(`[dev-tools] Removed from index: ${relativePath}`);
    // Notify callback (e.g., for embedding removal)
    this.onFileChange?.(fullPath, "delete");
  }
}
