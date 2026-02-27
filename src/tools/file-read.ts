/**
 * file_read — Read file contents with line numbers, pagination, binary detection,
 * "did you mean?" suggestions, and directional truncation (tail).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "../core/types.js";
import { truncateIfNeeded } from "../core/token-budget.js";
import { resolvePath } from "../core/security.js";

// Binary detection: common binary extensions
const BINARY_EXTENSIONS = new Set([
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".wasm", ".pyc", ".pyo", ".class",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac", ".ogg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".db", ".sqlite", ".sqlite3",
  ".ttf", ".otf", ".woff", ".woff2",
  ".o", ".a", ".lib",
]);

// Image extensions that can be returned as attachments
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
]);

function isBinaryByExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function isBinaryByContent(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  // Check for null bytes
  if (sample.includes(0)) return true;
  // Check ratio of non-printable characters
  let nonPrintable = 0;
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.3;
}

async function findSuggestions(dirPath: string, filename: string, maxSuggestions: number = 3): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath);
    const lower = filename.toLowerCase();
    const matches = entries
      .filter((e) => e.toLowerCase().includes(lower) || lower.includes(e.toLowerCase()))
      .slice(0, maxSuggestions)
      .map((e) => path.join(dirPath, e));
    return matches;
  } catch {
    return [];
  }
}

export interface FileReadParams {
  path: string;
  offset?: number;
  limit?: number;
}

export async function fileRead(params: FileReadParams, ctx: ToolContext): Promise<unknown> {
  const { workspaceDir, storageDir, config, workspace } = ctx;
  const resolvedPath = resolvePath(params.path, workspaceDir);

  // Check if path is gitignored
  const relativePath = path.relative(workspaceDir, resolvedPath);
  if (workspace.gitignoreFilter(relativePath)) {
    return { error: "file_ignored", path: params.path, message: "File is in .gitignore. Use { ignoreGitignore: true } to override." };
  }

  // Check existence
  try {
    await fs.access(resolvedPath);
  } catch {
    const dir = path.dirname(resolvedPath);
    const basename = path.basename(resolvedPath);
    const suggestions = await findSuggestions(dir, basename);
    return {
      error: "file_not_found",
      path: params.path,
      suggestions: suggestions.length > 0
        ? suggestions.map((s) => path.relative(workspaceDir, s))
        : undefined,
    };
  }

  // Check for binary
  if (isBinaryByExtension(resolvedPath)) {
    const ext = path.extname(resolvedPath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      const stat = await fs.stat(resolvedPath);
      return {
        type: "image",
        path: params.path,
        size: stat.size,
        message: "Image file. Contents available as attachment for multimodal models.",
      };
    }
    const stat = await fs.stat(resolvedPath);
    return {
      error: "binary_file",
      path: params.path,
      size: formatSize(stat.size),
      message: "Binary file detected. Use shell for binary inspection.",
    };
  }

  // Read file
  const rawContent = await fs.readFile(resolvedPath);

  // Content-based binary check
  if (isBinaryByContent(rawContent)) {
    return {
      error: "binary_file",
      path: params.path,
      size: formatSize(rawContent.length),
      message: "Binary file detected (content analysis). Use shell for binary inspection.",
    };
  }

  const fullContent = rawContent.toString("utf-8");
  const allLines = fullContent.split("\n");
  const totalLines = allLines.length;

  // Apply offset/limit
  const offset = Math.max(1, params.offset ?? 1);
  const limit = params.limit ?? totalLines;
  const startIdx = offset - 1;
  const endIdx = Math.min(startIdx + limit, totalLines);
  const selectedLines = allLines.slice(startIdx, endIdx);

  // Format with line numbers
  const lineWidth = String(endIdx).length;
  const formatted = selectedLines
    .map((line, i) => `${String(startIdx + i + 1).padStart(lineWidth)}│ ${line}`)
    .join("\n");

  // Detect language from extension
  const ext = path.extname(resolvedPath).slice(1);
  const language = extToLanguage(ext);

  // Token budget truncation (tail direction — preserve beginning)
  const budget = {
    maxResponseTokens: config.tokenBudget?.maxResponseTokens ?? 4000,
    toolOutputDir: path.join(storageDir, "tool-output"),
  };
  const truncated = await truncateIfNeeded(formatted, "tail", budget);

  const result: Record<string, unknown> = {
    content: truncated.content,
    lines: totalLines,
    language,
  };

  if (offset > 1 || endIdx < totalLines) {
    result.showing = { from: offset, to: endIdx, total: totalLines };
  }

  if (truncated.truncated) {
    result.truncated = true;
    result.hint = truncated.hint;
  }

  return result;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", swift: "swift",
    java: "java", kt: "kotlin", cs: "csharp", rb: "ruby",
    php: "php", dart: "dart", ex: "elixir", exs: "elixir",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    html: "html", css: "css", scss: "scss", json: "json",
    yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown",
    sql: "sql", graphql: "graphql", sh: "bash", bash: "bash",
    dockerfile: "dockerfile", makefile: "makefile",
  };
  return map[ext.toLowerCase()] ?? ext;
}
