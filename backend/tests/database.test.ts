import { describe, expect, it, vi } from 'vitest';
import { createDatabase, initialize } from '../src/core/database.ts';
import type { Database } from '../src/features/todos/types.ts';

function initializeWithFake() {
  const executeRaw = vi.fn().mockResolvedValue(0);
  return { executeRaw, run: () => initialize({ $executeRaw: executeRaw } as unknown as Database) };
}

describe('database', () => {
  it('creates a client without connecting', () => {
    const database = createDatabase('postgresql://test:test@localhost:5432/test');
    expect(database.todo).toBeDefined();
    expect(typeof database.$connect).toBe('function');
  });

  it('creates the todos table idempotently with one statement', async () => {
    const { executeRaw, run } = initializeWithFake();
    await run();
    expect(executeRaw).toHaveBeenCalledOnce();
    const sql = (executeRaw.mock.calls[0][0] as TemplateStringsArray).join('');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS todos/);
  });

  it('enforces the same limits as the API validation', async () => {
    const { executeRaw, run } = initializeWithFake();
    await run();
    const sql = (executeRaw.mock.calls[0][0] as TemplateStringsArray).join('');
    expect(sql).toMatch(/title VARCHAR\(120\) NOT NULL/);
    expect(sql).toMatch(/CHECK \(length\(title\) >= 1\)/);
    expect(sql).toMatch(/description VARCHAR\(2000\) NOT NULL DEFAULT ''/);
    expect(sql).toMatch(/priority IN \('low', 'medium', 'high'\)/);
    expect(sql).toMatch(/completed BOOLEAN NOT NULL DEFAULT FALSE/);
  });

  it('propagates database errors', async () => {
    const executeRaw = vi.fn().mockRejectedValue(new Error('permission denied'));
    await expect(initialize({ $executeRaw: executeRaw } as unknown as Database)).rejects.toThrow('permission denied');
  });
});
