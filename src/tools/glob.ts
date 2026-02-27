/**
 * glob — Find files by pattern with .gitignore awareness, sorted by mtime.
 */

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { ToolContext } from "../core/types.js";

export interface GlobParams {
  pattern: string;
  path?: string;
}

export async function glob(params: GlobParams, ctx: ToolContext): Promise<unknown> {
  const { workspaceDir, workspace } = ctx;
  const searchBase = params.path
    ? path.resolve(workspaceDir, params.path)
    : workspaceDir;

  try {
    const entries = await fg(params.pattern, {
      cwd: searchBase,
      dot: false,
      absolute: false,
      stats: true,
      ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"],
    });

    // Filter by gitignore and add stats
    const files: Array<{ path: string; size: number; modified: string }> = [];

    for (const entry of entries) {
      const relPath = params.path
        ? path.join(params.path, entry.path)
        : entry.path;

      if (workspace.gitignoreFilter(relPath)) continue;

      const fullPath = path.resolve(searchBase, entry.path);
      try {
        const stat = await fs.stat(fullPath);
        files.push({
          path: relPath,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      } catch {
        // File disappeared between glob and stat
      }
    }

    // Sort by mtime (most recent first)
    files.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    return { files, total: files.length };
  } catch (err) {
    return {
      error: "glob_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
