// ABOUTME: Worker entry point with auth middleware and route handling
// ABOUTME: Routes requests to MCP handler, REST API, or admin endpoints

import { Env } from './types';
import { handleMcp } from './mcp';
import { handleOAuthMetadata, handleAuthorize, handleToken, handleRegister } from './oauth';
import { validateAuth } from './auth';
import { handleSearch } from './tools/search';
import { handleReadEntry } from './tools/read-entry';
import { handleListRecent } from './tools/list-recent';
import { handleProcessThoughts } from './tools/process-thoughts';
import { handleStats } from './tools/stats';
import {
  insertExchange,
  insertEntryFts,
  insertExchangeFts,
} from './db';
import { generateEmbedding, extractExchangeText } from './embeddings';

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
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
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          },
        });
      }

      // OAuth endpoints (no auth required)
      if (path === '/.well-known/oauth-authorization-server') {
        return handleOAuthMetadata(request, env);
      }
      if (path === '/.well-known/oauth-protected-resource') {
        const baseUrl = `${url.protocol}//${url.host}`;
        return new Response(JSON.stringify({
          resource: baseUrl,
          authorization_servers: [`${baseUrl}/.well-known/oauth-authorization-server`],
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/authorize') {
        return handleAuthorize(request, env);
      }
      if (path === '/token') {
        return handleToken(request, env);
      }
      if (path === '/register') {
        return handleRegister(request, env);
      }

      // MCP endpoint (requires auth)
      if (path === '/' || path === '/mcp' || path.startsWith('/mcp/')) {
        const authResult = await validateAuth(request, env);
        if (!authResult.valid) {
          return jsonError('Unauthorized', 401);
        }
        return handleMcp(request, env);
      }

      // All remaining routes require auth
      const authResult = await validateAuth(request, env);
      if (!authResult.valid) {
        return jsonError('Unauthorized', 401);
      }

      // --- REST API endpoints ---

      if (path === '/api/search' && request.method === 'GET') {
        const args: Record<string, unknown> = {};
        const q = url.searchParams.get('q');
        if (q) args.query = q;
        if (url.searchParams.has('limit')) args.limit = Number(url.searchParams.get('limit'));
        if (url.searchParams.has('mode')) args.mode = url.searchParams.get('mode');
        if (url.searchParams.has('after')) args.after = url.searchParams.get('after');
        if (url.searchParams.has('before')) args.before = url.searchParams.get('before');
        if (url.searchParams.has('source')) args.source = url.searchParams.get('source');
        if (url.searchParams.has('project')) args.project = url.searchParams.get('project');
        if (url.searchParams.has('sections')) args.sections = url.searchParams.get('sections')!.split(',');

        const result = await handleSearch(args, env);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (offset > 0) {
          result.results = result.results.slice(offset);
        }
        return jsonOk(result);
      }

      if (path === '/api/entries/recent' && request.method === 'GET') {
        const args: Record<string, unknown> = {};
        if (url.searchParams.has('limit')) args.limit = Number(url.searchParams.get('limit'));
        if (url.searchParams.has('days')) args.days = Number(url.searchParams.get('days'));
        if (url.searchParams.has('project')) args.project = url.searchParams.get('project');
        if (url.searchParams.has('source')) args.source = url.searchParams.get('source');

        const result = await handleListRecent(args, env);
        return jsonOk(result);
      }

      // GET /api/entries/:id — must come after /api/entries/recent
      const entryMatch = path.match(/^\/api\/entries\/(.+)$/);
      if (entryMatch && request.method === 'GET') {
        const result = await handleReadEntry({ id: decodeURIComponent(entryMatch[1]) }, env);
        return jsonOk(result);
      }

      if (path === '/api/entries' && request.method === 'POST') {
        const body = await request.json() as Record<string, unknown>;
        const result = await handleProcessThoughts(body, env);
        return jsonOk(result, 201);
      }

      if (path === '/api/stats' && request.method === 'GET') {
        const result = await handleStats({}, env);
        return jsonOk(result);
      }

      if ((path === '/api/import' || path === '/admin/import-conversations') && request.method === 'POST') {
        return await handleImportConversations(request, env);
      }

      // --- Admin endpoints ---

      if (path === '/admin/clear' && request.method === 'POST') {
        return await handleAdminClear(url, env);
      }

      if (path === '/admin/backfill-fts' && request.method === 'POST') {
        return await handleBackfillFts(env);
      }

      return jsonError('Not Found', 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return jsonError(message, 500);
    }
  },
};

// --- Import conversations endpoint ---

async function handleImportConversations(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    exchanges: Array<{
      user_message: string;
      assistant_message: string;
      tool_names?: string[];
      session_id?: string;
      project?: string;
      timestamp?: number;
    }>;
  };

  if (!Array.isArray(body.exchanges)) {
    return jsonError('exchanges array is required', 400);
  }

  let imported = 0;
  let skipped = 0;
  const errors: { index: number; error: string }[] = [];

  for (let i = 0; i < body.exchanges.length; i++) {
    const exc = body.exchanges[i];
    try {
      const now = exc.timestamp || Date.now();
      const date = new Date(now).toISOString().split('T')[0];

      // Generate deterministic hash for dedup
      const hashInput = (exc.project ?? '') + (exc.session_id ?? '') +
        exc.user_message.slice(0, 100) + now.toString();
      const hashBuffer = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(hashInput)
      );
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hash = hashArray.slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
      const id = `exc-${hash}`;

      const toolNamesStr = exc.tool_names?.join(',') ?? null;

      // Insert into D1 (returns false if already exists)
      const wasInserted = await insertExchange(env, {
        id,
        session_id: exc.session_id ?? null,
        project: exc.project ?? null,
        timestamp: now,
        date,
        user_message: exc.user_message,
        assistant_message: exc.assistant_message,
        tool_names: toolNamesStr,
      });

      if (!wasInserted) {
        skipped++;
        continue;
      }

      // Generate embedding and upsert to Vectorize
      try {
        const searchText = extractExchangeText(exc.user_message, exc.assistant_message);
        const embedding = await generateEmbedding(env, searchText);

        await env.VECTORIZE.upsert([{
          id,
          values: embedding,
          metadata: {
            timestamp: now,
            date,
            source: 'chat',
            session_id: exc.session_id ?? '',
          },
        }]);
      } catch (vecErr) {
        // Rollback D1 insert if Vectorize fails
        await env.DB.prepare('DELETE FROM exchanges WHERE id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM exchanges_fts WHERE id = ?').bind(id).run();
        throw vecErr;
      }

      imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      errors.push({ index: i, error: message });
    }
  }

  return jsonOk({ imported, skipped, errors });
}

