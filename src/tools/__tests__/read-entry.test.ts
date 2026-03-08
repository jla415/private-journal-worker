// ABOUTME: Tests for read-entry tool
// ABOUTME: Covers successful reads and not-found cases

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleReadEntry } from '../read-entry';
import { createMockEnv, createMockEntryRow } from '../../__tests__/mocks';
import { Env } from '../../types';

describe('handleReadEntry', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should return error if path is not a string', async () => {
    const result = await handleReadEntry({}, env);
    expect(result).toEqual({ error: 'path is required and must be a string' });
  });

  it('should return error if path is a number', async () => {
    const result = await handleReadEntry({ path: 123 }, env);
    expect(result).toEqual({ error: 'path is required and must be a string' });
  });

  it('should return entry content when found', async () => {
    const entry = createMockEntryRow();
    const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(entry) };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleReadEntry({ path: entry.id }, env);

    expect(result).toEqual({
      content: entry.content,
      timestamp: entry.timestamp,
      sections: ['Feelings', 'Project Notes'],
    });
  });

  it('should return error when entry not found', async () => {
    const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleReadEntry({ path: 'nonexistent-id' }, env);

    expect(result).toEqual({ error: 'Entry not found: nonexistent-id' });
  });
});
