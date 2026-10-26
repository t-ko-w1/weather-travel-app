const express = require('express');

const FIELDS = ['outingDate', 'city', 'destination', 'activity', 'notes', 'weather'];
const MAX_LENGTHS = { city: 100, destination: 200, activity: 5000, notes: 5000, weather: 50 };
const SELECT_COLUMNS = `
  id,
  outing_date AS "outingDate",
  city,
  destination,
  activity,
  notes,
  weather,
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

  for (const field of FIELDS) {
    if (!Object.hasOwn(body, field)) errors.push(`${field}は必須です。`);
  }
  for (const key of Object.keys(body)) {
    if (!FIELDS.includes(key)) errors.push(`${key}は指定できません。`);
  }
  if (Object.hasOwn(body, 'outingDate') && !validDate(body.outingDate)) {
    errors.push('outingDateは有効なYYYY-MM-DD形式で指定してください。');
  }

  const values = {};
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
  return { values, errors };
}

function validId(value) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function createApp({ query }) {
  if (typeof query !== 'function') throw new TypeError('query関数が必要です。');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/trips', async (_req, res, next) => {
    try {
      const result = await query(`SELECT ${SELECT_COLUMNS}
        FROM public.outing_records ORDER BY outing_date DESC, id DESC`);
      res.json(result.rows);
    } catch (error) { next(error); }
  });

  app.get('/api/trips/:id', async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'IDは正の整数で指定してください。' } });
    try {
      const result = await query(`SELECT ${SELECT_COLUMNS}
        FROM public.outing_records WHERE id = $1`, [req.params.id]);
      if (!result.rows[0]) return notFound(res);
      res.json(result.rows[0]);
    } catch (error) { next(error); }
  });

  app.post('/api/trips', async (req, res, next) => {
    const { values, errors } = normalizeTrip(req.body);
    if (errors.length) return validationError(res, errors);
    try {
      const result = await query(`INSERT INTO public.outing_records
        (outing_date, city, destination, activity, notes, weather)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SELECT_COLUMNS}`,
      [values.outingDate, values.city, values.destination, values.activity, values.notes, values.weather]);
      res.status(201).json(result.rows[0]);
    } catch (error) { next(error); }
  });

  app.put('/api/trips/:id', async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'IDは正の整数で指定してください。' } });
    const { values, errors } = normalizeTrip(req.body);
    if (errors.length) return validationError(res, errors);
    try {
      const result = await query(`UPDATE public.outing_records SET
        outing_date = $1, city = $2, destination = $3, activity = $4,
        notes = $5, weather = $6, updated_at = CURRENT_TIMESTAMP
        WHERE id = $7 RETURNING ${SELECT_COLUMNS}`,
      [values.outingDate, values.city, values.destination, values.activity, values.notes, values.weather, req.params.id]);
      if (!result.rows[0]) return notFound(res);
      res.json(result.rows[0]);
    } catch (error) { next(error); }
  });

  app.delete('/api/trips/:id', async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'IDは正の整数で指定してください。' } });
    try {
      const result = await query('DELETE FROM public.outing_records WHERE id = $1 RETURNING id', [req.params.id]);
      if (!result.rows[0]) return notFound(res);
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
