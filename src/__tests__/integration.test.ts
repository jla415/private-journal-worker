// ABOUTME: Integration tests for end-to-end API flows
// ABOUTME: Tests complete request/response cycles through the worker fetch handler

import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index';
import { createMockEnv, createMockEntryRow } from './mocks';
import { Env } from '../types';

const AUTH_HEADERS = { Authorization: 'Bearer test-token' };

function jsonRequest(path: string, options: RequestInit = {}) {
  return new Request(`https://example.com${path}`, {
    headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
    ...options,
  });
}

describe('Integration: Journal entry lifecycle', () => {
  let env: Env;
  let insertedEntry: any;

  beforeEach(() => {
    env = createMockEnv();
    insertedEntry = null;

    // Track D1 inserts to simulate stored data
    let prepareCallCount = 0;
    (env.DB.prepare as any).mockImplementation((sql: string) => {
      prepareCallCount++;
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockImplementation(async () => {
          // Capture the entry from the bind call for INSERT
          if (sql.startsWith('INSERT INTO entries')) {
            const args = stmt.bind.mock.calls[0];
            insertedEntry = {
              id: args[0],
              timestamp: args[1],
              date: args[2],
              project: args[3],
              sections: args[4],
              content: args[5],
              created_at: Math.floor(Date.now() / 1000),
            };
          }
          return {};
        }),
        first: vi.fn().mockImplementation(async () => {
          // Return the inserted entry when queried
          if (sql.includes('FROM entries WHERE id') && insertedEntry) {
            return insertedEntry;
          }
          return null;
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      return stmt;
    });
  });

  it('should create a journal entry via POST /api/entries', async () => {
    const request = jsonRequest('/api/entries', {
      method: 'POST',
      body: JSON.stringify({
        feelings: 'Feeling productive today',
        project_notes: 'Implemented the new search feature',
        project: 'journal-worker',
      }),
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(201);

    const body = (await response.json()) as any;
    expect(body.success).toBe(true);
    expect(body.id).toMatch(/^\d{4}-\d{2}-\d{2}-\d+-[a-f0-9]+$/);

    // Verify D1 insert was called
    expect(env.DB.prepare).toHaveBeenCalled();
    // Verify embedding was generated
    expect(env.AI.run).toHaveBeenCalled();
    // Verify Vectorize upsert was called
    expect(env.VECTORIZE.upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        id: body.id,
        values: expect.any(Array),
        metadata: expect.objectContaining({ source: 'journal' }),
      }),
    ]);
  });

  it('should read the created entry via GET /api/entries/:id', async () => {
    // Simulate an existing entry
    const entry = createMockEntryRow();
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(entry),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({}),
    }));

    const request = jsonRequest(`/api/entries/${entry.id}`);
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.content).toContain('Feelings');
    expect(body.source).toBe('journal');
    expect(body.sections).toEqual(['Feelings', 'Project Notes']);
  });

  it('should return error for non-existent entry', async () => {
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    }));

    const request = jsonRequest('/api/entries/nonexistent-id');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.error).toContain('not found');
  });
});

