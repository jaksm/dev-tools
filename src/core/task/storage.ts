/**
 * Task plan storage — read/write plan JSON files to {storage}/plans/.
 * Completed plans move to plans/.completed/.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Plan } from "./types.js";

export interface TaskStorage {
  /** Save (create or update) a plan */
  savePlan(plan: Plan): Promise<void>;
  /** Load a plan by ID. Checks active first, then completed. */
  loadPlan(planId: string): Promise<Plan | null>;
  /** Load the most recently modified active plan */
  loadActivePlan(): Promise<Plan | null>;
  /** Move a plan to .completed/ */
  completePlan(planId: string): Promise<void>;
  /** List all plans (active + completed) */
  listPlans(): Promise<{ active: PlanSummary[]; completed: PlanSummary[] }>;
}

export interface PlanSummary {
  planId: string;
  goal: string;
  progress: string;
  lastModified: string;
  filename: string;
}

/**
 * Create a task storage manager.
 */
export function createTaskStorage(plansDir: string, completedDir: string): TaskStorage {
  return {
    async savePlan(plan: Plan): Promise<void> {
      await fs.mkdir(plansDir, { recursive: true });
      const filename = planFilename(plan.planId);
      const filePath = path.join(plansDir, filename);
      await fs.writeFile(filePath, JSON.stringify(plan, null, 2), "utf-8");
    },

    async loadPlan(planId: string): Promise<Plan | null> {
      const filename = planFilename(planId);

      // Check active first
      try {
        const data = await fs.readFile(path.join(plansDir, filename), "utf-8");
        return JSON.parse(data) as Plan;
      } catch {
        // Not in active
      }

      // Check completed
      try {
        const data = await fs.readFile(path.join(completedDir, filename), "utf-8");
        return JSON.parse(data) as Plan;
      } catch {
        return null;
      }
    },

    async loadActivePlan(): Promise<Plan | null> {
      const plans = await listJsonFiles(plansDir);
      if (plans.length === 0) return null;

      // Sort by mtime descending, return most recent
      let bestPlan: Plan | null = null;
      let bestMtime = 0;

      for (const file of plans) {
        try {
          const filePath = path.join(plansDir, file);
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs > bestMtime) {
            const data = await fs.readFile(filePath, "utf-8");
            const plan = JSON.parse(data) as Plan;
            if (plan.status === "active") {
              bestPlan = plan;
              bestMtime = stat.mtimeMs;
            }
          }
        } catch {
          // Skip invalid files
        }
      }

      return bestPlan;
    },

    async completePlan(planId: string): Promise<void> {
      const filename = planFilename(planId);
      const srcPath = path.join(plansDir, filename);
      const destPath = path.join(completedDir, filename);

      try {
        await fs.mkdir(completedDir, { recursive: true });
        // Read, update status, write to completed, remove from active
        const data = await fs.readFile(srcPath, "utf-8");
        const plan = JSON.parse(data) as Plan;
        plan.status = "completed";
        plan.lastModifiedAt = new Date().toISOString();
        await fs.writeFile(destPath, JSON.stringify(plan, null, 2), "utf-8");
        await fs.unlink(srcPath);
      } catch {
        // Plan may not exist in active dir
      }
    },

    async listPlans(): Promise<{ active: PlanSummary[]; completed: PlanSummary[] }> {
      const active = await loadSummaries(plansDir);
      const completed = await loadSummaries(completedDir);
      return { active, completed };
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function planFilename(planId: string): string {
  return `${planId}.json`;
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(f => f.endsWith(".json") && !f.startsWith("."));
  } catch {
    return [];
  }
}

async function loadSummaries(dir: string): Promise<PlanSummary[]> {
  const files = await listJsonFiles(dir);
  const summaries: PlanSummary[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const data = await fs.readFile(filePath, "utf-8");
      const plan = JSON.parse(data) as Plan;
      const progress = computeProgress(plan.tasks);
      const stat = await fs.stat(filePath);

      summaries.push({
        planId: plan.planId,
        goal: plan.goal,
        progress,
        lastModified: stat.mtime.toISOString(),
        filename: file,
      });
    } catch {
      // Skip invalid files
    }
  }

  // Sort by lastModified descending
  summaries.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return summaries;
}

function computeProgress(tasks: { status: string; subtasks?: { status: string; subtasks?: unknown[] }[] }[]): string {
  let total = 0;
  let completed = 0;

  function walk(items: typeof tasks): void {
    for (const t of items) {
      total++;
      if (t.status === "completed") completed++;
      if (t.subtasks && t.subtasks.length > 0) {
        walk(t.subtasks as typeof tasks);
      }
    }
  }

  walk(tasks);
  return `${completed}/${total}`;
}
