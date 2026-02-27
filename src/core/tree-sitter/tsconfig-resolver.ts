/**
 * TypeScript path alias resolver — reads tsconfig.json paths/baseUrl
 * and resolves aliased imports to absolute file paths.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type AliasResolver = (source: string) => string | null;

interface TsconfigPaths {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const INDEX_SUFFIXES = EXTENSIONS.map(e => `/index${e}`);

/**
 * Create an alias resolver for a workspace directory.
 * Returns null if no tsconfig.json or no paths/baseUrl configured.
 */
export async function createAliasResolver(
  workspaceDir: string,
): Promise<AliasResolver | null> {
  const merged = await loadTsconfigPaths(workspaceDir);
  if (!merged) return null;

  const { baseUrl, paths } = merged;

  // If no paths and no baseUrl, nothing to resolve
  if (!paths && !baseUrl) return null;

  const resolvedBaseUrl = baseUrl
    ? path.resolve(workspaceDir, baseUrl)
    : workspaceDir;

  // Pre-compile path patterns
  const patterns = compilePaths(paths ?? {}, resolvedBaseUrl);

  return (source: string): string | null => {
    // Try path alias patterns first
    for (const pattern of patterns) {
      const result = pattern.resolve(source);
      if (result !== null) return result;
    }

    // If baseUrl is set, try resolving non-relative imports against it
    if (baseUrl && !source.startsWith(".") && !source.startsWith("/")) {
      const candidate = path.resolve(resolvedBaseUrl, source);
      const resolved = resolveToExistingFile(candidate);
      if (resolved) return resolved;
    }

    return null;
  };
}

interface CompiledPattern {
  resolve(source: string): string | null;
}

function compilePaths(
  paths: Record<string, string[]>,
  baseUrl: string,
): CompiledPattern[] {
  const patterns: CompiledPattern[] = [];

  for (const [pattern, targets] of Object.entries(paths)) {
    if (pattern.includes("*")) {
      // Wildcard pattern: "@/*" → ["src/*"]
      const prefix = pattern.slice(0, pattern.indexOf("*"));
      const suffix = pattern.slice(pattern.indexOf("*") + 1);

      const resolvedTargets = targets.map(t => {
        const tPrefix = t.slice(0, t.indexOf("*"));
        const tSuffix = t.slice(t.indexOf("*") + 1);
        return { baseDir: path.resolve(baseUrl, tPrefix), suffix: tSuffix };
      });

      patterns.push({
        resolve(source: string): string | null {
          if (!source.startsWith(prefix)) return null;
          if (suffix && !source.endsWith(suffix)) return null;

          const star = suffix
            ? source.slice(prefix.length, -suffix.length || undefined)
            : source.slice(prefix.length);

          for (const target of resolvedTargets) {
            const candidate = path.join(target.baseDir, star + target.suffix);
            const resolved = resolveToExistingFile(candidate);
            if (resolved) return resolved;
          }
          return null;
        },
      });
    } else {
      // Exact pattern: "@utils" → ["src/utils/index"]
      const resolvedTargets = targets.map(t => path.resolve(baseUrl, t));

      patterns.push({
        resolve(source: string): string | null {
          if (source !== pattern) return null;
          for (const target of resolvedTargets) {
            const resolved = resolveToExistingFile(target);
            if (resolved) return resolved;
          }
          return null;
        },
      });
    }
  }

  return patterns;
}

/**
 * Try to resolve a path to an existing file with extension variants.
 */
