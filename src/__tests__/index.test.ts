// ABOUTME: Tests for Worker entry point routing
// ABOUTME: Covers auth middleware, route matching, admin endpoints, REST API, and security

import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index';
import { createMockEnv } from './mocks';
import { Env } from '../types';

// Helper: mock DB to return an OAuth token for auth validation
function mockOAuthAuth(env: Env, scope: string) {
  const oauthToken = {
    client_id: 'client-1',
    scope,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(oauthToken),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({}),
  };
  (env.DB.prepare as any).mockReturnValue(stmt);
}

describe('Worker fetch handler', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  describe('OPTIONS preflight', () => {
    it('should return 204 with no CORS headers', async () => {
      const request = new Request('https://example.com/', { method: 'OPTIONS' });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
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

  describe('Admin endpoints', () => {
    it('should require auth', async () => {
      const request = new Request('https://example.com/admin/clear', {
        method: 'POST',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
    });

    it('should reject OAuth tokens with 403', async () => {
      mockOAuthAuth(env, 'journal:read journal:write');

      const request = new Request('https://example.com/admin/clear', {
        method: 'POST',
        headers: { Authorization: 'Bearer oauth-token' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(403);
      const body = await response.json() as any;
      expect(body.error).toContain('admin');
    });

    it('should allow static token access to admin/clear', async () => {
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

      expect(response.status).toBe(200);
    });

    it('should allow static token access to admin/backfill-fts', async () => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const request = new Request('https://example.com/admin/backfill-fts', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
    });

    it('should return 404 for non-POST method on admin/clear', async () => {
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
  });

  describe('REST API scope enforcement', () => {
    it('should require journal:read for GET /api/stats', async () => {
      mockOAuthAuth(env, 'journal:write');

      const request = new Request('https://example.com/api/stats', {
        headers: { Authorization: 'Bearer oauth-token' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(403);
    });

    it('should require journal:write for POST /api/entries', async () => {
      mockOAuthAuth(env, 'journal:read');

      const request = new Request('https://example.com/api/entries', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ feelings: 'test' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(403);
    });

    it('should require journal:write for POST /api/import', async () => {
      mockOAuthAuth(env, 'journal:read');

      const request = new Request('https://example.com/api/import', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer oauth-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ exchanges: [] }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(403);
    });

    it('should allow journal:read scope for read endpoints', async () => {
      const oauthToken = {
        client_id: 'client-1',
        scope: 'journal:read',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
      // First call: auth lookup. Subsequent: stats queries.
      let callCount = 0;
      (env.DB.prepare as any).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(oauthToken) };
        }
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ count: 0, earliest: null, latest: null }),
          all: vi.fn().mockResolvedValue({ results: [] }),
        };
      });

      const request = new Request('https://example.com/api/stats', {
        headers: { Authorization: 'Bearer oauth-token' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
    });

    it('should allow static token (full scope) for all endpoints', async () => {
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
    it('should return generic error message in 500 response', async () => {
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
      expect(body.error).toBe('Internal server error');
      // Should NOT leak the real error message
      expect(body.error).not.toContain('DB connection');
    });
  });
});
