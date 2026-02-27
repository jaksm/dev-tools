/**
 * Tests for task tool helpers — tree traversal, ID generation, context aggregation.
 */

import { describe, it, expect } from "vitest";
import {
  generatePlanId,
  findTask,
  findParent,
  findTaskInContext,
  inputsToTasks,
  countTasks,
  getProgress,
  findCurrentTask,
  aggregateContext,
  allSubtasksCompleted,
  isPlanComplete,
  mergeContext,
} from "../core/task/helpers.js";
import type { Task, Plan } from "../core/task/types.js";

// ── generatePlanId ──────────────────────────────────────────────────────────

describe("generatePlanId", () => {
  it("should generate slug from goal", () => {
    const id = generatePlanId("Fix authentication bug");
    expect(id).toMatch(/^fix-authentication-bug-[a-f0-9]{4}$/);
  });

  it("should handle special characters", () => {
    const id = generatePlanId("Add login — token refresh!");
    expect(id).toMatch(/^add-login-token-refresh-[a-f0-9]{4}$/);
  });

  it("should truncate long goals", () => {
    const longGoal = "A".repeat(100);
    const id = generatePlanId(longGoal);
    // Slug portion should be <= 40 chars + 1 dash + 4 hex = <=45
    expect(id.length).toBeLessThanOrEqual(46);
  });

  it("should handle empty goal", () => {
    const id = generatePlanId("");
    expect(id).toMatch(/^plan-[a-f0-9]{4}$/);
  });

  it("should generate unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generatePlanId("Same goal"));
    }
    // With 2 random bytes, collisions are extremely unlikely in 100 iterations
    expect(ids.size).toBeGreaterThan(90);
  });
});

// ── findTask ────────────────────────────────────────────────────────────────

describe("findTask", () => {
  const tasks: Task[] = [
    {
      id: "1", title: "First", status: "pending",
      subtasks: [
        { id: "1.1", title: "Sub first", status: "pending" },
        {
          id: "1.2", title: "Sub second", status: "pending",
          subtasks: [
            { id: "1.2.1", title: "Deep", status: "pending" },
          ],
        },
      ],
    },
    { id: "2", title: "Second", status: "pending" },
  ];

  it("should find top-level task", () => {
    expect(findTask(tasks, "1")?.title).toBe("First");
    expect(findTask(tasks, "2")?.title).toBe("Second");
  });

  it("should find nested task", () => {
    expect(findTask(tasks, "1.1")?.title).toBe("Sub first");
    expect(findTask(tasks, "1.2.1")?.title).toBe("Deep");
  });

  it("should return null for non-existent", () => {
    expect(findTask(tasks, "99")).toBeNull();
  });
});

// ── findParent ──────────────────────────────────────────────────────────────

describe("findParent", () => {
  const tasks: Task[] = [
    {
      id: "1", title: "First", status: "pending",
      subtasks: [
        { id: "1.1", title: "Sub", status: "pending" },
      ],
    },
  ];

  it("should find parent of nested task", () => {
    const result = findParent(tasks, "1.1");
    expect(result).not.toBeNull();
    expect(result!.parent.id).toBe("1");
    expect(result!.index).toBe(0);
  });

  it("should return null for top-level task", () => {
    expect(findParent(tasks, "1")).toBeNull();
  });
});

// ── inputsToTasks ───────────────────────────────────────────────────────────

