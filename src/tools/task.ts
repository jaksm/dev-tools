/**
 * task tool — Plan, track, and adapt work with persistent task lists.
 *
 * Actions:
 * - "plan"       — Create initial plan from goal + tasks
 * - "status"     — Read current plan state (cheap, call often)
 * - "update"     — Mark progress, add notes and context
 * - "add"        — Insert new tasks discovered during work
 * - "replan"     — Restructure when approach changes
 * - "checkpoint" — Write narrative checkpoint summary
 * - "export"     — Compact completion summary for upstream agent
 * - "list"       — Discover plans (active + completed)
 */

import type { ToolResult } from "../core/types.js";
import type {
  TaskActionParams,
  Plan,
  Task,
  Checkpoint,
} from "../core/task/types.js";
import type { TaskStorage } from "../core/task/storage.js";
import {
  generatePlanId,
  findTask,
  inputsToTasks,
  countTasks,
  getProgress,
  findCurrentTask,
  aggregateContext,
  allSubtasksCompleted,
  isPlanComplete,
  mergeContext,
} from "../core/task/helpers.js";

// ── Params type (used by OC adapter) ────────────────────────────────────────

export interface TaskParams {
  action: string;
  goal?: string;
  tasks?: unknown[];
  id?: string;
  status?: string;
  notes?: string;
  context?: unknown;
  planId?: string;
  parentId?: string;
  after?: string;
  reason?: string;
  cancel?: string[];
  add?: unknown[];
  summary?: string;
  format?: string;
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export async function task(
  params: TaskParams,
  storage: TaskStorage,
  agentId?: string,
): Promise<ToolResult> {
  const action = params.action;

  try {
    switch (action) {
      case "plan":
        return await handlePlan(params, storage, agentId);
      case "status":
        return await handleStatus(params, storage);
      case "update":
        return await handleUpdate(params, storage, agentId);
      case "add":
        return await handleAdd(params, storage, agentId);
      case "replan":
        return await handleReplan(params, storage, agentId);
      case "checkpoint":
        return await handleCheckpoint(params, storage, agentId);
      case "export":
        return await handleExport(params, storage);
      case "list":
        return await handleList(storage);
      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Valid actions: plan, status, update, add, replan, checkpoint, export, list`,
        };
    }
  } catch (e) {
    return {
      success: false,
      error: `Task tool error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── Action: plan ────────────────────────────────────────────────────────────

async function handlePlan(
  params: TaskParams,
  storage: TaskStorage,
  agentId?: string,
): Promise<ToolResult> {
  if (!params.goal) {
    return { success: false, error: "Missing required field: goal" };
  }
  if (!params.tasks || !Array.isArray(params.tasks) || params.tasks.length === 0) {
    return { success: false, error: "Missing required field: tasks (non-empty array)" };
  }

  const planId = generatePlanId(params.goal);
  const tasks = inputsToTasks(params.tasks as TaskActionParams extends { action: "plan" } ? TaskActionParams["tasks" & keyof TaskActionParams] : never[]);
  const now = new Date().toISOString();
  const taskCount = countTasks(tasks);

  const plan: Plan = {
    planId,
    goal: params.goal,
    tasks,
    checkpoints: [],
    history: [
      { time: now, event: `Plan created with ${tasks.length} top-level tasks (${taskCount} total)` },
    ],
    createdBy: agentId,
    lastModifiedBy: agentId,
    createdAt: now,
    lastModifiedAt: now,
    status: "active",
  };

  await storage.savePlan(plan);

  return {
    success: true,
    data: {
      planId,
      created: true,
      taskCount,
      goal: params.goal,
    },
  };
}

// ── Action: status ──────────────────────────────────────────────────────────

async function handleStatus(
  params: TaskParams,
  storage: TaskStorage,
): Promise<ToolResult> {
  const plan = await resolvePlan(params.planId, storage);
  if (!plan) {
    return { success: false, error: params.planId ? `Plan not found: ${params.planId}` : "No active plan found" };
  }

  const current = findCurrentTask(plan.tasks);
  const progress = getProgress(plan.tasks);

  // Check for pending checkpoints (subtasks all completed but no checkpoint written)
  const pendingCheckpoints = findPendingCheckpoints(plan);

  return {
    success: true,
    data: {
      planId: plan.planId,
      goal: plan.goal,
      status: plan.status,
      progress,
      current: current ? `${current.id} — ${current.title} [${current.status}]` : null,
      tasks: plan.tasks,
      checkpoints: plan.checkpoints,
      pendingCheckpoints: pendingCheckpoints.length > 0 ? pendingCheckpoints : undefined,
      history: plan.history.slice(-20), // Last 20 events
    },
  };
}

// ── Action: update ──────────────────────────────────────────────────────────

async function handleUpdate(
  params: TaskParams,
  storage: TaskStorage,
  agentId?: string,
): Promise<ToolResult> {
  if (!params.id) {
    return { success: false, error: "Missing required field: id" };
  }

  const plan = await resolvePlan(params.planId, storage);
  if (!plan) {
    return { success: false, error: params.planId ? `Plan not found: ${params.planId}` : "No active plan found" };
  }

  const task = findTask(plan.tasks, params.id);
  if (!task) {
    return { success: false, error: `Task not found: ${params.id}` };
  }

  const now = new Date().toISOString();
  const changes: string[] = [];

  // Update status
  if (params.status) {
    const newStatus = params.status as Task["status"];

    // Validation: can't complete a task with pending subtasks
    if (newStatus === "completed" && task.subtasks && task.subtasks.length > 0) {
      if (!allSubtasksCompleted(task)) {
        return {
          success: false,
          error: `Cannot complete task ${params.id}: has pending subtasks. Complete or cancel subtasks first.`,
        };
      }
    }

    const oldStatus = task.status;
    task.status = newStatus;
    changes.push(`${params.id} status: ${oldStatus} → ${newStatus}`);
  }

  // Update notes
  if (params.notes !== undefined) {
    task.notes = params.notes;
    changes.push(`${params.id} notes updated`);
  }

  // Update context
  if (params.context && typeof params.context === "object") {
    task.context = mergeContext(task.context, params.context as import("../core/task/types.js").TaskContext);
    changes.push(`${params.id} context updated`);
  }

  // Record in history
  for (const change of changes) {
    plan.history.push({ time: now, event: change });
  }

  plan.lastModifiedBy = agentId;
  plan.lastModifiedAt = now;

  // Check if this completion triggers a checkpoint
  let checkpointReady: { taskId: string; aggregated: import("../core/task/types.js").AggregatedContext } | undefined;

  if (params.status === "completed") {
    // Check if parent is a checkpoint task and all its subtasks are done
    checkpointReady = checkForCheckpointTrigger(plan, params.id);
  }

  // Check if entire plan is complete
  if (isPlanComplete(plan)) {
    plan.status = "completed";
    plan.history.push({ time: now, event: "All tasks completed — plan marked as completed" });
  }

  // Save first (to active dir), then move to completed if done
  await storage.savePlan(plan);

  if (plan.status === "completed") {
    await storage.completePlan(plan.planId);
  }

  const result: Record<string, unknown> = {
    updated: true,
    taskId: params.id,
    changes,
    progress: getProgress(plan.tasks),
  };

  if (checkpointReady) {
    result.checkpointReady = true;
    result.checkpointTaskId = checkpointReady.taskId;
    result.aggregated = checkpointReady.aggregated;
  }

  if (plan.status === "completed") {
    result.planCompleted = true;
  }

  return { success: true, data: result };
}

// ── Action: add ─────────────────────────────────────────────────────────────

async function handleAdd(
  params: TaskParams,
  storage: TaskStorage,
  agentId?: string,
): Promise<ToolResult> {
  if (!params.parentId) {
    return { success: false, error: "Missing required field: parentId" };
  }
  if (!params.tasks || !Array.isArray(params.tasks) || params.tasks.length === 0) {
    return { success: false, error: "Missing required field: tasks (non-empty array)" };
  }

  const plan = await resolvePlan(params.planId, storage);
  if (!plan) {
    return { success: false, error: params.planId ? `Plan not found: ${params.planId}` : "No active plan found" };
  }

  // Find parent — could be a top-level task or the plan itself (parentId = "root")
  let targetArray: Task[];
  if (params.parentId === "root") {
    targetArray = plan.tasks;
  } else {
    const parent = findTask(plan.tasks, params.parentId);
    if (!parent) {
      return { success: false, error: `Parent task not found: ${params.parentId}` };
    }
    if (!parent.subtasks) parent.subtasks = [];
    targetArray = parent.subtasks;
  }

  // Determine the starting index to avoid duplicate IDs with existing children
  const startIndex = targetArray.length;
  const newTasks = inputsToTasks(
    params.tasks as import("../core/task/types.js").TaskInput[],
    params.parentId === "root" ? undefined : params.parentId,
    startIndex,
  );

  // Insert after specified sibling, or append
  if (params.after) {
    const afterIdx = targetArray.findIndex(t => t.id === params.after);
    if (afterIdx >= 0) {
      targetArray.splice(afterIdx + 1, 0, ...newTasks);
    } else {
      targetArray.push(...newTasks);
    }
  } else {
    targetArray.push(...newTasks);
  }

  const now = new Date().toISOString();
  const addedIds = newTasks.map(t => t.id).join(", ");
  plan.history.push({ time: now, event: `Added ${newTasks.length} task(s) under ${params.parentId}: ${addedIds}` });
  plan.lastModifiedBy = agentId;
  plan.lastModifiedAt = now;

  await storage.savePlan(plan);

  return {
    success: true,
    data: {
      added: true,
      parentId: params.parentId,
      newTasks: newTasks.map(t => ({ id: t.id, title: t.title })),
      progress: getProgress(plan.tasks),
    },
  };
}

// ── Action: replan ──────────────────────────────────────────────────────────

async function handleReplan(
  params: TaskParams,
  storage: TaskStorage,
  agentId?: string,
): Promise<ToolResult> {
  if (!params.reason) {
    return { success: false, error: "Missing required field: reason" };
  }

  const plan = await resolvePlan(params.planId, storage);
  if (!plan) {
    return { success: false, error: params.planId ? `Plan not found: ${params.planId}` : "No active plan found" };
  }

  const now = new Date().toISOString();
  const changes: string[] = [];

  // Cancel specified tasks
  if (params.cancel && Array.isArray(params.cancel)) {
    for (const cancelId of params.cancel) {
      const taskToCancel = findTask(plan.tasks, cancelId);
      if (taskToCancel) {
        cancelTaskTree(taskToCancel);
        changes.push(`Cancelled: ${cancelId} (${taskToCancel.title})`);
      }
    }
  }

  // Add new tasks
  if (params.add && Array.isArray(params.add)) {
    for (const addItem of params.add) {
      const item = addItem as import("../core/task/types.js").TaskInput & { parentId?: string };
      const parentId = item.parentId ?? "root";

      let targetArray: Task[];
      if (parentId === "root") {
        targetArray = plan.tasks;
      } else {
        const parent = findTask(plan.tasks, parentId);
        if (!parent) {
          changes.push(`Warning: parent ${parentId} not found, skipping add`);
          continue;
        }
        if (!parent.subtasks) parent.subtasks = [];
        targetArray = parent.subtasks;
      }

      const newTasks = inputsToTasks([item], parentId === "root" ? undefined : parentId);
      targetArray.push(...newTasks);
      changes.push(`Added: ${newTasks[0].id} (${newTasks[0].title}) under ${parentId}`);
    }
  }

  plan.history.push({ time: now, event: `Replan: ${params.reason}` });
  for (const change of changes) {
    plan.history.push({ time: now, event: change });
  }

  plan.lastModifiedBy = agentId;
  plan.lastModifiedAt = now;

  await storage.savePlan(plan);

  return {
    success: true,
    data: {
      replanned: true,
      reason: params.reason,
      changes,
      progress: getProgress(plan.tasks),
    },
  };
}

// ── Action: checkpoint ──────────────────────────────────────────────────────

async function handleCheckpoint(
  params: TaskParams,
  storage: TaskStorage,
  agentId?: string,
): Promise<ToolResult> {
  if (!params.id) {
    return { success: false, error: "Missing required field: id" };
  }
  if (!params.summary) {
    return { success: false, error: "Missing required field: summary" };
  }

  const plan = await resolvePlan(params.planId, storage);
  if (!plan) {
    return { success: false, error: params.planId ? `Plan not found: ${params.planId}` : "No active plan found" };
  }

  const checkpointTask = findTask(plan.tasks, params.id);
  if (!checkpointTask) {
    return { success: false, error: `Task not found: ${params.id}` };
  }

  // Aggregate context from completed subtasks
  const aggregated = aggregateContext(checkpointTask);

  const checkpoint: Checkpoint = {
    taskId: params.id,
    completedAt: new Date().toISOString(),
    summary: params.summary,
    aggregated,
    keyFiles: aggregated.files.length > 0 ? aggregated.files : undefined,
  };

  // Replace existing checkpoint for this task ID, or add new
  const existingIdx = plan.checkpoints.findIndex(c => c.taskId === params.id);
  if (existingIdx >= 0) {
    plan.checkpoints[existingIdx] = checkpoint;
  } else {
    plan.checkpoints.push(checkpoint);
  }

  const now = new Date().toISOString();
  plan.history.push({ time: now, event: `Checkpoint saved for task ${params.id}: "${params.summary.slice(0, 80)}..."` });
  plan.lastModifiedBy = agentId;
  plan.lastModifiedAt = now;

  await storage.savePlan(plan);

  return {
    success: true,
    data: {
      checkpointSaved: true,
      taskId: params.id,
      aggregatedFindings: aggregated.findings.length,
      aggregatedDecisions: aggregated.decisions.length,
      aggregatedFiles: aggregated.files.length,
    },
  };
}

// ── Action: export ──────────────────────────────────────────────────────────

async function handleExport(
  params: TaskParams,
  storage: TaskStorage,
): Promise<ToolResult> {
  const plan = await resolvePlan(params.planId, storage);
  if (!plan) {
    return { success: false, error: params.planId ? `Plan not found: ${params.planId}` : "No active plan found" };
  }

  const format = params.format ?? "summary";

  if (format === "full") {
    return {
      success: true,
      data: plan,
    };
  }

  // Summary format — compact ~500 token export
  const allDecisions: string[] = [];
  const allFiles: string[] = [];

  function collectFromTasks(tasks: Task[]): void {
    for (const t of tasks) {
      if (t.context?.decisions) allDecisions.push(...t.context.decisions);
      if (t.context?.files) allFiles.push(...t.context.files);
      if (t.subtasks) collectFromTasks(t.subtasks);
    }
  }
  collectFromTasks(plan.tasks);

  // Also collect from checkpoints
  for (const cp of plan.checkpoints) {
    allDecisions.push(...cp.aggregated.decisions);
    allFiles.push(...cp.aggregated.files);
  }

  const uniqueFiles = [...new Set(allFiles)];
  const uniqueDecisions = [...new Set(allDecisions)];

  // Build summary from last checkpoint or goal
  const lastCheckpoint = plan.checkpoints[plan.checkpoints.length - 1];
  const summaryText = lastCheckpoint?.summary ?? plan.goal;

  return {
    success: true,
    data: {
      planId: plan.planId,
      goal: plan.goal,
      status: plan.status,
      progress: getProgress(plan.tasks),
      summary: summaryText,
      checkpoints: plan.checkpoints.map(c => ({
        taskId: c.taskId,
        summary: c.summary,
      })),
      filesModified: uniqueFiles,
      decisions: uniqueDecisions,
    },
  };
}

// ── Action: list ────────────────────────────────────────────────────────────

async function handleList(storage: TaskStorage): Promise<ToolResult> {
  const plans = await storage.listPlans();

  return {
    success: true,
    data: {
      active: plans.active,
      completed: plans.completed,
      totalActive: plans.active.length,
      totalCompleted: plans.completed.length,
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a plan by ID, or fall back to the most recently modified active plan.
 */
async function resolvePlan(planId: string | undefined, storage: TaskStorage): Promise<Plan | null> {
  if (planId) {
    return storage.loadPlan(planId);
  }
  return storage.loadActivePlan();
}

/**
 * Cancel a task and all its subtasks recursively.
 */
function cancelTaskTree(taskItem: Task): void {
  if (taskItem.status !== "completed") {
    taskItem.status = "cancelled";
  }
  if (taskItem.subtasks) {
    for (const sub of taskItem.subtasks) {
      cancelTaskTree(sub);
    }
  }
}

/**
 * Check if completing a task triggers a checkpoint.
 * Returns aggregated context if a checkpoint is ready.
 */
function checkForCheckpointTrigger(
  plan: Plan,
  completedTaskId: string,
): { taskId: string; aggregated: import("../core/task/types.js").AggregatedContext } | undefined {
  // Walk all tasks to find checkpoint parents of the completed task
  function findCheckpointParent(tasks: Task[]): Task | null {
    for (const t of tasks) {
      if (t.checkpoint && t.subtasks) {
        // Is the completed task one of my subtasks (direct or nested)?
        if (findTask(t.subtasks, completedTaskId)) {
          // Are all subtasks completed?
          if (allSubtasksCompleted(t)) {
            return t;
          }
        }
      }
      if (t.subtasks) {
        const found = findCheckpointParent(t.subtasks);
        if (found) return found;
      }
    }
    return null;
  }

  const checkpointTask = findCheckpointParent(plan.tasks);
  if (!checkpointTask) return undefined;

  // Don't trigger if checkpoint already exists
  if (plan.checkpoints.some(c => c.taskId === checkpointTask.id)) return undefined;

  const aggregated = aggregateContext(checkpointTask);
  return { taskId: checkpointTask.id, aggregated };
}

/**
 * Find checkpoint tasks where all subtasks are complete but no checkpoint has been written.
 */
function findPendingCheckpoints(plan: Plan): string[] {
  const pending: string[] = [];

  function walk(tasks: Task[]): void {
    for (const t of tasks) {
      if (t.checkpoint && t.subtasks && t.subtasks.length > 0) {
        if (allSubtasksCompleted(t) && !plan.checkpoints.some(c => c.taskId === t.id)) {
          pending.push(t.id);
        }
      }
      if (t.subtasks) walk(t.subtasks);
    }
  }

  walk(plan.tasks);
  return pending;
}
