// ABOUTME: Tests for read-entry tool
// ABOUTME: Covers successful reads, not-found cases, and exchange support

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleReadEntry } from '../read-entry';
import { createMockEnv, createMockEntryRow } from '../../__tests__/mocks';
import { Env } from '../../types';

describe('handleReadEntry', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should return error if id is not a string', async () => {
    const result = await handleReadEntry({}, env);
    expect(result).toEqual({ error: 'id is required and must be a string' });
  });

  it('should return error if id is a number', async () => {
    const result = await handleReadEntry({ id: 123 }, env);
    expect(result).toEqual({ error: 'id is required and must be a string' });
  });

  it('should support deprecated path parameter', async () => {
    const entry = createMockEntryRow();
    const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(entry) };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleReadEntry({ path: entry.id }, env) as any;
    expect(result.source).toBe('journal');
    expect(result.content).toBe(entry.content);
  });

  it('should return entry content when found', async () => {
    const entry = createMockEntryRow();
    const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(entry) };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleReadEntry({ id: entry.id }, env) as any;

    expect(result.content).toBe(entry.content);
    expect(result.timestamp).toBe(entry.timestamp);
    expect(result.sections).toEqual(['Feelings', 'Project Notes']);
    expect(result.source).toBe('journal');
  });

  it('should return error when entry not found', async () => {
    const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleReadEntry({ id: 'nonexistent-id' }, env);

    expect(result).toEqual({ error: 'Entry not found: nonexistent-id' });
  });

  it('should route exchange IDs to exchanges table', async () => {
    const exchange = {
      id: 'exc-abc123',
      session_id: 'session-1',
      project: 'test',
      timestamp: 1705312800000,
      date: '2025-01-15',
      user_message: 'Hello',
      assistant_message: 'Hi there!',
      tool_names: null,
      created_at: 1705312800,
    };
    const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(exchange) };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleReadEntry({ id: 'exc-abc123' }, env) as any;

    expect(result.source).toBe('chat');
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('Hi there!');
  });
});
