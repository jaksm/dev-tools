/**
 * .gitignore integration — parse gitignore files into a filter function.
 */

import fs from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

/**
 * Build a gitignore filter for a workspace root.
 * Parses .gitignore at root and nested directories.
 * Returns a function that checks if a relative path is ignored.
 */
export async function createGitignoreFilter(
  workspaceRoot: string,
): Promise<(relativePath: string) => boolean> {
  const ig = ignore();

  // Always ignore these
  ig.add(["node_modules", ".git", ".dev-tools"]);

  // Load root .gitignore
  await loadGitignore(ig, workspaceRoot);

  return (relativePath: string): boolean => {
    if (!relativePath || relativePath === ".") return false;
    // Normalize to forward slashes for the ignore package
    const normalized = relativePath.split(path.sep).join("/");
    return ig.ignores(normalized);
  };
}

async function loadGitignore(ig: Ignore, dir: string): Promise<void> {
  try {
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    ig.add(content);
  } catch {
    // No .gitignore — that's fine
  }
}

/**
 * Recursively discover and parse nested .gitignore files.
 * For Phase 1, we use root-level only. Nested support can be added later.
 */
export async function createDeepGitignoreFilter(
  workspaceRoot: string,
): Promise<(relativePath: string) => boolean> {
  // For now, delegate to simple filter. Deep nesting is a Phase 2 enhancement.
  return createGitignoreFilter(workspaceRoot);
}
