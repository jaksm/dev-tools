/**
 * AGENTS.md generator — produces project context markdown from static analysis.
 * Pure static analysis, no LLM calls, no network requests.
 * Gracefully degrades when any source file is missing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { StorageManager } from "./types.js";
import type { IndexJson } from "./index/index-json.js";

// ── Well-known package descriptions ─────────────────────────────────────────

const KNOWN_PACKAGES: Record<string, string> = {
  // Frameworks
  "next": "Next.js framework",
  "react": "UI library",
  "react-dom": "React DOM renderer",
  "vue": "Vue.js framework",
  "nuxt": "Nuxt framework",
  "svelte": "Svelte compiler",
  "@sveltejs/kit": "SvelteKit framework",
  "express": "web framework",
  "fastify": "web framework",
  "hono": "lightweight web framework",
  "@hono/node-server": "Hono Node.js adapter",
  "koa": "web framework",
  "nest": "enterprise Node.js framework",
  "@nestjs/core": "NestJS core",
  "@nestjs/common": "NestJS common utilities",
  "remix": "Remix framework",
  "@remix-run/node": "Remix Node.js runtime",
  "gatsby": "static site generator",
  "astro": "content-focused framework",
  "solid-js": "SolidJS reactive UI",

  // State management
  "redux": "state management",
  "@reduxjs/toolkit": "Redux Toolkit",
  "zustand": "state management",
  "jotai": "atomic state management",
  "recoil": "state management",
  "mobx": "observable state management",
  "pinia": "Vue state management",
  "vuex": "Vue state management",

  // Styling
  "tailwindcss": "utility-first CSS framework",
  "styled-components": "CSS-in-JS",
  "@emotion/react": "CSS-in-JS",
  "sass": "CSS preprocessor",
  "postcss": "CSS post-processor",

  // Database / ORM
  "prisma": "ORM",
  "@prisma/client": "Prisma client",
  "drizzle-orm": "TypeScript ORM",
  "typeorm": "ORM",
  "sequelize": "ORM",
  "mongoose": "MongoDB ODM",
  "knex": "SQL query builder",
  "pg": "PostgreSQL client",
  "mysql2": "MySQL client",
  "better-sqlite3": "SQLite driver",
  "redis": "Redis client",
  "ioredis": "Redis client",

  // Auth
  "next-auth": "authentication for Next.js",
  "@auth/core": "Auth.js core",
  "passport": "authentication middleware",
  "jsonwebtoken": "JWT implementation",
  "bcrypt": "password hashing",
  "bcryptjs": "password hashing",
  "@supabase/supabase-js": "Supabase client",
  "firebase": "Firebase SDK",

  // API / HTTP
  "axios": "HTTP client",
  "node-fetch": "Fetch API for Node.js",
  "graphql": "GraphQL query language",
  "@apollo/client": "Apollo GraphQL client",
  "@apollo/server": "Apollo GraphQL server",
  "trpc": "end-to-end typesafe APIs",
  "@trpc/server": "tRPC server",
  "@trpc/client": "tRPC client",
  "zod": "schema validation",
  "joi": "schema validation",
  "yup": "schema validation",
  "@sinclair/typebox": "JSON Schema type builder",

  // Testing
  "vitest": "test framework",
  "jest": "test framework",
  "mocha": "test framework",
  "@testing-library/react": "React testing utilities",
  "@testing-library/jest-dom": "Jest DOM matchers",
  "playwright": "browser testing",
  "@playwright/test": "Playwright test runner",
  "cypress": "E2E testing",
  "supertest": "HTTP assertion library",
  "msw": "API mocking",
  "nock": "HTTP mocking",
  "c8": "code coverage",
  "nyc": "code coverage",
  "@vitest/coverage-v8": "Vitest coverage",

  // Build tools
  "typescript": "TypeScript compiler",
  "esbuild": "JavaScript bundler",
  "vite": "build tool & dev server",
  "webpack": "module bundler",
  "rollup": "module bundler",
  "tsup": "TypeScript bundler",
  "unbuild": "build tool",
  "turbo": "monorepo build system",
  "nx": "monorepo build system",

  // Linting / Formatting
  "eslint": "linter",
  "prettier": "code formatter",
  "biome": "linter & formatter",
  "@biomejs/biome": "linter & formatter",
  "oxlint": "linter",

  // Utilities
  "lodash": "utility library",
  "ramda": "functional utility library",
  "date-fns": "date utilities",
  "dayjs": "date library",
  "luxon": "date/time library",
  "uuid": "UUID generation",
  "nanoid": "ID generation",
  "chalk": "terminal colors",
  "commander": "CLI framework",
  "yargs": "CLI argument parsing",
  "inquirer": "interactive CLI prompts",
  "dotenv": "environment variable loader",
  "winston": "logging",
  "pino": "logging",
  "debug": "debug logging",

  // React Native / Mobile
  "react-native": "mobile framework",
  "expo": "React Native toolchain",
  "@expo/vector-icons": "Expo icons",

  // Deployment / Infra
  "serverless": "serverless framework",
  "aws-sdk": "AWS SDK",
  "@aws-sdk/client-s3": "AWS S3 client",
  "docker-compose": "Docker orchestration",
};

// ── Framework detection ─────────────────────────────────────────────────────

interface FrameworkMatch {
  name: string;
  dep: string;
}

const FRAMEWORK_DETECTORS: Array<{ deps: string[]; name: string }> = [
  { deps: ["next"], name: "Next.js" },
  { deps: ["nuxt"], name: "Nuxt" },
  { deps: ["@remix-run/node", "@remix-run/react"], name: "Remix" },
  { deps: ["gatsby"], name: "Gatsby" },
  { deps: ["astro"], name: "Astro" },
  { deps: ["@sveltejs/kit"], name: "SvelteKit" },
  { deps: ["svelte"], name: "Svelte" },
  { deps: ["@nestjs/core"], name: "NestJS" },
  { deps: ["@hono/node-server", "hono"], name: "Hono" },
  { deps: ["fastify"], name: "Fastify" },
  { deps: ["express"], name: "Express" },
  { deps: ["koa"], name: "Koa" },
  { deps: ["react-native", "expo"], name: "React Native" },
  { deps: ["react"], name: "React" },
  { deps: ["vue"], name: "Vue" },
  { deps: ["solid-js"], name: "SolidJS" },
];

function detectFrameworks(allDeps: Record<string, string>): FrameworkMatch[] {
  const matches: FrameworkMatch[] = [];
  const seen = new Set<string>();

  for (const detector of FRAMEWORK_DETECTORS) {
    if (seen.has(detector.name)) continue;
    for (const dep of detector.deps) {
      if (allDeps[dep]) {
        matches.push({ name: detector.name, dep });
        seen.add(detector.name);
        break;
      }
    }
  }

  return matches;
}

// ── Runtime detection ───────────────────────────────────────────────────────

async function detectRuntime(projectDir: string, pkg: PackageJson): Promise<string> {
  // Check engines field
  if (pkg.engines) {
    if (pkg.engines["bun"]) return "Bun";
    if (pkg.engines["deno"]) return "Deno";
    if (pkg.engines["node"]) return `Node.js ${pkg.engines["node"]}`;
  }

  // Check lockfiles
  try {
    await fs.access(path.join(projectDir, "bun.lockb"));
    return "Bun";
  } catch { /* ignore */ }

  try {
    await fs.access(path.join(projectDir, "bun.lock"));
    return "Bun";
  } catch { /* ignore */ }

  try {
    await fs.access(path.join(projectDir, "deno.lock"));
    return "Deno";
  } catch { /* ignore */ }

  return "Node.js";
}

