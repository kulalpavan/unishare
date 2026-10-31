'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');

const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const storage = require('./storage');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.UNISHARE_DATA_DIR
  ? path.resolve(process.env.UNISHARE_DATA_DIR)
  : path.join(__dirname, 'data');
const UPLOAD_TMP_DIR = path.join(DATA_DIR, 'tmp');
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 200);
const MAX_REQUEST_MB = Number(process.env.MAX_REQUEST_MB || 500);
const BCRYPT_ROUNDS = 10;
const UNLOCK_COOKIE_TTL_SECONDS = 600;
const COOKIE_SECURE = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
const EXPIRY_UNITS = { minutes: 60e3, hours: 3600e3, days: 86400e3 };

fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

const SECRET_PATH = path.join(DATA_DIR, '.secret');
let SERVER_SECRET = process.env.UNISHARE_SECRET || '';
if (!SERVER_SECRET) {
  SERVER_SECRET = fs.existsSync(SECRET_PATH)
    ? fs.readFileSync(SECRET_PATH, 'utf8').trim()
    : crypto.randomBytes(32).toString('hex');
  if (!fs.existsSync(SECRET_PATH)) fs.writeFileSync(SECRET_PATH, SERVER_SECRET);
}

const app = express();
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.UPLOAD_RATE_LIMIT || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads. Try again later.' }
});

const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.UNLOCK_RATE_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password attempts. Try again later.' }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`)
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1000 }
});

function sign(payload) {
  return crypto.createHmac('sha256', SERVER_SECRET).update(payload).digest('hex');
}

function makeId() {
  return crypto.randomBytes(16).toString('base64url');
}

function statusFor(share) {
  return share.expires_at !== null && share.expires_at <= Date.now() ? 'expired' : 'ok';
}

function authCookieName(id) {
  return `us_${id.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

function makeAuthToken(id) {
  const exp = Date.now() + UNLOCK_COOKIE_TTL_SECONDS * 1000;
  return { value: `${exp}.${sign(`${id}.${exp}`)}`, exp };
}

function checkAuthToken(id, token) {
  if (typeof token !== 'string') return false;
  const sep = token.indexOf('.');
  if (sep < 0) return false;
  const exp = Number(token.slice(0, sep));
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  const expected = Buffer.from(sign(`${id}.${exp}`));
  const given = Buffer.from(token.slice(sep + 1));
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

function isUnlocked(req, share) {
  if (!share.password_hash) return true;
  return checkAuthToken(share.id, req.cookies[authCookieName(share.id)]);
}

function requireAccessible(req, res, share) {
  if (!share) { res.status(404).json({ error: 'Share not found.' }); return false; }
  if (statusFor(share) === 'expired') {
    res.status(410).json({ error: 'This share has expired.' });
    return false;
  }
  if (!isUnlocked(req, share)) {
    res.status(401).json({ error: 'Password required.', locked: true });
    return false;
  }
  return true;
}

const cookieParser = (req, res, next) => {
  const jar = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) {
        const name = part.slice(0, i).trim();
        const value = part.slice(i + 1).trim();
        try { jar[name] = decodeURIComponent(value); } catch { jar[name] = value; }
      }
    }
  }
  req.cookies = jar;
  next();
};

app.use(cookieParser);

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cleanupTemp(files) {
  for (const f of files || []) {
    try { fs.unlinkSync(f.path); } catch {}
  }
}

app.get('/api/health', wrap(async (req, res) => {
  await db.pool.query('SELECT 1');
  res.json({ ok: true, storage: storage.driver });
}));

async function shareListing(share) {
  return storage.list(share.id);
}

function uploadSizeGuard(req, res, next) {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_REQUEST_MB * 1024 * 1024) {
    return res.status(413).json({ error: `Upload too large (limit ${MAX_REQUEST_MB} MB per request).` });
  }
  next();
}

app.post('/api/upload', uploadSizeGuard, uploadLimiter, (req, res, next) => {  upload.array('files', 1000)(req, res, err => {
    if (err) {
      cleanupTemp(req.files);
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File too large (limit ${MAX_FILE_MB} MB).`
        : `Upload error: ${err.message}`;
      return res.status(400).json({ error: msg });
    }
    handleUpload(req, res).catch(next);
  });
});