describe("inputsToTasks", () => {
  it("should convert inputs with explicit IDs", () => {
    const result = inputsToTasks([
      { id: "1", title: "Task 1" },
      { id: "2", title: "Task 2", checkpoint: true },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("1");
    expect(result[0].status).toBe("pending");
    expect(result[1].checkpoint).toBe(true);
  });

  it("should auto-generate IDs", () => {
    const result = inputsToTasks([
      { title: "Task A" },
      { title: "Task B" },
    ]);

    expect(result[0].id).toBe("1");
    expect(result[1].id).toBe("2");
  });

  it("should handle nested subtasks with parent ID", () => {
    const result = inputsToTasks([
      {
        id: "1", title: "Parent",
        subtasks: [
          { title: "Child A" },
          { title: "Child B" },
        ],
      },
    ]);

    expect(result[0].subtasks).toHaveLength(2);
    expect(result[0].subtasks![0].id).toBe("1.1");
    expect(result[0].subtasks![1].id).toBe("1.2");
  });
});

// ── countTasks ───────────────────────────────────────────────────────────────

describe("countTasks", () => {
  it("should count flat tasks", () => {
    const tasks: Task[] = [
      { id: "1", title: "A", status: "pending" },
      { id: "2", title: "B", status: "pending" },
    ];
    expect(countTasks(tasks)).toBe(2);
  });

  it("should count nested tasks", () => {
    const tasks: Task[] = [
      {
        id: "1", title: "Parent", status: "pending",
        subtasks: [
          { id: "1.1", title: "Child", status: "pending" },
          { id: "1.2", title: "Child 2", status: "pending" },
        ],
      },
    ];
    expect(countTasks(tasks)).toBe(3);
  });
});

// ── getProgress ─────────────────────────────────────────────────────────────

describe("getProgress", () => {
  it("should return progress string", () => {
    const tasks: Task[] = [
      { id: "1", title: "A", status: "completed" },
      { id: "2", title: "B", status: "pending" },
      { id: "3", title: "C", status: "in_progress" },
    ];
    expect(getProgress(tasks)).toBe("1/3");
  });

  it("should count nested completions", () => {
    const tasks: Task[] = [
      {
        id: "1", title: "Parent", status: "completed",
        subtasks: [
          { id: "1.1", title: "Child", status: "completed" },
          { id: "1.2", title: "Child 2", status: "pending" },
        ],
      },
    ];
    expect(getProgress(tasks)).toBe("2/3");
  });
});

// ── findCurrentTask ─────────────────────────────────────────────────────────

describe("findCurrentTask", () => {
  it("should find in_progress task", () => {
    const tasks: Task[] = [
      { id: "1", title: "Done", status: "completed" },
      { id: "2", title: "Working", status: "in_progress" },
      { id: "3", title: "Next", status: "pending" },
    ];
    expect(findCurrentTask(tasks)?.id).toBe("2");
  });

  it("should fall back to first pending", () => {
    const tasks: Task[] = [
      { id: "1", title: "Done", status: "completed" },
      { id: "2", title: "Next", status: "pending" },
      { id: "3", title: "Later", status: "pending" },
    ];
    expect(findCurrentTask(tasks)?.id).toBe("2");
  });

  it("should find nested in_progress", () => {
    const tasks: Task[] = [
      {
        id: "1", title: "Parent", status: "in_progress",
        subtasks: [
          { id: "1.1", title: "Done", status: "completed" },
          { id: "1.2", title: "Working", status: "in_progress" },
        ],
      },
    ];
    // Should find deepest in_progress
    expect(findCurrentTask(tasks)?.id).toBe("1");
  });

  it("should return null when all done", () => {
    const tasks: Task[] = [
      { id: "1", title: "Done", status: "completed" },
    ];
    expect(findCurrentTask(tasks)).toBeNull();
  });
});

// ── aggregateContext ────────────────────────────────────────────────────────

describe("aggregateContext", () => {
  it("should aggregate context from completed subtasks", () => {
    const task: Task = {
      id: "1", title: "Checkpoint", status: "completed", checkpoint: true,
      subtasks: [
        {
          id: "1.1", title: "Sub 1", status: "completed",
          context: {
            findings: ["Found A", "Found B"],
            decisions: ["Decided X"],
            files: ["src/a.ts"],
          },
        },
        {
          id: "1.2", title: "Sub 2", status: "completed",
          context: {
            findings: ["Found C"],
            files: ["src/a.ts", "src/b.ts"], // Duplicate file
          },
        },
        {
          id: "1.3", title: "Sub 3", status: "pending",
          context: {
            findings: ["Should not be included"],
          },
        },
      ],
    };

    const result = aggregateContext(task);
    expect(result.findings).toEqual(["Found A", "Found B", "Found C"]);
    expect(result.decisions).toEqual(["Decided X"]);
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]); // Deduplicated
  });

  it("should handle empty context", () => {
    const task: Task = {
      id: "1", title: "Empty", status: "completed",
      subtasks: [
        { id: "1.1", title: "No context", status: "completed" },
      ],
    };

    const result = aggregateContext(task);
    expect(result.findings).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.files).toEqual([]);
  });
});

