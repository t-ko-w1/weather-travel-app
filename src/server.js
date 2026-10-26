require('dotenv').config();
const { createApp } = require('./app');
const { createPool } = require('./db');

const pool = createPool();
const app = createApp({ query: (text, params) => pool.query(text, params) });
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
