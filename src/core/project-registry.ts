/**
 * Project registry — persists known project roots to ~/.dev-tools/.projects.json
 * 
 * Enables:
 * - Auto-activate projects by matching cwd against registered roots
 * - Instant project switching (index data already exists under ~/.dev-tools/{slug}/)
 * - No repeated `init` when returning to a previously-initialized project
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEV_TOOLS_HOME = path.join(os.homedir(), ".dev-tools");
const REGISTRY_FILE = path.join(DEV_TOOLS_HOME, ".projects.json");

export interface ProjectEntry {
  /** Absolute path to the project root */
  root: string;
  /** URL-safe slug (matches ~/.dev-tools/{slug}/) */
  slug: string;
  /** Timestamp of last activation */
  lastUsed: number;
  /** Timestamp of last full index */
  lastIndexed?: number;
}

export interface ProjectRegistry {
  /** All registered projects, keyed by absolute root path */
  projects: Record<string, ProjectEntry>;
}

/**
 * Load the project registry from disk. Returns empty registry if file doesn't exist.
 */
export async function loadRegistry(): Promise<ProjectRegistry> {
  try {
    const data = await fs.readFile(REGISTRY_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed.projects === "object") {
      return parsed as ProjectRegistry;
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  return { projects: {} };
}

/**
 * Save the project registry to disk.
 */
export async function saveRegistry(registry: ProjectRegistry): Promise<void> {
  await fs.mkdir(DEV_TOOLS_HOME, { recursive: true });
  const tmp = REGISTRY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(registry, null, 2), "utf-8");
  await fs.rename(tmp, REGISTRY_FILE);
}

/**
 * Register a project (or update its lastUsed timestamp).
 */
export async function registerProject(root: string, slug: string): Promise<void> {
  const resolved = path.resolve(root);
  const registry = await loadRegistry();
  registry.projects[resolved] = {
    root: resolved,
    slug,
    lastUsed: Date.now(),
    lastIndexed: registry.projects[resolved]?.lastIndexed,
  };
  await saveRegistry(registry);
}

/**
 * Update the lastIndexed timestamp for a project.
 */
export async function markProjectIndexed(root: string): Promise<void> {
  const resolved = path.resolve(root);
  const registry = await loadRegistry();
  const entry = registry.projects[resolved];
  if (entry) {
    entry.lastIndexed = Date.now();
    entry.lastUsed = Date.now();
    await saveRegistry(registry);
  }
}

/**
 * Find a registered project that matches the given directory.
 * Checks exact match first, then walks up parent directories.
 * Returns null if no match found.
 */
export async function findProjectForDir(dir: string): Promise<ProjectEntry | null> {
  const resolved = path.resolve(dir);
  const registry = await loadRegistry();

  // Exact match
  if (registry.projects[resolved]) {
    return registry.projects[resolved];
  }

  // Walk up parents
  let current = resolved;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break; // reached root
    if (registry.projects[parent]) {
      return registry.projects[parent];
    }
    current = parent;
  }

  // Check if dir is inside any registered project
  for (const entry of Object.values(registry.projects)) {
    if (resolved.startsWith(entry.root + path.sep)) {
      return entry;
    }
  }

  return null;
}
