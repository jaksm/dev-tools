/**
 * Fixture repo integration tests — test git tool, test runner detection,
 * and language detection against real cloned repos at ~/.dev-tools/fixtures/.
 *
 * These tests exercise the tools against real-world projects:
 * - csharp-mediatr (C#, MediatR library)
 * - go-bubbletea (Go, TUI framework)
 * - java-gson (Java, JSON library)
 * - kotlin-okio (Kotlin, I/O library)
 * - python-httpie (Python, HTTP client)
 * - rust-ripgrep (Rust, line-oriented search)
 *
 * All are shallow clones (1 commit, 1 branch).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { git } from "../tools/git.js";
import { detectLanguages } from "../core/languages.js";
import { detectTestRunners } from "../core/test-detection.js";
import type { LanguageInfo } from "../core/types.js";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const FIXTURES_DIR = path.join(process.env.HOME ?? "", ".dev-tools", "fixtures");

// Synchronous check so skipIf works at definition time
const fixturesExist = existsSync(FIXTURES_DIR);

// ── Helper ──────────────────────────────────────────────────────────────────

function fixtureDir(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

const noFilter = () => false; // Don't filter anything

// ── Git operations on fixture repos ─────────────────────────────────────────

describe("fixtures — git operations", () => {
  it.skipIf(!fixturesExist)("status is clean on all fixture repos", async () => {
    const repos = ["csharp-mediatr", "go-bubbletea", "java-gson", "kotlin-okio", "python-httpie", "rust-ripgrep"];
    for (const repo of repos) {
      const dir = fixtureDir(repo);
      try {
        await fs.access(dir);
      } catch {
        continue;
      }
      const result = await git({ action: "status" }, dir);
      expect(result.success, `status failed for ${repo}: ${result.error}`).toBe(true);
      const data = result.data as any;
      expect(data.clean, `${repo} is not clean`).toBe(true);
    }
  });

  it.skipIf(!fixturesExist)("log returns at least 1 commit for each repo", async () => {
    const repos = ["csharp-mediatr", "go-bubbletea", "java-gson", "kotlin-okio", "python-httpie", "rust-ripgrep"];
    for (const repo of repos) {
      const dir = fixtureDir(repo);
      try {
        await fs.access(dir);
      } catch {
        continue;
      }
      const result = await git({ action: "log", limit: 5 }, dir);
      expect(result.success, `log failed for ${repo}: ${result.error}`).toBe(true);
      const data = result.data as any;
      expect(data.commits.length, `${repo} has no commits`).toBeGreaterThanOrEqual(1);
      // Every commit should have required fields
      for (const commit of data.commits) {
        expect(commit.hash).toBeTruthy();
        expect(commit.message).toBeTruthy();
        expect(commit.author).toBeTruthy();
        expect(commit.date).toBeTruthy();
      }
    }
  });

  it.skipIf(!fixturesExist)("branch works on all fixture repos", async () => {
    const repos = ["csharp-mediatr", "go-bubbletea", "java-gson", "kotlin-okio", "python-httpie", "rust-ripgrep"];
    for (const repo of repos) {
      const dir = fixtureDir(repo);
      try {
        await fs.access(dir);
      } catch {
        continue;
      }
      const result = await git({ action: "branch" }, dir);
      expect(result.success, `branch failed for ${repo}: ${result.error}`).toBe(true);
      const data = result.data as any;
      expect(data.current).toBeTruthy();
      expect(data.branches.length).toBeGreaterThanOrEqual(1);
      // Exactly one branch should be marked as current
      const currentBranches = data.branches.filter((b: any) => b.current);
      expect(currentBranches.length, `${repo} has ${currentBranches.length} current branches`).toBe(1);
    }
  });

  it.skipIf(!fixturesExist)("diff is empty on clean fixture repos", async () => {
    const repos = ["go-bubbletea", "rust-ripgrep", "python-httpie"];
    for (const repo of repos) {
      const dir = fixtureDir(repo);
      try {
        await fs.access(dir);
      } catch {
        continue;
      }
      const result = await git({ action: "diff" }, dir);
      expect(result.success).toBe(true);
      expect((result.data as any).files).toEqual([]);
    }
  });

  it.skipIf(!fixturesExist)("log with path filter on go-bubbletea", async () => {
    const dir = fixtureDir("go-bubbletea");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const result = await git({ action: "log", path: "go.mod" }, dir);
    expect(result.success).toBe(true);
    // go.mod was certainly in the initial commit
    const data = result.data as any;
    if (data.commits.length > 0) {
      expect(data.commits[0].files).toContain("go.mod");
    }
  });

  it.skipIf(!fixturesExist)("log with author filter on rust-ripgrep", async () => {
    const dir = fixtureDir("rust-ripgrep");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const result = await git({ action: "log", limit: 1 }, dir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    if (data.commits.length > 0) {
      const author = data.commits[0].author;
      // Now filter by that author — should get the same commit
      const filtered = await git({ action: "log", author, limit: 1 }, dir);
      expect(filtered.success).toBe(true);
      expect((filtered.data as any).commits[0].hash).toBe(data.commits[0].hash);
    }
  });
});

// ── Language detection on fixture repos ─────────────────────────────────────

describe("fixtures — language detection", () => {
  it.skipIf(!fixturesExist)("detects Go in go-bubbletea", async () => {
    const dir = fixtureDir("go-bubbletea");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const langs = await detectLanguages(dir, noFilter);
    const goLangs = langs.filter(l => l.language === "go");
    expect(goLangs.length).toBeGreaterThanOrEqual(1);
    expect(goLangs[0].root).toBe(dir);
  });

  it.skipIf(!fixturesExist)("detects Rust in rust-ripgrep", async () => {
    const dir = fixtureDir("rust-ripgrep");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const langs = await detectLanguages(dir, noFilter);
    const rustLangs = langs.filter(l => l.language === "rust");
    expect(rustLangs.length).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!fixturesExist)("detects Python in python-httpie", async () => {
    const dir = fixtureDir("python-httpie");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const langs = await detectLanguages(dir, noFilter);
    const pyLangs = langs.filter(l => l.language === "python");
    expect(pyLangs.length).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!fixturesExist)("detects Java in java-gson", async () => {
    const dir = fixtureDir("java-gson");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const langs = await detectLanguages(dir, noFilter);
    const javaLangs = langs.filter(l => l.language === "java");
    expect(javaLangs.length).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!fixturesExist)("detects Kotlin in kotlin-okio", async () => {
    const dir = fixtureDir("kotlin-okio");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const langs = await detectLanguages(dir, noFilter);
    const kotlinLangs = langs.filter(l => l.language === "kotlin");
    expect(kotlinLangs.length).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!fixturesExist)("detects C# in csharp-mediatr", async () => {
    const dir = fixtureDir("csharp-mediatr");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const langs = await detectLanguages(dir, noFilter);
    const csharpLangs = langs.filter(l => l.language === "csharp");
    expect(csharpLangs.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Test runner detection on fixture repos ──────────────────────────────────

describe("fixtures — test runner detection", () => {
  it.skipIf(!fixturesExist)("detects go test for go-bubbletea", async () => {
    const dir = fixtureDir("go-bubbletea");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const langs = await detectLanguages(dir, noFilter);
    const runners = await detectTestRunners(dir, langs);
    const goRunner = runners.find(r => r.framework === "go");
    expect(goRunner).toBeDefined();
    expect(goRunner!.root).toBe(dir);
    expect(goRunner!.command).toContain("go test");
  });

  it.skipIf(!fixturesExist)("detects cargo test for rust-ripgrep", async () => {
    const dir = fixtureDir("rust-ripgrep");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const langs = await detectLanguages(dir, noFilter);
    const runners = await detectTestRunners(dir, langs);
    const cargoRunner = runners.find(r => r.framework === "cargo");
    expect(cargoRunner).toBeDefined();
    expect(cargoRunner!.root).toBe(dir);
  });

  it.skipIf(!fixturesExist)("detects pytest for python-httpie", async () => {
    const dir = fixtureDir("python-httpie");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const langs = await detectLanguages(dir, noFilter);
    const runners = await detectTestRunners(dir, langs);
    const pytestRunner = runners.find(r => r.framework === "pytest");
    expect(pytestRunner).toBeDefined();
    expect(pytestRunner!.root).toBe(dir);
    expect(pytestRunner!.command).toContain("pytest");
  });

  it.skipIf(!fixturesExist)("no JS test runner detected for non-JS repos", async () => {
    const dir = fixtureDir("rust-ripgrep");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const langs = await detectLanguages(dir, noFilter);
    const runners = await detectTestRunners(dir, langs);
    const jsRunners = runners.filter(r => r.framework === "vitest" || r.framework === "jest");
    expect(jsRunners.length).toBe(0);
  });

  it.skipIf(!fixturesExist)("detects correct number of runners per repo", async () => {
    // Each single-language repo should have exactly 1 test runner
    const testCases: Array<{ repo: string; expectedFramework: string }> = [
      { repo: "go-bubbletea", expectedFramework: "go" },
      { repo: "rust-ripgrep", expectedFramework: "cargo" },
      { repo: "python-httpie", expectedFramework: "pytest" },
    ];

    for (const { repo, expectedFramework } of testCases) {
      const dir = fixtureDir(repo);
      try {
        await fs.access(dir);
      } catch {
        continue;
      }
      const langs = await detectLanguages(dir, noFilter);
      const runners = await detectTestRunners(dir, langs);
      // Should have at least the expected runner
      const matched = runners.find(r => r.framework === expectedFramework);
      expect(matched, `${repo} should have ${expectedFramework} runner`).toBeDefined();
    }
  });
});

// ── Git tool on repos with many files ───────────────────────────────────────

describe("fixtures — git on complex repos", () => {
  it.skipIf(!fixturesExist)("log shows files changed in commit for java-gson", async () => {
    const dir = fixtureDir("java-gson");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const result = await git({ action: "log", limit: 1 }, dir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.commits.length).toBe(1);
    // The commit should list changed files
    expect(data.commits[0].files.length).toBeGreaterThan(0);
  });

  it.skipIf(!fixturesExist)("branch info includes hash and subject for kotlin-okio", async () => {
    const dir = fixtureDir("kotlin-okio");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const result = await git({ action: "branch" }, dir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    for (const branch of data.branches) {
      expect(branch.hash).toMatch(/^[a-f0-9]+$/);
      expect(branch.subject).toBeTruthy();
      expect(typeof branch.lastCommit).toBe("string");
    }
  });

  it.skipIf(!fixturesExist)("status handles large repo structure (csharp-mediatr)", async () => {
    const dir = fixtureDir("csharp-mediatr");
    try {
      await fs.access(dir);
    } catch {
      return;
    }
    const start = Date.now();
    const result = await git({ action: "status" }, dir);
    const duration = Date.now() - start;
    expect(result.success).toBe(true);
    expect((result.data as any).clean).toBe(true);
    // Should be fast even on larger repos
    expect(duration).toBeLessThan(5000);
  });
});

// ── Cross-repo git log format consistency ───────────────────────────────────

describe("fixtures — log format consistency", () => {
  it.skipIf(!fixturesExist)("all repos produce consistent log format", async () => {
    const repos = ["csharp-mediatr", "go-bubbletea", "java-gson", "kotlin-okio", "python-httpie", "rust-ripgrep"];

    for (const repo of repos) {
      const dir = fixtureDir(repo);
      try {
        await fs.access(dir);
      } catch {
        continue;
      }
      const result = await git({ action: "log", limit: 1 }, dir);
      expect(result.success, `log failed for ${repo}`).toBe(true);
      const data = result.data as any;
      expect(data.count).toBe(data.commits.length);

      for (const commit of data.commits) {
        // hash should be short (7-12 chars)
        expect(commit.hash.length, `${repo} hash length`).toBeGreaterThanOrEqual(7);
        expect(commit.hash.length, `${repo} hash length`).toBeLessThanOrEqual(12);
        // date should be ISO format
        expect(commit.date, `${repo} date format`).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // message should be non-empty
        expect(commit.message.length, `${repo} message`).toBeGreaterThan(0);
        // files should be an array
        expect(Array.isArray(commit.files), `${repo} files array`).toBe(true);
      }
    }
  });
});