describe('Integration: Chat history import and retrieval', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should import exchanges via POST /api/import', async () => {
    // Mock D1 to indicate new inserts (not duplicates)
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }));

    const request = jsonRequest('/api/import', {
      method: 'POST',
      body: JSON.stringify({
        exchanges: [
          {
            user_message: 'How do I parse JSON in TypeScript?',
            assistant_message: 'Use JSON.parse() with a type assertion...',
            tool_names: ['Read', 'Bash'],
            session_id: 'session-abc',
            project: 'my-project',
            timestamp: 1700000000000,
          },
          {
            user_message: 'What about error handling?',
            assistant_message: 'Wrap it in a try/catch block...',
            session_id: 'session-abc',
            project: 'my-project',
            timestamp: 1700000060000,
          },
        ],
      }),
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);

    const body = (await response.json()) as any;
    expect(body.imported).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.errors).toEqual([]);

    // Verify embeddings were generated for each exchange
    expect(env.AI.run).toHaveBeenCalledTimes(2);
    // Verify Vectorize upserts with chat source
    expect(env.VECTORIZE.upsert).toHaveBeenCalledTimes(2);
    expect(env.VECTORIZE.upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        id: expect.stringMatching(/^exc-/),
        metadata: expect.objectContaining({ source: 'chat' }),
      }),
    ]);
  });

  it('should skip duplicate exchanges on re-import', async () => {
    // Mock D1 to indicate no changes (duplicate)
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }));

    const request = jsonRequest('/api/import', {
      method: 'POST',
      body: JSON.stringify({
        exchanges: [
          {
            user_message: 'Hello',
            assistant_message: 'Hi there!',
            timestamp: 1700000000000,
          },
        ],
      }),
    });

    const response = await worker.fetch(request, env);
    const body = (await response.json()) as any;

    expect(body.imported).toBe(0);
    expect(body.skipped).toBe(1);
    // No embedding should be generated for skipped exchanges
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('should reject import without exchanges array', async () => {
    const request = jsonRequest('/api/import', {
      method: 'POST',
      body: JSON.stringify({ data: 'wrong format' }),
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);

    const body = (await response.json()) as any;
    expect(body.error).toContain('exchanges array is required');
  });

  it('should read imported exchange via GET /api/entries/exc-...', async () => {
    const exchange = {
      id: 'exc-abc123def456',
      session_id: 'session-abc',
      project: 'my-project',
      timestamp: 1700000000000,
      date: '2023-11-14',
      user_message: 'How do I parse JSON?',
      assistant_message: 'Use JSON.parse()...',
      tool_names: 'Read,Bash',
      created_at: 1700000000,
    };

    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(sql.includes('exchanges') ? exchange : null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }));

    const request = jsonRequest('/api/entries/exc-abc123def456');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.source).toBe('chat');
    expect(body.session_id).toBe('session-abc');
    expect(body.content).toContain('How do I parse JSON?');
    expect(body.content).toContain('Use JSON.parse()');
  });

  it('should rollback D1 insert when Vectorize upsert fails', async () => {
    const deleteSpy = vi.fn().mockResolvedValue({});
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      run: sql.startsWith('DELETE')
        ? deleteSpy
        : vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }));

    // Make Vectorize upsert fail
    (env.VECTORIZE.upsert as any).mockRejectedValue(new Error('Vectorize unavailable'));

    const request = jsonRequest('/api/import', {
      method: 'POST',
      body: JSON.stringify({
        exchanges: [
          {
            user_message: 'test',
            assistant_message: 'test reply',
            timestamp: 1700000000000,
          },
        ],
      }),
    });

    const response = await worker.fetch(request, env);
    const body = (await response.json()) as any;

    expect(body.imported).toBe(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].error).toContain('Vectorize unavailable');
    // Verify rollback DELETE was called
    expect(deleteSpy).toHaveBeenCalled();
  });
});

