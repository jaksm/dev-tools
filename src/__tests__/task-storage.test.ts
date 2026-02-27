/**
 * Tests for task plan storage (read/write/list/complete).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTaskStorage } from "../core/task/storage.js";
import type { Plan } from "../core/task/types.js";

let tmpDir: string;
let plansDir: string;
let completedDir: string;

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: "test-plan-a1b2",
    goal: "Test goal",
    tasks: [
      { id: "1", title: "First task", status: "pending" },
      { id: "2", title: "Second task", status: "completed" },
    ],
    checkpoints: [],
    history: [{ time: "2026-02-27T00:00:00Z", event: "Created" }],
    createdAt: "2026-02-27T00:00:00Z",
    lastModifiedAt: "2026-02-27T00:00:00Z",
    status: "active",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-storage-test-"));
  plansDir = path.join(tmpDir, "plans");
  completedDir = path.join(tmpDir, "plans", ".completed");
  await fs.mkdir(plansDir, { recursive: true });
  await fs.mkdir(completedDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("TaskStorage", () => {
  describe("savePlan + loadPlan", () => {
    it("should save and load a plan", async () => {
      const storage = createTaskStorage(plansDir, completedDir);
      const plan = makePlan();

      await storage.savePlan(plan);
      const loaded = await storage.loadPlan("test-plan-a1b2");

      expect(loaded).not.toBeNull();
      expect(loaded!.planId).toBe("test-plan-a1b2");
      expect(loaded!.goal).toBe("Test goal");
      expect(loaded!.tasks).toHaveLength(2);
    });

    it("should return null for non-existent plan", async () => {
      const storage = createTaskStorage(plansDir, completedDir);
      const loaded = await storage.loadPlan("non-existent");
      expect(loaded).toBeNull();
    });

    it("should overwrite existing plan on save", async () => {
      const storage = createTaskStorage(plansDir, completedDir);
      const plan = makePlan();

      await storage.savePlan(plan);
      plan.goal = "Updated goal";
      await storage.savePlan(plan);

      const loaded = await storage.loadPlan("test-plan-a1b2");
      expect(loaded!.goal).toBe("Updated goal");
    });
  });

  describe("loadActivePlan", () => {
    it("should return most recently modified active plan", async () => {
      const storage = createTaskStorage(plansDir, completedDir);

      const plan1 = makePlan({ planId: "plan-1", goal: "Older plan" });
      const plan2 = makePlan({ planId: "plan-2", goal: "Newer plan" });

      await storage.savePlan(plan1);
      // Small delay to ensure different mtime
      await new Promise(r => setTimeout(r, 50));
      await storage.savePlan(plan2);

      const active = await storage.loadActivePlan();
      expect(active).not.toBeNull();
      expect(active!.planId).toBe("plan-2");
    });

    it("should return null when no active plans", async () => {
      const storage = createTaskStorage(plansDir, completedDir);
      const active = await storage.loadActivePlan();
      expect(active).toBeNull();
    });

    it("should skip completed plans", async () => {
      const storage = createTaskStorage(plansDir, completedDir);

      const plan1 = makePlan({ planId: "plan-1", status: "completed" });
      const plan2 = makePlan({ planId: "plan-2", status: "active", goal: "Active one" });

      await storage.savePlan(plan1);
      await storage.savePlan(plan2);

      const active = await storage.loadActivePlan();
      expect(active!.planId).toBe("plan-2");
    });
  });

  describe("completePlan", () => {
    it("should move plan to completed directory", async () => {
      const storage = createTaskStorage(plansDir, completedDir);
      const plan = makePlan();

      await storage.savePlan(plan);
      await storage.completePlan("test-plan-a1b2");

      // Should not be in active
      const files = await fs.readdir(plansDir);
      expect(files.filter(f => f.endsWith(".json"))).toHaveLength(0);

      // Should be in completed
      const completedFiles = await fs.readdir(completedDir);
      expect(completedFiles).toContain("test-plan-a1b2.json");

      // Status should be updated
      const loaded = await storage.loadPlan("test-plan-a1b2");
      expect(loaded!.status).toBe("completed");
    });

    it("should handle non-existent plan gracefully", async () => {
      const storage = createTaskStorage(plansDir, completedDir);
      // Should not throw
      await storage.completePlan("non-existent");
    });
  });

  describe("listPlans", () => {
    it("should list active and completed plans", async () => {
      const storage = createTaskStorage(plansDir, completedDir);

      await storage.savePlan(makePlan({ planId: "active-1", goal: "Active plan" }));
      await storage.savePlan(makePlan({ planId: "active-2", goal: "Another active" }));

      // Put one in completed
      const completedPlan = makePlan({ planId: "done-1", goal: "Done plan", status: "completed" });
      await fs.writeFile(
        path.join(completedDir, "done-1.json"),
        JSON.stringify(completedPlan),
      );

      const { active, completed } = await storage.listPlans();
      expect(active).toHaveLength(2);
      expect(completed).toHaveLength(1);
      expect(completed[0].planId).toBe("done-1");
    });

    it("should include progress in summaries", async () => {
      const storage = createTaskStorage(plansDir, completedDir);
      await storage.savePlan(makePlan());

      const { active } = await storage.listPlans();
      expect(active[0].progress).toBe("1/2"); // One completed out of two
    });

    it("should return empty lists when no plans exist", async () => {
      const storage = createTaskStorage(plansDir, completedDir);
      const { active, completed } = await storage.listPlans();
      expect(active).toHaveLength(0);
      expect(completed).toHaveLength(0);
    });
  });

  describe("loadPlan from completed", () => {
    it("should find plan in completed directory", async () => {
      const storage = createTaskStorage(plansDir, completedDir);
      const plan = makePlan({ planId: "completed-plan" });

      // Write directly to completed
      await fs.writeFile(
        path.join(completedDir, "completed-plan.json"),
        JSON.stringify(plan),
      );

      const loaded = await storage.loadPlan("completed-plan");
      expect(loaded).not.toBeNull();
      expect(loaded!.planId).toBe("completed-plan");
    });
  });
});
