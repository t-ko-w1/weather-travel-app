const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createApp } = require('../src/app');

const sample = {
  id: '101', outingDate: '2026-04-12', city: '京都市', destination: '嵐山',
  activity: null, notes: null, weather: '晴れ',
  createdAt: '2026-04-12T00:00:00.000Z', updatedAt: '2026-04-12T00:00:00.000Z',
};
const validBody = {
  outingDate: '2026-04-12', city: ' 京都市 ', destination: '嵐山',
  activity: '', notes: null, weather: '晴れ',
};

async function withApi(query, run, appOptions = {}) {
  const sessionMiddleware = (req, _res, next) => {
    req.session = { userId: '7', csrfToken: 'test-csrf-token' };
    next();
  };
  const server = createServer(createApp({ query, sessionMiddleware, ...appOptions }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('GET /api/trips returns an ordered list', async () => {
  let statement;
  await withApi(async (sql, params) => {
    statement = { sql, params };
    return { rows: [sample] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [sample]);
  });
  assert.match(statement.sql, /ORDER BY outing_date DESC, id DESC/);
  assert.match(statement.sql, /outing_date::text AS "outingDate"/);
  assert.match(statement.sql, /WHERE user_id = \$1/);
  assert.deepEqual(statement.params, ['7']);
});

test('GET /api/trips uses owner-scoped LIMIT/OFFSET and returns pagination metadata', async () => {
  const statements = [];
  await withApi(async (sql, params) => {
    statements.push({ sql, params });
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: '23' }] };
    return { rows: [sample] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips?page=2&limit=5`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: [sample], pagination: { page: 2, limit: 5, total: 23, totalPages: 5 },
    });
  });
  assert.match(statements[0].sql, /COUNT\(\*\).*WHERE user_id = \$1/s);
  assert.deepEqual(statements[0].params, ['7']);
  assert.match(statements[1].sql, /WHERE user_id = \$1 ORDER BY outing_date DESC, id DESC LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(statements[1].params, ['7', 5, 5]);
});

test('GET /api/trips validates pagination values and clamps a stale last page', async () => {
  let called = false;
  await withApi(async () => { called = true; return { rows: [] }; }, async (base) => {
    for (const queryString of ['?page=0', '?page=abc', '?limit=7', '?page=9007199254740991&limit=20']) {
      const invalid = await fetch(`${base}/api/trips${queryString}`);
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, 'INVALID_PAGINATION');
    }
  });
  assert.equal(called, false, '不正な値ではDB queryを行わない');

  const params = [];
  await withApi(async (sql, values) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: '21' }] };
    params.push(values);
    return { rows: [sample] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips?page=9&limit=10`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).pagination, { page: 3, limit: 10, total: 21, totalPages: 3 });
  });
  assert.deepEqual(params[0], ['7', 10, 20]);
});

