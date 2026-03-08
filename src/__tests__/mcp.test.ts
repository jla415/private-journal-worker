// ABOUTME: Tests for MCP JSON-RPC handler
// ABOUTME: Covers initialize, tools/list, tools/call routing, and error cases

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMcp } from '../mcp';
import { createMockEnv } from './mocks';
import { Env } from '../types';

function mcpRequest(method: string, params?: Record<string, unknown>, id: number = 1) {
  return new Request('https://example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

describe('handleMcp', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should return 501 for GET requests', async () => {
    const request = new Request('https://example.com/mcp', { method: 'GET' });
    const response = await handleMcp(request, env);
    expect(response.status).toBe(501);
  });

  it('should return 405 for non-POST/GET requests', async () => {
    const request = new Request('https://example.com/mcp', { method: 'PUT' });
    const response = await handleMcp(request, env);
    expect(response.status).toBe(405);
  });

  it('should return 400 for invalid JSON', async () => {
    const request = new Request('https://example.com/mcp', {
      method: 'POST',
      body: 'not json',
    });
    const response = await handleMcp(request, env);
    expect(response.status).toBe(400);
  });

  describe('initialize', () => {
    it('should return server info and capabilities', async () => {
      const response = await handleMcp(mcpRequest('initialize'), env);
      const body = await response.json() as any;

      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result.serverInfo.name).toBe('private-journal');
      expect(body.result.capabilities.tools).toBeDefined();
    });
  });

  describe('tools/list', () => {
    it('should return all 4 tools', async () => {
      const response = await handleMcp(mcpRequest('tools/list'), env);
      const body = await response.json() as any;

      const tools = body.result.tools;
      expect(tools).toHaveLength(4);

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toContain('process_thoughts');
      expect(toolNames).toContain('search_journal');
      expect(toolNames).toContain('read_journal_entry');
      expect(toolNames).toContain('list_recent_entries');
    });

    it('should include inputSchema for each tool', async () => {
      const response = await handleMcp(mcpRequest('tools/list'), env);
      const body = await response.json() as any;

      for (const tool of body.result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  describe('tools/call', () => {
    it('should route to search_journal', async () => {
      // Mock vectorize to return empty results
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'search_journal',
          arguments: { query: 'test' },
        }),
        env
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
        env
      );
      const body = await response.json() as any;

      expect(body.result.content[0].type).toBe('text');
      const parsed = JSON.parse(body.result.content[0].text);
      expect(parsed.entries).toBeDefined();
    });

    it('should return error for unknown tool', async () => {
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'nonexistent_tool',
          arguments: {},
        }),
        env
      );
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32601);
    });

    it('should return error when tool throws', async () => {
      // search_journal throws when query is missing
      const response = await handleMcp(
        mcpRequest('tools/call', {
          name: 'search_journal',
          arguments: {},
        }),
        env
      );
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32603);
    });
  });

  describe('unknown method', () => {
    it('should return method not found error', async () => {
      const response = await handleMcp(mcpRequest('unknown/method'), env);
      const body = await response.json() as any;

      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32601);
    });
  });
});
