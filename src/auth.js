const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createGoogleAuth({ query, clientId, clientSecret, redirectUri, oauthClient } = {}) {
  if (typeof query !== 'function') throw new TypeError('query関数が必要です。');
  if (!clientId || !clientSecret || !redirectUri) throw new Error('Google OAuthの環境変数を設定してください。');
  const client = oauthClient || new OAuth2Client({ clientId, clientSecret, redirectUri });

  async function startLogin(req, res) {
    try {
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
      req.session.oauth = {
        state: crypto.randomBytes(32).toString('base64url'),
        nonce: crypto.randomBytes(32).toString('base64url'),
        codeVerifier,
      };
      const url = client.generateAuthUrl({
        response_type: 'code',
        scope: GOOGLE_SCOPES,
        state: req.session.oauth.state,
        nonce: req.session.oauth.nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      res.redirect(url);
    } catch {
      return res.redirect('/login.html?error=login_failed');
    }
  }

  async function callback(req, res) {
    const oauth = req.session?.oauth;
    const stateMatches = safeEqual(req.query.state, oauth?.state);
    delete req.session?.oauth;
    if (!stateMatches || typeof req.query.code !== 'string' || req.query.error) {
      return res.redirect('/login.html?error=login_failed');
    }

    try {
      // Persist state consumption before exchanging the code to prevent callback replay races.
      await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
      const { tokens } = await client.getToken({ code: req.query.code, codeVerifier: oauth.codeVerifier });
      if (!tokens.id_token) return res.redirect('/login.html?error=login_failed');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const profile = ticket.getPayload();
      if (!profile || !safeEqual(profile.nonce, oauth.nonce) || typeof profile.sub !== 'string'
        || !profile.sub || profile.sub.length > 255 || typeof profile.email !== 'string'
        || !profile.email.trim() || profile.email.length > 320 || profile.email_verified !== true) {
        return res.redirect('/login.html?error=login_failed');
      }

      const result = await query(`INSERT INTO public.users
        (google_sub, email, email_verified, display_name, avatar_url)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (google_sub) DO UPDATE SET
          email = EXCLUDED.email,
          email_verified = EXCLUDED.email_verified,
          display_name = EXCLUDED.display_name,
          avatar_url = EXCLUDED.avatar_url,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id, email, display_name AS "displayName", avatar_url AS "avatarUrl"`,
      [profile.sub, profile.email, profile.email_verified,
        typeof profile.name === 'string' ? profile.name.slice(0, 200) || null : null,
        typeof profile.picture === 'string' ? profile.picture : null]);
      const user = result.rows[0];
      if (!user) throw new Error('Googleユーザーを保存できませんでした。');

      await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
      req.session.userId = user.id;
      req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
      await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
      return res.redirect('/');
    } catch {
      return res.redirect('/login.html?error=login_failed');
    }
  }

  return { startLogin, callback };
}

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'ログインしてください。' } });
  }
  return next();
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!safeEqual(req.get('x-csrf-token'), req.session?.csrfToken)) {
    return res.status(403).json({ error: { code: 'CSRF_INVALID', message: 'ページを再読み込みして、もう一度お試しください。' } });
  }
  return next();
}

module.exports = { GOOGLE_SCOPES, createGoogleAuth, requireAuth, requireCsrf, safeEqual };
