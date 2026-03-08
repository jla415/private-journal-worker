// ABOUTME: Tests for Worker entry point routing
// ABOUTME: Covers CORS, auth middleware, route matching, admin endpoints, and REST API

import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index';
import { createMockEnv, createMockEntryRow } from './mocks';
import { Env } from '../types';

describe('Worker fetch handler', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  describe('CORS', () => {
    it('should handle OPTIONS preflight', async () => {
      const request = new Request('https://example.com/', { method: 'OPTIONS' });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
  });

  describe('OAuth routes', () => {
    it('should route /.well-known/oauth-authorization-server', async () => {
      const request = new Request('https://example.com/.well-known/oauth-authorization-server');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.authorization_endpoint).toBeDefined();
      expect(body.token_endpoint).toBeDefined();
    });

    it('should route /.well-known/oauth-protected-resource', async () => {
      const request = new Request('https://example.com/.well-known/oauth-protected-resource');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.resource).toBeDefined();
      expect(body.authorization_servers).toBeDefined();
    });
  });

  describe('MCP routes', () => {
    it('should require auth for / endpoint', async () => {
      const request = new Request('https://example.com/', { method: 'POST' });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
    });

    it('should require auth for /mcp endpoint', async () => {
      const request = new Request('https://example.com/mcp', { method: 'POST' });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
    });

    it('should allow authenticated MCP requests', async () => {
      const request = new Request('https://example.com/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        }),
      });

      const response = await worker.fetch(request, env);
      expect(response.status).toBe(200);
    });
  });

  describe('Admin clear', () => {
    it('should require auth', async () => {
      const request = new Request('https://example.com/admin/clear', {
        method: 'POST',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
    });

    it('should return 404 for non-POST method', async () => {
      const request = new Request('https://example.com/admin/clear', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-token' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });

    it('should delete all entries and vectors', async () => {
      const entries = [{ id: 'entry-1' }, { id: 'entry-2' }];
      const stmts = [
        { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: entries }), run: vi.fn().mockResolvedValue({}) },
        { bind: vi.fn().mockReturnThis(), all: vi.fn().mockResolvedValue({ results: [] }), run: vi.fn().mockResolvedValue({}) },
      ];
      let callCount = 0;
      (env.DB.prepare as any).mockImplementation(() => stmts[callCount++ % stmts.length] || stmts[1]);

      const request = new Request('https://example.com/admin/clear', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      });
      const response = await worker.fetch(request, env);
      const body = await response.json() as any;

      expect(body.deleted).toBeGreaterThanOrEqual(2);
      expect(env.VECTORIZE.deleteByIds).toHaveBeenCalled();
    });

    it('should handle empty database gracefully', async () => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const request = new Request('https://example.com/admin/clear', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      });
      const response = await worker.fetch(request, env);
      const body = await response.json() as any;

      expect(body.deleted).toBe(0);
      expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    });
  });

  describe('REST API', () => {
    it('should require auth for API routes', async () => {
      const request = new Request('https://example.com/api/stats');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
    });

    it('should route GET /api/stats', async () => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ count: 0, earliest: null, latest: null }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const request = new Request('https://example.com/api/stats', {
        headers: { Authorization: 'Bearer test-token' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.journal_entries).toBeDefined();
    });

    it('should route GET /api/entries/:id', async () => {
      const entry = createMockEntryRow();
      const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(entry) };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const request = new Request(`https://example.com/api/entries/${entry.id}`, {
        headers: { Authorization: 'Bearer test-token' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
    });
  });

  describe('404', () => {
    it('should return 401 for unknown paths without auth', async () => {
      const request = new Request('https://example.com/unknown');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
    });

    it('should return 404 for unknown paths with auth', async () => {
      const request = new Request('https://example.com/unknown', {
        headers: { Authorization: 'Bearer test-token' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });
  });

  describe('error handling', () => {
    it('should catch and return 500 for unhandled errors', async () => {
      (env.DB.prepare as any).mockImplementation(() => {
        throw new Error('DB connection failed');
      });

      const request = new Request('https://example.com/admin/clear', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(500);
      const body = await response.json() as any;
      expect(body.error).toBe('DB connection failed');
    });
  });
});