// --- Admin clear endpoint ---

async function handleAdminClear(url: URL, env: Env): Promise<Response> {
  const source = url.searchParams.get('source');

  let totalDeleted = 0;

  if (!source || source === 'journal') {
    const rows = await env.DB.prepare('SELECT id FROM entries').all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    if (ids.length > 0) {
      for (let i = 0; i < ids.length; i += 100) {
        await env.VECTORIZE.deleteByIds(ids.slice(i, i + 100));
      }
      await env.DB.prepare('DELETE FROM entries').run();
    }
    await env.DB.prepare('DELETE FROM entries_fts').run();
    totalDeleted += ids.length;
  }

  if (!source || source === 'chat') {
    const rows = await env.DB.prepare('SELECT id FROM exchanges').all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    if (ids.length > 0) {
      for (let i = 0; i < ids.length; i += 100) {
        await env.VECTORIZE.deleteByIds(ids.slice(i, i + 100));
      }
      await env.DB.prepare('DELETE FROM exchanges').run();
    }
    await env.DB.prepare('DELETE FROM exchanges_fts').run();
    totalDeleted += ids.length;
  }

  return jsonOk({ deleted: totalDeleted });
}

// --- FTS backfill endpoint ---

async function handleBackfillFts(env: Env): Promise<Response> {
  // Clear existing FTS data first (idempotent)
  await env.DB.prepare('DELETE FROM entries_fts').run();
  await env.DB.prepare('DELETE FROM exchanges_fts').run();

  // Backfill entries
  const entries = await env.DB.prepare('SELECT id, content, sections FROM entries')
    .all<{ id: string; content: string; sections: string }>();
  for (const row of entries.results) {
    await insertEntryFts(env, row.id, row.content, row.sections);
  }

  // Backfill exchanges
  const exchanges = await env.DB.prepare(
    'SELECT id, user_message, assistant_message, tool_names FROM exchanges'
  ).all<{ id: string; user_message: string; assistant_message: string; tool_names: string | null }>();
  for (const row of exchanges.results) {
    await insertExchangeFts(env, row.id, row.user_message, row.assistant_message, row.tool_names ?? '');
  }

  return jsonOk({
    entries_indexed: entries.results.length,
    exchanges_indexed: exchanges.results.length,
  });
}