function resolveToExistingFile(candidate: string): string | null {
  const candidates = [
    candidate,
    ...EXTENSIONS.map(e => candidate + e),
    ...INDEX_SUFFIXES.map(s => candidate + s),
  ];

  for (const c of candidates) {
    try {
      const stat = fs.statSync(c);
      if (stat.isFile()) return c;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Load tsconfig.json paths, following extends chain.
 */
async function loadTsconfigPaths(
  workspaceDir: string,
): Promise<TsconfigPaths | null> {
  const tsconfigPath = path.join(workspaceDir, "tsconfig.json");

  let content: string;
  try {
    content = await fsp.readFile(tsconfigPath, "utf-8");
  } catch {
    return null;
  }

  let tsconfig: Record<string, unknown>;
  try {
    tsconfig = JSON.parse(stripJsonComments(content));
  } catch {
    return null;
  }

  // Follow extends chain
  let merged: TsconfigPaths = {};
  if (typeof tsconfig.extends === "string") {
    const parentPaths = await resolveExtends(tsconfig.extends, workspaceDir);
    if (parentPaths) {
      merged = { ...parentPaths };
    }
  }

  const compilerOptions = tsconfig.compilerOptions as Record<string, unknown> | undefined;
  if (compilerOptions) {
    if (typeof compilerOptions.baseUrl === "string") {
      merged.baseUrl = compilerOptions.baseUrl;
    }
    if (compilerOptions.paths && typeof compilerOptions.paths === "object") {
      merged.paths = compilerOptions.paths as Record<string, string[]>;
    }
  }

  if (!merged.baseUrl && !merged.paths) return null;
  return merged;
}

/**
 * Resolve an extends reference and extract paths config.
 */
async function resolveExtends(
  extendsRef: string,
  fromDir: string,
): Promise<TsconfigPaths | null> {
  let resolvedPath: string;

  if (extendsRef.startsWith(".")) {
    // Relative path
    resolvedPath = path.resolve(fromDir, extendsRef);
    if (!resolvedPath.endsWith(".json")) resolvedPath += ".json";
  } else {
    // Package reference like "next/core" → node_modules/next/core.json or node_modules/next/core/tsconfig.json
    const candidates = [
      path.join(fromDir, "node_modules", extendsRef + ".json"),
      path.join(fromDir, "node_modules", extendsRef, "tsconfig.json"),
      path.join(fromDir, "node_modules", extendsRef),
    ];

    resolvedPath = "";
    for (const c of candidates) {
      try {
        fs.accessSync(c);
        resolvedPath = c;
        break;
      } catch {
        // continue
      }
    }
    if (!resolvedPath) return null;
  }

  let content: string;
  try {
    content = await fsp.readFile(resolvedPath, "utf-8");
  } catch {
    return null;
  }

  let parentConfig: Record<string, unknown>;
  try {
    parentConfig = JSON.parse(stripJsonComments(content));
  } catch {
    return null;
  }

  const result: TsconfigPaths = {};
  const compilerOptions = parentConfig.compilerOptions as Record<string, unknown> | undefined;
  if (compilerOptions) {
    if (typeof compilerOptions.baseUrl === "string") {
      result.baseUrl = compilerOptions.baseUrl;
    }
    if (compilerOptions.paths && typeof compilerOptions.paths === "object") {
      result.paths = compilerOptions.paths as Record<string, string[]>;
    }
  }

  return (result.baseUrl || result.paths) ? result : null;
}

/**
 * Strip single-line and multi-line comments from JSON (tsconfig allows them).
 */
function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;

  while (i < text.length) {
    if (inString) {
      if (text[i] === "\\" && i + 1 < text.length) {
        result += text[i] + text[i + 1];
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        inString = false;
      }
      result += text[i];
      i++;
    } else {
      if (text[i] === '"') {
        inString = true;
        result += text[i];
        i++;
      } else if (text[i] === "/" && i + 1 < text.length && text[i + 1] === "/") {
        // Single-line comment — skip to end of line
        while (i < text.length && text[i] !== "\n") i++;
      } else if (text[i] === "/" && i + 1 < text.length && text[i + 1] === "*") {
        // Multi-line comment
        i += 2;
        while (i < text.length && !(text[i] === "*" && i + 1 < text.length && text[i + 1] === "/")) i++;
        i += 2; // skip */
      } else {
        result += text[i];
        i++;
      }
    }
  }

  return result;
}
