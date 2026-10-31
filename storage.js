'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand
} = require('@aws-sdk/client-s3');

const DRIVER = (process.env.STORAGE_DRIVER || (process.env.R2_BUCKET ? 'r2' : 'local')).toLowerCase();
const DATA_DIR = process.env.UNISHARE_DATA_DIR
  ? path.resolve(process.env.UNISHARE_DATA_DIR)
  : path.join(__dirname, 'data');
const SHARED_DIR = path.join(DATA_DIR, 'shares');

let s3 = null;
let bucket = null;

function sanitizeRel(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split('/').filter(s => s.length && s !== '.');
  for (const part of parts) {
    if (part === '..' || /[\x00-\x1f]/.test(part)) return null;
  }
  if (!parts.length) return null;
  return parts.join('/');
}

function localShareDir(id) {
  const dir = path.join(SHARED_DIR, id);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(SHARED_DIR) + path.sep)) return null;
  return resolved;
}

function localPath(id, rel) {
  const dir = localShareDir(id);
  if (!dir) return null;
  const full = path.join(dir, ...rel.split('/'));
  if (!full.startsWith(dir + path.sep)) return null;
  return full;
}

function keyFor(id, rel) {
  return `${id}/${rel}`;
}

function init() {
  if (DRIVER === 'local') {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    return;
  }
  if (DRIVER === 'pg') return;
  if (DRIVER !== 'r2') throw new Error(`Unknown STORAGE_DRIVER "${DRIVER}" (use "local", "pg" or "r2").`);

  const accountId = process.env.R2_ACCOUNT_ID;
  bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT
    || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 storage requires R2_ACCOUNT_ID (or R2_ENDPOINT), R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  }

  s3 = new S3Client({
    region: process.env.R2_REGION || 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    ...(process.env.R2_FORCE_PATH_STYLE === 'true' ? { forcePathStyle: true } : {})
  });
}

async function put(id, rel, tempPath, contentType) {
  if (DRIVER === 'local') {
    const dest = localPath(id, rel);
    if (!dest) throw new Error('unsafe storage path');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.renameSync(tempPath, dest);
    } catch (err) {
      if (err.code === 'EXDEV') {
        fs.copyFileSync(tempPath, dest);
        fs.unlinkSync(tempPath);
      } else {
        throw err;
      }
    }
    return;
  }

  if (DRIVER === 'pg') {
    const data = fs.readFileSync(tempPath);
    await require('./db').pool.query(
      `INSERT INTO share_files (share_id, path, size, content_type, data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (share_id, path)
       DO UPDATE SET size = EXCLUDED.size, content_type = EXCLUDED.content_type, data = EXCLUDED.data`,
      [id, rel, data.length, contentType || 'application/octet-stream', data]
    );
    return;
  }

  const st = fs.statSync(tempPath);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: keyFor(id, rel),
    Body: fs.createReadStream(tempPath),
    ContentLength: st.size,
    ContentType: contentType || 'application/octet-stream'
  }));
}

async function list(id) {
  if (DRIVER === 'local') {
    const dir = localShareDir(id);
    const out = [];
    if (!dir || !fs.existsSync(dir)) return out;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else {
          out.push({
            path: path.relative(dir, full).split(path.sep).join('/'),
            size: fs.statSync(full).size
          });
        }
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  if (DRIVER === 'pg') {
    const { rows } = await require('./db').pool.query(
      'SELECT path, size FROM share_files WHERE share_id = $1 ORDER BY path',
      [id]
    );
    return rows.map(row => ({ path: row.path, size: Number(row.size) }));
  }

  const prefix = `${id}/`;
  const out = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token
    }));
    for (const obj of page.Contents || []) {
      out.push({ path: obj.Key.slice(prefix.length), size: obj.Size || 0 });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function openFile(id, rel) {
  if (DRIVER === 'local') {
    const full = localPath(id, rel);
    if (!full) throw new Error('unsafe storage path');
    const st = fs.statSync(full);
    if (!st.isFile()) {
      const err = new Error('not a file');
      err.code = 'ENOENT';
      throw err;
    }
    return { stream: fs.createReadStream(full), size: st.size };
  }

  if (DRIVER === 'pg') {
    const { rows } = await require('./db').pool.query(
      'SELECT data, size FROM share_files WHERE share_id = $1 AND path = $2',
      [id, rel]
    );
    if (!rows[0]) {
      const missing = new Error('not found');
      missing.code = 'ENOENT';
      throw missing;
    }
    return { stream: Readable.from([rows[0].data]), size: Number(rows[0].size) };
  }

  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(id, rel) }));
    return { stream: res.Body, size: Number(res.ContentLength) || 0 };
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      const missing = new Error('not found');
      missing.code = 'ENOENT';
      throw missing;
    }
    throw err;
  }
}

async function remove(id) {
  if (DRIVER === 'local') {
    const dir = localShareDir(id);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return;
  }

  if (DRIVER === 'pg') {
    await require('./db').pool.query('DELETE FROM share_files WHERE share_id = $1', [id]);
    return;
  }

  const prefix = `${id}/`;
  const keys = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token
    }));
    for (const obj of page.Contents || []) keys.push({ Key: obj.Key });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  for (let i = 0; i < keys.length; i += 1000) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.slice(i, i + 1000), Quiet: true }
    }));
  }
}

module.exports = {
  driver: DRIVER,
  sanitizeRel,
  init,
  put,
  list,
  openFile,
  remove
};
