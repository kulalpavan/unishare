'use strict';

const { Pool, types } = require('pg');

types.setTypeParser(20, value => (value === null ? null : Number(value)));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Example: postgres://unishare:unishare@127.0.0.1:5433/unishare');
}

const sslRequired = process.env.PGSSL === 'true'
  || /[?&]sslmode=(require|verify-ca|verify-full)/i.test(DATABASE_URL);
const ssl = sslRequired ? { rejectUnauthorized: false } : undefined;

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 5),
  ...(ssl ? { ssl } : {})
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      top_name TEXT,
      kind TEXT NOT NULL DEFAULT 'files',
      folder_name TEXT,
      text TEXT,
      password_hash TEXT,
      created_at BIGINT NOT NULL,
      expires_at BIGINT
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS shares_expires_at_idx ON shares (expires_at)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS share_files (
      share_id TEXT NOT NULL,
      path TEXT NOT NULL,
      size BIGINT NOT NULL,
      content_type TEXT,
      data BYTEA NOT NULL,
      PRIMARY KEY (share_id, path)
    )
  `);
  await pool.query('ALTER TABLE share_files DROP CONSTRAINT IF EXISTS share_files_share_id_fkey');
}

async function initWithRetry(attempts = 20, delayMs = 1000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await init();
      return;
    } catch (err) {
      lastErr = err;
      console.error(`[db] not ready (attempt ${i + 1}/${attempts}): ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function getShare(id) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  const { rows } = await pool.query('SELECT * FROM shares WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createShare(share) {
  await pool.query(
    `INSERT INTO shares (id, top_name, kind, folder_name, text, password_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      share.id,
      share.topName,
      share.kind,
      share.folderName,
      share.text,
      share.passwordHash,
      share.createdAt,
      share.expiresAt
    ]
  );
}

async function listExpired(now) {
  const { rows } = await pool.query(
    'SELECT id FROM shares WHERE expires_at IS NOT NULL AND expires_at <= $1',
    [now]
  );
  return rows;
}

async function deleteShare(id) {
  await pool.query('DELETE FROM shares WHERE id = $1', [id]);
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  init,
  initWithRetry,
  getShare,
  createShare,
  listExpired,
  deleteShare,
  close
};
