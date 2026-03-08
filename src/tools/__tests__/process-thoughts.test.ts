// ABOUTME: Tests for process-thoughts tool - journal entry creation
// ABOUTME: Covers section building, ID generation, embedding, and storage

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleProcessThoughts } from '../process-thoughts';
import { createMockEnv } from '../../__tests__/mocks';
import { Env } from '../../types';

describe('handleProcessThoughts', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
    // Mock D1 prepare chain for insertEntry
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({}),
    };
    (env.DB.prepare as any).mockReturnValue(stmt);
  });

  it('should throw if no sections provided', async () => {
    await expect(handleProcessThoughts({}, env)).rejects.toThrow(
      'At least one section must be provided'
    );
  });

  it('should create entry with feelings section', async () => {
    const result = await handleProcessThoughts(
      { feelings: 'I feel great today' },
      env
    );

    expect(result.success).toBe(true);
    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe('string');
  });

  it('should create entry with multiple sections', async () => {
    const result = await handleProcessThoughts(
      {
        feelings: 'Excited',
        project_notes: 'Working on auth',
        technical_insights: 'PKCE is important',
      },
      env
    );

    expect(result.success).toBe(true);

    // Verify D1 insert was called
    const stmt = (env.DB.prepare as any).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalled();
    const bindArgs = stmt.bind.mock.calls[0];
    const content = bindArgs[5]; // content is 6th arg
    expect(content).toContain('## Feelings');
    expect(content).toContain('## Project Notes');
    expect(content).toContain('## Technical Insights');

    const sections = JSON.parse(bindArgs[4]); // sections is 5th arg
    expect(sections).toEqual(['Feelings', 'Project Notes', 'Technical Insights']);
  });

  it('should generate embedding and store in Vectorize', async () => {
    await handleProcessThoughts({ feelings: 'test' }, env);

    expect(env.AI.run).toHaveBeenCalled();
    expect(env.VECTORIZE.upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        values: expect.any(Array),
        metadata: expect.objectContaining({
          date: expect.any(String),
          timestamp: expect.any(Number),
          sections: 'Feelings',
          source: 'journal',
        }),
      }),
    ]);
  });

  it('should include project in entry when provided', async () => {
    await handleProcessThoughts(
      { feelings: 'test', project: 'my-project' },
      env
    );

    const stmt = (env.DB.prepare as any).mock.results[0].value;
    const bindArgs = stmt.bind.mock.calls[0];
    expect(bindArgs[3]).toBe('my-project'); // project is 4th arg
  });

  it('should use null project when not provided', async () => {
    await handleProcessThoughts({ feelings: 'test' }, env);

    const stmt = (env.DB.prepare as any).mock.results[0].value;
    const bindArgs = stmt.bind.mock.calls[0];
    expect(bindArgs[3]).toBeNull();
  });

  it('should generate unique IDs for different entries', async () => {
    const result1 = await handleProcessThoughts({ feelings: 'entry 1' }, env);
    const result2 = await handleProcessThoughts({ feelings: 'entry 2' }, env);

    expect(result1.id).not.toBe(result2.id);
  });

  it('should generate ID in expected format', async () => {
    const result = await handleProcessThoughts({ feelings: 'test' }, env);

    // ID format: YYYY-MM-DD-timestamp-hash
    expect(result.id).toMatch(/^\d{4}-\d{2}-\d{2}-\d+-[a-f0-9]+$/);
  });
});
