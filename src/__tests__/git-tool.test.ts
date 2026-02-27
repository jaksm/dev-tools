/**
 * Tests for the git tool — structured wrappers around git CLI.
 * Uses a real temporary git repo for all tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { git, type GitParams } from "../tools/git.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

let tmpDir: string;

function runGitSync(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "" },
  }).toString();
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-tools-git-"));

  // Initialize a git repo
  runGitSync(["init"], tmpDir);
  runGitSync(["config", "user.email", "test@test.com"], tmpDir);
  runGitSync(["config", "user.name", "Test User"], tmpDir);

  // Create initial commit
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test Project\n");
  runGitSync(["add", "README.md"], tmpDir);
  runGitSync(["commit", "-m", "Initial commit"], tmpDir);
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Action: status ──────────────────────────────────────────────────────────

describe("git — status", () => {
  it("reports clean working tree", async () => {
    const result = await git({ action: "status" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.clean).toBe(true);
    expect(data.staged).toEqual([]);
    expect(data.unstaged).toEqual([]);
    expect(data.untracked).toEqual([]);
  });

  it("detects untracked files", async () => {
    await fs.writeFile(path.join(tmpDir, "new-file.ts"), "export const x = 1;\n");

    const result = await git({ action: "status" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.untracked.length).toBe(1);
    expect(data.untracked[0].path).toBe("new-file.ts");

    // Cleanup
    await fs.unlink(path.join(tmpDir, "new-file.ts"));
  });

  it("detects staged files", async () => {
    await fs.writeFile(path.join(tmpDir, "staged.ts"), "const y = 2;\n");
    runGitSync(["add", "staged.ts"], tmpDir);

    const result = await git({ action: "status" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.staged.length).toBe(1);
    expect(data.staged[0].path).toBe("staged.ts");
    expect(data.staged[0].status).toBe("added");

    // Cleanup
    runGitSync(["reset", "HEAD", "staged.ts"], tmpDir);
    await fs.unlink(path.join(tmpDir, "staged.ts"));
  });

  it("detects unstaged modifications", async () => {
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Updated\n");

    const result = await git({ action: "status" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.unstaged.length).toBe(1);
    expect(data.unstaged[0].path).toBe("README.md");
    expect(data.unstaged[0].status).toBe("modified");

    // Reset
    runGitSync(["checkout", "README.md"], tmpDir);
  });

  it("detects both staged and unstaged in same report", async () => {
    // Stage a new file
    await fs.writeFile(path.join(tmpDir, "a.ts"), "a\n");
    runGitSync(["add", "a.ts"], tmpDir);
    // Modify tracked file (unstaged)
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Changed\n");
    // Untracked file
    await fs.writeFile(path.join(tmpDir, "b.txt"), "b\n");

    const result = await git({ action: "status" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.staged.length).toBe(1);
    expect(data.unstaged.length).toBe(1);
    expect(data.untracked.length).toBe(1);
    expect(data.clean).toBe(false);

    // Cleanup
    runGitSync(["reset", "HEAD", "a.ts"], tmpDir);
    await fs.unlink(path.join(tmpDir, "a.ts"));
    await fs.unlink(path.join(tmpDir, "b.txt"));
    runGitSync(["checkout", "README.md"], tmpDir);
  });
});

// ── Action: diff ────────────────────────────────────────────────────────────

describe("git — diff", () => {
  it("returns empty diff when clean", async () => {
    const result = await git({ action: "diff" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.files).toEqual([]);
  });

  it("shows unstaged diff with insertions/deletions", async () => {
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Updated Project\nNew line.\n");

    const result = await git({ action: "diff" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.files.length).toBe(1);
    expect(data.files[0].path).toBe("README.md");
    expect(data.files[0].insertions).toBeGreaterThan(0);
    expect(data.files[0].deletions).toBeGreaterThan(0);
    expect(data.files[0].hunks.length).toBeGreaterThan(0);
    expect(data.summary).toContain("+");
    expect(data.summary).toContain("-");

    runGitSync(["checkout", "README.md"], tmpDir);
  });

  it("shows staged diff with --cached", async () => {
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Staged change\n");
    runGitSync(["add", "README.md"], tmpDir);

    const result = await git({ action: "diff", staged: true }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.files.length).toBe(1);
    expect(data.files[0].path).toBe("README.md");

    // Unstaged should be empty
    const unstaged = await git({ action: "diff" }, tmpDir);
    expect((unstaged.data as any).files).toEqual([]);

    runGitSync(["reset", "HEAD", "README.md"], tmpDir);
    runGitSync(["checkout", "README.md"], tmpDir);
  });

  it("filters diff by file", async () => {
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Changed\n");
    await fs.writeFile(path.join(tmpDir, "other.ts"), "x\n");
    runGitSync(["add", "other.ts"], tmpDir);
    runGitSync(["commit", "-m", "add other", "--no-verify"], tmpDir);
    await fs.writeFile(path.join(tmpDir, "other.ts"), "y\n");

    const result = await git({ action: "diff", file: "README.md" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.files.length).toBe(1);
    expect(data.files[0].path).toBe("README.md");

    runGitSync(["checkout", "README.md"], tmpDir);
    runGitSync(["checkout", "other.ts"], tmpDir);
  });
});

// ── Action: commit ──────────────────────────────────────────────────────────

describe("git — commit", () => {
  it("requires a message", async () => {
    const result = await git({ action: "commit" }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("message");
  });

  it("fails when nothing is staged", async () => {
    const result = await git({ action: "commit", message: "empty" }, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Nothing staged");
  });

  it("commits staged changes", async () => {
    await fs.writeFile(path.join(tmpDir, "commit-test.ts"), "export const z = 3;\n");
    runGitSync(["add", "commit-test.ts"], tmpDir);

    const result = await git({ action: "commit", message: "Add commit-test" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.hash).toBeTruthy();
    expect(data.message).toBe("Add commit-test");
    expect(data.filesCommitted).toBe(1);
    expect(data.files).toContain("commit-test.ts");
  });

  it("stages and commits files via files parameter", async () => {
    await fs.writeFile(path.join(tmpDir, "auto-stage.ts"), "const a = 1;\n");

    const result = await git({
      action: "commit",
      message: "Auto-staged commit",
      files: ["auto-stage.ts"],
    }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.files).toContain("auto-stage.ts");
  });
});

// ── Action: log ─────────────────────────────────────────────────────────────

describe("git — log", () => {
  it("returns commit history", async () => {
    const result = await git({ action: "log" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.commits.length).toBeGreaterThanOrEqual(1);
    expect(data.commits[0]).toHaveProperty("hash");
    expect(data.commits[0]).toHaveProperty("message");
    expect(data.commits[0]).toHaveProperty("author");
    expect(data.commits[0]).toHaveProperty("date");
    expect(data.commits[0]).toHaveProperty("files");
  });

  it("respects limit parameter", async () => {
    const result = await git({ action: "log", limit: 2 }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.commits.length).toBeLessThanOrEqual(2);
  });

  it("filters by author", async () => {
    const result = await git({ action: "log", author: "Test User" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.commits.length).toBeGreaterThanOrEqual(1);
    for (const commit of data.commits) {
      expect(commit.author).toBe("Test User");
    }
  });

  it("filters by path", async () => {
    const result = await git({ action: "log", path: "README.md" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.commits.length).toBeGreaterThanOrEqual(1);
    // Initial commit touched README.md
    expect(data.commits.some((c: any) => c.files.includes("README.md"))).toBe(true);
  });

  it("returns empty for non-matching author", async () => {
    const result = await git({ action: "log", author: "Nobody" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.commits).toEqual([]);
    expect(data.count).toBe(0);
  });

  it("includes files changed per commit", async () => {
    const result = await git({ action: "log", limit: 1 }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.commits[0].files.length).toBeGreaterThan(0);
  });
});

// ── Action: branch ──────────────────────────────────────────────────────────

describe("git — branch", () => {
  it("returns current branch and branch list", async () => {
    const result = await git({ action: "branch" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.current).toBeTruthy();
    expect(data.branches.length).toBeGreaterThanOrEqual(1);
    // The current branch should be marked
    const currentBranch = data.branches.find((b: any) => b.current);
    expect(currentBranch).toBeTruthy();
    expect(currentBranch.name).toBe(data.current);
  });

  it("branch entries have required fields", async () => {
    const result = await git({ action: "branch" }, tmpDir);
    const data = result.data as any;
    for (const branch of data.branches) {
      expect(branch).toHaveProperty("name");
      expect(branch).toHaveProperty("hash");
      expect(branch).toHaveProperty("lastCommit");
      expect(branch).toHaveProperty("subject");
      expect(branch).toHaveProperty("current");
    }
  });

  it("detects newly created branches", async () => {
    runGitSync(["branch", "feature/test-branch"], tmpDir);

    const result = await git({ action: "branch" }, tmpDir);
    const data = result.data as any;
    const featureBranch = data.branches.find((b: any) => b.name === "feature/test-branch");
    expect(featureBranch).toBeTruthy();
    expect(featureBranch.current).toBe(false);

    // Cleanup
    runGitSync(["branch", "-d", "feature/test-branch"], tmpDir);
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("git — errors", () => {
  it("returns error for unknown action", async () => {
    const result = await git({ action: "rebase" } as GitParams, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
    expect(result.error).toContain("rebase");
  });

  it("handles non-git directory gracefully", async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "no-git-"));
    try {
      const result = await git({ action: "status" }, nonGitDir);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });
});
