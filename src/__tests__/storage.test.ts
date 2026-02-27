import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deriveSlug, createStorageManager } from '../core/storage.js';

describe('deriveSlug', () => {
  it('normal path extracts basename and lowercases', () => {
    expect(deriveSlug('/Users/foo/Projects/my-app')).toBe('my-app');
  });

  it('spaces become hyphens', () => {
    expect(deriveSlug('/path/to/My App')).toBe('my-app');
  });

  it('special chars replaced with hyphens', () => {
    expect(deriveSlug('/path/to/my_app@2.0')).toBe('my-app-2-0');
  });

  it('root path returns default', () => {
    expect(deriveSlug('/')).toBe('default');
  });

  it('trailing slashes are handled', () => {
    expect(deriveSlug('/path/to/project/')).toBe('project');
  });

  it('deeply nested path extracts last segment', () => {
    expect(deriveSlug('/a/b/c/d/e/project')).toBe('project');
  });

  it('dots replaced with hyphens', () => {
    expect(deriveSlug('/path/my.project.v2')).toBe('my-project-v2');
  });
});

describe('createStorageManager', () => {
  const testWorkspace = '/tmp/test-workspace-storage-' + Date.now();
  const manager = createStorageManager(testWorkspace);

  afterAll(async () => {
    try {
      await fs.rm(manager.storageDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('storageDir contains .dev-tools and the slug', () => {
    const slug = deriveSlug(testWorkspace);
    expect(manager.storageDir).toContain('.dev-tools');
    expect(manager.storageDir).toContain(slug);
    expect(manager.storageDir).toBe(
      path.join(os.homedir(), '.dev-tools', slug),
    );
  });

  it('slug property matches deriveSlug()', () => {
    expect(manager.slug).toBe(deriveSlug(testWorkspace));
  });

  it('ensureDirs() creates all 6 subdirectories', async () => {
    await manager.ensureDirs();

    const expectedDirs = [
      manager.storageDir,
      path.join(manager.storageDir, 'plans'),
      path.join(manager.storageDir, 'plans', '.completed'),
      path.join(manager.storageDir, 'index'),
      path.join(manager.storageDir, 'logs'),
      path.join(manager.storageDir, 'tool-output'),
    ];

    for (const dir of expectedDirs) {
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('plansDir() returns correct path', () => {
    expect(manager.plansDir()).toBe(path.join(manager.storageDir, 'plans'));
  });

  it('completedPlansDir() returns correct path', () => {
    expect(manager.completedPlansDir()).toBe(
      path.join(manager.storageDir, 'plans', '.completed'),
    );
  });

  it('indexDir() returns correct path', () => {
    expect(manager.indexDir()).toBe(path.join(manager.storageDir, 'index'));
  });

  it('logsDir() returns correct path', () => {
    expect(manager.logsDir()).toBe(path.join(manager.storageDir, 'logs'));
  });

  it('toolOutputDir() returns correct path', () => {
    expect(manager.toolOutputDir()).toBe(
      path.join(manager.storageDir, 'tool-output'),
    );
  });
});
