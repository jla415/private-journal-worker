// ABOUTME: MCP server setup using Cloudflare's agents SDK
// ABOUTME: Registers journal tools and handles MCP protocol

import { Env } from './types';
import { handleProcessThoughts } from './tools/process-thoughts';
import { handleSearch } from './tools/search';
import { handleReadEntry } from './tools/read-entry';
import { handleListRecent } from './tools/list-recent';
import { handleStats } from './tools/stats';

// MCP JSON-RPC types
interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS = {
  process_thoughts: {
    name: 'process_thoughts',
    description:
      'Your PRIVATE JOURNAL for learning and reflection. Write to any combination of these completely private spaces. Nobody but you will ever see this.',
    inputSchema: {
      type: 'object',
      properties: {
        feelings: {
          type: 'string',
          description: 'YOUR PRIVATE SPACE to be completely honest about what you are feeling and thinking.',
        },
        project_notes: {
          type: 'string',
          description: 'Your PRIVATE TECHNICAL LABORATORY for capturing insights about the current project.',
        },
        user_context: {
          type: 'string',
          description: 'Your PRIVATE FIELD NOTES about working with your human collaborator.',
        },
        technical_insights: {
          type: 'string',
          description: 'Your PRIVATE SOFTWARE ENGINEERING NOTEBOOK for capturing broader learnings.',
        },
        world_knowledge: {
          type: 'string',
          description: 'Your PRIVATE LEARNING JOURNAL for everything else interesting or useful.',
        },
        project: {
          type: 'string',
          description: 'Project name (typically basename of working directory)',
        },
      },
      required: [],
    },
  },
  search_journal: {
    name: 'search_journal',
    description: 'Search through your private journal entries and chat history using natural language queries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, maxItems: 3 },
          ],
          description: 'Natural language search query, or array of 2-3 concepts for AND search',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by section types (journal entries only)',
        },
        project: {
          type: 'string',
          description: 'Filter by project name',
        },
        after: {
          type: 'string',
          description: 'Only return entries after this date (ISO format, e.g. 2025-01-01)',
        },
        before: {
          type: 'string',
          description: 'Only return entries before this date (ISO format, e.g. 2025-06-01)',
        },
        mode: {
          type: 'string',
          enum: ['vector', 'text', 'hybrid'],
          description: 'Search mode: vector (semantic), text (keyword), or hybrid (default)',
        },
        source: {
          type: 'string',
          enum: ['journal', 'chat', 'all'],
          description: 'Filter by source: journal entries, chat exchanges, or all (default)',
        },
      },
      required: ['query'],
    },
  },
  read_journal_entry: {
    name: 'read_journal_entry',
    description: 'Read the full content of a specific journal entry or chat exchange by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Entry or exchange ID (from search results)',
        },
        path: {
          type: 'string',
          description: 'Deprecated: use id instead',
        },
      },
      required: [],
    },
  },
  list_recent_entries: {
    name: 'list_recent_entries',
    description: 'Get recent journal entries and chat exchanges in chronological order.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of entries to return (default: 10)',
        },
        days: {
          type: 'number',
          description: 'Number of days back to search (default: 30)',
        },
        project: {
          type: 'string',
          description: 'Filter by project name',
        },
        source: {
          type: 'string',
          enum: ['journal', 'chat', 'all'],
          description: 'Filter by source: journal entries, chat exchanges, or all (default)',
        },
      },
      required: ['id'],
    },
  },
  journal_stats: {
    name: 'journal_stats',
    description: 'Get statistics about journal entries and chat exchanges.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    return jsonError('Streaming not implemented', 501);
  }

  if (request.method !== 'POST') {
    return jsonError('Method Not Allowed', 405);
  }

  let body: McpRequest;
  try {
    body = (await request.json()) as McpRequest;
  } catch {
    return jsonError('Invalid JSON request body', 400);
  }

  const response: McpResponse = {
    jsonrpc: '2.0',
    id: body.id,
  };

  switch (body.method) {
    case 'initialize': {
      response.result = {
        protocolVersion: '2025-06-18',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'private-journal',
          version: '1.0.0',
        },
      };
      break;
    }

    case 'tools/list': {
      response.result = {
        tools: Object.values(TOOLS),
      };
      break;
    }

    case 'tools/call': {
      const params = body.params as { name: string; arguments: Record<string, unknown> };
      const toolName = params.name;
      const args = params.arguments;

      try {
        let result: unknown;

        switch (toolName) {
          case 'process_thoughts':
            result = await handleProcessThoughts(args, env);
            break;
          case 'search_journal':
            result = await handleSearch(args, env);
            break;
          case 'read_journal_entry':
            result = await handleReadEntry(args, env);
            break;
          case 'list_recent_entries':
            result = await handleListRecent(args, env);
            break;
          case 'journal_stats':
            result = await handleStats(args, env);
            break;
          default:
            response.error = { code: -32601, message: `Unknown tool: ${toolName}` };
            return jsonResponse(response);
        }

        response.result = {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        response.error = { code: -32603, message };
      }
      break;
    }

    default: {
      response.error = { code: -32601, message: `Unknown method: ${body.method}` };
    }
  }

  return jsonResponse(response);
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}
