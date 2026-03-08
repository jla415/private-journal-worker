// ABOUTME: Shared mock factories for Cloudflare Worker bindings (D1, Vectorize, AI)
// ABOUTME: Used by all test files to create isolated mock environments

import { Env } from '../types';

// Mock D1 statement
export function createMockStatement(returnValue: unknown = { results: [] }) {
  const statement: any = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue(returnValue),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue(returnValue),
  };
  return statement;
}

// Mock D1 database
export function createMockDB(overrides: Partial<D1Database> = {}) {
  const statements: any[] = [];
  const db: any = {
    prepare: vi.fn().mockImplementation(() => {
      const stmt = createMockStatement();
      statements.push(stmt);
      return stmt;
    }),
    batch: vi.fn().mockResolvedValue([]),
    _statements: statements,
    ...overrides,
  };
  return db;
}

// Mock Vectorize index
export function createMockVectorize(queryResults: { matches: any[] } = { matches: [] }) {
  return {
    query: vi.fn().mockResolvedValue(queryResults),
    upsert: vi.fn().mockResolvedValue({ count: 1 }),
    deleteByIds: vi.fn().mockResolvedValue({ count: 1 }),
    getByIds: vi.fn().mockResolvedValue({ vectors: [] }),
  } as unknown as VectorizeIndex;
}

// Mock Workers AI
export function createMockAI(embedding: number[] = Array(1024).fill(0.1)) {
  return {
    run: vi.fn().mockResolvedValue({ data: [embedding] }),
  } as unknown as Ai;
}

// Create full mock Env
export function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createMockDB(),
    VECTORIZE: createMockVectorize(),
    AI: createMockAI(),
    JOURNAL_TOKEN: 'test-token',
    AUTHORIZE_PIN: 'test-pin',
    ...overrides,
  };
}

// Helper: create a mock entry row
export function createMockEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '2025-01-15-1705312800000-abc12345',
    timestamp: 1705312800000,
    date: '2025-01-15',
    project: 'test-project',
    sections: '["Feelings","Project Notes"]',
    content: '## Feelings\n\nTest feelings content\n\n## Project Notes\n\nTest project notes',
    created_at: 1705312800,
    ...overrides,
  };
}
