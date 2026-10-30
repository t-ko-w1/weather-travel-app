require('dotenv').config();
const { createApp } = require('./app');
const { createPool, withTransaction } = require('./db');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const { createGoogleAuth } = require('./auth');

const pool = createPool();
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRETには32文字以上のランダムな値を設定してください。');
}
const sessionCookieName = isProduction ? '__Host-weather.sid' : 'weather.sid';
const PgSessionStore = connectPgSimple(session);
const sessionMiddleware = session({
  name: sessionCookieName,
  secret: sessionSecret,
  store: new PgSessionStore({ pool, schemaName: 'public', tableName: 'user_sessions', createTableIfMissing: false }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});
const googleAuth = createGoogleAuth({
  query: (text, params) => pool.query(text, params),
  transaction: (work) => withTransaction(pool, work),
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI,
});
const app = createApp({
  query: (text, params) => pool.query(text, params),
  sessionMiddleware,
  googleAuth,
  sessionCookieName,
});
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
const port = Number(process.env.PORT || 3000);

const server = app.listen(port, () => {
  console.log(`Weather travel API listening on port ${port}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
