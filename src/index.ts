// ABOUTME: Worker entry point with auth middleware and route handling
// ABOUTME: Routes requests to MCP handler or OAuth endpoints

import { Env } from './types';
import { handleMcp } from './mcp';
import { handleOAuthMetadata, handleAuthorize, handleToken, handleRegister } from './oauth';
import { validateAuth } from './auth';

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // CORS headers for preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          },
        });
      }

      // OAuth endpoints (no auth required)
      if (path === '/.well-known/oauth-authorization-server') {
        return handleOAuthMetadata(request, env);
      }
      if (path === '/authorize') {
        return handleAuthorize(request, env);
      }
      if (path === '/token') {
        return handleToken(request, env);
      }
      if (path === '/register') {
        // Require bearer token to register new OAuth clients
        const authResult = await validateAuth(request, env);
        if (!authResult.valid) {
          return jsonError('Unauthorized', 401);
        }
        return handleRegister(request, env);
      }

      // MCP endpoint (requires auth)
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        const authResult = await validateAuth(request, env);
        if (!authResult.valid) {
          return jsonError('Unauthorized', 401);
        }
        return handleMcp(request, env);
      }

      // Admin clear endpoint (requires auth) - clears all entries
      if (path === '/admin/clear') {
        const authResult = await validateAuth(request, env);
        if (!authResult.valid) {
          return jsonError('Unauthorized', 401);
        }
        if (request.method !== 'POST') {
          return jsonError('Method not allowed', 405);
        }
        // Get all entry IDs
        const rows = await env.DB.prepare('SELECT id FROM entries').all<{ id: string }>();
        const ids = rows.results.map((r) => r.id);
        if (ids.length > 0) {
          // Delete from Vectorize (max 100 per call)
          for (let i = 0; i < ids.length; i += 100) {
            const batch = ids.slice(i, i + 100);
            await env.VECTORIZE.deleteByIds(batch);
          }
          // Delete from D1
          await env.DB.prepare('DELETE FROM entries').run();
        }
        return new Response(JSON.stringify({ deleted: ids.length }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return jsonError('Not Found', 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return jsonError(message, 500);
    }
  },
};
