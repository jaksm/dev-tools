/**
 * Task tool types — plan schema, actions, and results.
 * Pure TypeScript, zero OC dependencies.
 */

// ── Task Status ─────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "blocked";

// ── Task Context (structured external memory) ──────────────────────────────

export interface TaskContext {
  findings?: string[];
  decisions?: string[];
  files?: string[];
}

// ── Task ────────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  checkpoint?: boolean;
  notes?: string;
  context?: TaskContext;
  subtasks?: Task[];
}

// ── Checkpoint ──────────────────────────────────────────────────────────────

export interface Checkpoint {
  taskId: string;
  completedAt: string;
  summary: string;
  aggregated: AggregatedContext;
  keyFiles?: string[];
  keySymbols?: string[];
}

export interface AggregatedContext {
  findings: string[];
  decisions: string[];
  files: string[];
}

// ── History Entry ───────────────────────────────────────────────────────────

export interface HistoryEntry {
  time: string;
  event: string;
}

// ── Plan ────────────────────────────────────────────────────────────────────

export interface Plan {
  planId: string;
  goal: string;
  tasks: Task[];
  checkpoints: Checkpoint[];
  history: HistoryEntry[];
  createdBy?: string;
  lastModifiedBy?: string;
  createdAt: string;
  lastModifiedAt: string;
  status: "active" | "completed";
}

// ── Action Params ───────────────────────────────────────────────────────────

export interface PlanActionParams {
  action: "plan";
  goal: string;
  tasks: TaskInput[];
}

export interface StatusActionParams {
  action: "status";
  planId?: string;
}

export interface UpdateActionParams {
  action: "update";
  id: string;
  status?: TaskStatus;
  notes?: string;
  context?: TaskContext;
  planId?: string;
}

export interface AddActionParams {
  action: "add";
  parentId: string;
  after?: string;
  tasks: TaskInput[];
  planId?: string;
}

export interface ReplanActionParams {
  action: "replan";
  reason: string;
  cancel?: string[];
  add?: Array<TaskInput & { parentId?: string }>;
  planId?: string;
}

export interface CheckpointActionParams {
  action: "checkpoint";
  id: string;
  summary: string;
  planId?: string;
}

export interface ExportActionParams {
  action: "export";
  format?: "summary" | "full";
  planId?: string;
}

export interface ListActionParams {
  action: "list";
}

export type TaskActionParams =
  | PlanActionParams
  | StatusActionParams
  | UpdateActionParams
  | AddActionParams
  | ReplanActionParams
  | CheckpointActionParams
  | ExportActionParams
  | ListActionParams;

// ── Task Input (for plan/add actions) ───────────────────────────────────────

export interface TaskInput {
  id?: string;
  title: string;
  checkpoint?: boolean;
  subtasks?: TaskInput[];
}