test('GET /api/weather/locations validates the query and returns backend candidates', async () => {
  const weather = async () => ({});
  weather.searchLocations = async (term) => {
    assert.equal(term, 'Tokyo');
    return [{ id: 1, name: '東京', region: '東京都', country: '日本', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' }];
  };
  const server = createServer(createApp({ query: async () => ({ rows: [] }), sessionMiddleware: (req, _res, next) => {
    req.session = { userId: '7', csrfToken: 'test-csrf-token' }; next();
  }, weather }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/weather/locations?q=Tokyo`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await response.json()).results[0], {
      id: 1, name: '東京', region: '東京都', country: '日本', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo',
    });
    const invalid = await fetch(`${base}/api/weather/locations?q=a`);
    assert.equal(invalid.status, 400);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('GET /api/weather accepts selected coordinates while preserving the legacy city query', async () => {
  const calls = [];
  const weather = async (...args) => { calls.push(args); return { weather: '晴れ' }; };
  await withApi(async () => ({ rows: [] }), async (base) => {
    const url = new URL('/api/weather', base);
    url.search = new URLSearchParams({
      city: '東京', date: '2026-10-28', latitude: '35.68', longitude: '139.69', timezone: 'Asia/Tokyo',
      locationName: '東京', region: '東京都', country: '日本',
    });
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).weather, '晴れ');
    const legacy = await fetch(`${base}/api/weather?city=%E6%9D%B1%E4%BA%AC&date=2026-10-28`);
    assert.equal(legacy.status, 200);
  }, { weather });
  assert.deepEqual(calls[0][2], {
    latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo', name: '東京', region: '東京都', country: '日本',
  });
  assert.equal(calls[1][2], null);
});

test('GET /api/trips/:id uses a parameterized query and returns 404 when absent', async () => {
  await withApi(async (sql, params) => {
    assert.match(sql, /WHERE id = \$1 AND user_id = \$2/);
    assert.deepEqual(params, ['999', '7']);
    return { rows: [] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips/999`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  });
});

test('POST /api/trips normalizes optional fields and returns 201', async () => {
  await withApi(async (_sql, params) => {
    assert.deepEqual(params, ['2026-04-12', '京都市', '嵐山', null, null, '晴れ', false, '7']);
    return { rows: [sample] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' }, body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).id, '101');
  });
});

test('POST validates required fields and actual calendar dates without querying the database', async () => {
  let called = false;
  await withApi(async () => { called = true; return { rows: [] }; }, async (base) => {
    const response = await fetch(`${base}/api/trips`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
      body: JSON.stringify({ ...validBody, outingDate: '2026-02-30', city: '  ' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(body.error.details.length >= 2);
  });
  assert.equal(called, false);
});

test('POST accepts only explicit future reminders and records missed schedules without sending them', async () => {
  const scheduled = [];
  const fixedNow = () => new Date('2026-04-01T03:00:00.000Z');
  await withApi(async (sql, params) => {
    if (/INSERT INTO public\.outing_records/.test(sql)) return { rows: [{ ...sample, outingDate: params[0], destination: params[2], reminderEnabled: true }] };
    if (/FROM public\.reminder_jobs/.test(sql)) return { rows: [] };
    if (/INSERT INTO public\.reminder_jobs/.test(sql)) { scheduled.push(params); return { rows: [] }; }
    throw new Error(`Unexpected query: ${sql}`);
  }, async (base) => {
    const post = (outingDate) => fetch(`${base}/api/trips`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
      body: JSON.stringify({ ...validBody, outingDate, reminderEnabled: true }),
    });
    assert.equal((await post('2026-04-20')).status, 201);
    assert.equal((await post('2026-04-08')).status, 201);
  }, { now: fixedNow });
  assert.equal(scheduled[0][4], '2026-04-13T01:00:00.000Z');
  assert.equal(scheduled[0][5], 'pending');
  assert.equal(scheduled[1][4], '2026-04-01T01:00:00.000Z');
  assert.equal(scheduled[1][5], 'missed');

  let queried = false;
  await withApi(async () => { queried = true; return { rows: [] }; }, async (base) => {
    const response = await fetch(`${base}/api/trips`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
      body: JSON.stringify({ ...validBody, outingDate: '2026-03-31', reminderEnabled: true }),
    });
    assert.equal(response.status, 400);
  }, { now: fixedNow });
  assert.equal(queried, false, '過去日付はDBへ書き込まない');
});

test('PUT updates with parameters and DELETE returns 204', async () => {
  await withApi(async (sql, params) => {
    if (/FROM public\.reminder_jobs/.test(sql)) return { rows: [] };
    if (/SELECT id, outing_date::text/.test(sql)) return { rows: [{ id: '101', outingDate: '2026-04-12', destination: '嵐山', reminderEnabled: false }] };
    if (/UPDATE public\.outing_records/.test(sql)) {
      assert.match(sql, /updated_at = CURRENT_TIMESTAMP/);
      assert.deepEqual(params, ['2026-04-12', '京都市', '嵐山', null, null, '晴れ', false, '101', '7']);
      return { rows: [{ ...sample, reminderEnabled: false }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }, async (base) => {
    const response = await fetch(`${base}/api/trips/101`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' }, body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 200);
  });
  await withApi(async (sql, params) => {
    if (/SELECT id FROM public\.outing_records/.test(sql)) return { rows: [{ id: '101' }] };
    if (/UPDATE public\.reminder_jobs/.test(sql)) { assert.deepEqual(params, ['101', '7']); return { rows: [] }; }
    assert.match(sql, /^DELETE FROM public\.outing_records WHERE id = \$1 AND user_id = \$2/);
    assert.deepEqual(params, ['101', '7']);
    return { rows: [{ id: '101' }] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips/101`, { method: 'DELETE', headers: { 'x-csrf-token': 'test-csrf-token' } });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });
});

test('database errors return a generic 500 response', async () => {
  await withApi(async () => { throw new Error('sensitive database detail'); }, async (base) => {
    const response = await fetch(`${base}/api/trips`);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /sensitive database detail/);
  });
});

test('変更APIにCSRFトークンがない場合はDBへ到達しない', async () => {
  let queryCalled = false;
  await withApi(async () => { queryCalled = true; return { rows: [] }; }, async (base) => {
    const response = await fetch(`${base}/api/trips`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'CSRF_INVALID');
  });
  assert.equal(queryCalled, false);
});

test('所有者が異なる既存記録は詳細APIで見つからない扱いにする', async () => {
  await withApi(async (sql, params) => {
    assert.match(sql, /id = \$1 AND user_id = \$2/);
    assert.deepEqual(params, ['101', '7']);
    return { rows: [] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips/101`);
    assert.equal(response.status, 404);
  });
});

test('セッションがない場合は記録APIを拒否しDBに問い合わせない', async () => {
  let queryCalled = false;
  const server = createServer(createApp({ query: async () => { queryCalled = true; return { rows: [] }; } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const url of ['/api/trips', '/api/weather?city=東京&date=2026-10-28']) {
      const response = await fetch(`${base}${url}`);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, 'AUTHENTICATION_REQUIRED');
    }
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  assert.equal(queryCalled, false);
});
