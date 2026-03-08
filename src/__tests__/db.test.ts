// ABOUTME: Tests for D1 database operations
// ABOUTME: Covers insert, get, list, search result conversion, and exchange operations

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { insertEntry, getEntry, getEntriesByIds, listRecentEntries, rowToSearchResult, exchangeToSearchResult, insertEntryFts, getExchangesByIds } from '../db';
import { createMockEnv, createMockEntryRow } from './mocks';
import { Env, EntryRow, ExchangeRow } from '../types';

describe('db', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  describe('insertEntry', () => {
    it('should insert an entry with correct parameters', async () => {
      const entry = {
        id: '2025-01-15-123-abc',
        timestamp: 123,
        date: '2025-01-15',
        project: 'test',
        sections: ['Feelings'],
        content: 'test content',
      };

      await insertEntry(env, entry);

      expect(env.DB.prepare).toHaveBeenCalledWith(
        'INSERT OR IGNORE INTO entries (id, timestamp, date, project, sections, content) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const stmt = (env.DB.prepare as any).mock.results[0].value;
      expect(stmt.bind).toHaveBeenCalledWith(
        entry.id,
        entry.timestamp,
        entry.date,
        entry.project,
        JSON.stringify(entry.sections),
        entry.content
      );
    });

    it('should handle null project', async () => {
      await insertEntry(env, {
        id: 'test-id',
        timestamp: 0,
        date: '2025-01-01',
        project: null,
        sections: [],
        content: 'content',
      });

      const stmt = (env.DB.prepare as any).mock.results[0].value;
      expect(stmt.bind).toHaveBeenCalledWith(
        'test-id', 0, '2025-01-01', null, '[]', 'content'
      );
    });
  });

  describe('getEntry', () => {
    it('should return entry when found', async () => {
      const mockEntry = createMockEntryRow();
      const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(mockEntry) };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const result = await getEntry(env, mockEntry.id);

      expect(result).toEqual(mockEntry);
      expect(stmt.bind).toHaveBeenCalledWith(mockEntry.id);
    });

    it('should return null when entry not found', async () => {
      const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const result = await getEntry(env, 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getEntriesByIds', () => {
    it('should return empty array for empty ids', async () => {
      const result = await getEntriesByIds(env, []);
      expect(result).toEqual([]);
      expect(env.DB.prepare).not.toHaveBeenCalled();
    });

    it('should build correct IN clause for multiple ids', async () => {
      const entries = [createMockEntryRow({ id: 'a' }), createMockEntryRow({ id: 'b' })];
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: entries }),
      };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const result = await getEntriesByIds(env, ['a', 'b']);

      expect(env.DB.prepare).toHaveBeenCalledWith(
        'SELECT * FROM entries WHERE id IN (?, ?)'
      );
      expect(stmt.bind).toHaveBeenCalledWith('a', 'b');
      expect(result).toEqual(entries);
    });
  });

  describe('listRecentEntries', () => {
    it('should query with timestamp cutoff and limit', async () => {
      const entries = [createMockEntryRow()];
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: entries }),
      };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const result = await listRecentEntries(env, { limit: 5, days: 7 });

      expect(env.DB.prepare).toHaveBeenCalledWith(
        'SELECT * FROM entries WHERE timestamp > ? ORDER BY timestamp DESC LIMIT ?'
      );
      expect(result).toEqual(entries);
    });

    it('should add project filter when specified', async () => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      (env.DB.prepare as any).mockReturnValue(stmt);

      await listRecentEntries(env, { limit: 10, days: 30, project: 'myproject' });

      expect(env.DB.prepare).toHaveBeenCalledWith(
        'SELECT * FROM entries WHERE timestamp > ? AND project = ? ORDER BY timestamp DESC LIMIT ?'
      );
    });

    it('should handle null/empty project filter', async () => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      (env.DB.prepare as any).mockReturnValue(stmt);

      await listRecentEntries(env, { limit: 10, days: 30, project: '' });

      expect(env.DB.prepare).toHaveBeenCalledWith(
        'SELECT * FROM entries WHERE timestamp > ? AND project IS NULL ORDER BY timestamp DESC LIMIT ?'
      );
    });
  });

  describe('rowToSearchResult', () => {
    it('should convert row to search result with correct fields', () => {
      const row = createMockEntryRow() as EntryRow;
      const result = rowToSearchResult(row, 0.95);

      expect(result).toEqual({
        id: row.id,
        path: row.id,
        score: 0.95,
        timestamp: row.timestamp,
        date: row.date,
        source: 'journal',
        sections: ['Feelings', 'Project Notes'],
        excerpt: expect.any(String),
        project: 'test-project',
      });
    });

    it('should truncate long content to 200 chars with ellipsis', () => {
      const longContent = 'x'.repeat(300);
      const row = createMockEntryRow({ content: longContent }) as EntryRow;
      const result = rowToSearchResult(row, 0.5);

      expect(result.excerpt).toHaveLength(203);
      expect(result.excerpt.endsWith('...')).toBe(true);
    });

    it('should not add ellipsis for short content', () => {
      const row = createMockEntryRow({ content: 'short' }) as EntryRow;
      const result = rowToSearchResult(row, 0.5);

      expect(result.excerpt).toBe('short');
    });
  });

  describe('exchangeToSearchResult', () => {
    it('should convert exchange row to search result', () => {
      const row: ExchangeRow = {
        id: 'exc-abc123',
        session_id: 'session-1',
        project: 'test-project',
        timestamp: 1705312800000,
        date: '2025-01-15',
        user_message: 'How do I fix this bug?',
        assistant_message: 'Try checking the logs.',
        tool_names: 'Read,Edit',
        created_at: 1705312800,
      };
      const result = exchangeToSearchResult(row, 0.85);

      expect(result.source).toBe('chat');
      expect(result.session_id).toBe('session-1');
      expect(result.excerpt).toBe('How do I fix this bug?');
    });
  });

  describe('insertEntryFts', () => {
    it('should insert into FTS table', async () => {
      await insertEntryFts(env, 'test-id', 'content', '["Feelings"]');

      expect(env.DB.prepare).toHaveBeenCalledWith(
        'INSERT INTO entries_fts (id, content, sections) VALUES (?, ?, ?)'
      );
    });
  });

  describe('getExchangesByIds', () => {
    it('should return empty array for empty ids', async () => {
      const result = await getExchangesByIds(env, []);
      expect(result).toEqual([]);
    });
  });
});
