/**
 * Language detection — scan workspace for config files to identify languages.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { LanguageInfo } from "./types.js";

/** Directories to skip during recursive scanning (performance) */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", "__pycache__",
  ".venv", "venv", "target", ".build", "DerivedData", "Pods",
  ".gradle", ".idea", ".vs", "bin", "obj", "vendor", ".svn",
]);

interface LanguageDetector {
  language: string;
  configFiles: string[];
}

const DETECTORS: LanguageDetector[] = [
  { language: "typescript", configFiles: ["tsconfig.json", "jsconfig.json"] },
  { language: "swift", configFiles: ["Package.swift"] },
  { language: "python", configFiles: ["pyproject.toml", "setup.py", "requirements.txt"] },
  { language: "rust", configFiles: ["Cargo.toml"] },
  { language: "go", configFiles: ["go.mod"] },
  { language: "java", configFiles: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  { language: "csharp", configFiles: ["*.csproj", "*.sln", "*.slnx", "Directory.Build.props"] },
  { language: "ruby", configFiles: ["Gemfile"] },
  { language: "php", configFiles: ["composer.json"] },
  { language: "dart", configFiles: ["pubspec.yaml"] },
  { language: "elixir", configFiles: ["mix.exs"] },
  { language: "kotlin", configFiles: ["build.gradle.kts"] },
];

/** Default max depth for monorepo scanning */
const DEFAULT_MAX_DEPTH = 3;

/**
 * Detect languages present in a workspace by scanning for config files.
 * Scans root level and up to `maxDepth` levels deep (for monorepos).
 */
export async function detectLanguages(
  workspaceRoot: string,
  isIgnored: (relativePath: string) => boolean,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Promise<LanguageInfo[]> {
  const results: LanguageInfo[] = [];
  const seen = new Set<string>();

  await scanDirRecursive(workspaceRoot, workspaceRoot, isIgnored, results, seen, 0, maxDepth);

  return results;
}

/**
 * Recursively scan directories for language config files up to maxDepth.
 */
async function scanDirRecursive(
  dir: string,
  root: string,
  isIgnored: (relativePath: string) => boolean,
  results: LanguageInfo[],
  seen: Set<string>,
  depth: number,
  maxDepth: number,
): Promise<void> {
  await scanDir(dir, root, isIgnored, results, seen);

  if (depth >= maxDepth) return;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = path.relative(root, path.join(dir, entry.name));
      if (isIgnored(rel)) continue;
      // Skip common non-source directories for performance
      if (SKIP_DIRS.has(entry.name)) continue;
      await scanDirRecursive(
        path.join(dir, entry.name), root, isIgnored, results, seen,
        depth + 1, maxDepth,
      );
    }
  } catch {
    // Can't read directory — skip
  }
}

async function scanDir(
  dir: string,
  root: string,
  isIgnored: (relativePath: string) => boolean,
  results: LanguageInfo[],
  seen: Set<string>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  for (const detector of DETECTORS) {
    for (const configFile of detector.configFiles) {
      if (configFile.includes("*")) {
        // Glob pattern — check by extension
        const ext = configFile.replace("*", "");
        const match = entries.find((e) => e.endsWith(ext));
        if (match) {
          const key = `${detector.language}:${dir}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              language: detector.language,
              root: dir,
              configFile: path.join(dir, match),
            });
          }
        }
      } else if (entries.includes(configFile)) {
        const relConfig = path.relative(root, path.join(dir, configFile));
        if (!isIgnored(relConfig)) {
          const key = `${detector.language}:${dir}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              language: detector.language,
              root: dir,
              configFile: path.join(dir, configFile),
            });
          }
        }
      }
    }
  }
}
