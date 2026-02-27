/**
 * Per-file mutex — prevents concurrent read-write or write-write races
 * on the same file across parallel tool calls within a session.
 * 
 * Uses a simple Map<path, Promise> chain: each operation on a file
 * waits for the previous operation to complete before starting.
 */

const locks = new Map<string, Promise<void>>();

/**
 * Acquire an exclusive lock on a file path. Returns a release function.
 * Operations on the same path are serialized; different paths run in parallel.
 */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const normalizedPath = filePath.replace(/\\/g, "/");

  const prev = locks.get(normalizedPath) ?? Promise.resolve();

  let releaseFn: () => void;
  const next = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  locks.set(normalizedPath, next);

  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      releaseFn();
      // Clean up if this is the latest lock (prevents memory leak)
      if (locks.get(normalizedPath) === next) {
        locks.delete(normalizedPath);
      }
    }
  });
}

/**
 * Get the number of active locks (for testing/debugging).
 */
export function getActiveLockCount(): number {
  return locks.size;
}

/**
 * Clear all locks (for testing only).
 */
export function clearAllLocks(): void {
  locks.clear();
}