// ── allSubtasksCompleted ────────────────────────────────────────────────────

describe("allSubtasksCompleted", () => {
  it("should return true when all subtasks completed or cancelled", () => {
    const task: Task = {
      id: "1", title: "Parent", status: "in_progress",
      subtasks: [
        { id: "1.1", title: "Done", status: "completed" },
        { id: "1.2", title: "Cancelled", status: "cancelled" },
      ],
    };
    expect(allSubtasksCompleted(task)).toBe(true);
  });

  it("should return false when any subtask pending", () => {
    const task: Task = {
      id: "1", title: "Parent", status: "in_progress",
      subtasks: [
        { id: "1.1", title: "Done", status: "completed" },
        { id: "1.2", title: "Still working", status: "in_progress" },
      ],
    };
    expect(allSubtasksCompleted(task)).toBe(false);
  });

  it("should return true when no subtasks", () => {
    const task: Task = { id: "1", title: "Leaf", status: "pending" };
    expect(allSubtasksCompleted(task)).toBe(true);
  });
});

// ── isPlanComplete ──────────────────────────────────────────────────────────

describe("isPlanComplete", () => {
  it("should detect all-terminal plan", () => {
    const plan: Plan = {
      planId: "test", goal: "Test", tasks: [
        { id: "1", title: "Done", status: "completed" },
        { id: "2", title: "Failed", status: "failed" },
        { id: "3", title: "Cancelled", status: "cancelled" },
      ],
      checkpoints: [], history: [], createdAt: "", lastModifiedAt: "", status: "active",
    };
    expect(isPlanComplete(plan)).toBe(true);
  });

  it("should detect incomplete plan", () => {
    const plan: Plan = {
      planId: "test", goal: "Test", tasks: [
        { id: "1", title: "Done", status: "completed" },
        { id: "2", title: "Pending", status: "pending" },
      ],
      checkpoints: [], history: [], createdAt: "", lastModifiedAt: "", status: "active",
    };
    expect(isPlanComplete(plan)).toBe(false);
  });
});

// ── mergeContext ─────────────────────────────────────────────────────────────

describe("mergeContext", () => {
  it("should merge into empty context", () => {
    const result = mergeContext(undefined, {
      findings: ["Found something"],
      files: ["src/a.ts"],
    });
    expect(result.findings).toEqual(["Found something"]);
    expect(result.files).toEqual(["src/a.ts"]);
  });

  it("should append to existing context", () => {
    const result = mergeContext(
      { findings: ["Existing"], files: ["src/a.ts"] },
      { findings: ["New"], files: ["src/a.ts", "src/b.ts"] },
    );
    expect(result.findings).toEqual(["Existing", "New"]);
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]); // Deduplicated
  });
});

// ── findTaskInContext ───────────────────────────────────────────────────────

describe("findTaskInContext", () => {
  const tasks: Task[] = [
    {
      id: "1", title: "First", status: "pending",
      subtasks: [
        { id: "1.1", title: "Sub", status: "pending" },
        { id: "1.2", title: "Sub 2", status: "pending" },
      ],
    },
    { id: "2", title: "Second", status: "pending" },
  ];

  it("should find top-level task with siblings", () => {
    const result = findTaskInContext(tasks, "1");
    expect(result).not.toBeNull();
    expect(result!.task.id).toBe("1");
    expect(result!.siblings).toBe(tasks);
    expect(result!.index).toBe(0);
  });

  it("should find nested task with siblings", () => {
    const result = findTaskInContext(tasks, "1.2");
    expect(result).not.toBeNull();
    expect(result!.task.id).toBe("1.2");
    expect(result!.index).toBe(1);
  });

  it("should return null for missing task", () => {
    expect(findTaskInContext(tasks, "99")).toBeNull();
  });
});
