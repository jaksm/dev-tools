/**
 * git tool — Structured wrappers around git CLI.
 *
 * Actions:
 * - "status"  — staged/unstaged/untracked arrays
 * - "diff"    — files with insertions/deletions/hunks
 * - "commit"  — hash + message + files committed
 * - "log"     — commits with hash/message/author/date/files
 * - "branch"  — current branch + list
 *
 * All output as structured JSON — no raw git parsing for agents.
 * Conditional registration: only if .git/ detected.
 * No interactive operations (no rebase -i, no merge, no cherry-pick).
 */

import { execFile } from "node:child_process";
import type { ToolResult } from "../core/types.js";

// ── Params ──────────────────────────────────────────────────────────────────

export interface GitParams {
  action: string;
  // For commit
  message?: string;
  files?: string[];       // Files to stage before commit (optional — if omitted, commits what's already staged)
  // For diff
  staged?: boolean;       // Show staged changes (default: unstaged)
  file?: string;          // Limit diff to a single file
  // For log
  limit?: number;         // Max commits to return (default: 10)
  author?: string;        // Filter by author
  since?: string;         // Filter by date (e.g., "2 days ago", "2026-02-01")
  path?: string;          // Filter log by path
}

// ── Structured Output Types ─────────────────────────────────────────────────

interface StatusFile {
  path: string;
  status: string; // "modified" | "added" | "deleted" | "renamed" | "copied" | "unmerged" | "unknown"
  oldPath?: string; // For renames
}

interface DiffHunk {
  header: string;
  lines: string[];
}

interface DiffFile {
  path: string;
  insertions: number;
  deletions: number;
  hunks: DiffHunk[];
}

interface LogCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
  files: string[];
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export async function git(
  params: GitParams,
  workspaceDir: string,
): Promise<ToolResult> {
  const action = params.action;

  try {
    switch (action) {
      case "status":
        return await handleStatus(workspaceDir);
      case "diff":
        return await handleDiff(params, workspaceDir);
      case "commit":
        return await handleCommit(params, workspaceDir);
      case "log":
        return await handleLog(params, workspaceDir);
      case "branch":
        return await handleBranch(workspaceDir);
      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Valid actions: status, diff, commit, log, branch`,
        };
    }
  } catch (e) {
    return {
      success: false,
      error: `Git tool error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── Action: status ──────────────────────────────────────────────────────────

async function handleStatus(workspaceDir: string): Promise<ToolResult> {
  // Use porcelain v2 for machine-readable output
  const raw = await runGit(["status", "--porcelain=v1", "-z"], workspaceDir);

  const staged: StatusFile[] = [];
  const unstaged: StatusFile[] = [];
  const untracked: StatusFile[] = [];

  if (!raw.trim()) {
    return {
      success: true,
      data: { staged, unstaged, untracked, clean: true },
    };
  }

  // Porcelain v1 with -z: entries separated by NUL, renames have an extra NUL-delimited field
  const entries = raw.split("\0").filter(Boolean);
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];
    if (entry.length < 4) {
      i++;
      continue;
    }

    const indexStatus = entry[0];
    const workTreeStatus = entry[1];
    const filePath = entry.slice(3);

    // Handle renames — next entry is the original path
    let oldPath: string | undefined;
    if (indexStatus === "R" || workTreeStatus === "R" ||
        indexStatus === "C" || workTreeStatus === "C") {
      i++;
      oldPath = entries[i];
    }

    // Staged changes (index status)
    if (indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!") {
      staged.push({
        path: filePath,
        status: statusChar(indexStatus),
        ...(oldPath ? { oldPath } : {}),
      });
    }

    // Unstaged changes (work tree status)
    if (workTreeStatus !== " " && workTreeStatus !== "?" && workTreeStatus !== "!") {
      unstaged.push({
        path: filePath,
        status: statusChar(workTreeStatus),
      });
    }

    // Untracked
    if (indexStatus === "?") {
      untracked.push({ path: filePath, status: "untracked" });
    }

    i++;
  }

  return {
    success: true,
    data: {
      staged,
      unstaged,
      untracked,
      clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    },
  };
}

// ── Action: diff ────────────────────────────────────────────────────────────

async function handleDiff(
  params: GitParams,
  workspaceDir: string,
): Promise<ToolResult> {
  const args = ["diff", "--no-color"];
  if (params.staged) {
    args.push("--cached");
  }
  if (params.file) {
    args.push("--", params.file);
  }

  const raw = await runGit(args, workspaceDir);

  if (!raw.trim()) {
    return {
      success: true,
      data: {
        files: [],
        summary: params.staged ? "No staged changes" : "No unstaged changes",
      },
    };
  }

  const files = parseDiff(raw);

  // Summary
  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalInsertions += f.insertions;
    totalDeletions += f.deletions;
  }

  return {
    success: true,
    data: {
      files,
      summary: `${files.length} file(s), +${totalInsertions} -${totalDeletions}`,
    },
  };
}

// ── Action: commit ──────────────────────────────────────────────────────────

