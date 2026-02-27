/**
 * Security — dangerous pattern detection for shell commands.
 */

import path from "node:path";

/**
 * Resolve a file path. If relative, resolves against cwd.
 * No jail — agents are trusted to work within their project.
 */
export function resolvePath(
  filePath: string,
  cwd: string,
): string {
  return path.resolve(cwd, filePath);
}

// ── Dangerous Pattern Detection ─────────────────────────────────────────────

interface DangerousPattern {
  pattern: RegExp;
  severity: "block" | "warn";
  message: string;
  alternative?: string;
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  {
    // Match: rm -rf / , rm -rf /* , rm / — bare root deletion only
    // Does NOT match: rm /specific/file.txt or rm -rf /some/path
    pattern: new RegExp("\\brm\\s+(-[a-zA-Z]+\\s+)*\\/([\\s*]|$)"),
    severity: "block",
    message: "Deletion of root directory detected.",
    alternative: "Use a specific path with trash command instead.",
  },
  {
    // Match: rm -rf ~ , rm -rf ~/ , rm ~ — bare home deletion only
    pattern: new RegExp("\\brm\\s+(-[a-zA-Z]+\\s+)*~([/\\s*]|$)"),
    severity: "block",
    message: "Deletion of home directory detected.",
    alternative: "Use trash command or specify exact files.",
  },
  {
    pattern: /\bcurl\s+.*\|\s*(ba)?sh\b/,
    severity: "block",
    message: "Piping curl output to shell detected.",
    alternative: "Download the script first, review it, then execute.",
  },
  {
    pattern: /\bwget\s+.*\|\s*(ba)?sh\b/,
    severity: "block",
    message: "Piping wget output to shell detected.",
    alternative: "Download the script first, review it, then execute.",
  },
  {
    pattern: /\bchmod\s+777\b/,
    severity: "warn",
    message: "chmod 777 makes files world-writable. Consider using more restrictive permissions.",
  },
  {
    pattern: /\bgit\s+push\s+--force\s+(origin\s+)?(main|master)\b/,
    severity: "warn",
    message: "Force pushing to main/master branch detected.",
    alternative: "Use --force-with-lease for safer force pushes.",
  },
];

export interface DangerCheckResult {
  blocked: boolean;
  warnings: string[];
  blockReason?: string;
  alternative?: string;
}

export function checkDangerousPatterns(command: string): DangerCheckResult {
  const warnings: string[] = [];

  for (const dp of DANGEROUS_PATTERNS) {
    if (dp.pattern.test(command)) {
      if (dp.severity === "block") {
        return {
          blocked: true,
          warnings: [],
          blockReason: dp.message,
          alternative: dp.alternative,
        };
      }
      warnings.push(dp.message + (dp.alternative ? ` ${dp.alternative}` : ""));
    }
  }

  return { blocked: false, warnings };
}

// ── Shell Command Blocklist ─────────────────────────────────────────────────

const BLOCKED_COMMANDS_PREFIX = [
  "vim", "vi", "emacs", "nano", "less", "tail -f", "gdb", "nohup",
];

const BLOCKED_COMMANDS_EXACT = [
  "python", "python3", "ipython", "node", "bash", "sh", "su",
];

export interface BlockedCommandResult {
  blocked: boolean;
  command?: string;
  reason?: string;
  alternative?: string;
}

export function checkBlockedCommand(
  command: string,
  additionalBlocklist?: string[],
): BlockedCommandResult {
  const trimmed = command.trim();
  const parts = trimmed.split(/\s+/);
  const baseCommand = parts[0] ?? "";

  // Check exact matches — only block if no arguments (REPL mode)
  if (parts.length === 1) {
    const allExact = [...BLOCKED_COMMANDS_EXACT, ...(additionalBlocklist ?? [])];
    if (allExact.includes(baseCommand)) {
      return {
        blocked: true,
        command: baseCommand,
        reason: `Interactive REPLs are not supported. "${baseCommand}" without arguments launches an interactive session.`,
        alternative: baseCommand === "python" || baseCommand === "python3"
          ? "Use 'python script.py' or 'python -c \"code\"' instead."
          : baseCommand === "node"
            ? "Use 'node script.js' or 'node -e \"code\"' instead."
            : `Use file_edit for modifications, or run ${baseCommand} with a specific command/script.`,
      };
    }
  }

  // Check prefix matches
  for (const prefix of BLOCKED_COMMANDS_PREFIX) {
    if (trimmed === prefix || trimmed.startsWith(prefix + " ")) {
      return {
        blocked: true,
        command: prefix,
        reason: `Interactive command "${prefix}" is not supported in this environment.`,
        alternative: prefix === "vim" || prefix === "vi" || prefix === "nano" || prefix === "emacs"
          ? "Use file_edit for modifications."
          : prefix === "less"
            ? "Use file_read with offset/limit for pagination."
            : prefix === "tail -f"
              ? "Use shell with background mode for log watching."
              : undefined,
      };
    }
  }

  return { blocked: false };
}
