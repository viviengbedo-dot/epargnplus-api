const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },  // required by Supabase
  max: 10,
  idleTimeoutMillis: 30000,
  // Force IPv4 — Supabase direct connection resolves IPv6 on some networks
  host: undefined,
  family: 4,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  if (process.env.NODE_ENV === 'development') {
    console.log(`[DB] ${Date.now() - start}ms — ${text.slice(0, 60)}`);
  }
  return res;
}

module.exports = { pool, query };
