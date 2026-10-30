const test = require('node:test');
const assert = require('node:assert/strict');
const { withTransaction } = require('../src/db');

test('withTransaction commits successful work and always releases its client', async () => {
  const statements = [];
  let released = false;
  const pool = { connect: async () => ({
    query: async (sql, params) => { statements.push([sql, params]); return { rows: [] }; },
    release: () => { released = true; },
  }) };
  const result = await withTransaction(pool, async (query) => {
    await query('UPDATE test SET value = $1', ['ok']);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(statements.map(([sql]) => sql), ['BEGIN', 'UPDATE test SET value = $1', 'COMMIT']);
  assert.deepEqual(statements[1][1], ['ok']);
  assert.equal(released, true);
});

test('withTransaction rolls back failures and rethrows the original error', async () => {
  const statements = [];
  let released = false;
  const pool = { connect: async () => ({
    query: async (sql) => { statements.push(sql); return { rows: [] }; },
    release: () => { released = true; },
  }) };
  const failure = new Error('transaction failure');
  await assert.rejects(withTransaction(pool, async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual(statements, ['BEGIN', 'ROLLBACK']);
  assert.equal(released, true);
});
