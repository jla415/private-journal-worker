// ABOUTME: Tests for search tool - vector, text, and hybrid search
// ABOUTME: Covers query flow, section filtering, project filtering, mode selection, and edge cases

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSearch } from '../search';
import { createMockEnv, createMockEntryRow, createMockVectorize } from '../../__tests__/mocks';
import { Env } from '../../types';

describe('handleSearch', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should throw if query is not a string or array', async () => {
    await expect(handleSearch({}, env)).rejects.toThrow('query is required');
    await expect(handleSearch({ query: 123 }, env)).rejects.toThrow('query is required');
  });

  it('should return empty results when Vectorize returns no matches', async () => {
    const result = await handleSearch({ query: 'test', mode: 'vector' }, env);
    expect(result).toEqual({ results: [] });
  });

  it('should perform vector search with mode=vector', async () => {
    const entry = createMockEntryRow({ id: 'entry-1' });
    const vectorize = createMockVectorize({
      matches: [
        { id: 'entry-1', score: 0.95, metadata: { sections: 'Feelings', date: '2025-01-15' } },
      ],
    });
    env.VECTORIZE = vectorize;

    const stmt = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [entry] }),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const result = await handleSearch({ query: 'test feelings', mode: 'vector' }, env);

    expect(env.AI.run).toHaveBeenCalled();
    expect(vectorize.query).toHaveBeenCalled();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('entry-1');
    expect(result.results[0].score).toBe(0.95);
    expect(result.results[0].source).toBe('journal');
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

    await handleSearch({ query: 'test', limit: 2, mode: 'vector' }, env);

    expect(vectorize.query).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ topK: 4 })
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
      { query: 'test', sections: ['Feelings'], mode: 'vector' },
      env
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('a');
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
      { query: 'test', project: 'myapp', mode: 'vector' },
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

    const result = await handleSearch({ query: 'test', mode: 'vector' }, env);

    expect(result.results[0].id).toBe('b');
    expect(result.results[1].id).toBe('a');
  });

  it('should accept query as an array for multi-concept search', async () => {
    const result = await handleSearch({ query: ['auth', 'security'] }, env);
    expect(result.results).toEqual([]);
  });

  it('should reject query array items that are not strings', async () => {
    await expect(handleSearch({ query: ['test', 123] }, env)).rejects.toThrow('query array items must be strings');
  });
});
