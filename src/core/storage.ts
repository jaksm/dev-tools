/**
 * Storage manager — resolves ~/.dev-tools/{slug}/ and creates directory structure.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { StorageManager } from "./types.js";

const DEV_TOOLS_HOME = path.join(os.homedir(), ".dev-tools");

/**
 * Derive a URL-safe slug from a workspace path.
 * Uses the last path segment, sanitized.
 */
export function deriveSlug(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  const basename = path.basename(resolved);
  // Sanitize: lowercase, replace non-alphanumeric with hyphens, collapse
  return basename
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "default";
}

export function createStorageManager(workspacePath: string): StorageManager {
  const slug = deriveSlug(workspacePath);
  const storageDir = path.join(DEV_TOOLS_HOME, slug);

  return {
    get storageDir() { return storageDir; },
    get slug() { return slug; },

    async ensureDirs(): Promise<void> {
      const dirs = [
        storageDir,
        path.join(storageDir, "plans"),
        path.join(storageDir, "plans", ".completed"),
        path.join(storageDir, "index"),
        path.join(storageDir, "logs"),
        path.join(storageDir, "tool-output"),
      ];
      for (const dir of dirs) {
        await fs.mkdir(dir, { recursive: true });
      }
    },

    plansDir(): string {
      return path.join(storageDir, "plans");
    },

    completedPlansDir(): string {
      return path.join(storageDir, "plans", ".completed");
    },

    indexDir(): string {
      return path.join(storageDir, "index");
    },

    logsDir(): string {
      return path.join(storageDir, "logs");
    },

    toolOutputDir(): string {
      return path.join(storageDir, "tool-output");
    },
  };
}
