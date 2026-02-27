import { describe, it, expect, afterEach } from "vitest";
import { withFileLock, getActiveLockCount, clearAllLocks } from "../core/file-mutex.js";

afterEach(() => {
  clearAllLocks();
});

describe("withFileLock", () => {
  it("executes function and returns result", async () => {
    const result = await withFileLock("/test/file.ts", async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it("serializes operations on the same path", async () => {
    const order: number[] = [];

    const p1 = withFileLock("/test/file.ts", async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = withFileLock("/test/file.ts", async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]); // p1 completes before p2 starts
  });

  it("allows parallel operations on different paths", async () => {
    const order: string[] = [];

    const p1 = withFileLock("/test/a.ts", async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push("a");
    });

    const p2 = withFileLock("/test/b.ts", async () => {
      order.push("b");
    });

    await Promise.all([p1, p2]);
    // b should complete before a since they're parallel and b has no delay
    expect(order).toEqual(["b", "a"]);
  });

  it("releases lock on error", async () => {
    try {
      await withFileLock("/test/file.ts", async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }

    // Should be able to acquire lock again
    const result = await withFileLock("/test/file.ts", async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("cleans up lock map to prevent memory leaks", async () => {
    await withFileLock("/test/file.ts", async () => {});
    expect(getActiveLockCount()).toBe(0);
  });

  it("handles three sequential operations on same file", async () => {
    const order: number[] = [];

    const p1 = withFileLock("/test/file.ts", async () => {
      await new Promise(r => setTimeout(r, 30));
      order.push(1);
    });

    const p2 = withFileLock("/test/file.ts", async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(2);
    });

    const p3 = withFileLock("/test/file.ts", async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("normalizes backslashes in paths", async () => {
    const order: number[] = [];

    const p1 = withFileLock("/test/file.ts", async () => {
      await new Promise(r => setTimeout(r, 30));
      order.push(1);
    });

    // Same path with backslashes — should serialize
    const p2 = withFileLock("\\test\\file.ts", async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
});
