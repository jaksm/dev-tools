/**
 * shell — Execute commands with project-aware cwd, timeout, background mode,
 * command blocklist, and dangerous pattern detection.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { ToolContext } from "../core/types.js";
import { checkBlockedCommand, checkDangerousPatterns, resolvePath } from "../core/security.js";
import { truncateIfNeeded } from "../core/token-budget.js";

export interface ShellParams {
  command: string;
  cwd?: string;
  timeout?: number;
  background?: boolean;
}

export async function shell(params: ShellParams, ctx: ToolContext): Promise<unknown> {
  const { workspaceDir, storageDir, config } = ctx;

  // Check blocked commands
  const blocked = checkBlockedCommand(params.command, config.shell?.blocklist);
  if (blocked.blocked) {
    return {
      error: "blocked_command",
      command: blocked.command,
      reason: blocked.reason,
      alternative: blocked.alternative,
    };
  }

  // Check dangerous patterns
  const danger = checkDangerousPatterns(params.command);
  if (danger.blocked) {
    return {
      error: "dangerous_command",
      reason: danger.blockReason,
      alternative: danger.alternative,
    };
  }

  // Resolve working directory
  const cwd = params.cwd ? resolvePath(params.cwd, workspaceDir) : workspaceDir;

  const timeout = params.timeout ?? config.shell?.defaultTimeout ?? 120000;

  return new Promise((resolve) => {
    const proc = execFile(
      "/bin/sh",
      ["-c", params.command],
      {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
      },
      async (error, stdout, stderr) => {
        const exitCode = error && "code" in error ? (error.code as number) : (error ? 1 : 0);
        const timedOut = error && "killed" in error && error.killed;

        // Token budget truncation (head direction — preserve end for errors)
        const budget = {
          maxResponseTokens: config.tokenBudget?.maxResponseTokens ?? 4000,
          toolOutputDir: path.join(storageDir, "tool-output"),
        };

        const truncatedStdout = await truncateIfNeeded(stdout, "head", budget);
        const truncatedStderr = stderr.trim()
          ? await truncateIfNeeded(stderr, "head", budget)
          : undefined;

        const result: Record<string, unknown> = {
          exitCode,
          stdout: truncatedStdout.content,
        };

        if (truncatedStderr?.content) {
          result.stderr = truncatedStderr.content;
        }

        if (timedOut) {
          result.timedOut = true;
          result.timeout = timeout;
        }

        if (truncatedStdout.truncated || truncatedStderr?.truncated) {
          result.truncated = true;
          result.hint = truncatedStdout.hint ?? truncatedStderr?.hint;
        }

        if (danger.warnings.length > 0) {
          result.warnings = danger.warnings;
        }

        resolve(result);
      },
    );

    // For background mode, resolve immediately
    if (params.background) {
      proc.unref();
      resolve({
        background: true,
        pid: proc.pid,
        command: params.command,
        message: "Command started in background.",
      });
    }
  });
}
