// ABOUTME: Tests for OAuth PIN authorization endpoint
// ABOUTME: Covers PIN validation using timing-safe comparison

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAuthorize } from '../oauth';
import { createMockEnv } from './mocks';
import { Env } from '../types';

describe('oauth authorize', () => {
  let env: Env;
  const validParams = 'client_id=client1&redirect_uri=https://example.com/callback&response_type=code&code_challenge=abc&code_challenge_method=S256&scope=journal:read';

  beforeEach(() => {
    env = createMockEnv();

    // Mock client lookup to return a valid client
    const clientStmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({
        client_id: 'client1',
        client_secret: 'secret',
        redirect_uris: '["https://example.com/callback"]',
      }),
    };
    // Mock code insertion
    const codeStmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({}),
    };
    let callCount = 0;
    (env.DB.prepare as any).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return clientStmt;
      return codeStmt;
    });
  });

  it('should accept correct PIN', async () => {
    const formData = new FormData();
    formData.append('pin', 'test-pin');

    const request = new Request(`https://example.com/authorize?${validParams}`, {
      method: 'POST',
      body: formData,
    });
    const response = await handleAuthorize(request, env);
    expect(response.status).toBe(302);
  });

  it('should reject wrong PIN with 403', async () => {
    const formData = new FormData();
    formData.append('pin', 'wrong-pin');

    const request = new Request(`https://example.com/authorize?${validParams}`, {
      method: 'POST',
      body: formData,
    });
    const response = await handleAuthorize(request, env);
    expect(response.status).toBe(403);
  });

  it('should reject non-string PIN values', async () => {
    const formData = new FormData();
    // FormData without pin field
    const request = new Request(`https://example.com/authorize?${validParams}`, {
      method: 'POST',
      body: formData,
    });
    const response = await handleAuthorize(request, env);
    expect(response.status).toBe(403);
  });
});