async function handleUpload(req, res) {
  const files = req.files || [];
  const paths = req.body.paths;
  const relPaths = (typeof paths === 'string' ? [paths] : paths) || files.map(() => '');
  const text = typeof req.body.text === 'string' ? req.body.text : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const id = makeId();
  const saved = [];
  let committed = false;

  try {
    if (files.length && relPaths.length !== files.length) {
      return res.status(400).json({ error: 'paths/files mismatch.' });
    }
    if (!files.length && !text.trim()) {
      return res.status(400).json({ error: 'Nothing to share: add files, a folder, or text.' });
    }
    if (password.length > 200) {
      return res.status(400).json({ error: 'Password too long.' });
    }

    let expiresInMs = null;
    const evVal = Number(req.body.expiryValue);
    const evUnit = req.body.expiryUnit;
    if (evVal > 0 && EXPIRY_UNITS[evUnit]) {
      expiresInMs = Math.round(evVal * EXPIRY_UNITS[evUnit]);
    }

    for (let i = 0; i < files.length; i++) {
      const rel = storage.sanitizeRel(relPaths[i] || '');
      if (!rel) {
        return res.status(400).json({ error: `Unsafe or missing path for file ${i + 1}.` });
      }
      await storage.put(id, rel, files[i].path, files[i].mimetype);
      saved.push(rel);
    }

    const requestedKind = typeof req.body.kind === 'string' ? req.body.kind : '';
    let kind;
    let folderName = null;
    if (files.length === 0) {
      kind = 'note';
    } else {
      const tops = new Set(saved.map(p => p.split('/')[0]));
      const allNested = saved.every(p => p.includes('/'));
      if (requestedKind === 'folder' || (requestedKind !== 'files' && tops.size === 1 && allNested)) {
        if (tops.size !== 1 || !allNested) {
          return res.status(400).json({ error: 'A folder upload must keep its files inside one top-level folder.' });
        }
        kind = 'folder';
        folderName = saved[0].split('/')[0];
      } else {
        kind = 'files';
      }
    }

    let topName;
    if (kind === 'note') topName = 'note.txt';
    else if (kind === 'folder') topName = folderName;
    else if (saved.length === 1) topName = path.posix.basename(saved[0]);
    else topName = 'files';

    const passwordHash = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : null;
    const now = Date.now();
    const expiresAt = expiresInMs !== null ? now + expiresInMs : null;
    await db.createShare({
      id,
      topName,
      kind,
      folderName,
      text: text || null,
      passwordHash,
      createdAt: now,
      expiresAt
    });
    committed = true;

    res.status(201).json({
      id,
      url: `/s/${id}`,
      kind,
      folderName,
      locked: !!passwordHash,
      expiresAt
    });
  } finally {
    cleanupTemp(files);
    if (!committed) {
      try { await storage.remove(id); } catch (err) { console.error(`[upload] cleanup failed for ${id}: ${err.message}`); }
    }
  }
}

app.get('/api/share/:id', wrap(async (req, res) => {
  const share = await db.getShare(req.params.id);
  if (!share) return res.status(404).json({ error: 'Share not found.' });
  if (statusFor(share) === 'expired') return res.status(410).json({ error: 'This share has expired.' });

  if (share.password_hash && !isUnlocked(req, share)) {
    return res.status(401).json({ error: 'Password required.', locked: true });
  }

  res.json({
    id: share.id,
    topName: share.top_name,
    kind: share.kind || 'files',
    folderName: share.folder_name || null,
    text: share.text,
    files: await shareListing(share),
    createdAt: share.created_at,
    expiresAt: share.expires_at
  });
}));

app.post('/api/share/:id/unlock', unlockLimiter, wrap(async (req, res) => {
  const share = await db.getShare(req.params.id);
  if (!share) return res.status(404).json({ error: 'Share not found.' });
  if (statusFor(share) === 'expired') return res.status(410).json({ error: 'This share has expired.' });
  if (!share.password_hash) return res.json({ unlocked: true });

  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!password.length) return res.status(400).json({ error: 'Password required.' });
  if (!(await bcrypt.compare(password, share.password_hash))) {
    return res.status(401).json({ error: 'Wrong password.' });
  }

  const token = makeAuthToken(share.id);
  const cookie = `${authCookieName(share.id)}=${encodeURIComponent(token.value)}; HttpOnly; SameSite=Lax; Max-Age=${UNLOCK_COOKIE_TTL_SECONDS}${COOKIE_SECURE ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [
    `${cookie}; Path=/s/${share.id}`,
    `${cookie}; Path=/api/share/${share.id}`,
    `${cookie}; Path=/d/${share.id}`
  ]);
  res.json({ unlocked: true });
}));

async function sendSingleFile(res, share, rel) {
  const safe = storage.sanitizeRel(rel);
  if (!safe) return res.status(400).end();
  let file;
  try {
    file = await storage.openFile(share.id, safe);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).end();
    throw err;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', file.size);
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURI(path.posix.basename(safe))}`);
  file.stream.on('error', () => res.destroy());
  file.stream.pipe(res);
}

