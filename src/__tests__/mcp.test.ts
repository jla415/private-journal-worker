// ABOUTME: Tests for MCP JSON-RPC handler
// ABOUTME: Covers initialize, tools/list, tools/call routing, error cases, and scope enforcement

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMcp } from '../mcp';
import { createMockEnv } from './mocks';
import { Env } from '../types';
import { AuthResult } from '../auth';

function mcpRequest(method: string, params?: Record<string, unknown>, id: number = 1) {
  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

const fullAuth: AuthResult = { valid: true, scope: 'journal:read journal:write', scopes: ['journal:read', 'journal:write'], authSource: 'static' };
const readOnlyAuth: AuthResult = { valid: true, scope: 'journal:read', scopes: ['journal:read'], authSource: 'oauth', clientId: 'c1' };
const writeOnlyAuth: AuthResult = { valid: true, scope: 'journal:write', scopes: ['journal:write'], authSource: 'oauth', clientId: 'c1' };

describe('handleMcp', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should return 501 for GET requests', async () => {
    const request = new Request('https://example.com/mcp', { method: 'GET' });
    const response = await handleMcp(request, env, fullAuth);
    expect(response.status).toBe(501);
  });

  it('should return 405 for non-POST/GET requests', async () => {
    const request = new Request('https://example.com/mcp', { method: 'PUT' });
    const response = await handleMcp(request, env, fullAuth);
    expect(response.status).toBe(405);
  });

  it('should return 400 for invalid JSON', async () => {
    const request = new Request('https://example.com/mcp', {
      method: 'POST',
      body: 'not json',
    });
    const response = await handleMcp(request, env, fullAuth);
    expect(response.status).toBe(400);
  });

  describe('initialize', () => {
    it('should return server info and capabilities', async () => {
      const response = await handleMcp(mcpRequest('initialize'), env, fullAuth);
      const body = await response.json() as any;

      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result.serverInfo.name).toBe('private-journal');
      expect(body.result.capabilities.tools).toBeDefined();
    });
  });

  describe('tools/list', () => {
    it('should return all 5 tools', async () => {
      const response = await handleMcp(mcpRequest('tools/list'), env, fullAuth);
      const body = await response.json() as any;

      const tools = body.result.tools;
      expect(tools).toHaveLength(5);

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain('process_thoughts');
      expect(toolNames).toContain('search_journal');
      expect(toolNames).toContain('read_journal_entry');
      expect(toolNames).toContain('list_recent_entries');
      expect(toolNames).toContain('journal_stats');
    });

    it('should include inputSchema for each tool', async () => {
      const response = await handleMcp(mcpRequest('tools/list'), env, fullAuth);
      const body = await response.json() as any;

      for (const tool of body.result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  describe('tools/call', () => {
    it('should route to search_journal', async () => {
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'search_journal',
          arguments: { query: 'test', mode: 'vector' },
        }),
        env,
        fullAuth
      );
      const body = await response.json() as any;

      expect(body.result.content).toBeDefined();
      expect(body.result.content[0].type).toBe('text');
    });

    it('should route to list_recent_entries', async () => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'list_recent_entries',
          arguments: {},
        }),
        env,
        fullAuth
      );
      const body = await response.json() as any;

      expect(body.result.content[0].type).toBe('text');
      const parsed = JSON.parse(body.result.content[0].text);
      expect(parsed.entries).toBeDefined();
    });

    it('should route to journal_stats', async () => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ count: 0 }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'journal_stats',
          arguments: {},
        }),
        env,
        fullAuth
      );
      const body = await response.json() as any;

      expect(body.result.content[0].type).toBe('text');
    });

    it('should return error for unknown tool', async () => {
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'nonexistent_tool',
          arguments: {},
        }),
        env,
        fullAuth
      );
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32601);
    });

    it('should return error when tool throws', async () => {
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'search_journal',
          arguments: {},
        }),
        env,
        fullAuth
      );
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32603);
    });
  });

  describe('scope enforcement', () => {
    it('should reject process_thoughts without journal:write', async () => {
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'process_thoughts',
          arguments: { feelings: 'test' },
        }),
        env,
        readOnlyAuth
      );
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain('scope');
    });

    it('should allow process_thoughts with journal:write', async () => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({}),
        first: vi.fn().mockResolvedValue(null),
      };
      (env.DB.prepare as any).mockReturnValue(stmt);

      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'process_thoughts',
          arguments: { feelings: 'test' },
        }),
        env,
        fullAuth
      );
      const body = await response.json() as any;

      expect(body.error).toBeUndefined();
      expect(body.result.content).toBeDefined();
    });

    it('should reject search_journal without journal:read', async () => {
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'search_journal',
          arguments: { query: 'test', mode: 'vector' },
        }),
        env,
        writeOnlyAuth
      );
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32600);
    });

    it('should reject read_journal_entry without journal:read', async () => {
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'read_journal_entry',
          arguments: { id: 'test-id' },
        }),
        env,
        writeOnlyAuth
      );
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32600);
    });

    it('should reject list_recent_entries without journal:read', async () => {
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'list_recent_entries',
          arguments: {},
        }),
        env,
        writeOnlyAuth
      );
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32600);
    });

    it('should reject journal_stats without journal:read', async () => {
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'journal_stats',
          arguments: {},
        }),
        env,
        writeOnlyAuth
      );
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32600);
    });
  });

  describe('unknown method', () => {
    it('should return method not found error', async () => {
      const response = await handleMcp(mcpRequest('unknown/method'), env, fullAuth);
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32601);
    });
  });
});
