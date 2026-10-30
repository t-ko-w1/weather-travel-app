const express = require('express');
const path = require('node:path');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { getWeather } = require('./weather');
const { requireAuth, requireCsrf } = require('./auth');
const { isFutureInTokyo, syncReminderJob, cancelReminderJob } = require('./reminder-scheduling');

const FIELDS = ['outingDate', 'city', 'destination', 'activity', 'notes', 'weather', 'reminderEnabled'];
const REQUIRED_FIELDS = ['outingDate', 'city', 'destination', 'activity', 'notes', 'weather'];
const MAX_LENGTHS = { city: 100, destination: 200, activity: 5000, notes: 5000, weather: 50 };
const SELECT_COLUMNS = `
  id,
  outing_date::text AS "outingDate",
  city,
  destination,
  activity,
  notes,
  weather,
  reminder_enabled AS "reminderEnabled",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function normalizeTrip(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['JSONオブジェクトを送信してください。'] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(body, field)) errors.push(`${field}は必須です。`);
  }
  for (const key of Object.keys(body)) {
    if (!FIELDS.includes(key)) errors.push(`${key}は指定できません。`);
  }
  if (Object.hasOwn(body, 'outingDate') && !validDate(body.outingDate)) {
    errors.push('outingDateは有効なYYYY-MM-DD形式で指定してください。');
  }

  const values = {};
  const reminderEnabledProvided = Object.hasOwn(body, 'reminderEnabled');
  if (reminderEnabledProvided && typeof body.reminderEnabled !== 'boolean') {
    errors.push('reminderEnabledはtrueまたはfalseで指定してください。');
  }
  values.reminderEnabled = reminderEnabledProvided ? body.reminderEnabled : false;
  for (const field of ['city', 'destination']) {
    if (typeof body[field] !== 'string' || body[field].trim() === '') {
      errors.push(`${field}は空白以外の文字を含む文字列で指定してください。`);
    } else {
      values[field] = body[field].trim();
    }
  }
  for (const field of ['activity', 'notes', 'weather']) {
    const value = body[field];
    if (value === null || value === '') {
      values[field] = null;
    } else if (typeof value !== 'string') {
      errors.push(`${field}は文字列またはnullで指定してください。`);
    } else {
      values[field] = value.trim() || null;
    }
  }
  for (const [field, max] of Object.entries(MAX_LENGTHS)) {
    if (typeof values[field] === 'string' && [...values[field]].length > max) {
      errors.push(`${field}は${max}文字以内で指定してください。`);
    }
  }

  if (validDate(body.outingDate)) values.outingDate = body.outingDate;
  return { values, errors, reminderEnabledProvided };
}

function validId(value) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function parsePositiveInteger(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function createApp({ query, transaction, now = () => new Date(), weather = getWeather, sessionMiddleware, googleAuth, sessionCookieName = 'weather.sid' }) {
  if (typeof query !== 'function') throw new TypeError('query関数が必要です。');
  const runTransaction = transaction || (async (work) => work(query));
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"],
      formAction: ["'self'"], frameAncestors: ["'none'"],
    } },
    strictTransportSecurity: process.env.NODE_ENV === 'production' ? undefined : false,
  }));
  app.use(express.json({ limit: '32kb' }));
  if (sessionMiddleware) app.use(sessionMiddleware);
  // Serve the browser UI from the same origin so it can call /api without CORS setup.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const locationSearchLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
  app.get('/auth/google', authLimiter, (req, res, next) => {
    if (!googleAuth) return res.status(503).send('Googleログインの設定がありません。');
    return googleAuth.startLogin(req, res, next);
  });
  app.get('/auth/google/callback', authLimiter, (req, res, next) => {
    if (!googleAuth) return res.redirect('/login.html?error=login_failed');
    return googleAuth.callback(req, res, next);
  });

  app.get('/api/auth/me', requireAuth, async (req, res, next) => {
    try {
      const result = await query(`SELECT id, email, display_name AS "displayName", avatar_url AS "avatarUrl"
        FROM public.users WHERE id = $1`, [req.session.userId]);
      if (!result.rows[0]) {
        return req.session.destroy(() => res.status(401).json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'ログインしてください。' } }));
      }
      res.set('Cache-Control', 'no-store');
      return res.json({ user: result.rows[0], csrfToken: req.session.csrfToken });
    } catch (error) { return next(error); }
  });

  app.post('/api/auth/logout', requireAuth, requireCsrf, (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie(sessionCookieName, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
      return res.status(204).end();
    });
  });

  app.get('/api/weather', requireAuth, async (req, res, next) => {
    try {
      if (!validDate(req.query.date)) {
        return res.status(400).json({ error: { code: 'INVALID_DATE', message: '日付は有効なYYYY-MM-DD形式で指定してください。' } });
      }
      let location = null;
      if (['latitude', 'longitude', 'timezone', 'locationName'].some((key) => Object.hasOwn(req.query, key))) {
        const latitude = Number(req.query.latitude);
        const longitude = Number(req.query.longitude);
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
          || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
          || typeof req.query.timezone !== 'string' || req.query.timezone.length > 100
          || typeof req.query.locationName !== 'string' || req.query.locationName.length < 1 || req.query.locationName.length > 100
          || (req.query.region && req.query.region.length > 100) || (req.query.country && req.query.country.length > 100)) {
          return res.status(400).json({ error: { code: 'INVALID_LOCATION', message: '選択した都市の位置情報が正しくありません。候補を選び直してください。' } });
        }
        location = {
          latitude, longitude, timezone: req.query.timezone,
          name: req.query.locationName, region: req.query.region || null, country: req.query.country || null,
        };
      }
      const result = await weather(req.query.city, req.query.date, location);
      res.json(result);
    } catch (error) { next(error); }
  });

  app.get('/api/weather/locations', requireAuth, locationSearchLimiter, async (req, res, next) => {
    try {
      const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if ([...term].length < 2 || [...term].length > 100) {
        return res.status(400).json({ error: { code: 'INVALID_QUERY', message: '都市名は2文字以上100文字以内で入力してください。' } });
      }
      if (typeof weather.searchLocations !== 'function') {
        return res.status(503).json({ error: { code: 'LOCATION_SEARCH_UNAVAILABLE', message: '都市候補検索を利用できません。' } });
      }
      const results = await weather.searchLocations(term);
      res.set('Cache-Control', 'no-store');
      res.json({ results });
    } catch (error) { next(error); }
  });

  app.use('/api/trips', requireAuth, requireCsrf);

  app.get('/api/trips', async (req, res, next) => {
    try {
      const paginationRequested = req.query.page !== undefined || req.query.limit !== undefined;
      if (!paginationRequested) {
        const result = await query(`SELECT ${SELECT_COLUMNS}
          FROM public.outing_records WHERE user_id = $1 ORDER BY outing_date DESC, id DESC`, [req.session.userId]);
        return res.json(result.rows);
      }

      const page = req.query.page === undefined ? 1 : parsePositiveInteger(req.query.page);
      const limit = req.query.limit === undefined ? 10 : parsePositiveInteger(req.query.limit);
      if (page === null || limit === null || ![5, 10, 20].includes(limit)) {
        return res.status(400).json({ error: { code: 'INVALID_PAGINATION', message: 'pageは正の整数、limitは5・10・20のいずれかで指定してください。' } });
      }
      if (page > 1_000_000 || !Number.isSafeInteger((page - 1) * limit)) {
        return res.status(400).json({ error: { code: 'INVALID_PAGINATION', message: '指定したページ番号が大きすぎます。' } });
      }
      const countResult = await query(`SELECT COUNT(*) AS total
        FROM public.outing_records WHERE user_id = $1`, [req.session.userId]);
      const total = Number(countResult.rows[0]?.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const currentPage = Math.min(page, totalPages);
      const result = await query(`SELECT ${SELECT_COLUMNS}
        FROM public.outing_records WHERE user_id = $1 ORDER BY outing_date DESC, id DESC LIMIT $2 OFFSET $3`,
      [req.session.userId, limit, (currentPage - 1) * limit]);
      return res.json({ data: result.rows, pagination: { page: currentPage, limit, total, totalPages } });
    } catch (error) { next(error); }
  });

  app.get('/api/trips/:id', async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'IDは正の整数で指定してください。' } });
    try {
      const result = await query(`SELECT ${SELECT_COLUMNS}
        FROM public.outing_records WHERE id = $1 AND user_id = $2`, [req.params.id, req.session.userId]);
      if (!result.rows[0]) return notFound(res);
      res.json(result.rows[0]);
    } catch (error) { next(error); }
  });

  app.post('/api/trips', async (req, res, next) => {
    const { values, errors } = normalizeTrip(req.body);
    if (values.reminderEnabled && values.outingDate && !isFutureInTokyo(values.outingDate, now())) {
      errors.push('メール通知を設定できるのは未来の日付です。');
    }
    if (errors.length) return validationError(res, errors);
    try {
      const trip = await runTransaction(async (transactionQuery) => {
        const result = await transactionQuery(`INSERT INTO public.outing_records
          (outing_date, city, destination, activity, notes, weather, reminder_enabled, user_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${SELECT_COLUMNS}`,
        [values.outingDate, values.city, values.destination, values.activity, values.notes, values.weather, values.reminderEnabled, req.session.userId]);
        if (values.reminderEnabled) {
          await syncReminderJob(transactionQuery, { trip: result.rows[0], userId: req.session.userId, enabled: true, now: now() });
        }
        return result.rows[0];
      });
      res.status(201).json(trip);
    } catch (error) { next(error); }
  });

  app.put('/api/trips/:id', async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'IDは正の整数で指定してください。' } });
    const { values, errors, reminderEnabledProvided } = normalizeTrip(req.body);
    if (errors.length) return validationError(res, errors);
    try {
      const outcome = await runTransaction(async (transactionQuery) => {
        const existingResult = await transactionQuery(`SELECT id, outing_date::text AS "outingDate", destination,
          reminder_enabled AS "reminderEnabled" FROM public.outing_records
          WHERE id = $1 AND user_id = $2 FOR UPDATE`, [req.params.id, req.session.userId]);
        const existing = existingResult.rows[0];
        if (!existing) return { missing: true };
        const reminderEnabled = reminderEnabledProvided ? values.reminderEnabled : existing.reminderEnabled;
        if (reminderEnabled && !isFutureInTokyo(values.outingDate, now())) {
          return { errors: ['メール通知を設定できるのは未来の日付です。'] };
        }
        const updated = await transactionQuery(`UPDATE public.outing_records SET
          outing_date = $1, city = $2, destination = $3, activity = $4,
          notes = $5, weather = $6, reminder_enabled = $7, updated_at = CURRENT_TIMESTAMP
          WHERE id = $8 AND user_id = $9 RETURNING ${SELECT_COLUMNS}`,
        [values.outingDate, values.city, values.destination, values.activity, values.notes, values.weather, reminderEnabled, req.params.id, req.session.userId]);
        await syncReminderJob(transactionQuery, { trip: updated.rows[0], userId: req.session.userId, enabled: reminderEnabled, now: now() });
        return { trip: updated.rows[0] };
      });
      if (outcome.missing) return notFound(res);
      if (outcome.errors) return validationError(res, outcome.errors);
      res.json(outcome.trip);
    } catch (error) { next(error); }
  });

  app.delete('/api/trips/:id', async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'IDは正の整数で指定してください。' } });
    try {
      const deleted = await runTransaction(async (transactionQuery) => {
        const existing = await transactionQuery('SELECT id FROM public.outing_records WHERE id = $1 AND user_id = $2 FOR UPDATE', [req.params.id, req.session.userId]);
        if (!existing.rows[0]) return false;
        await cancelReminderJob(transactionQuery, { tripId: req.params.id, userId: req.session.userId });
        const result = await transactionQuery('DELETE FROM public.outing_records WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.session.userId]);
        return Boolean(result.rows[0]);
      });
      if (!deleted) return notFound(res);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'APIが見つかりません。' } }));
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'JSON形式を確認してください。' } });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'リクエストが大きすぎます。' } });
    }
    if (error.status && error.code) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    // Detailed errors are logged server-side only; never return database internals.
    console.error('API request failed:', error.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました。' } });
  });
  return app;
}

function validationError(res, details) {
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '入力内容を確認してください。', details } });
}

function notFound(res) {
  return res.status(404).json({ error: { code: 'NOT_FOUND', message: '記録が見つかりません。' } });
}

module.exports = { createApp };
