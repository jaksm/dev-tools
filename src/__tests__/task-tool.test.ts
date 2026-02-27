/**
 * Tests for the task tool — all 8 actions end-to-end through the tool function.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { task } from "../tools/task.js";
import { createTaskStorage, type TaskStorage } from "../core/task/storage.js";

let tmpDir: string;
let storage: TaskStorage;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-tool-test-"));
  const plansDir = path.join(tmpDir, "plans");
  const completedDir = path.join(tmpDir, "plans", ".completed");
  await fs.mkdir(plansDir, { recursive: true });
  await fs.mkdir(completedDir, { recursive: true });
  storage = createTaskStorage(plansDir, completedDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helper: create a standard plan ──────────────────────────────────────────

async function createTestPlan() {
  return task({
    action: "plan",
    goal: "Fix authentication bug",
    tasks: [
      {
        id: "1", title: "Understand auth flow", checkpoint: true,
        subtasks: [
          { id: "1.1", title: "Read UserService auth methods" },
          { id: "1.2", title: "Read AuthMiddleware token validation" },
        ],
      },
      { id: "2", title: "Implement fix" },
      { id: "3", title: "Verify" },
    ],
  }, storage, "test-agent");
}

// ── Action: plan ────────────────────────────────────────────────────────────

describe("task — plan action", () => {
  it("should create a plan with generated ID", async () => {
    const result = await task({
      action: "plan",
      goal: "Build new feature",
      tasks: [
        { id: "1", title: "Research" },
        { id: "2", title: "Implement" },
      ],
    }, storage, "agent-1");

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.created).toBe(true);
    expect(data.taskCount).toBe(2);
    expect(data.planId).toMatch(/^build-new-feature-[a-f0-9]{4}$/);
  });

  it("should persist plan to storage", async () => {
    const result = await task({
      action: "plan",
      goal: "Test persistence",
      tasks: [{ id: "1", title: "Only task" }],
    }, storage);

    const data = result.data as Record<string, unknown>;
    const loaded = await storage.loadPlan(data.planId as string);
    expect(loaded).not.toBeNull();
    expect(loaded!.goal).toBe("Test persistence");
  });

  it("should count nested tasks", async () => {
    const result = await task({
      action: "plan",
      goal: "Nested plan",
      tasks: [
        {
          id: "1", title: "Parent",
          subtasks: [
            { id: "1.1", title: "Child 1" },
            { id: "1.2", title: "Child 2" },
          ],
        },
        { id: "2", title: "Other" },
      ],
    }, storage);

    const data = result.data as Record<string, unknown>;
    expect(data.taskCount).toBe(4); // 1 + 1.1 + 1.2 + 2
  });

  it("should fail without goal", async () => {
    const result = await task({ action: "plan", tasks: [{ title: "x" }] }, storage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("goal");
  });

  it("should fail without tasks", async () => {
    const result = await task({ action: "plan", goal: "No tasks" }, storage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("tasks");
  });
});

// ── Action: status ──────────────────────────────────────────────────────────

describe("task — status action", () => {
  it("should return full plan state", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    const result = await task({ action: "status", planId }, storage);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.goal).toBe("Fix authentication bug");
    expect(data.progress).toBe("0/5");
    expect(data.status).toBe("active");
    expect((data.tasks as unknown[]).length).toBe(3);
  });

  it("should find current task", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    // Update first subtask to in_progress
    await task({ action: "update", id: "1.1", status: "in_progress", planId }, storage);

    const result = await task({ action: "status", planId }, storage);
    const data = result.data as Record<string, unknown>;
    expect(data.current).toContain("1.1");
    expect(data.current).toContain("in_progress");
  });

  it("should auto-resolve to most recent active plan", async () => {
    await createTestPlan();
    const result = await task({ action: "status" }, storage);
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).goal).toBe("Fix authentication bug");
  });

  it("should fail when no plan exists", async () => {
    const result = await task({ action: "status" }, storage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No active plan");
  });
});

// ── Action: update ──────────────────────────────────────────────────────────

describe("task — update action", () => {
  it("should update task status", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    const result = await task({
      action: "update", id: "1.1", status: "completed", planId,
    }, storage);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.changes).toContain("1.1 status: pending → completed");
    expect(data.progress).toBe("1/5");
  });

  it("should update notes and context", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    await task({
      action: "update", id: "1.1", planId,
      notes: "Found the issue",
      context: {
        findings: ["Token expires after 1 hour"],
        files: ["src/auth.ts"],
      },
    }, storage);

    // Check via status
    const status = await task({ action: "status", planId }, storage);
    const tasks = (status.data as Record<string, unknown>).tasks as Array<{
      subtasks?: Array<{ id: string; notes?: string; context?: Record<string, unknown> }>;
    }>;
    const subtask = tasks[0].subtasks!.find(t => t.id === "1.1")!;
    expect(subtask.notes).toBe("Found the issue");
    expect(subtask.context?.findings).toEqual(["Token expires after 1 hour"]);
  });

  it("should prevent completing task with pending subtasks", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    const result = await task({
      action: "update", id: "1", status: "completed", planId,
    }, storage);

    expect(result.success).toBe(false);
    expect(result.error).toContain("pending subtasks");
  });

  it("should allow completing task when all subtasks done", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    // Complete both subtasks
    await task({ action: "update", id: "1.1", status: "completed", planId }, storage);
    await task({ action: "update", id: "1.2", status: "completed", planId }, storage);

    // Now parent should be completable
    const result = await task({
      action: "update", id: "1", status: "completed", planId,
    }, storage);
    expect(result.success).toBe(true);
  });

  it("should trigger checkpoint when all subtasks under checkpoint task complete", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    // Add context to subtasks
    await task({
      action: "update", id: "1.1", status: "completed", planId,
      context: { findings: ["Auth uses JWT"], files: ["src/auth.ts"] },
    }, storage);

    // Complete last subtask — should trigger checkpoint
    const result = await task({
      action: "update", id: "1.2", status: "completed", planId,
      context: { findings: ["Token validated in middleware"] },
    }, storage);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.checkpointReady).toBe(true);
    expect(data.checkpointTaskId).toBe("1");
    const agg = data.aggregated as Record<string, unknown>;
    expect((agg.findings as string[]).length).toBe(2);
  });

  it("should mark plan as completed when all tasks done", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    // Complete all tasks
    await task({ action: "update", id: "1.1", status: "completed", planId }, storage);
    await task({ action: "update", id: "1.2", status: "completed", planId }, storage);
    await task({ action: "update", id: "1", status: "completed", planId }, storage);
    await task({ action: "update", id: "2", status: "completed", planId }, storage);

    const result = await task({
      action: "update", id: "3", status: "completed", planId,
    }, storage);

    const data = result.data as Record<string, unknown>;
    expect(data.planCompleted).toBe(true);
  });

  it("should fail with invalid task ID", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    const result = await task({
      action: "update", id: "99", status: "completed", planId,
    }, storage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Task not found");
  });

  it("should merge context additively", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    // First update with context
    await task({
      action: "update", id: "1.1", planId,
      context: { findings: ["Finding 1"], files: ["src/a.ts"] },
    }, storage);

    // Second update with more context
    await task({
      action: "update", id: "1.1", planId,
      context: { findings: ["Finding 2"], files: ["src/a.ts", "src/b.ts"] },
    }, storage);

    const status = await task({ action: "status", planId }, storage);
    const tasks = (status.data as Record<string, unknown>).tasks as Array<{
      subtasks?: Array<{ id: string; context?: { findings: string[]; files: string[] } }>;
    }>;
    const subtask = tasks[0].subtasks!.find(t => t.id === "1.1")!;
    expect(subtask.context?.findings).toEqual(["Finding 1", "Finding 2"]);
    expect(subtask.context?.files).toEqual(["src/a.ts", "src/b.ts"]); // Deduplicated
  });
});

// ── Action: add ─────────────────────────────────────────────────────────────

describe("task — add action", () => {
  it("should add tasks under a parent", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    const result = await task({
      action: "add", planId,
      parentId: "2",
      tasks: [
        { id: "2.1", title: "Sub-implement A" },
        { id: "2.2", title: "Sub-implement B" },
      ],
    }, storage);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.added).toBe(true);
    expect(data.progress).toBe("0/7"); // 5 + 2 new

    // Verify via status
    const status = await task({ action: "status", planId }, storage);
    const tasks = (status.data as Record<string, unknown>).tasks as Array<{
      id: string; subtasks?: Array<{ id: string }>;
    }>;
    const task2 = tasks.find(t => t.id === "2")!;
    expect(task2.subtasks).toHaveLength(2);
  });

  it("should add tasks at root level", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    await task({
      action: "add", planId,
      parentId: "root",
      tasks: [{ id: "4", title: "New top-level task" }],
    }, storage);

    const status = await task({ action: "status", planId }, storage);
    const tasks = (status.data as Record<string, unknown>).tasks as Array<{ id: string }>;
    expect(tasks).toHaveLength(4);
    expect(tasks[3].id).toBe("4");
  });

  it("should insert after specified sibling", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    await task({
      action: "add", planId,
      parentId: "1",
      after: "1.1",
      tasks: [{ id: "1.1b", title: "Inserted task" }],
    }, storage);

    const status = await task({ action: "status", planId }, storage);
    const tasks = (status.data as Record<string, unknown>).tasks as Array<{
      id: string; subtasks?: Array<{ id: string }>;
    }>;
    const subtasks = tasks.find(t => t.id === "1")!.subtasks!;
    expect(subtasks[0].id).toBe("1.1");
    expect(subtasks[1].id).toBe("1.1b");
    expect(subtasks[2].id).toBe("1.2");
  });
});

// ── Action: replan ──────────────────────────────────────────────────────────

describe("task — replan action", () => {
  it("should cancel tasks and add new ones", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    const result = await task({
      action: "replan", planId,
      reason: "Bug is simpler than expected",
      cancel: ["2"],
      add: [
        { id: "2", title: "Quick fix", parentId: "root" },
      ],
    }, storage);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.reason).toBe("Bug is simpler than expected");
    expect((data.changes as string[]).length).toBeGreaterThan(0);

    // Verify history has reason
    const status = await task({ action: "status", planId }, storage);
    const history = (status.data as Record<string, unknown>).history as Array<{ event: string }>;
    const replanEvent = history.find(h => h.event.includes("Replan:"));
    expect(replanEvent).toBeDefined();
    expect(replanEvent!.event).toContain("Bug is simpler");
  });

  it("should fail without reason", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    const result = await task({
      action: "replan", planId,
      cancel: ["2"],
    }, storage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("reason");
  });

  it("should recursively cancel subtasks", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    await task({
      action: "replan", planId,
      reason: "Changed approach",
      cancel: ["1"], // Has subtasks 1.1, 1.2
    }, storage);

    const status = await task({ action: "status", planId }, storage);
    const tasks = (status.data as Record<string, unknown>).tasks as Array<{
      id: string; status: string; subtasks?: Array<{ status: string }>;
    }>;
    const task1 = tasks.find(t => t.id === "1")!;
    expect(task1.status).toBe("cancelled");
    expect(task1.subtasks![0].status).toBe("cancelled");
    expect(task1.subtasks![1].status).toBe("cancelled");
  });
});

// ── Action: checkpoint ──────────────────────────────────────────────────────

describe("task — checkpoint action", () => {
  it("should save checkpoint with aggregated context", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    // Complete subtasks with context
    await task({
      action: "update", id: "1.1", status: "completed", planId,
      context: { findings: ["JWT-based auth"], files: ["src/auth.ts"] },
    }, storage);
    await task({
      action: "update", id: "1.2", status: "completed", planId,
      context: { findings: ["Middleware validates token"], decisions: ["Fix in middleware"] },
    }, storage);

    // Write checkpoint
    const result = await task({
      action: "checkpoint", id: "1", planId,
      summary: "Auth flow traced. Bug is in middleware — verify rejects expired tokens without refresh.",
    }, storage);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.checkpointSaved).toBe(true);
    expect(data.aggregatedFindings).toBe(2);
    expect(data.aggregatedDecisions).toBe(1);

    // Verify in status
    const status = await task({ action: "status", planId }, storage);
    const checkpoints = (status.data as Record<string, unknown>).checkpoints as Array<{
      taskId: string; summary: string;
    }>;
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].summary).toContain("Auth flow traced");
  });

  it("should replace existing checkpoint", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    await task({ action: "update", id: "1.1", status: "completed", planId }, storage);
    await task({ action: "update", id: "1.2", status: "completed", planId }, storage);

    await task({ action: "checkpoint", id: "1", summary: "First draft", planId }, storage);
    await task({ action: "checkpoint", id: "1", summary: "Revised summary", planId }, storage);

    const status = await task({ action: "status", planId }, storage);
    const checkpoints = (status.data as Record<string, unknown>).checkpoints as Array<{
      summary: string;
    }>;
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].summary).toBe("Revised summary");
  });
});

// ── Action: export ──────────────────────────────────────────────────────────

describe("task — export action", () => {
  it("should export summary format", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    // Add some context
    await task({
      action: "update", id: "1.1", status: "completed", planId,
      context: { decisions: ["Fix in middleware"], files: ["src/auth.ts"] },
    }, storage);

    const result = await task({ action: "export", planId }, storage);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.planId).toBe(planId);
    expect(data.goal).toBe("Fix authentication bug");
    expect(data.progress).toBe("1/5");
    expect((data.filesModified as string[])).toContain("src/auth.ts");
    expect((data.decisions as string[])).toContain("Fix in middleware");
  });

  it("should export full format", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    const result = await task({ action: "export", format: "full", planId }, storage);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    // Full format returns the entire plan
    expect(data.planId).toBe(planId);
    expect(data.tasks).toBeDefined();
    expect(data.history).toBeDefined();
    expect(data.checkpoints).toBeDefined();
  });
});

// ── Action: list ────────────────────────────────────────────────────────────

describe("task — list action", () => {
  it("should list active and completed plans", async () => {
    await createTestPlan();

    // Create and complete another plan
    const r2 = await task({
      action: "plan", goal: "Quick fix",
      tasks: [{ id: "1", title: "Do it" }],
    }, storage);
    const planId2 = (r2.data as Record<string, unknown>).planId as string;
    await task({ action: "update", id: "1", status: "completed", planId: planId2 }, storage);

    const result = await task({ action: "list" }, storage);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    expect(data.totalActive).toBe(1);
    expect(data.totalCompleted).toBe(1);
  });

  it("should return empty when no plans", async () => {
    const result = await task({ action: "list" }, storage);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.totalActive).toBe(0);
    expect(data.totalCompleted).toBe(0);
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("task — error handling", () => {
  it("should reject unknown action", async () => {
    const result = await task({ action: "invalid" }, storage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
  });

  it("should require id for update", async () => {
    const result = await task({ action: "update", status: "completed" }, storage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("id");
  });

  it("should require id for checkpoint", async () => {
    const result = await task({ action: "checkpoint", summary: "test" }, storage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("id");
  });

  it("should require summary for checkpoint", async () => {
    await createTestPlan();
    const result = await task({ action: "checkpoint", id: "1" }, storage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("summary");
  });

  it("should require parentId for add", async () => {
    const result = await task({
      action: "add",
      tasks: [{ title: "New" }],
    }, storage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("parentId");
  });
});

// ── Pending checkpoint detection ────────────────────────────────────────────

describe("task — pending checkpoint detection", () => {
  it("should report pending checkpoints in status", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    // Complete both subtasks under checkpoint task
    await task({ action: "update", id: "1.1", status: "completed", planId }, storage);
    await task({ action: "update", id: "1.2", status: "completed", planId }, storage);

    // Don't write the checkpoint — status should flag it
    const result = await task({ action: "status", planId }, storage);
    const data = result.data as Record<string, unknown>;
    expect(data.pendingCheckpoints).toBeDefined();
    expect((data.pendingCheckpoints as string[])).toContain("1");
  });

  it("should not report checkpoint after it is written", async () => {
    const createResult = await createTestPlan();
    const planId = (createResult.data as Record<string, unknown>).planId as string;

    await task({ action: "update", id: "1.1", status: "completed", planId }, storage);
    await task({ action: "update", id: "1.2", status: "completed", planId }, storage);
    await task({ action: "checkpoint", id: "1", summary: "Done", planId }, storage);

    const result = await task({ action: "status", planId }, storage);
    const data = result.data as Record<string, unknown>;
    expect(data.pendingCheckpoints).toBeUndefined();
  });
});