describe('Integration: Search flows', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  function setupSearchMocks(entries: any[], exchanges: any[] = []) {
    const vectorMatches = [
      ...entries.map((e) => ({
        id: e.id,
        score: 0.95,
        metadata: { sections: e.sections ? JSON.parse(e.sections).join(',') : '', date: e.date, source: 'journal' },
      })),
      ...exchanges.map((e) => ({
        id: e.id,
        score: 0.90,
        metadata: { date: e.date, source: 'chat' },
      })),
    ];

    env.VECTORIZE = {
      query: vi.fn().mockResolvedValue({ matches: vectorMatches }),
      upsert: vi.fn().mockResolvedValue({ count: 1 }),
      deleteByIds: vi.fn().mockResolvedValue({ count: 1 }),
      getByIds: vi.fn().mockResolvedValue({ vectors: [] }),
    } as unknown as VectorizeIndex;

    (env.DB.prepare as any).mockImplementation((sql: string) => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({}),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockImplementation(async () => {
          if (sql.includes('FROM entries WHERE id IN')) {
            return { results: entries };
          }
          if (sql.includes('FROM exchanges WHERE id IN')) {
            return { results: exchanges };
          }
          // FTS queries return empty
          if (sql.includes('entries_fts') || sql.includes('exchanges_fts')) {
            return { results: [] };
          }
          return { results: [] };
        }),
      };
      return stmt;
    });
  }

  it('should search via GET /api/search with vector mode', async () => {
    const entry = createMockEntryRow();
    setupSearchMocks([entry]);

    const request = jsonRequest('/api/search?q=feelings&mode=vector');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe(entry.id);
    expect(body.results[0].source).toBe('journal');
    expect(body.results[0].score).toBeGreaterThan(0);
    expect(body.results[0].excerpt).toBeDefined();

    // Verify embedding was generated for the query
    expect(env.AI.run).toHaveBeenCalled();
    expect(env.VECTORIZE.query).toHaveBeenCalled();
  });

  it('should search across both entries and exchanges', async () => {
    const entry = createMockEntryRow();
    const exchange = {
      id: 'exc-abc123def456',
      session_id: 'session-1',
      project: 'test-project',
      timestamp: 1705312900000,
      date: '2025-01-15',
      user_message: 'How do I search?',
      assistant_message: 'Use the search API...',
      tool_names: null,
      created_at: 1705312900,
    };

    setupSearchMocks([entry], [exchange]);

    const request = jsonRequest('/api/search?q=search&mode=vector&source=all');
    const response = await worker.fetch(request, env);

    const body = (await response.json()) as any;
    expect(body.results.length).toBe(2);

    const sources = body.results.map((r: any) => r.source);
    expect(sources).toContain('journal');
    expect(sources).toContain('chat');
  });

  it('should filter search by source=journal', async () => {
    const entry = createMockEntryRow();
    const exchange = {
      id: 'exc-abc123def456',
      session_id: 'session-1',
      project: null,
      timestamp: 1705312900000,
      date: '2025-01-15',
      user_message: 'test',
      assistant_message: 'reply',
      tool_names: null,
      created_at: 1705312900,
    };

    setupSearchMocks([entry], [exchange]);

    const request = jsonRequest('/api/search?q=test&mode=vector&source=journal');
    const response = await worker.fetch(request, env);

    const body = (await response.json()) as any;
    // Only journal entries should be returned
    for (const r of body.results) {
      expect(r.source).toBe('journal');
    }
  });

  it('should apply date filtering', async () => {
    const entry = createMockEntryRow();
    setupSearchMocks([entry]);

    const request = jsonRequest('/api/search?q=test&mode=vector&after=2025-01-01&before=2025-01-31');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);

    // Verify Vectorize was called with filter
    const queryCall = (env.VECTORIZE.query as any).mock.calls[0];
    const options = queryCall[1];
    expect(options.filter).toBeDefined();
    expect(options.filter.timestamp).toBeDefined();
    expect(options.filter.timestamp.$gte).toBeDefined();
    expect(options.filter.timestamp.$lte).toBeDefined();
  });

  it('should handle text search mode', async () => {
    // FTS returns results
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({}),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockImplementation(async () => {
        if (sql.includes('entries_fts')) {
          return {
            results: [{ id: createMockEntryRow().id, rank: -5.0 }],
          };
        }
        if (sql.includes('exchanges_fts')) {
          return { results: [] };
        }
        if (sql.includes('FROM entries WHERE id IN')) {
          return { results: [createMockEntryRow()] };
        }
        return { results: [] };
      }),
    }));

    const request = jsonRequest('/api/search?q=feelings&mode=text');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.results).toHaveLength(1);
    // Text search should NOT call AI for embeddings
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('should return empty results for no matches', async () => {
    env.VECTORIZE = {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      upsert: vi.fn(),
      deleteByIds: vi.fn(),
      getByIds: vi.fn(),
    } as unknown as VectorizeIndex;

    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({}),
      first: vi.fn().mockResolvedValue(null),
    }));

    const request = jsonRequest('/api/search?q=nonexistent&mode=vector');
    const response = await worker.fetch(request, env);

    const body = (await response.json()) as any;
    expect(body.results).toEqual([]);
  });
});

describe('Integration: List recent entries', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should list recent journal entries', async () => {
    const entries = [
      createMockEntryRow({ id: 'entry-1', timestamp: 1705312900000 }),
      createMockEntryRow({ id: 'entry-2', timestamp: 1705312800000 }),
    ];

    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: sql.includes('FROM entries') ? entries : [],
      }),
      run: vi.fn().mockResolvedValue({}),
    }));

    const request = jsonRequest('/api/entries/recent?source=journal&limit=5');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.entries.length).toBe(2);
    expect(body.entries[0].source).toBe('journal');
    // Should be sorted by timestamp descending
    expect(body.entries[0].timestamp).toBeGreaterThanOrEqual(body.entries[1].timestamp);
  });

  it('should list recent from all sources', async () => {
    const entry = createMockEntryRow({ timestamp: 1705312800000 });
    const exchange = {
      id: 'exc-abc123',
      session_id: 'sess-1',
      project: null,
      timestamp: 1705312900000,
      date: '2025-01-15',
      user_message: 'Hello',
      assistant_message: 'Hi!',
      tool_names: null,
      created_at: 1705312900,
    };

    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockImplementation(async () => {
        if (sql.includes('FROM entries')) return { results: [entry] };
        if (sql.includes('FROM exchanges')) return { results: [exchange] };
        return { results: [] };
      }),
      run: vi.fn().mockResolvedValue({}),
    }));

    const request = jsonRequest('/api/entries/recent?source=all');
    const response = await worker.fetch(request, env);

    const body = (await response.json()) as any;
    expect(body.entries.length).toBe(2);

    const sources = body.entries.map((e: any) => e.source);
    expect(sources).toContain('journal');
    expect(sources).toContain('chat');

    // Exchange has higher timestamp, should be first
    expect(body.entries[0].source).toBe('chat');
  });
});

