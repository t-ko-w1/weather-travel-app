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

async function withApi(query, run) {
  const server = createServer(createApp({ query }));
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
  assert.deepEqual(statement.params, undefined);
});

test('GET /api/trips/:id uses a parameterized query and returns 404 when absent', async () => {
  await withApi(async (sql, params) => {
    assert.match(sql, /WHERE id = \$1/);
    assert.deepEqual(params, ['999']);
    return { rows: [] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips/999`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  });
});

test('POST /api/trips normalizes optional fields and returns 201', async () => {
  await withApi(async (_sql, params) => {
    assert.deepEqual(params, ['2026-04-12', '京都市', '嵐山', null, null, '晴れ']);
    return { rows: [sample] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).id, '101');
  });
});

test('POST validates required fields and actual calendar dates without querying the database', async () => {
  let called = false;
  await withApi(async () => { called = true; return { rows: [] }; }, async (base) => {
    const response = await fetch(`${base}/api/trips`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, outingDate: '2026-02-30', city: '  ' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(body.error.details.length >= 2);
  });
  assert.equal(called, false);
});

test('PUT updates with parameters and DELETE returns 204', async () => {
  await withApi(async (sql, params) => {
    assert.match(sql, /updated_at = CURRENT_TIMESTAMP/);
    assert.deepEqual(params, ['2026-04-12', '京都市', '嵐山', null, null, '晴れ', '101']);
    return { rows: [sample] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips/101`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 200);
  });
  await withApi(async (sql, params) => {
    assert.match(sql, /^DELETE FROM public\.outing_records WHERE id = \$1/);
    assert.deepEqual(params, ['101']);
    return { rows: [{ id: '101' }] };
  }, async (base) => {
    const response = await fetch(`${base}/api/trips/101`, { method: 'DELETE' });
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
