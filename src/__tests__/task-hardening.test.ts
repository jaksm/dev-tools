/**
 * Task tool hardening tests — edge cases for deep hierarchies, performance,
 * unicode, history growth, export size, and complex status transitions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { task } from "../tools/task.js";
import { createTaskStorage, type TaskStorage } from "../core/task/storage.js";
import {
  generatePlanId,
  findTask,
  countTasks,
  getProgress,
  aggregateContext,
  isPlanComplete,
  inputsToTasks,
  findCurrentTask,
} from "../core/task/helpers.js";
import type { Task, Plan } from "../core/task/types.js";

let tmpDir: string;
let storage: TaskStorage;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-hard-"));
  const plansDir = path.join(tmpDir, "plans");
  const completedDir = path.join(tmpDir, "plans", ".completed");
  await fs.mkdir(plansDir, { recursive: true });
  await fs.mkdir(completedDir, { recursive: true });
  storage = createTaskStorage(plansDir, completedDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Deep task hierarchies (5+ levels) ───────────────────────────────────────

describe("task — deep hierarchies", () => {
  it("creates and navigates 5-level deep task tree", async () => {
    const result = await task({
      action: "plan",
      goal: "Deep hierarchy test",
      tasks: [{
        id: "1", title: "Level 1",
        subtasks: [{
          id: "1.1", title: "Level 2",
          subtasks: [{
            id: "1.1.1", title: "Level 3",
            subtasks: [{
              id: "1.1.1.1", title: "Level 4",
              subtasks: [{
                id: "1.1.1.1.1", title: "Level 5",
              }],
            }],
          }],
        }],
      }],
    }, storage);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.taskCount).toBe(5);

    const planId = data.planId as string;

    // Can update deepest task
    const updateResult = await task({
      action: "update", planId,
      id: "1.1.1.1.1",
      status: "completed",
      notes: "Deep task done",
    }, storage);
    expect(updateResult.success).toBe(true);

    // Status reflects deep progress
    const statusResult = await task({ action: "status", planId }, storage);
    expect(statusResult.success).toBe(true);
    // Auto-promotion: completing the deepest leaf promotes all single-child ancestors
    expect((statusResult.data as any).progress).toBe("5/5");
  });

  it("completing parent with 3-level deep nested subtasks requires all done", async () => {
    const result = await task({
      action: "plan",
      goal: "Nested completion",
      tasks: [{
        id: "1", title: "Root", checkpoint: true,
        subtasks: [{
          id: "1.1", title: "Mid",
          subtasks: [{
            id: "1.1.1", title: "Leaf",
          }],
        }],
      }],
    }, storage);

    const planId = (result.data as any).planId;

    // Can't complete root while subtasks pending
    const failResult = await task({
      action: "update", planId, id: "1", status: "completed",
    }, storage);
    expect(failResult.success).toBe(false);
    expect(failResult.error).toContain("pending subtasks");

    // Can't complete mid while leaf is pending
    const failMid = await task({
      action: "update", planId, id: "1.1", status: "completed",
    }, storage);
    expect(failMid.success).toBe(false);

    // Complete leaf, then mid, then root
    await task({ action: "update", planId, id: "1.1.1", status: "completed" }, storage);
    await task({ action: "update", planId, id: "1.1", status: "completed" }, storage);
    const rootResult = await task({ action: "update", planId, id: "1", status: "completed" }, storage);
    expect(rootResult.success).toBe(true);
  });
});

// ── Unicode in goals and task titles ────────────────────────────────────────

describe("task — unicode", () => {
  it("handles unicode in goal and task titles", async () => {
    const result = await task({
      action: "plan",
      goal: "修复认证 bug 🐛",
      tasks: [
        { id: "1", title: "理解认证流程 🔑" },
        { id: "2", title: "修改代码 💻" },
        { id: "3", title: "Тестирование 🧪" },
      ],
    }, storage);

    expect(result.success).toBe(true);
    const planId = (result.data as any).planId;

    // Verify persistence
    const status = await task({ action: "status", planId }, storage);
    expect(status.success).toBe(true);
    expect((status.data as any).goal).toBe("修复认证 bug 🐛");
    const tasks = (status.data as any).tasks;
    expect(tasks[0].title).toBe("理解认证流程 🔑");
    expect(tasks[2].title).toBe("Тестирование 🧪");
  });

  it("handles unicode in notes and context", async () => {
    const result = await task({
      action: "plan",
      goal: "Unicode context test",
      tasks: [{ id: "1", title: "Task" }],
    }, storage);

    const planId = (result.data as any).planId;

    await task({
      action: "update", planId, id: "1",
      notes: "发现问题：令牌过期后不刷新 → 解决方案：添加刷新逻辑",
      context: {
        findings: ["Нашли баг в авторизации", "修复了问题 ✅"],
        files: ["src/авторизация.ts"],
      },
    }, storage);

    const status = await task({ action: "status", planId }, storage);
    const task1 = (status.data as any).tasks[0];
    expect(task1.notes).toContain("发现问题");
    expect(task1.context.findings[0]).toContain("Нашли баг");
  });

  it("generatePlanId handles unicode goals", () => {
    const id1 = generatePlanId("修复认证 bug");
    expect(id1).toMatch(/-[a-f0-9]{4}$/);

    const id2 = generatePlanId("🚀 Launch rocket");
    expect(id2).toMatch(/-[a-f0-9]{4}$/);

    // All-emoji goal should fall back to "plan"
    const id3 = generatePlanId("🎉🎊🎈");
    expect(id3).toMatch(/^plan-[a-f0-9]{4}$/);
  });
});

// ── Plan with 100+ tasks (performance) ──────────────────────────────────────

describe("task — large plans", () => {
  it("handles 100+ tasks efficiently", async () => {
    const tasks = Array.from({ length: 120 }, (_, i) => ({
      id: `${i + 1}`,
      title: `Task ${i + 1}: ${i % 3 === 0 ? "Research" : i % 3 === 1 ? "Implement" : "Test"}`,
    }));

    const start = Date.now();
    const result = await task({
      action: "plan",
      goal: "Large plan performance test",
      tasks,
    }, storage);
    const createTime = Date.now() - start;

    expect(result.success).toBe(true);
    expect((result.data as any).taskCount).toBe(120);
    expect(createTime).toBeLessThan(5000); // Should be well under 5s

    const planId = (result.data as any).planId;

    // Update many tasks
    const updateStart = Date.now();
    for (let i = 1; i <= 50; i++) {
      await task({
        action: "update", planId, id: `${i}`, status: "completed",
      }, storage);
    }
    const updateTime = Date.now() - updateStart;

    expect(updateTime).toBeLessThan(10000); // 50 updates in under 10s

    // Status should work
    const statusResult = await task({ action: "status", planId }, storage);
    expect(statusResult.success).toBe(true);
    expect((statusResult.data as any).progress).toBe("50/120");
  });

  it("handles plan with nested 100+ tasks", async () => {
    const subtasks = Array.from({ length: 50 }, (_, i) => ({
      id: `1.${i + 1}`,
      title: `Subtask ${i + 1}`,
    }));

    const result = await task({
      action: "plan",
      goal: "Nested large plan",
      tasks: [
        { id: "1", title: "Phase 1", subtasks },
        { id: "2", title: "Phase 2" },
      ],
    }, storage);

    expect(result.success).toBe(true);
    expect((result.data as any).taskCount).toBe(52); // 1 parent + 50 children + 1 phase 2
  });
});

// ── History log growth over many operations ─────────────────────────────────

describe("task — history growth", () => {
  it("history grows with each operation", async () => {
    const result = await task({
      action: "plan",
      goal: "History test",
      tasks: [
        { id: "1", title: "A" },
        { id: "2", title: "B" },
        { id: "3", title: "C" },
      ],
    }, storage);

    const planId = (result.data as any).planId;

    // Perform many operations
    for (let i = 1; i <= 3; i++) {
      await task({ action: "update", planId, id: `${i}`, status: "in_progress" }, storage);
      await task({
        action: "update", planId, id: `${i}`,
        notes: `Working on ${i}`,
        context: { findings: [`Finding ${i}`] },
      }, storage);
      await task({ action: "update", planId, id: `${i}`, status: "completed" }, storage);
    }

    const status = await task({ action: "status", planId }, storage);
    const history = (status.data as any).history;
    // Should have creation + multiple updates
    expect(history.length).toBeGreaterThanOrEqual(10);
    // All entries should have time and event
    for (const entry of history) {
      expect(entry.time).toBeTruthy();
      expect(entry.event).toBeTruthy();
    }
  });

  it("status returns last 20 history events", async () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      id: `${i + 1}`,
      title: `Task ${i + 1}`,
    }));

    const result = await task({
      action: "plan",
      goal: "History truncation test",
      tasks,
    }, storage);

    const planId = (result.data as any).planId;

    // Generate 30+ history events
    for (let i = 1; i <= 30; i++) {
      await task({ action: "update", planId, id: `${i}`, status: "completed" }, storage);
    }

    const status = await task({ action: "status", planId }, storage);
    const history = (status.data as any).history;
    // Status should cap at 20
    expect(history.length).toBeLessThanOrEqual(20);
  });
});

// ── Export summary token size ───────────────────────────────────────────────

describe("task — export", () => {
  it("export summary is compact (rough ~500 token target)", async () => {
    const result = await task({
      action: "plan",
      goal: "Fix authentication token refresh bug in middleware",
      tasks: [
        { id: "1", title: "Trace auth flow", checkpoint: true,
          subtasks: [
            { id: "1.1", title: "Read UserService" },
            { id: "1.2", title: "Read middleware" },
          ],
        },
        { id: "2", title: "Implement fix" },
        { id: "3", title: "Write tests" },
        { id: "4", title: "Verify in staging" },
      ],
    }, storage);

    const planId = (result.data as any).planId;

    // Add context through updates
    await task({
      action: "update", planId, id: "1.1", status: "completed",
      context: {
        findings: ["JWT tokens expire after 1 hour", "No refresh logic exists"],
        decisions: ["Add refresh endpoint to UserService"],
        files: ["src/services/user.ts", "src/middleware/auth.ts"],
      },
    }, storage);
    await task({
      action: "update", planId, id: "1.2", status: "completed",
      context: {
        findings: ["Middleware rejects expired tokens without checking refresh"],
        files: ["src/middleware/auth.ts"],
      },
    }, storage);
    await task({
      action: "checkpoint", planId, id: "1",
      summary: "Auth flow traced. Middleware rejects expired tokens. Fix: add refresh check before reject.",
    }, storage);
    await task({ action: "update", planId, id: "2", status: "completed" }, storage);
    await task({ action: "update", planId, id: "3", status: "completed" }, storage);
    await task({ action: "update", planId, id: "4", status: "completed" }, storage);

    const exportResult = await task({ action: "export", planId }, storage);
    expect(exportResult.success).toBe(true);

    const data = exportResult.data as any;
    const jsonStr = JSON.stringify(data);
    // Rough token estimate: ~4 chars per token
    const estimatedTokens = jsonStr.length / 4;
    expect(estimatedTokens).toBeLessThan(1000); // Should be well under 1000 tokens
    expect(data.filesModified).toBeDefined();
    expect(data.decisions).toBeDefined();
    expect(data.summary).toContain("Auth flow traced");
  });

  it("full format export includes everything", async () => {
    const result = await task({
      action: "plan",
      goal: "Full export test",
      tasks: [{ id: "1", title: "Do it" }],
    }, storage);

    const planId = (result.data as any).planId;
    await task({
      action: "update", planId, id: "1", status: "completed",
      notes: "Done!",
    }, storage);

    const exportResult = await task({ action: "export", planId, format: "full" }, storage);
    const data = exportResult.data as any;
    expect(data.tasks).toBeDefined();
    expect(data.history).toBeDefined();
    expect(data.checkpoints).toBeDefined();
    expect(data.planId).toBe(planId);
  });
});

// ── Concurrent rapid updates (sequential, testing correctness) ──────────────

describe("task — rapid sequential updates", () => {
  it("handles rapid sequential status transitions", async () => {
    const result = await task({
      action: "plan",
      goal: "Rapid update test",
      tasks: [
        { id: "1", title: "Task 1" },
        { id: "2", title: "Task 2" },
        { id: "3", title: "Task 3" },
      ],
    }, storage);

    const planId = (result.data as any).planId;

    // Rapid fire: update all tasks in sequence
    await task({ action: "update", planId, id: "1", status: "in_progress" }, storage);
    await task({ action: "update", planId, id: "1", status: "completed" }, storage);
    await task({ action: "update", planId, id: "2", status: "in_progress" }, storage);
    await task({ action: "update", planId, id: "2", status: "completed" }, storage);
    await task({ action: "update", planId, id: "3", status: "in_progress" }, storage);
    await task({ action: "update", planId, id: "3", status: "completed" }, storage);

    // Plan should be completed
    const status = await task({ action: "status", planId }, storage);
    // The plan auto-completes, so loading from active might fail
    // Try listing to find it
    const list = await task({ action: "list" }, storage);
    const data = list.data as any;
    expect(data.totalCompleted).toBe(1);
  });

  it("handles back-and-forth status changes", async () => {
    const result = await task({
      action: "plan",
      goal: "Back and forth",
      tasks: [{ id: "1", title: "Volatile task" }],
    }, storage);

    const planId = (result.data as any).planId;

    // Toggle back and forth
    await task({ action: "update", planId, id: "1", status: "in_progress" }, storage);
    await task({ action: "update", planId, id: "1", status: "blocked" }, storage);
    await task({ action: "update", planId, id: "1", status: "in_progress" }, storage);
    await task({ action: "update", planId, id: "1", status: "failed" }, storage);

    // Check final state
    const status = await task({ action: "status", planId }, storage);
    const tasks = (status.data as any).tasks;
    expect(tasks[0].status).toBe("failed");
  });
});

// ── Replan edge cases ───────────────────────────────────────────────────────

describe("task — replan edge cases", () => {
  it("cancels already-completed task gracefully", async () => {
    const result = await task({
      action: "plan",
      goal: "Cancel completed test",
      tasks: [
        { id: "1", title: "Done task" },
        { id: "2", title: "To cancel" },
      ],
    }, storage);

    const planId = (result.data as any).planId;
    await task({ action: "update", planId, id: "1", status: "completed" }, storage);

    const replanResult = await task({
      action: "replan", planId,
      reason: "Changed approach",
      cancel: ["1"], // Already completed
    }, storage);

    expect(replanResult.success).toBe(true);
    // Completed task should NOT be cancelled (cancelTaskTree skips completed)
    const status = await task({ action: "status", planId }, storage);
    expect((status.data as any).tasks[0].status).toBe("completed");
  });

  it("replan with both cancel and add simultaneously", async () => {
    const result = await task({
      action: "plan",
      goal: "Replan complex",
      tasks: [
        { id: "1", title: "Keep this" },
        { id: "2", title: "Cancel this" },
        { id: "3", title: "Cancel this too" },
      ],
    }, storage);

    const planId = (result.data as any).planId;

    const replanResult = await task({
      action: "replan", planId,
      reason: "New approach needed",
      cancel: ["2", "3"],
      add: [
        { id: "4", title: "New task A", parentId: "root" },
        { id: "5", title: "New task B", parentId: "root" },
      ],
    }, storage);

    expect(replanResult.success).toBe(true);

    const status = await task({ action: "status", planId }, storage);
    const tasks = (status.data as any).tasks;
    expect(tasks.find((t: any) => t.id === "2").status).toBe("cancelled");
    expect(tasks.find((t: any) => t.id === "3").status).toBe("cancelled");
    expect(tasks.find((t: any) => t.id === "4")).toBeDefined();
    expect(tasks.find((t: any) => t.id === "5")).toBeDefined();
  });
});

// ── Add edge cases ──────────────────────────────────────────────────────────

describe("task — add edge cases", () => {
  it("adding to non-existent parent fails", async () => {
    const result = await task({
      action: "plan",
      goal: "Add fail test",
      tasks: [{ id: "1", title: "Only task" }],
    }, storage);

    const planId = (result.data as any).planId;

    const addResult = await task({
      action: "add", planId,
      parentId: "99",
      tasks: [{ id: "99.1", title: "Orphan" }],
    }, storage);

    expect(addResult.success).toBe(false);
    expect(addResult.error).toContain("Parent task not found");
  });

  it("adding with after pointing to nonexistent sibling appends", async () => {
    const result = await task({
      action: "plan",
      goal: "After miss test",
      tasks: [{
        id: "1", title: "Parent",
        subtasks: [{ id: "1.1", title: "Child" }],
      }],
    }, storage);

    const planId = (result.data as any).planId;

    await task({
      action: "add", planId,
      parentId: "1",
      after: "nonexistent",
      tasks: [{ id: "1.2", title: "New child" }],
    }, storage);

    // Should be appended at end
    const status = await task({ action: "status", planId }, storage);
    const subtasks = (status.data as any).tasks[0].subtasks;
    expect(subtasks[subtasks.length - 1].id).toBe("1.2");
  });
});

// ── Helper edge cases ───────────────────────────────────────────────────────

describe("task helpers — edge cases", () => {
  it("findCurrentTask with all cancelled", () => {
    const tasks: Task[] = [
      { id: "1", title: "A", status: "cancelled" },
      { id: "2", title: "B", status: "cancelled" },
    ];
    expect(findCurrentTask(tasks)).toBeNull();
  });

  it("findCurrentTask prefers in_progress over pending", () => {
    const tasks: Task[] = [
      { id: "1", title: "Pending", status: "pending" },
      { id: "2", title: "Active", status: "in_progress" },
      { id: "3", title: "Also pending", status: "pending" },
    ];
    expect(findCurrentTask(tasks)?.id).toBe("2");
  });

  it("countTasks with deeply nested empty arrays", () => {
    const tasks: Task[] = [
      {
        id: "1", title: "A", status: "pending",
        subtasks: [],
      },
    ];
    expect(countTasks(tasks)).toBe(1);
  });

  it("getProgress with all failed", () => {
    const tasks: Task[] = [
      { id: "1", title: "A", status: "failed" },
      { id: "2", title: "B", status: "failed" },
    ];
    expect(getProgress(tasks)).toBe("0/2");
  });

  it("isPlanComplete with mixed terminal states", () => {
    const plan: Plan = {
      planId: "test", goal: "Test",
      tasks: [
        { id: "1", title: "A", status: "completed" },
        { id: "2", title: "B", status: "cancelled" },
        { id: "3", title: "C", status: "failed" },
      ],
      checkpoints: [], history: [], createdAt: "", lastModifiedAt: "", status: "active",
    };
    expect(isPlanComplete(plan)).toBe(true);
  });

  it("isPlanComplete with blocked task", () => {
    const plan: Plan = {
      planId: "test", goal: "Test",
      tasks: [
        { id: "1", title: "A", status: "completed" },
        { id: "2", title: "B", status: "blocked" },
      ],
      checkpoints: [], history: [], createdAt: "", lastModifiedAt: "", status: "active",
    };
    expect(isPlanComplete(plan)).toBe(false);
  });

  it("inputsToTasks preserves all fields", () => {
    const result = inputsToTasks([
      { id: "custom-1", title: "Custom", checkpoint: true },
      { title: "Auto ID" },
    ]);
    expect(result[0].id).toBe("custom-1");
    expect(result[0].checkpoint).toBe(true);
    expect(result[0].status).toBe("pending");
    expect(result[1].id).toBe("2"); // Auto-generated
  });

  it("aggregateContext with deeply nested completed subtasks", () => {
    const parentTask: Task = {
      id: "1", title: "Root", status: "completed", checkpoint: true,
      subtasks: [
        {
          id: "1.1", title: "Mid", status: "completed",
          context: { findings: ["A"], files: ["f1.ts"] },
          subtasks: [
            {
              id: "1.1.1", title: "Leaf", status: "completed",
              context: { findings: ["B"], decisions: ["D1"], files: ["f2.ts"] },
            },
          ],
        },
      ],
    };
    const agg = aggregateContext(parentTask);
    // aggregateContext collects from completed subtasks recursively
    expect(agg.findings).toContain("A");
    expect(agg.findings).toContain("B");
    expect(agg.decisions).toContain("D1");
    expect(agg.files).toContain("f1.ts");
    expect(agg.files).toContain("f2.ts");
  });
});

// ── Storage edge cases ──────────────────────────────────────────────────────

describe("task storage — edge cases", () => {
  it("loadPlan returns null for nonexistent plan", async () => {
    const result = await storage.loadPlan("nonexistent-plan-id");
    expect(result).toBeNull();
  });

  it("loadActivePlan returns null when no plans exist", async () => {
    const result = await storage.loadActivePlan();
    expect(result).toBeNull();
  });

  it("listPlans returns empty when no plans exist", async () => {
    const result = await storage.listPlans();
    expect(result.active).toEqual([]);
    expect(result.completed).toEqual([]);
  });

  it("completePlan handles nonexistent plan gracefully", async () => {
    // Should not throw
    await storage.completePlan("does-not-exist");
  });

  it("multiple active plans — loadActivePlan returns most recent", async () => {
    await task({
      action: "plan",
      goal: "First plan",
      tasks: [{ id: "1", title: "A" }],
    }, storage);

    // Small delay to ensure different mtime
    await new Promise(r => setTimeout(r, 50));

    const secondResult = await task({
      action: "plan",
      goal: "Second plan",
      tasks: [{ id: "1", title: "B" }],
    }, storage);

    const activePlan = await storage.loadActivePlan();
    expect(activePlan).not.toBeNull();
    expect(activePlan!.goal).toBe("Second plan");
  });
});

// ── Checkpoint with no subtasks ─────────────────────────────────────────────

describe("task — checkpoint edge cases", () => {
  it("checkpoint on task with no subtasks still works", async () => {
    const result = await task({
      action: "plan",
      goal: "Checkpoint no subtasks",
      tasks: [{ id: "1", title: "Solo task", checkpoint: true }],
    }, storage);

    const planId = (result.data as any).planId;

    const cpResult = await task({
      action: "checkpoint", planId,
      id: "1",
      summary: "Solo checkpoint",
    }, storage);

    expect(cpResult.success).toBe(true);
    const data = cpResult.data as any;
    expect(data.checkpointSaved).toBe(true);
    expect(data.aggregatedFindings).toBe(0);
  });

  it("checkpoint on nonexistent task fails", async () => {
    const result = await task({
      action: "plan",
      goal: "CP fail test",
      tasks: [{ id: "1", title: "Task" }],
    }, storage);

    const planId = (result.data as any).planId;

    const cpResult = await task({
      action: "checkpoint", planId,
      id: "99",
      summary: "Should fail",
    }, storage);

    expect(cpResult.success).toBe(false);
    expect(cpResult.error).toContain("Task not found");
  });
});

// ── Plan auto-completion with mixed terminal states ─────────────────────────

describe("task — plan auto-completion", () => {
  it("plan completes when all tasks are failed/cancelled/completed", async () => {
    const result = await task({
      action: "plan",
      goal: "Mixed terminal",
      tasks: [
        { id: "1", title: "Completed" },
        { id: "2", title: "To fail" },
        { id: "3", title: "To cancel" },
      ],
    }, storage);

    const planId = (result.data as any).planId;

    await task({ action: "update", planId, id: "1", status: "completed" }, storage);
    await task({ action: "update", planId, id: "2", status: "failed" }, storage);
    const lastResult = await task({ action: "update", planId, id: "3", status: "cancelled" }, storage);

    expect(lastResult.success).toBe(true);
    expect((lastResult.data as any).planCompleted).toBe(true);
  });

  it("plan does NOT auto-complete with blocked task", async () => {
    const result = await task({
      action: "plan",
      goal: "Blocked test",
      tasks: [
        { id: "1", title: "Done" },
        { id: "2", title: "Blocked" },
      ],
    }, storage);

    const planId = (result.data as any).planId;

    await task({ action: "update", planId, id: "1", status: "completed" }, storage);
    const blockedResult = await task({ action: "update", planId, id: "2", status: "blocked" }, storage);

    expect((blockedResult.data as any).planCompleted).toBeUndefined();
  });
});
