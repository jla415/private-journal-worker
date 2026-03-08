// ABOUTME: Tests for search tool - semantic vector search over journal entries
// ABOUTME: Covers query flow, section filtering, project filtering, and edge cases

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSearch } from '../search';
import { createMockEnv, createMockEntryRow, createMockVectorize } from '../../__tests__/mocks';
import { Env } from '../../types';

describe('handleSearch', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should throw if query is not a string', async () => {
    await expect(handleSearch({}, env)).rejects.toThrow('query is required and must be a string');
    await expect(handleSearch({ query: 123 }, env)).rejects.toThrow('query is required');
  });

  it('should return empty results when Vectorize returns no matches', async () => {
    const result = await handleSearch({ query: 'test' }, env);
    expect(result).toEqual({ results: [] });
  });

  it('should perform end-to-end search with vector matches', async () => {
    const entry = createMockEntryRow({ id: 'entry-1' });
    const vectorize = createMockVectorize({
      matches: [
        { id: 'entry-1', score: 0.95, metadata: { sections: 'Feelings', date: '2025-01-15' } },
      ],
    });
    env.VECTORIZE = vectorize;

    // Mock D1 to return the entry
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [entry] }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleSearch({ query: 'test feelings' }, env);

    expect(env.AI.run).toHaveBeenCalled();
    expect(vectorize.query).toHaveBeenCalled();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('entry-1');
    expect(result.results[0].score).toBe(0.95);
  });

  it('should respect limit parameter', async () => {
    const vectorize = createMockVectorize({
      matches: [
        { id: 'a', score: 0.9, metadata: {} },
        { id: 'b', score: 0.8, metadata: {} },
        { id: 'c', score: 0.7, metadata: {} },
      ],
    });
    env.VECTORIZE = vectorize;

    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: [
          createMockEntryRow({ id: 'a' }),
          createMockEntryRow({ id: 'b' }),
        ],
      }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleSearch({ query: 'test', limit: 2 }, env);

    // topK should be min(limit*2, 50)
    expect(vectorize.query).toHaveBeenCalledWith(
      expect.any(Array),
      { topK: 4, returnMetadata: true }
    );
  });

  it('should filter by sections metadata', async () => {
    const vectorize = createMockVectorize({
      matches: [
        { id: 'a', score: 0.9, metadata: { sections: 'Feelings,Project Notes' } },
        { id: 'b', score: 0.8, metadata: { sections: 'Technical Insights' } },
        { id: 'c', score: 0.7, metadata: {} },
      ],
    });
    env.VECTORIZE = vectorize;

    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: [createMockEntryRow({ id: 'a' })],
      }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleSearch(
      { query: 'test', sections: ['Feelings'] },
      env
    );

    // Only 'a' matches the Feelings section filter
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('a');
  });

  it('should normalize section names for comparison', async () => {
    const vectorize = createMockVectorize({
      matches: [
        { id: 'a', score: 0.9, metadata: { sections: 'project_notes' } },
      ],
    });
    env.VECTORIZE = vectorize;

    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: [createMockEntryRow({ id: 'a' })],
      }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleSearch(
      { query: 'test', sections: ['Project Notes'] },
      env
    );

    expect(result.results).toHaveLength(1);
  });

  it('should filter by project after D1 fetch', async () => {
    const vectorize = createMockVectorize({
      matches: [
        { id: 'a', score: 0.9, metadata: {} },
        { id: 'b', score: 0.8, metadata: {} },
      ],
    });
    env.VECTORIZE = vectorize;

    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: [
          createMockEntryRow({ id: 'a', project: 'myapp' }),
          createMockEntryRow({ id: 'b', project: 'other' }),
        ],
      }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleSearch(
      { query: 'test', project: 'myapp' },
      env
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('a');
  });

  it('should sort results by score descending', async () => {
    const vectorize = createMockVectorize({
      matches: [
        { id: 'a', score: 0.7, metadata: {} },
        { id: 'b', score: 0.9, metadata: {} },
      ],
    });
    env.VECTORIZE = vectorize;

    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: [
          createMockEntryRow({ id: 'a' }),
          createMockEntryRow({ id: 'b' }),
        ],
      }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleSearch({ query: 'test' }, env);

    expect(result.results[0].id).toBe('b');
    expect(result.results[1].id).toBe('a');
  });
});
