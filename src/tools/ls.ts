/**
 * ls — List directory with configurable depth, sizes, child counts, .gitignore-aware.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "../core/types.js";

export interface LsParams {
  path?: string;
  depth?: number;
}

interface LsEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  children?: number;
  entries?: LsEntry[];
}

export async function ls(params: LsParams, ctx: ToolContext): Promise<unknown> {
  const { workspaceDir, workspace } = ctx;
  const targetPath = params.path ?? ".";
  const maxDepth = params.depth ?? 2;
  const resolvedPath = path.resolve(workspaceDir, targetPath);

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      return { error: "not_a_directory", path: targetPath };
    }
  } catch {
    return { error: "directory_not_found", path: targetPath };
  }

  const entries = await listRecursive(
    resolvedPath,
    workspaceDir,
    workspace.gitignoreFilter,
    maxDepth,
    0,
  );

  return { entries, path: targetPath };
}

async function listRecursive(
  dirPath: string,
  workspaceRoot: string,
  isIgnored: (relPath: string) => boolean,
  maxDepth: number,
  currentDepth: number,
): Promise<LsEntry[]> {
  let items: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    const raw = await fs.readdir(dirPath, { withFileTypes: true });
    items = raw.map((d) => ({ name: String(d.name), isDirectory: () => d.isDirectory(), isFile: () => d.isFile() }));
  } catch {
    return [];
  }

  const entries: LsEntry[] = [];

  // Sort: directories first, then alphabetical
  items.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    const relPath = path.relative(workspaceRoot, fullPath);

    if (isIgnored(relPath)) continue;

    if (item.isDirectory()) {
      const entry: LsEntry = { name: item.name + "/", type: "dir" };

      // Count children
      try {
        const children = await fs.readdir(fullPath);
        entry.children = children.length;
      } catch {
        entry.children = 0;
      }

      // Recurse if within depth
      if (currentDepth < maxDepth - 1) {
        entry.entries = await listRecursive(
          fullPath, workspaceRoot, isIgnored, maxDepth, currentDepth + 1,
        );
      }

      entries.push(entry);
    } else if (item.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        entries.push({ name: item.name, type: "file", size: stat.size });
      } catch {
        entries.push({ name: item.name, type: "file" });
      }
    }
  }

  return entries;
}