// ── Types ───────────────────────────────────────────────────────────────────

interface PackageJson {
  name?: string;
  description?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

interface TsConfig {
  compilerOptions?: {
    target?: string;
    module?: string;
    strict?: boolean;
    outDir?: string;
    paths?: Record<string, string[]>;
  };
}

interface EnvVar {
  name: string;
  comment: string | null;
}

// ── File readers (graceful) ─────────────────────────────────────────────────

async function readPackageJson(projectDir: string): Promise<PackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(projectDir, "package.json"), "utf-8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

async function readTsConfig(projectDir: string): Promise<TsConfig | null> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const raw = await fs.readFile(path.join(projectDir, name), "utf-8");
      // Strip comments (tsconfig allows them)
      const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      return JSON.parse(stripped) as TsConfig;
    } catch {
      continue;
    }
  }
  return null;
}

async function readEnvExample(projectDir: string): Promise<EnvVar[]> {
  for (const name of [".env.example", ".env.local.example", ".env.sample"]) {
    try {
      const raw = await fs.readFile(path.join(projectDir, name), "utf-8");
      return parseEnvFile(raw);
    } catch {
      continue;
    }
  }
  return [];
}

function parseEnvFile(content: string): EnvVar[] {
  const vars: EnvVar[] = [];
  let pendingComment: string | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("#")) {
      // Accumulate comment
      const commentText = trimmed.replace(/^#+\s*/, "").trim();
      if (commentText) {
        pendingComment = pendingComment ? `${pendingComment}; ${commentText}` : commentText;
      }
      continue;
    }

    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=/i);
    if (match) {
      vars.push({ name: match[1], comment: pendingComment });
      pendingComment = null;
    } else if (trimmed === "") {
      pendingComment = null;
    }
  }

  return vars;
}

