import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGitignoreFilter } from '../core/gitignore.js';

describe('createGitignoreFilter', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitignore-test-'));
    await fs.writeFile(
      path.join(tmpDir, '.gitignore'),
      'dist\n*.log\nbuild/\n',
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('ignores paths matching .gitignore patterns', async () => {
    const filter = await createGitignoreFilter(tmpDir);
    expect(filter('dist/bundle.js')).toBe(true);
  });

  it('does not ignore non-matching paths', async () => {
    const filter = await createGitignoreFilter(tmpDir);
    expect(filter('src/index.ts')).toBe(false);
  });

  it('ignores files matching glob patterns (*.log)', async () => {
    const filter = await createGitignoreFilter(tmpDir);
    expect(filter('error.log')).toBe(true);
    expect(filter('deep/nested/app.log')).toBe(true);
  });

  it('ignores build/ directory', async () => {
    const filter = await createGitignoreFilter(tmpDir);
    expect(filter('build/output.js')).toBe(true);
  });

  it('node_modules always ignored (hardcoded)', async () => {
    const filter = await createGitignoreFilter(tmpDir);
    expect(filter('node_modules/package/index.js')).toBe(true);
  });

  it('.git always ignored (hardcoded)', async () => {
    const filter = await createGitignoreFilter(tmpDir);
    expect(filter('.git/HEAD')).toBe(true);
  });

  it('nested paths not matching patterns are not ignored', async () => {
    const filter = await createGitignoreFilter(tmpDir);
    expect(filter('src/deep/nested/file.ts')).toBe(false);
  });

  it('root path "." returns false (not ignored)', async () => {
    const filter = await createGitignoreFilter(tmpDir);
    expect(filter('.')).toBe(false);
  });

  it('empty string returns false', async () => {
    const filter = await createGitignoreFilter(tmpDir);
    expect(filter('')).toBe(false);
  });

  it('works without a .gitignore file', async () => {
    const noGitignoreDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'no-gitignore-'),
    );
    try {
      const filter = await createGitignoreFilter(noGitignoreDir);
      // Still ignores hardcoded patterns
      expect(filter('node_modules/foo')).toBe(true);
      expect(filter('.git/config')).toBe(true);
      // Does not ignore normal files
      expect(filter('src/index.ts')).toBe(false);
    } finally {
      await fs.rm(noGitignoreDir, { recursive: true, force: true });
    }
  });
});