describe('Integration: Stats endpoint', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should return aggregate stats', async () => {
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('COUNT') && sql.includes('entries')) return { count: 42 };
        if (sql.includes('COUNT') && sql.includes('exchanges')) return { count: 15 };
        if (sql.includes('MIN(date)')) return { earliest: '2024-01-01', latest: '2025-01-15' };
        return null;
      }),
      all: vi.fn().mockImplementation(async () => {
        if (sql.includes('GROUP BY') && sql.includes('entries')) {
          return {
            results: [
              { name: 'project-a', count: 30 },
              { name: '(none)', count: 12 },
            ],
          };
        }
        if (sql.includes('GROUP BY') && sql.includes('exchanges')) {
          return {
            results: [
              { name: 'project-a', count: 10 },
              { name: 'project-b', count: 5 },
            ],
          };
        }
        return { results: [] };
      }),
    }));

    const request = jsonRequest('/api/stats');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.journal_entries).toBe(42);
    expect(body.chat_exchanges).toBe(15);
    expect(body.date_range.earliest).toBe('2024-01-01');
    expect(body.date_range.latest).toBe('2025-01-15');
    expect(body.projects.length).toBe(3); // project-a, (none), project-b
    // project-a should have both entries and exchanges
    const projectA = body.projects.find((p: any) => p.name === 'project-a');
    expect(projectA.entries).toBe(30);
    expect(projectA.exchanges).toBe(10);
  });
});

describe('Integration: Admin endpoints', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should clear only journal entries with source=journal', async () => {
    const journalIds = [{ id: 'entry-1' }, { id: 'entry-2' }];
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: sql.includes('FROM entries') ? journalIds : [],
      }),
      run: vi.fn().mockResolvedValue({}),
    }));

    const request = jsonRequest('/admin/clear?source=journal', { method: 'POST' });
    const response = await worker.fetch(request, env);

    const body = (await response.json()) as any;
    expect(body.deleted).toBe(2);
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledWith(['entry-1', 'entry-2']);
  });

  it('should clear only chat exchanges with source=chat', async () => {
    const exchangeIds = [{ id: 'exc-aaa' }, { id: 'exc-bbb' }];
    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: sql.includes('FROM exchanges') ? exchangeIds : [],
      }),
      run: vi.fn().mockResolvedValue({}),
    }));

    const request = jsonRequest('/admin/clear?source=chat', { method: 'POST' });
    const response = await worker.fetch(request, env);

    const body = (await response.json()) as any;
    expect(body.deleted).toBe(2);
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledWith(['exc-aaa', 'exc-bbb']);
  });

  it('should backfill FTS indexes', async () => {
    const entries = [
      { id: 'entry-1', content: 'Entry one content', sections: '["Feelings"]' },
      { id: 'entry-2', content: 'Entry two content', sections: '["Project Notes"]' },
    ];
    const exchanges = [
      { id: 'exc-aaa', user_message: 'Question', assistant_message: 'Answer', tool_names: 'Bash' },
    ];

    (env.DB.prepare as any).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockImplementation(async () => {
        if (sql.includes('SELECT id, content, sections FROM entries')) return { results: entries };
        if (sql.includes('SELECT id, user_message')) return { results: exchanges };
        return { results: [] };
      }),
      run: vi.fn().mockResolvedValue({}),
    }));

    const request = jsonRequest('/admin/backfill-fts', { method: 'POST' });
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.entries_indexed).toBe(2);
    expect(body.exchanges_indexed).toBe(1);
  });
});

