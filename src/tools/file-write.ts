/**
 * file_write — Create or overwrite file with auto-create parent dirs.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "../core/types.js";
import { resolvePath } from "../core/security.js";
import { withFileLock } from "../core/file-mutex.js";

export interface FileWriteParams {
  path: string;
  content: string;
}

export async function fileWrite(params: FileWriteParams, ctx: ToolContext): Promise<unknown> {
  const { workspaceDir } = ctx;
  const resolvedPath = resolvePath(params.path, workspaceDir);

  return withFileLock(resolvedPath, async () => {
    // Check if file already exists
    let existed = false;
    try {
      await fs.access(resolvedPath);
      existed = true;
    } catch {
      // File doesn't exist — will create
    }

    // Auto-create parent directories
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

    // Write the file
    const bytes = Buffer.byteLength(params.content, "utf-8");
    await fs.writeFile(resolvedPath, params.content, "utf-8");

    return {
      [existed ? "overwritten" : "created"]: true,
      path: path.relative(workspaceDir, resolvedPath),
      bytes,
    };
  });
}