async function streamZip(res, share, listing) {
  const files = listing || await shareListing(share);
  const zipName = share.kind === 'folder' && share.folder_name
    ? share.folder_name
    : (share.top_name || 'unishare');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURI(zipName)}.zip`);
  const { ZipArchive } = await import('archiver');
  const zip = new ZipArchive({ store: true });
  zip.on('error', () => res.destroy());
  zip.pipe(res);
  try {
    for (const f of files) {
      const file = await storage.openFile(share.id, f.path);
      file.stream.on('error', () => res.destroy());
      zip.append(file.stream, { name: f.path });
    }
    if (share.text) zip.append(Buffer.from(share.text), { name: 'note.txt' });
    await zip.finalize();
  } catch (err) {
    zip.abort();
    res.destroy();
    throw err;
  }
}

async function shareDownload(req, res) {
  const share = await db.getShare(req.params.id);
  if (!requireAccessible(req, res, share)) return;

  const files = await shareListing(share);
  if (share.kind === 'folder') return streamZip(res, share, files);

  if (files.length === 0 && share.text) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURI(share.top_name || 'note.txt')}`);
    return res.send(share.text);
  }

  if (files.length === 1 && !share.text) {
    return sendSingleFile(res, share, files[0].path);
  }

  return streamZip(res, share, files);
}

app.get('/s/:id/download', wrap(shareDownload));
app.get('/d/:id', wrap(shareDownload));

app.get('/s/:id/file', wrap(async (req, res) => {
  const share = await db.getShare(req.params.id);
  if (!requireAccessible(req, res, share)) return;
  const files = await shareListing(share);
  if (!files.length) return res.status(400).end();
  await sendSingleFile(res, share, req.query.path || '');
}));

app.get('/d/:id/file', wrap(async (req, res) => {
  const share = await db.getShare(req.params.id);
  if (!requireAccessible(req, res, share)) return;
  const files = await shareListing(share);
  if (!files.length) return res.status(400).end();
  await sendSingleFile(res, share, req.query.path || '');
}));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/s/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.use((req, res) => {
  res.status(404);
  if (req.path.startsWith('/api/')) return res.json({ error: 'Not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: 'Server error.' });
});

async function cleanupExpired() {
  const rows = await db.listExpired(Date.now());
  let removed = 0;
  for (const row of rows) {
    try {
      await storage.remove(row.id);
      await db.deleteShare(row.id);
      removed++;
    } catch (err) {
      console.error(`[cleanup] failed for ${row.id}: ${err.message}`);
    }
  }
  if (removed) console.log(`[cleanup] removed ${removed} expired share(s)`);
}

function cleanTempDir() {
  for (const name of fs.readdirSync(UPLOAD_TMP_DIR)) {
    try { fs.rmSync(path.join(UPLOAD_TMP_DIR, name), { recursive: true, force: true }); } catch {}
  }
}

const server = http.createServer(app);

let cleaning = false;

async function cleanupOrphans() {
  const { rowCount } = await db.pool.query(
    'DELETE FROM share_files sf WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.id = sf.share_id)'
  );
  if (rowCount) console.log(`[cleanup] removed ${rowCount} orphaned file row(s)`);
}

async function start() {
  await db.initWithRetry();
  storage.init();
  cleanTempDir();
  await cleanupOrphans();
  await cleanupExpired();
  server.listen(PORT, () => {
    console.log(`UniShare running at http://localhost:${PORT} (db: postgres, storage: ${storage.driver})`);
  });
  setInterval(async () => {
    if (cleaning) return;
    cleaning = true;
    try { await cleanupExpired(); } catch (err) { console.error('[cleanup]', err); } finally { cleaning = false; }
  }, 60 * 1000).unref();
}

async function shutdown() {
  server.close(async () => {
    try { await db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) {
  start().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app, server, db, storage, cleanupExpired, start };