describe('Integration: MCP protocol', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should handle MCP initialize and list tools', async () => {
    // Initialize
    const initRequest = jsonRequest('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      }),
    });

    const initResponse = await worker.fetch(initRequest, env);
    expect(initResponse.status).toBe(200);

    const initBody = (await initResponse.json()) as any;
    expect(initBody.result.serverInfo).toBeDefined();

    // List tools
    const listRequest = jsonRequest('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    });

    const listResponse = await worker.fetch(listRequest, env);
    expect(listResponse.status).toBe(200);

    const listBody = (await listResponse.json()) as any;
    const toolNames = listBody.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('process_thoughts');
    expect(toolNames).toContain('search_journal');
    expect(toolNames).toContain('read_journal_entry');
    expect(toolNames).toContain('list_recent_entries');
    expect(toolNames).toContain('journal_stats');
    expect(toolNames).toHaveLength(5);
  });

  it('should call process_thoughts via MCP tools/call', async () => {
    const request = jsonRequest('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'process_thoughts',
          arguments: {
            feelings: 'Testing MCP integration',
            project: 'test-project',
          },
        },
      }),
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);

    const body = (await response.json()) as any;
    expect(body.result).toBeDefined();
    // MCP returns content as array of text blocks
    const text = body.result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(true);
    expect(parsed.id).toBeDefined();

    // Verify full pipeline: AI + D1 + Vectorize
    expect(env.AI.run).toHaveBeenCalled();
    expect(env.DB.prepare).toHaveBeenCalled();
    expect(env.VECTORIZE.upsert).toHaveBeenCalled();
  });

  it('should call journal_stats via MCP tools/call', async () => {
    (env.DB.prepare as any).mockImplementation(() => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 5, earliest: '2025-01-01', latest: '2025-01-15' }),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }));

    const request = jsonRequest('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'journal_stats',
          arguments: {},
        },
      }),
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);

    const body = (await response.json()) as any;
    const text = body.result.content[0].text;
    const stats = JSON.parse(text);
    expect(stats.journal_entries).toBeDefined();
    expect(stats.chat_exchanges).toBeDefined();
  });
});

describe('Integration: Auth enforcement', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  const protectedRoutes = [
    ['GET', '/api/search?q=test'],
    ['GET', '/api/entries/recent'],
    ['GET', '/api/entries/some-id'],
    ['POST', '/api/entries'],
    ['GET', '/api/stats'],
    ['POST', '/api/import'],
    ['POST', '/admin/clear'],
    ['POST', '/admin/backfill-fts'],
    ['POST', '/mcp'],
  ];

  for (const [method, path] of protectedRoutes) {
    it(`should require auth for ${method} ${path.split('?')[0]}`, async () => {
      const request = new Request(`https://example.com${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });

      const response = await worker.fetch(request, env);
      expect(response.status).toBe(401);
    });
  }

  const publicRoutes = [
    ['OPTIONS', '/'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['GET', '/.well-known/oauth-protected-resource'],
  ];

  for (const [method, path] of publicRoutes) {
    it(`should not require auth for ${method} ${path}`, async () => {
      const request = new Request(`https://example.com${path}`, { method });
      const response = await worker.fetch(request, env);
      expect(response.status).not.toBe(401);
    });
  }
});

describe('Integration: Error resilience', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should return 500 when AI embedding generation fails', async () => {
    (env.AI.run as any).mockRejectedValue(new Error('AI service unavailable'));

    const request = jsonRequest('/api/search?q=test&mode=vector');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(500);
    const body = (await response.json()) as any;
    expect(body.error).toContain('AI service unavailable');
  });

  it('should return 500 when D1 is unavailable', async () => {
    (env.DB.prepare as any).mockImplementation(() => {
      throw new Error('D1 unavailable');
    });

    const request = jsonRequest('/api/stats');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(500);
    const body = (await response.json()) as any;
    expect(body.error).toContain('D1 unavailable');
  });

  it('should return 500 when Vectorize query fails', async () => {
    (env.VECTORIZE.query as any).mockRejectedValue(new Error('Vectorize timeout'));

    const request = jsonRequest('/api/search?q=test&mode=vector');
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(500);
    const body = (await response.json()) as any;
    expect(body.error).toContain('Vectorize timeout');
  });

  it('should handle malformed JSON in POST body', async () => {
    const request = new Request('https://example.com/api/entries', {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
      body: 'not json',
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(500);
  });
});
