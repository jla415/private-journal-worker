// ABOUTME: OAuth 2.1 endpoints for Claude.ai web integration
// ABOUTME: Implements metadata, DCR, authorize, and token endpoints

import { Env, OAuthClientRow, OAuthCodeRow } from './types';

// Generate cryptographically secure random string
function generateToken(length: number = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256 hash for PKCE verification
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// JSON error response helper (OAuth 2.1 RFC format)
function jsonError(error: string, description: string, status: number): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

export function handleOAuthMetadata(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  const metadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    scopes_supported: ['journal:read', 'journal:write'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  };

  return new Response(JSON.stringify(metadata), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonError('method_not_allowed', 'Method Not Allowed', 405);
  }

  let body: { redirect_uris?: string[] };
  try {
    body = await request.json() as { redirect_uris?: string[] };
  } catch {
    return jsonError('invalid_request', 'Invalid JSON body', 400);
  }

  const redirectUris = body.redirect_uris || [];

  const clientId = generateToken(16);
  const clientSecret = generateToken(32);

  try {
    await env.DB.prepare(
      'INSERT INTO oauth_clients (client_id, client_secret, redirect_uris) VALUES (?, ?, ?)'
    )
      .bind(clientId, clientSecret, JSON.stringify(redirectUris))
      .run();
  } catch (err) {
    return jsonError('server_error', 'Failed to register client', 500);
  }

  return new Response(
    JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
    }),
    {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const responseType = url.searchParams.get('response_type');
  const scope = url.searchParams.get('scope') || 'journal:read journal:write';
  const state = url.searchParams.get('state');
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method');

  // Validate required params
  if (!clientId || !redirectUri || responseType !== 'code') {
    return jsonError('invalid_request', 'Missing required parameters: client_id, redirect_uri, response_type=code', 400);
  }

  // PKCE is required for OAuth 2.1
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return jsonError('invalid_request', 'PKCE with S256 is required', 400);
  }

  // Verify client exists
  let client: OAuthClientRow | null;
  try {
    client = await env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
      .bind(clientId)
      .first<OAuthClientRow>();
  } catch {
    return jsonError('server_error', 'Database error', 500);
  }

  if (!client) {
    return jsonError('invalid_client', 'Unknown client', 400);
  }

  // Verify redirect URI
  const allowedUris: string[] = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(redirectUri)) {
    return jsonError('invalid_request', 'Invalid redirect_uri', 400);
  }

  // Single-user: auto-approve (no login UI needed)
  // Generate authorization code
  const code = generateToken(32);
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutes

  try {
    await env.DB.prepare(
      'INSERT INTO oauth_codes (code, client_id, code_challenge, redirect_uri, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(code, clientId, codeChallenge, redirectUri, scope, expiresAt)
      .run();
  } catch {
    return jsonError('server_error', 'Failed to generate authorization code', 500);
  }

  // Redirect back with code
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (state) {
    redirectUrl.searchParams.set('state', state);
  }

  return Response.redirect(redirectUrl.toString(), 302);
}

export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonError('invalid_request', 'Method Not Allowed', 405);
  }

  const contentType = request.headers.get('Content-Type') || '';
  let body: Record<string, string>;

  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData();
      body = Object.fromEntries(formData.entries()) as Record<string, string>;
    } else {
      body = await request.json() as Record<string, string>;
    }
  } catch {
    return jsonError('invalid_request', 'Invalid request body', 400);
  }

  const grantType = body['grant_type'];
  const clientId = body['client_id'];
  const clientSecret = body['client_secret'];

  // Verify client credentials
  let client: OAuthClientRow | null;
  try {
    client = await env.DB.prepare(
      'SELECT * FROM oauth_clients WHERE client_id = ? AND client_secret = ?'
    )
      .bind(clientId, clientSecret)
      .first<OAuthClientRow>();
  } catch {
    return jsonError('server_error', 'Database error', 500);
  }

  if (!client) {
    return jsonError('invalid_client', 'Invalid client credentials', 401);
  }

  if (grantType === 'authorization_code') {
    const code = body['code'];
    const codeVerifier = body['code_verifier'];
    const redirectUri = body['redirect_uri'];

    // Look up authorization code
    const now = Math.floor(Date.now() / 1000);
    let authCode: OAuthCodeRow | null;
    try {
      authCode = await env.DB.prepare(
        'SELECT * FROM oauth_codes WHERE code = ? AND client_id = ? AND expires_at > ?'
      )
        .bind(code, clientId, now)
        .first<OAuthCodeRow>();
    } catch {
      return jsonError('server_error', 'Database error', 500);
    }

    if (!authCode) {
      return jsonError('invalid_grant', 'Invalid or expired authorization code', 400);
    }

    // Verify redirect URI matches
    if (authCode.redirect_uri !== redirectUri) {
      return jsonError('invalid_grant', 'Redirect URI mismatch', 400);
    }

    // Verify PKCE code_verifier
    const expectedChallenge = await sha256(codeVerifier);
    if (expectedChallenge !== authCode.code_challenge) {
      return jsonError('invalid_grant', 'Invalid code verifier', 400);
    }

    // Delete used code and generate tokens
    const accessToken = generateToken(32);
    const refreshToken = generateToken(32);
    const accessExpiresAt = now + 3600; // 1 hour
    const refreshExpiresAt = now + 2592000; // 30 days

    try {
      await env.DB.prepare('DELETE FROM oauth_codes WHERE code = ?').bind(code).run();
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO oauth_tokens (token, client_id, token_type, scope, expires_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(accessToken, clientId, 'access', authCode.scope, accessExpiresAt),
        env.DB.prepare(
          'INSERT INTO oauth_tokens (token, client_id, token_type, scope, expires_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(refreshToken, clientId, 'refresh', authCode.scope, refreshExpiresAt),
      ]);
    } catch {
      return jsonError('server_error', 'Failed to generate tokens', 500);
    }

    return new Response(
      JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: authCode.scope,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (grantType === 'refresh_token') {
    const refreshToken = body['refresh_token'];

    // Look up refresh token
    const now = Math.floor(Date.now() / 1000);
    let token: { scope: string } | null;
    try {
      token = await env.DB.prepare(
        "SELECT * FROM oauth_tokens WHERE token = ? AND client_id = ? AND token_type = 'refresh' AND expires_at > ?"
      )
        .bind(refreshToken, clientId, now)
        .first<{ scope: string }>();
    } catch {
      return jsonError('server_error', 'Database error', 500);
    }

    if (!token) {
      return jsonError('invalid_grant', 'Invalid or expired refresh token', 400);
    }

    // Generate new access token
    const accessToken = generateToken(32);
    const accessExpiresAt = now + 3600;

    try {
      await env.DB.prepare(
        'INSERT INTO oauth_tokens (token, client_id, token_type, scope, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(accessToken, clientId, 'access', token.scope, accessExpiresAt);
    } catch {
      return jsonError('server_error', 'Failed to generate token', 500);
    }

    return new Response(
      JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: token.scope,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return jsonError('unsupported_grant_type', 'Unsupported grant type', 400);
}
