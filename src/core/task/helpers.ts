/**
 * Task tool helpers — plan ID generation, task tree traversal, ID generation.
 */

import crypto from "node:crypto";
import type { Task, TaskInput, TaskContext, AggregatedContext, Plan } from "./types.js";

// ── Plan ID Generation ──────────────────────────────────────────────────────

/**
 * Generate a plan ID from a goal string.
 * Format: {goal-slug}-{4-char-hex}
 */
export function generatePlanId(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "");

  const shortId = crypto.randomBytes(2).toString("hex");
  return `${slug || "plan"}-${shortId}`;
}

// ── Task Tree Operations ────────────────────────────────────────────────────

/**
 * Find a task by ID in a task tree.
 */
export function findTask(tasks: Task[], id: string): Task | null {
  for (const task of tasks) {
    if (task.id === id) return task;
    if (task.subtasks) {
      const found = findTask(task.subtasks, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find the parent of a task by ID.
 */
export function findParent(tasks: Task[], id: string): { parent: Task; index: number } | null {
  for (const task of tasks) {
    if (task.subtasks) {
      const idx = task.subtasks.findIndex(t => t.id === id);
      if (idx >= 0) return { parent: task, index: idx };
      const found = findParent(task.subtasks, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find a task and its siblings array (top-level or within a parent).
 */
export function findTaskInContext(tasks: Task[], id: string): { task: Task; siblings: Task[]; index: number } | null {
  // Check top level
  const topIdx = tasks.findIndex(t => t.id === id);
  if (topIdx >= 0) return { task: tasks[topIdx], siblings: tasks, index: topIdx };

  // Check nested
  for (const task of tasks) {
    if (task.subtasks) {
      const result = findTaskInContext(task.subtasks, id);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Convert TaskInput[] to Task[] with status = "pending".
 */
export function inputsToTasks(inputs: TaskInput[], parentId?: string, startIndex = 0): Task[] {
  return inputs.map((input, index) => {
    const id = input.id ?? (parentId ? `${parentId}.${startIndex + index + 1}` : `${startIndex + index + 1}`);
    const task: Task = {
      id,
      title: input.title,
      status: "pending",
    };
    if (input.checkpoint) task.checkpoint = true;
    if (input.subtasks && input.subtasks.length > 0) {
      task.subtasks = inputsToTasks(input.subtasks, id);
    }
    return task;
  });
}

/**
 * Count all tasks (including subtasks) in a task tree.
 */
export function countTasks(tasks: Task[]): number {
  let count = 0;
  for (const task of tasks) {
    count++;
    if (task.subtasks) count += countTasks(task.subtasks);
  }
  return count;
}

/**
 * Get progress string for a task tree.
 */
export function getProgress(tasks: Task[]): string {
  let total = 0;
  let completed = 0;
  function walk(items: Task[]): void {
    for (const t of items) {
      total++;
      if (t.status === "completed") completed++;
      if (t.subtasks) walk(t.subtasks);
    }
  }
  walk(tasks);
  return `${completed}/${total}`;
}

/**
 * Find the current task (first in_progress, or first pending if none in_progress).
 */
export function findCurrentTask(tasks: Task[]): Task | null {
  // First pass: find in_progress
  for (const task of tasks) {
    if (task.status === "in_progress") return task;
    if (task.subtasks) {
      const found = findCurrentTask(task.subtasks);
      if (found) return found;
    }
  }
  // Second pass: find first pending
  for (const task of tasks) {
    if (task.status === "pending") return task;
    if (task.subtasks) {
      const found = findFirstPending(task.subtasks);
      if (found) return found;
    }
  }
  return null;
}

function findFirstPending(tasks: Task[]): Task | null {
  for (const task of tasks) {
    if (task.status === "pending") return task;
    if (task.subtasks) {
      const found = findFirstPending(task.subtasks);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Aggregate context from all completed subtasks under a checkpoint task.
 */
export function aggregateContext(task: Task): AggregatedContext {
  const findings: string[] = [];
  const decisions: string[] = [];
  const files: string[] = [];

  function collectFromTask(t: Task): void {
    if (t.context) {
      if (t.context.findings) findings.push(...t.context.findings);
      if (t.context.decisions) decisions.push(...t.context.decisions);
      if (t.context.files) files.push(...t.context.files);
    }
    if (t.subtasks) {
      for (const sub of t.subtasks) {
        if (sub.status === "completed") {
          collectFromTask(sub);
        }
      }
    }
  }

  // Collect from the task's completed subtasks (not the task itself)
  if (task.subtasks) {
    for (const sub of task.subtasks) {
      if (sub.status === "completed") {
        collectFromTask(sub);
      }
    }
  }

  // Deduplicate files
  const uniqueFiles = [...new Set(files)];

  return { findings, decisions, files: uniqueFiles };
}

/**
 * Check if all subtasks of a task are completed.
 */
export function allSubtasksCompleted(task: Task): boolean {
  if (!task.subtasks || task.subtasks.length === 0) return true;
  return task.subtasks.every(
    sub => sub.status === "completed" || sub.status === "cancelled",
  );
}

/**
 * Check if a plan has any non-terminal tasks.
 */
/**
 * Walk the task tree and auto-promote parent tasks whose subtasks are all terminal.
 * Mutates tasks in-place, records changes in history.
 */
export function autoPromoteParents(
  tasks: Task[],
  now: string,
  history: Array<{ time: string; event: string }>,
  changes: string[],
): void {
  for (const task of tasks) {
    if (!task.subtasks || task.subtasks.length === 0) continue;

    // Recurse first (bottom-up promotion)
    autoPromoteParents(task.subtasks, now, history, changes);

    // Check if all subtasks are terminal
    const allTerminal = task.subtasks.every(
      sub => sub.status === "completed" || sub.status === "cancelled" || sub.status === "failed",
    );

    if (allTerminal && task.status !== "completed" && task.status !== "cancelled" && task.status !== "failed") {
      // Promote: if any child failed, parent fails; otherwise completed
      const anyFailed = task.subtasks.some(sub => sub.status === "failed");
      const newStatus = anyFailed ? "failed" : "completed";
      const oldStatus = task.status;
      task.status = newStatus;
      const msg = `${task.id} status: ${oldStatus} → ${newStatus} (auto-promoted: all subtasks terminal)`;
      changes.push(msg);
      history.push({ time: now, event: msg });
    }
  }
}

export function isPlanComplete(plan: Plan): boolean {
  function isTaskTerminal(t: Task): boolean {
    // If task has subtasks, derive status from children (parent may lag behind)
    if (t.subtasks && t.subtasks.length > 0) {
      return t.subtasks.every(sub => isTaskTerminal(sub));
    }
    // Leaf task: check explicit status
    return t.status === "completed" || t.status === "cancelled" || t.status === "failed";
  }
  return plan.tasks.every(t => isTaskTerminal(t));
}

/**
 * Merge context into a task's existing context.
 */
export function mergeContext(existing: TaskContext | undefined, incoming: TaskContext): TaskContext {
  const merged: TaskContext = { ...existing };
  if (incoming.findings) {
    merged.findings = [...(merged.findings ?? []), ...incoming.findings];
  }
  if (incoming.decisions) {
    merged.decisions = [...(merged.decisions ?? []), ...incoming.decisions];
  }
  if (incoming.files) {
    const all = [...(merged.files ?? []), ...incoming.files];
    merged.files = [...new Set(all)];
  }
  return merged;
}
