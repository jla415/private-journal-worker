// ABOUTME: Tests for authentication middleware
// ABOUTME: Covers static token, OAuth token, and rejection cases

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateAuth } from '../auth';
import { createMockEnv } from './mocks';
import { Env } from '../types';

describe('auth', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('should reject request without Authorization header', async () => {
    const request = new Request('https://example.com', {});
    const result = await validateAuth(request, env);
    expect(result.valid).toBe(false);
  });

  it('should reject non-Bearer auth', async () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Basic abc123' },
    });
    const result = await validateAuth(request, env);
    expect(result.valid).toBe(false);
  });

  it('should accept valid static JOURNAL_TOKEN with authSource static', async () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const result = await validateAuth(request, env);
    expect(result.valid).toBe(true);
    expect(result.scope).toBe('journal:read journal:write');
    expect(result.authSource).toBe('static');
  });

  it('should reject invalid static token and fall through to OAuth check', async () => {
    const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    const result = await validateAuth(request, env);
    expect(result.valid).toBe(false);
  });

  it('should accept valid OAuth token from DB', async () => {
    const oauthToken = {
      token: 'oauth-token-123',
      client_id: 'client-1',
      token_type: 'access',
      scope: 'journal:read',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    const stmt = { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(oauthToken) };
    (env.DB.prepare as any).mockReturnValue(stmt);

    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer oauth-token-123' },
    });
    const result = await validateAuth(request, env);

    expect(result.valid).toBe(true);
    expect(result.clientId).toBe('client-1');
    expect(result.scope).toBe('journal:read');
    expect(result.authSource).toBe('oauth');
  });
});