// ── Section builders ────────────────────────────────────────────────────────

function buildOverview(pkg: PackageJson): string {
  const parts: string[] = [];
  if (pkg.name) parts.push(`**${pkg.name}**`);
  if (pkg.version) parts.push(`v${pkg.version}`);
  const nameLine = parts.join(" ");
  if (pkg.description) {
    return nameLine ? `${nameLine} — ${pkg.description}` : pkg.description;
  }
  return nameLine || "No description available.";
}

async function buildTechStack(
  projectDir: string,
  pkg: PackageJson | null,
  tsconfig: TsConfig | null,
  testRunners: string[],
): Promise<string[]> {
  const lines: string[] = [];
  const allDeps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };

  // Runtime
  const runtime = pkg ? await detectRuntime(projectDir, pkg) : "Unknown";
  lines.push(`- **Runtime:** ${runtime}`);

  // Language
  if (tsconfig) {
    const tsVersion = allDeps["typescript"] ?? "";
    const strict = tsconfig.compilerOptions?.strict ? "yes" : "no";
    const versionStr = tsVersion ? ` ${tsVersion}` : "";
    lines.push(`- **Language:** TypeScript${versionStr} (strict: ${strict})`);
  } else if (pkg) {
    lines.push("- **Language:** JavaScript");
  }

  // Framework
  if (pkg) {
    const frameworks = detectFrameworks(allDeps);
    if (frameworks.length > 0) {
      const fwStr = frameworks.map(f => {
        const version = allDeps[f.dep];
        return version ? `${f.name} ${version}` : f.name;
      }).join(", ");
      lines.push(`- **Framework:** ${fwStr}`);
    }
  }

  // Testing
  if (testRunners.length > 0) {
    lines.push(`- **Testing:** ${testRunners.join(", ")}`);
  }

  // Build
  if (pkg?.scripts?.["build"]) {
    lines.push(`- **Build:** \`${pkg.scripts["build"]}\``);
  } else if (tsconfig?.compilerOptions?.outDir) {
    lines.push(`- **Build:** TypeScript → ${tsconfig.compilerOptions.outDir}`);
  }

  return lines;
}

function buildCommands(pkg: PackageJson): string[] {
  const commandMap: Array<[string, string]> = [
    ["Build", "build"],
    ["Test", "test"],
    ["Dev", "dev"],
    ["Lint", "lint"],
    ["Start", "start"],
    ["Format", "format"],
    ["Typecheck", "typecheck"],
  ];

  const rows: string[] = [];
  for (const [label, key] of commandMap) {
    const script = pkg.scripts?.[key];
    if (script) {
      const cmd = key === "test" ? "npm test" : `npm run ${key}`;
      rows.push(`| ${label} | \`${cmd}\` | \`${script}\` |`);
    }
  }

  if (rows.length === 0) return [];

  return [
    "| Command | Run | Script |",
    "|---|---|---|",
    ...rows,
  ];
}

function buildProjectStructure(indexJson: IndexJson): string[] {
  // Aggregate top-level directory stats
  const dirStats = new Map<string, { files: number; symbols: number }>();

  for (const entry of indexJson.files) {
    const parts = entry.file.split("/");
    const topDir = parts.length > 1 ? parts[0] : "(root)";
    const stats = dirStats.get(topDir) ?? { files: 0, symbols: 0 };
    stats.files++;
    stats.symbols += entry.symbols;
    dirStats.set(topDir, stats);
  }

  // Sort by file count descending
  const sorted = [...dirStats.entries()].sort((a, b) => b[1].files - a[1].files);

  const lines: string[] = [];
  for (const [dir, stats] of sorted) {
    const symbolNote = stats.symbols > 0 ? `, ${stats.symbols} symbols` : "";
    lines.push(`- \`${dir}/\` — ${stats.files} files${symbolNote}`);
  }

  return lines;
}

function buildKeyFiles(indexJson: IndexJson): string[] {
  // Top 10 by rank (already sorted)
  const top = indexJson.files.slice(0, 10);
  if (top.length === 0) return [];

  const lines: string[] = [];
  for (const entry of top) {
    const exportsStr = entry.exports.length > 0
      ? ` — exports: ${entry.exports.slice(0, 5).join(", ")}${entry.exports.length > 5 ? "…" : ""}`
      : "";
    lines.push(`- \`${entry.file}\` (${entry.lines} lines, ${entry.symbols} symbols${exportsStr})`);
  }

  return lines;
}

