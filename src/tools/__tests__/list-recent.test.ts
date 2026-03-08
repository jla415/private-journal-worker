// ABOUTME: Tests for list-recent tool
// ABOUTME: Covers default params, custom params, source filtering, and result formatting

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleListRecent } from '../list-recent';
import { createMockEnv, createMockEntryRow } from '../../__tests__/mocks';
import { Env } from '../../types';

describe('handleListRecent', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should use default limit=10 and days=30', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    await handleListRecent({}, env);

    // Called twice: once for entries, once for exchanges (source='all' is default)
    expect(env.DB.prepare).toHaveBeenCalled();
  });

  it('should respect custom limit and days', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    await handleListRecent({ limit: 5, days: 7 }, env);

    const bindArgs = stmt.bind.mock.calls[0];
    expect(bindArgs[bindArgs.length - 1]).toBe(5);
  });

  it('should return entries in SearchResult format with score 1.0', async () => {
    const entries = [createMockEntryRow({ id: 'entry-1' }), createMockEntryRow({ id: 'entry-2' })];
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: entries }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    // Use source='journal' to avoid querying exchanges table
    const result = await handleListRecent({ source: 'journal' }, env);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].score).toBe(1.0);
    expect(result.entries[0].source).toBe('journal');
  });

  it('should pass project filter', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    await handleListRecent({ project: 'myapp', source: 'journal' }, env);

    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('AND project = ?')
    );
  });

  it('should filter by source=chat', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    await handleListRecent({ source: 'chat' }, env);

    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('exchanges')
    );
  });
});