async function handleCommit(
  params: GitParams,
  workspaceDir: string,
): Promise<ToolResult> {
  if (!params.message) {
    return { success: false, error: "Missing required field: message" };
  }

  // Stage specific files if provided
  if (params.files && params.files.length > 0) {
    await runGit(["add", ...params.files], workspaceDir);
  }

  // Check if there's anything to commit
  const statusRaw = await runGit(["diff", "--cached", "--name-only"], workspaceDir);
  if (!statusRaw.trim()) {
    return {
      success: false,
      error: "Nothing staged to commit. Stage files first with git add, or pass files parameter.",
    };
  }

  // Commit
  await runGit(
    ["commit", "-m", params.message, "--no-verify"],
    workspaceDir,
  );

  // Get the commit hash
  const hash = await runGit(["rev-parse", "--short", "HEAD"], workspaceDir);

  // Get committed files
  const filesRaw = await runGit(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
    workspaceDir,
  );
  const filesCommitted = filesRaw.trim().split("\n").filter(Boolean);

  return {
    success: true,
    data: {
      hash: hash.trim(),
      message: params.message,
      filesCommitted: filesCommitted.length,
      files: filesCommitted,
    },
  };
}

// ── Action: log ─────────────────────────────────────────────────────────────

async function handleLog(
  params: GitParams,
  workspaceDir: string,
): Promise<ToolResult> {
  const limit = params.limit ?? 10;

  // Use a custom format with delimiters for reliable parsing
  // Format: HASH<|>AUTHOR<|>DATE<|>MESSAGE
  const SEP = "<|>";
  const RECORD_SEP = "<||>";
  const format = `${RECORD_SEP}%h${SEP}%an${SEP}%aI${SEP}%s`;
  const args = ["log", `--format=${format}`, `-n`, `${limit}`, "--name-only"];

  if (params.author) {
    args.push(`--author=${params.author}`);
  }
  if (params.since) {
    args.push(`--since=${params.since}`);
  }
  if (params.path) {
    args.push("--", params.path);
  }

  const raw = await runGit(args, workspaceDir);

  if (!raw.trim()) {
    return {
      success: true,
      data: { commits: [], count: 0 },
    };
  }

  const commits: LogCommit[] = [];
  const records = raw.split(RECORD_SEP).filter(Boolean);

  for (const record of records) {
    const lines = record.trim().split("\n");
    if (lines.length === 0) continue;

    const headerParts = lines[0].split(SEP);
    if (headerParts.length < 4) continue;

    const [hash, author, date, message] = headerParts;
    const files = lines.slice(1).filter(l => l.trim().length > 0);

    commits.push({
      hash: hash.trim(),
      author: author.trim(),
      date: date.trim(),
      message: message.trim(),
      files,
    });
  }

  return {
    success: true,
    data: {
      commits,
      count: commits.length,
    },
  };
}

// ── Action: branch ──────────────────────────────────────────────────────────

async function handleBranch(workspaceDir: string): Promise<ToolResult> {
  // Get current branch
  let current: string;
  try {
    current = (await runGit(["branch", "--show-current"], workspaceDir)).trim();
    if (!current) {
      // Detached HEAD — branch --show-current returns empty string
      const rev = (await runGit(["rev-parse", "--short", "HEAD"], workspaceDir)).trim();
      current = `(detached HEAD at ${rev})`;
    }
  } catch {
    // Fallback for older git versions
    const rev = (await runGit(["rev-parse", "--short", "HEAD"], workspaceDir)).trim();
    current = `(detached HEAD at ${rev})`;
  }

  // Get all local branches with last commit info
  const raw = await runGit(
    ["branch", "--format=%(refname:short)\t%(objectname:short)\t%(committerdate:relative)\t%(subject)"],
    workspaceDir,
  );

  const branches = raw.trim().split("\n").filter(Boolean).map(line => {
    const [name, hash, date, subject] = line.split("\t");
    return {
      name: name?.trim() ?? "",
      hash: hash?.trim() ?? "",
      lastCommit: date?.trim() ?? "",
      subject: subject?.trim() ?? "",
      current: (name?.trim() ?? "") === current,
    };
  });

  return {
    success: true,
    data: {
      current,
      branches,
      count: branches.length,
    },
  };
}

// ── Git Execution Helper ────────────────────────────────────────────────────

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "",
          TERM: "dumb",
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          // Git exits non-zero for many non-error cases, check stderr
          const msg = stderr?.trim() || stdout?.trim() || error.message;
          reject(new Error(`git ${args[0]}: ${msg}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// ── Diff Parser ─────────────────────────────────────────────────────────────

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  // Split on "diff --git" markers
  const fileDiffs = raw.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split("\n");
    if (lines.length === 0) continue;

    // Extract file path from first line: "a/path b/path"
    const headerMatch = lines[0].match(/a\/(.+?) b\/(.+)/);
    const filePath = headerMatch ? headerMatch[2] : "unknown";

    let insertions = 0;
    let deletions = 0;
    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("@@")) {
        // New hunk
        if (currentHunk) hunks.push(currentHunk);
        currentHunk = { header: line, lines: [] };
        continue;
      }

      if (currentHunk) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          insertions++;
          currentHunk.lines.push(line);
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          deletions++;
          currentHunk.lines.push(line);
        } else if (line.startsWith(" ") || line === "") {
          currentHunk.lines.push(line);
        }
      }
    }

    if (currentHunk) hunks.push(currentHunk);

    files.push({ path: filePath, insertions, deletions, hunks });
  }

  return files;
}

// ── Status Character Mapping ────────────────────────────────────────────────

function statusChar(c: string): string {
  switch (c) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "U": return "unmerged";
    case "T": return "typechange";
    default: return "unknown";
  }
}