function buildEnvVars(envVars: EnvVar[]): string[] {
  if (envVars.length === 0) return [];

  const lines: string[] = [];
  for (const v of envVars) {
    const desc = v.comment ? ` — ${v.comment}` : "";
    lines.push(`- \`${v.name}\`${desc}`);
  }
  return lines;
}

function buildDependencies(deps: Record<string, string>, label: string): string[] {
  const entries = Object.entries(deps);
  if (entries.length === 0) return [];

  const lines: string[] = [`### ${label}`];
  for (const [name, version] of entries) {
    const desc = KNOWN_PACKAGES[name];
    if (desc) {
      lines.push(`- \`${name}\` ${version} — ${desc}`);
    } else {
      lines.push(`- \`${name}\` ${version}`);
    }
  }
  return lines;
}

// ── Main generator ──────────────────────────────────────────────────────────

/**
 * Generate AGENTS.md content from static project analysis.
 * Never throws — returns minimal markdown on any error.
 */
export async function generateAgentsMd(
  projectDir: string,
  _storage: StorageManager,
  indexJson?: IndexJson,
): Promise<string> {
  const pkg = await readPackageJson(projectDir);
  const tsconfig = await readTsConfig(projectDir);
  const envVars = await readEnvExample(projectDir);

  const projectName = pkg?.name ?? path.basename(projectDir);
  const sections: string[] = [];

  // Header
  sections.push(`# AGENTS.md — ${projectName}\n`);

  // Overview
  if (pkg) {
    sections.push(`## Overview\n${buildOverview(pkg)}\n`);
  }

  // Tech Stack
  const testRunnerNames = detectTestRunnerNames(pkg);
  const techStack = await buildTechStack(projectDir, pkg, tsconfig, testRunnerNames);
  if (techStack.length > 0) {
    sections.push(`## Tech Stack\n${techStack.join("\n")}\n`);
  }

  // Commands
  if (pkg) {
    const commands = buildCommands(pkg);
    if (commands.length > 0) {
      sections.push(`## Commands\n${commands.join("\n")}\n`);
    }
  }

  // Project Structure
  if (indexJson && indexJson.files.length > 0) {
    const structure = buildProjectStructure(indexJson);
    if (structure.length > 0) {
      sections.push(`## Project Structure\n${structure.join("\n")}\n`);
    }
  }

  // Key Files
  if (indexJson && indexJson.files.length > 0) {
    const keyFiles = buildKeyFiles(indexJson);
    if (keyFiles.length > 0) {
      sections.push(`## Key Files\n${keyFiles.join("\n")}\n`);
    }
  }

  // Environment Variables
  const envLines = buildEnvVars(envVars);
  if (envLines.length > 0) {
    sections.push(`## Environment Variables\n${envLines.join("\n")}\n`);
  }

  // Dependencies
  if (pkg) {
    const depSections: string[] = [];
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      depSections.push(...buildDependencies(pkg.dependencies, "Production"));
    }
    if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) {
      depSections.push(...buildDependencies(pkg.devDependencies, "Development"));
    }
    if (depSections.length > 0) {
      sections.push(`## Dependencies\n${depSections.join("\n")}\n`);
    }
  }

  return sections.join("\n").trim() + "\n";
}

/**
 * Detect test runner names from package.json deps (lightweight, no filesystem scan).
 */
function detectTestRunnerNames(pkg: PackageJson | null): string[] {
  if (!pkg) return [];
  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  const runners: string[] = [];
  if (allDeps["vitest"]) runners.push("Vitest");
  if (allDeps["jest"]) runners.push("Jest");
  if (allDeps["mocha"]) runners.push("Mocha");
  if (allDeps["@playwright/test"] || allDeps["playwright"]) runners.push("Playwright");
  if (allDeps["cypress"]) runners.push("Cypress");
  return runners;
}

/**
 * Write AGENTS.md to the storage directory.
 */
export async function writeAgentsMd(
  content: string,
  storageDir: string,
): Promise<string> {
  const filePath = path.join(storageDir, "AGENTS.md");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

/**
 * Read AGENTS.md from storage directory.
 * Returns null if not found.
 */
export async function readAgentsMd(storageDir: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(storageDir, "AGENTS.md"), "utf-8");
  } catch {
    return null;
  }
}
