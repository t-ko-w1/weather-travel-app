const { Pool } = require('pg');

function createPool() {
  const config = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST,
        port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
      };

  return new Pool({ ...config, max: 10, idleTimeoutMillis: 30000 });
}

async function withTransaction(pool, work) {
  if (!pool || typeof pool.connect !== 'function' || typeof work !== 'function') {
    throw new TypeError('PostgreSQL poolとトランザクション処理が必要です。');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createPool, withTransaction };
