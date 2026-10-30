const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const session = require('express-session');
const { createApp } = require('../src/app');
const { createGoogleAuth, safeEqual } = require('../src/auth');

function cookieFrom(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'session cookie is returned');
  return value.split(';', 1)[0];
}

test('constant-time string helper rejects missing, differing, and unequal-length state', () => {
  assert.equal(safeEqual('state', 'state'), true);
  assert.equal(safeEqual('state', 'other'), false);
  assert.equal(safeEqual('a', 'aa'), false);
  assert.equal(safeEqual(undefined, 'state'), false);
});

test('OIDC code flow validates state, nonce, PKCE and upserts verified Google subject', async () => {
  let authOptions;
  let inserted;
  const oauthClient = {
    async generateCodeVerifierAsync() { return { codeVerifier: 'verifier-value', codeChallenge: 'challenge-value' }; },
    generateAuthUrl(options) {
      authOptions = options;
      return `https://accounts.google.com/mock?state=${encodeURIComponent(options.state)}&nonce=${encodeURIComponent(options.nonce)}&code_challenge=${options.code_challenge}`;
    },
    async getToken(options) {
      assert.equal(options.code, 'auth-code');
      assert.equal(options.codeVerifier, 'verifier-value');
      return { tokens: { id_token: 'signed-id-token' } };
    },
    async verifyIdToken(options) {
      assert.equal(options.idToken, 'signed-id-token');
      assert.equal(options.audience, 'client-id');
      return { getPayload: () => ({
        sub: 'google-stable-sub', email: 'person@example.com', email_verified: true,
        name: '旅人', picture: 'https://example.test/avatar.png', nonce: authOptions.nonce,
      }) };
    },
  };
  const query = async (sql, params) => {
    if (/INSERT INTO public\.users/.test(sql)) {
      inserted = { sql, params };
      return { rows: [{ id: '44', email: params[1], displayName: params[3], avatarUrl: params[4] }] };
    }
    if (/FROM public\.users WHERE id/.test(sql)) {
      assert.deepEqual(params, ['44']);
      return { rows: [{ id: '44', email: 'person@example.com', displayName: '旅人', avatarUrl: null }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const auth = createGoogleAuth({ query, clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost/callback', oauthClient });
  const sessionMiddleware = session({ secret: 'test-session-secret-with-more-than-32-characters', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: false, path: '/' } });
  const server = createServer(createApp({ query, sessionMiddleware, googleAuth: auth }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/auth/google`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(authOptions.scope.join(' '), 'openid email profile');
    assert.equal(authOptions.code_challenge_method, 'S256');
    assert.ok(authOptions.state);
    assert.ok(authOptions.nonce);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/i);
    const oauthCookie = cookieFrom(response);

    response = await fetch(`${base}/auth/google/callback?code=auth-code&state=${encodeURIComponent(authOptions.state)}`, {
      headers: { cookie: oauthCookie }, redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
    assert.match(inserted.sql, /ON CONFLICT \(google_sub\) DO UPDATE/);
    assert.equal(inserted.params[0], 'google-stable-sub');
    assert.equal(inserted.params[2], true);
    const authenticatedCookie = cookieFrom(response);

    response = await fetch(`${base}/api/auth/me`, { headers: { cookie: authenticatedCookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.id, '44');
    assert.ok(body.csrfToken);

    response = await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { cookie: authenticatedCookie, 'x-csrf-token': body.csrfToken },
    });
    assert.equal(response.status, 204);
    response = await fetch(`${base}/api/auth/me`, { headers: { cookie: authenticatedCookie } });
    assert.equal(response.status, 401, 'ログアウト後は旧Cookieを再利用できない');
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('OAuth state不一致ではGoogle IDを登録しない', async () => {
  let upsertCalled = false;
  const oauthClient = {
    async generateCodeVerifierAsync() { return { codeVerifier: 'v', codeChallenge: 'c' }; },
    generateAuthUrl: (options) => { oauthClient.state = options.state; return 'https://accounts.google.com/mock'; },
    async getToken() { throw new Error('must not exchange an invalid state'); },
  };
  const query = async () => { upsertCalled = true; return { rows: [] }; };
  const auth = createGoogleAuth({ query, clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/callback', oauthClient });
  const sessionMiddleware = session({ secret: 'test-session-secret-with-more-than-32-characters', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: false, path: '/' } });
  const server = createServer(createApp({ query, sessionMiddleware, googleAuth: auth }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
    const cookie = cookieFrom(start);
    const callback = await fetch(`${base}/auth/google/callback?code=abc&state=wrong`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/login.html?error=login_failed');
    assert.equal(upsertCalled, false);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
