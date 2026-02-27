/**
 * Git tool hardening tests — edge cases for status, diff, commit, log, branch.
 * Uses real temporary git repos.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-tools-git-hard-"));
  runGitSync(["init"], tmpDir);
  runGitSync(["config", "user.email", "test@test.com"], tmpDir);
  runGitSync(["config", "user.name", "Test User"], tmpDir);

  // Initial commit
  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test Project\n");
  runGitSync(["add", "README.md"], tmpDir);
  runGitSync(["commit", "-m", "Initial commit"], tmpDir);
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Status: Renamed / Copied files ──────────────────────────────────────────

describe("git status — renames and copies", () => {
  it("detects renamed file in staging area", async () => {
    await fs.writeFile(path.join(tmpDir, "oldname.ts"), "content\n");
    runGitSync(["add", "oldname.ts"], tmpDir);
    runGitSync(["commit", "-m", "add oldname"], tmpDir);

    // Rename via git mv
    runGitSync(["mv", "oldname.ts", "newname.ts"], tmpDir);

    const result = await git({ action: "status" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    
    // Should have a staged rename
    const renamed = data.staged.find((f: any) => f.status === "renamed");
    expect(renamed).toBeDefined();
    expect(renamed.path).toBe("newname.ts");
    expect(renamed.oldPath).toBe("oldname.ts");

    // Cleanup
    runGitSync(["reset", "HEAD~1", "--hard"], tmpDir);
  });

  it("detects file with spaces and special chars", async () => {
    const specialName = "my file (1).ts";
    await fs.writeFile(path.join(tmpDir, specialName), "content\n");

    const result = await git({ action: "status" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.untracked.some((f: any) => f.path === specialName)).toBe(true);

    await fs.unlink(path.join(tmpDir, specialName));
  });
});

// ── Diff: edge cases ────────────────────────────────────────────────────────

describe("git diff — edge cases", () => {
  it("handles empty file addition (staged diff)", async () => {
    await fs.writeFile(path.join(tmpDir, "empty.ts"), "");
    runGitSync(["add", "empty.ts"], tmpDir);

    const result = await git({ action: "diff", staged: true }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    // Empty file shows in diff header but has 0 insertions
    // It may or may not appear depending on git version — just verify no crash
    expect(Array.isArray(data.files)).toBe(true);

    // Cleanup
    runGitSync(["reset", "HEAD", "empty.ts"], tmpDir);
    await fs.unlink(path.join(tmpDir, "empty.ts"));
  });

  it("handles multiple files in diff", async () => {
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Changed README\nNew content.\n");
    await fs.writeFile(path.join(tmpDir, "fileA.ts"), "export const a = 1;\n");
    runGitSync(["add", "fileA.ts"], tmpDir);
    runGitSync(["commit", "-m", "add fileA"], tmpDir);
    await fs.writeFile(path.join(tmpDir, "fileA.ts"), "export const a = 2;\n");

    const result = await git({ action: "diff" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.files.length).toBe(2); // README.md + fileA.ts
    expect(data.summary).toMatch(/2 file\(s\)/);

    // Cleanup
    runGitSync(["checkout", "README.md"], tmpDir);
    runGitSync(["checkout", "fileA.ts"], tmpDir);
  });

  it("handles diff with file containing special chars in content", async () => {
    // Create and commit a file, then modify with special chars
    await fs.writeFile(path.join(tmpDir, "special.ts"), "line one\n");
    runGitSync(["add", "special.ts"], tmpDir);
    runGitSync(["commit", "-m", "add special"], tmpDir);

    await fs.writeFile(path.join(tmpDir, "special.ts"), "line one\nüñîcödé 你好 🚀\n");

    const result = await git({ action: "diff" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.files.length).toBe(1);
    expect(data.files[0].insertions).toBeGreaterThan(0);

    runGitSync(["checkout", "special.ts"], tmpDir);
  });
});

// ── Commit: edge cases ──────────────────────────────────────────────────────

describe("git commit — edge cases", () => {
  it("commits multiple files at once via files parameter", async () => {
    await fs.writeFile(path.join(tmpDir, "multi1.ts"), "const a = 1;\n");
    await fs.writeFile(path.join(tmpDir, "multi2.ts"), "const b = 2;\n");
    await fs.writeFile(path.join(tmpDir, "multi3.ts"), "const c = 3;\n");

    const result = await git({
      action: "commit",
      message: "Add multiple files",
      files: ["multi1.ts", "multi2.ts", "multi3.ts"],
    }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.filesCommitted).toBe(3);
    expect(data.files).toContain("multi1.ts");
    expect(data.files).toContain("multi2.ts");
    expect(data.files).toContain("multi3.ts");
  });

  it("commits from subdirectory (workspaceDir is repo root)", async () => {
    const subDir = path.join(tmpDir, "src", "lib");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, "deep.ts"), "export const deep = true;\n");

    const result = await git({
      action: "commit",
      message: "Add deep file",
      files: ["src/lib/deep.ts"],
    }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.files).toContain("src/lib/deep.ts");
  });

  it("handles commit message with special characters", async () => {
    await fs.writeFile(path.join(tmpDir, "quotefile.ts"), "x\n");

    const result = await git({
      action: "commit",
      message: 'Fix "quoted" bug — don\'t break & stuff <tag>',
      files: ["quotefile.ts"],
    }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.message).toBe('Fix "quoted" bug — don\'t break & stuff <tag>');
  });

  it("handles commit message with newlines (should still work)", async () => {
    await fs.writeFile(path.join(tmpDir, "nlfile.ts"), "y\n");

    const result = await git({
      action: "commit",
      message: "Title line\n\nBody paragraph here.",
      files: ["nlfile.ts"],
    }, tmpDir);

    expect(result.success).toBe(true);
  });
});

// ── Log: edge cases ─────────────────────────────────────────────────────────

describe("git log — edge cases", () => {
  it("filters by since date", async () => {
    // All commits in this test repo are recent, so since "1 day ago" should include all
    const result = await git({ action: "log", since: "1 day ago" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.commits.length).toBeGreaterThan(0);
  });

  it("returns empty for future since date", async () => {
    const result = await git({ action: "log", since: "2099-01-01" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.commits).toEqual([]);
    expect(data.count).toBe(0);
  });

  it("log on empty repo (no commits)", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "empty-git-"));
    runGitSync(["init"], emptyDir);

    try {
      const result = await git({ action: "log" }, emptyDir);
      // Should either succeed with empty or fail gracefully
      if (result.success) {
        expect((result.data as any).commits).toEqual([]);
      } else {
        expect(result.error).toBeTruthy();
      }
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("handles merge commits in log", async () => {
    // Create a branch, make commits, merge
    runGitSync(["checkout", "-b", "merge-test"], tmpDir);
    await fs.writeFile(path.join(tmpDir, "branch-file.ts"), "branch content\n");
    runGitSync(["add", "branch-file.ts"], tmpDir);
    runGitSync(["commit", "-m", "Branch commit"], tmpDir);

    // Get the default branch name
    const defaultBranch = runGitSync(["rev-parse", "--abbrev-ref", "HEAD"], tmpDir).trim() === "merge-test"
      ? (() => {
          // We need to know what the main branch was
          const branches = runGitSync(["branch"], tmpDir);
          const mainBranch = branches.split("\n").find(b => !b.includes("merge-test") && b.trim().length > 0);
          return mainBranch?.replace("*", "").trim() ?? "master";
        })()
      : "master";

    // Switch back and merge
    runGitSync(["checkout", defaultBranch], tmpDir);
    runGitSync(["merge", "merge-test", "--no-ff", "-m", "Merge merge-test"], tmpDir);

    const result = await git({ action: "log", limit: 3 }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.commits.length).toBeGreaterThan(0);
    // Merge commit should be in history
    const mergeCommit = data.commits.find((c: any) => c.message.includes("Merge"));
    expect(mergeCommit).toBeDefined();

    // Cleanup
    runGitSync(["branch", "-d", "merge-test"], tmpDir);
  });

  it("log with path filter returns only commits touching that path", async () => {
    await fs.writeFile(path.join(tmpDir, "logpath.ts"), "v1\n");
    runGitSync(["add", "logpath.ts"], tmpDir);
    runGitSync(["commit", "-m", "add logpath"], tmpDir);

    await fs.writeFile(path.join(tmpDir, "other-log.ts"), "v1\n");
    runGitSync(["add", "other-log.ts"], tmpDir);
    runGitSync(["commit", "-m", "add other-log"], tmpDir);

    const result = await git({ action: "log", path: "logpath.ts" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    // Should only include commits that touched logpath.ts
    for (const commit of data.commits) {
      expect(commit.files).toContain("logpath.ts");
    }
  });
});

// ── Branch: edge cases ──────────────────────────────────────────────────────

describe("git branch — edge cases", () => {
  it("detects detached HEAD state", async () => {
    // Get current HEAD hash
    const hash = runGitSync(["rev-parse", "HEAD"], tmpDir).trim();
    const currentBranch = runGitSync(["branch", "--show-current"], tmpDir).trim();

    // Detach HEAD
    runGitSync(["checkout", "--detach", hash], tmpDir);

    const result = await git({ action: "branch" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.current).toMatch(/detached HEAD/);

    // Restore
    runGitSync(["checkout", currentBranch], tmpDir);
  });

  it("handles many branches", async () => {
    const branchNames = Array.from({ length: 10 }, (_, i) => `test-branch-${i}`);

    for (const name of branchNames) {
      runGitSync(["branch", name], tmpDir);
    }

    const result = await git({ action: "branch" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.count).toBeGreaterThanOrEqual(11); // 10 new + at least 1 existing

    for (const name of branchNames) {
      expect(data.branches.some((b: any) => b.name === name)).toBe(true);
    }

    // Cleanup
    for (const name of branchNames) {
      runGitSync(["branch", "-D", name], tmpDir);
    }
  });

  it("branch names with slashes work correctly", async () => {
    runGitSync(["branch", "feature/nested/deep/branch"], tmpDir);

    const result = await git({ action: "branch" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    const deepBranch = data.branches.find((b: any) => b.name === "feature/nested/deep/branch");
    expect(deepBranch).toBeDefined();

    runGitSync(["branch", "-D", "feature/nested/deep/branch"], tmpDir);
  });
});

// ── Status: simultaneous staged + unstaged on same file ─────────────────────

describe("git status — complex states", () => {
  it("detects same file both staged and unstaged (partially staged)", async () => {
    // Create and commit a file
    await fs.writeFile(path.join(tmpDir, "partial.ts"), "line 1\nline 2\n");
    runGitSync(["add", "partial.ts"], tmpDir);
    runGitSync(["commit", "-m", "add partial"], tmpDir);

    // Modify and stage
    await fs.writeFile(path.join(tmpDir, "partial.ts"), "line 1\nline 2 modified\n");
    runGitSync(["add", "partial.ts"], tmpDir);

    // Modify again (not staged)
    await fs.writeFile(path.join(tmpDir, "partial.ts"), "line 1\nline 2 modified\nline 3 extra\n");

    const result = await git({ action: "status" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;

    // Should appear in both staged and unstaged
    expect(data.staged.some((f: any) => f.path === "partial.ts")).toBe(true);
    expect(data.unstaged.some((f: any) => f.path === "partial.ts")).toBe(true);

    // Cleanup
    runGitSync(["checkout", "partial.ts"], tmpDir);
    runGitSync(["reset", "HEAD", "partial.ts"], tmpDir);
    runGitSync(["checkout", "partial.ts"], tmpDir);
  });

  it("detects deleted file", async () => {
    await fs.writeFile(path.join(tmpDir, "todelete.ts"), "x\n");
    runGitSync(["add", "todelete.ts"], tmpDir);
    runGitSync(["commit", "-m", "add todelete"], tmpDir);

    // Delete the file
    await fs.unlink(path.join(tmpDir, "todelete.ts"));

    const result = await git({ action: "status" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    const deleted = data.unstaged.find((f: any) => f.path === "todelete.ts");
    expect(deleted).toBeDefined();
    expect(deleted.status).toBe("deleted");

    // Cleanup: restore file
    runGitSync(["checkout", "todelete.ts"], tmpDir);
  });

  it("detects staged deletion", async () => {
    await fs.writeFile(path.join(tmpDir, "stagedel.ts"), "y\n");
    runGitSync(["add", "stagedel.ts"], tmpDir);
    runGitSync(["commit", "-m", "add stagedel"], tmpDir);

    // Stage the deletion
    runGitSync(["rm", "stagedel.ts"], tmpDir);

    const result = await git({ action: "status" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    const deleted = data.staged.find((f: any) => f.path === "stagedel.ts");
    expect(deleted).toBeDefined();
    expect(deleted.status).toBe("deleted");

    // Cleanup
    runGitSync(["reset", "HEAD", "stagedel.ts"], tmpDir);
    runGitSync(["checkout", "stagedel.ts"], tmpDir);
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("git — additional error cases", () => {
  it("handles invalid action gracefully", async () => {
    const result = await git({ action: "push" } as GitParams, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
  });

  it("handles commit with empty message", async () => {
    const result = await git({ action: "commit", message: "" }, tmpDir);
    // Empty string is falsy, should fail validation
    expect(result.success).toBe(false);
  });

  it("diff on nonexistent file doesn't crash", async () => {
    const result = await git({ action: "diff", file: "does-not-exist.ts" }, tmpDir);
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.files).toEqual([]);
  });
});
