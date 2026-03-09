// ABOUTME: Tests for sync orchestrator
// ABOUTME: RED tests written first per TDD approach

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sync, SyncOptions, SyncResult } from '../sync/sync';

// Mock fs and glob
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('node:path', async () => {
  const actual = await vi.importActual('node:path');
  return actual;
});

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';

// Mock parse-jsonl
vi.mock('../sync/parse-jsonl', () => ({
  parseJSONL: vi.fn(),
  readAndParseJSONLFile: vi.fn(),
}));

import { readAndParseJSONLFile } from '../sync/parse-jsonl';

// Mock glob
vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return {
    ...mod,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

import { readdirSync } from 'node:fs';

describe('sync', () => {
  let fetchMock: typeof fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ imported: 2, skipped: 0, errors: [] }),
    } as Response);
  });

  function makeOptions(overrides: Partial<SyncOptions> = {}): SyncOptions {
    return {
      claudeDir: '/Users/xd/.claude',
      apiUrl: 'https://journal.example.com',
      apiToken: 'test-token',
      dryRun: false,
      full: false,
      fetchFn: fetchMock,
      ...overrides,
    };
  }

  it('should discover JSONL files in projects directory', async () => {
    // Mock directory listing
    (readdirSync as any).mockImplementation((dir: string) => {
      if (dir.endsWith('/projects')) {
        return [{ name: '-Users-xd-code-myproject', isDirectory: () => true }];
      }
      if (dir.includes('myproject')) {
        return [{ name: 'abc123.jsonl', isDirectory: () => false }];
      }
      return [];
    });
    (existsSync as any).mockReturnValue(false);
    (statSync as any).mockReturnValue({ mtimeMs: Date.now() });
    (readAndParseJSONLFile as any).mockReturnValue([
      { user_message: 'hi', assistant_message: 'hello', tool_names: [], session_id: 's1', project: '', timestamp: Date.now() },
    ]);

    const result = await sync(makeOptions());
    expect(result.filesProcessed).toBe(1);
  });

  it('should batch exchanges into groups of 100', async () => {
    // Generate 150 exchanges from a single file
    const exchanges = Array.from({ length: 150 }, (_, i) => ({
      user_message: `msg ${i}`,
      assistant_message: `reply ${i}`,
      tool_names: [],
      session_id: 's1',
      project: '',
      timestamp: Date.now() + i,
    }));

    (readdirSync as any).mockImplementation((dir: string) => {
      if (dir.endsWith('/projects')) {
        return [{ name: '-Users-xd-code-proj', isDirectory: () => true }];
      }
      if (dir.includes('proj')) {
        return [{ name: 'session.jsonl', isDirectory: () => false }];
      }
      return [];
    });
    (existsSync as any).mockReturnValue(false);
    (statSync as any).mockReturnValue({ mtimeMs: Date.now() });
    (readAndParseJSONLFile as any).mockReturnValue(exchanges);

    await sync(makeOptions());

    // Should make 2 fetch calls (100 + 50)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should report totals correctly', async () => {
    (readdirSync as any).mockImplementation((dir: string) => {
      if (dir.endsWith('/projects')) {
        return [{ name: '-Users-xd-code-proj', isDirectory: () => true }];
      }
      return [{ name: 'a.jsonl', isDirectory: () => false }];
    });
    (existsSync as any).mockReturnValue(false);
    (statSync as any).mockReturnValue({ mtimeMs: Date.now() });
    (readAndParseJSONLFile as any).mockReturnValue([
      { user_message: 'hi', assistant_message: 'hello', tool_names: [], session_id: 's1', project: '', timestamp: Date.now() },
    ]);

    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ imported: 1, skipped: 0, errors: [] }),
    });

    const result = await sync(makeOptions());
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.filesProcessed).toBe(1);
  });

  it('should track sync state for incremental sync', async () => {
    const now = Date.now();

    // Simulate existing sync state
    (existsSync as any).mockImplementation((p: string) =>
      p.includes('journal-sync-state')
    );
    (readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('journal-sync-state')) {
        return JSON.stringify({
          '/Users/xd/.claude/projects/-Users-xd-code-proj/old.jsonl': now - 1000,
        });
      }
      return '';
    });

    // old.jsonl hasn't changed (mtime matches), new.jsonl is new
    (readdirSync as any).mockImplementation((dir: string) => {
      if (dir.endsWith('/projects')) {
        return [{ name: '-Users-xd-code-proj', isDirectory: () => true }];
      }
      return [
        { name: 'old.jsonl', isDirectory: () => false },
        { name: 'new.jsonl', isDirectory: () => false },
      ];
    });
    (statSync as any).mockImplementation((p: string) => ({
      mtimeMs: p.includes('old') ? now - 1000 : now + 5000,
    }));
    (readAndParseJSONLFile as any).mockReturnValue([
      { user_message: 'hi', assistant_message: 'hello', tool_names: [], session_id: 's1', project: '', timestamp: now },
    ]);

    const result = await sync(makeOptions());

    // Should only process new.jsonl (old.jsonl mtime matches state)
    expect(result.filesProcessed).toBe(1);
    expect(readAndParseJSONLFile).toHaveBeenCalledTimes(1);
  });

  it('should process all files when full=true', async () => {
    const now = Date.now();

    (existsSync as any).mockImplementation((p: string) =>
      p.includes('journal-sync-state')
    );
    (readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('journal-sync-state')) {
        return JSON.stringify({
          '/Users/xd/.claude/projects/-Users-xd-code-proj/old.jsonl': now - 1000,
        });
      }
      return '';
    });

    (readdirSync as any).mockImplementation((dir: string) => {
      if (dir.endsWith('/projects')) {
        return [{ name: '-Users-xd-code-proj', isDirectory: () => true }];
      }
      return [{ name: 'old.jsonl', isDirectory: () => false }];
    });
    (statSync as any).mockReturnValue({ mtimeMs: now - 1000 });
    (readAndParseJSONLFile as any).mockReturnValue([
      { user_message: 'hi', assistant_message: 'hello', tool_names: [], session_id: 's1', project: '', timestamp: now },
    ]);

    const result = await sync(makeOptions({ full: true }));

    // full=true should process even files that haven't changed
    expect(result.filesProcessed).toBe(1);
  });

  it('should not POST in dry-run mode', async () => {
    (readdirSync as any).mockImplementation((dir: string) => {
      if (dir.endsWith('/projects')) {
        return [{ name: '-Users-xd-code-proj', isDirectory: () => true }];
      }
      return [{ name: 'a.jsonl', isDirectory: () => false }];
    });
    (existsSync as any).mockReturnValue(false);
    (statSync as any).mockReturnValue({ mtimeMs: Date.now() });
    (readAndParseJSONLFile as any).mockReturnValue([
      { user_message: 'hi', assistant_message: 'hello', tool_names: [], session_id: 's1', project: '', timestamp: Date.now() },
    ]);

    const result = await sync(makeOptions({ dryRun: true }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.exchangesParsed).toBe(1);
    expect(result.filesProcessed).toBe(1);
  });
});
