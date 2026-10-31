'use strict';

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'unishare-verify-'));
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://unishare:unishare@127.0.0.1:5433/unishare_test';
const BASE = `http://127.0.0.1:${process.env.PORT || 0}`;
let BASE_URL = BASE;
let testDb = null;

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function getCookie(res) {
  if (typeof res.headers.getSetCookie === 'function') {
    const sc = res.headers.getSetCookie();
    if (sc.length) return sc[0];
  }
  const sc = res.headers.get('set-cookie');
  if (!sc) return null;
  return sc.split(';')[0];
}

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}/style.css`);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const port = await getFreePort();
  BASE_URL = `http://127.0.0.1:${port}`;
  console.log(`Starting UniShare on ${BASE_URL} ...`);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      UNISHARE_DATA_DIR: TEST_DATA_DIR,
      DATABASE_URL: TEST_DATABASE_URL,
      STORAGE_DRIVER: process.env.TEST_STORAGE_DRIVER || 'local',
      NODE_ENV: 'test',
      MAX_REQUEST_MB: '2'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const out = [];
  child.stdout.on('data', d => out.push(d));
  child.stderr.on('data', d => out.push(d));

  let exitCode = 0;
  try {
    const up = await waitForServer(BASE_URL);
    check('server boots on a free port', up);
    if (!up) throw new Error('server did not start');

    testDb = new Client({ connectionString: TEST_DATABASE_URL });
    await testDb.connect();
    await testDb.query('DELETE FROM share_files');
    await testDb.query('DELETE FROM shares');
    check('postgres test database ready', true);

    const health = await fetch(`${BASE_URL}/api/health`);
    check('health check reports ready', health.status === 200 && (await health.json()).ok === true);

    /* ---- 1. TEXT SHARE ---- */
    {
      const fd = new FormData();
      fd.append('text', 'Hello from UniShare! This is a text note.');
      fd.append('password', '');
      const res = await fetch(`${BASE_URL}/api/upload`, { method: 'POST', body: fd });
      const data = await res.json();
      check('upload text share -> 201', res.status === 201, JSON.stringify(data));
      check('share id is high-entropy (>=20 chars, urlsafe)', /^[A-Za-z0-9_-]{20,64}$/.test(data.id), data.id);

      const meta = await fetch(`${BASE_URL}/api/share/${data.id}`);
      const metaBody = await meta.json();
      check('text metadata readable, text matches', meta.status === 200 && metaBody.text.includes('Hello from UniShare'));

      const dl = await fetch(`${BASE_URL}/s/${data.id}/download`);
      const body = await dl.text();
      check('text download streams content', dl.status === 200 && body.includes('Hello from UniShare'), `ct=${dl.headers.get('content-type')}`);
      check('text download has no auth cookie set', !dl.headers.get('set-cookie'));

      /* ---- 2. MULTI-FILE / FOLDER SHARE (nested paths -> ZIP) ---- */
      const mfd = new FormData();
      const fileA = new Blob(['hello-one-content']);
      const fileB = new Blob(['hello-two-content']);
      const fileC = new Blob(['deep-deep-content']);
      mfd.append('files', fileA, 'one.txt');       mfd.append('paths', 'alpha/beta/one.txt');
      mfd.append('files', fileB, 'two.txt');       mfd.append('paths', 'alpha/gamma/two.txt');
      mfd.append('files', fileC, 'three.txt');     mfd.append('paths', 'delta/epsilon/three.txt');
      const mres = await fetch(`${BASE_URL}/api/upload`, { method: 'POST', body: mfd });
      const mdata = await mres.json();
      check('upload multi-file share -> 201', mres.status === 201, JSON.stringify(mdata));

      const mmeta = await fetch(`${BASE_URL}/api/share/${mdata.id}`);
      const mbody = await mmeta.json();
      const paths = (mbody.files || []).map(f => f.path).sort();
      check(
        'listing shows folder structure preserved',
        JSON.stringify(paths) === JSON.stringify(['alpha/beta/one.txt', 'alpha/gamma/two.txt', 'delta/epsilon/three.txt']),
        JSON.stringify(paths)
      );

      const zipRes = await fetch(`${BASE_URL}/s/${mdata.id}/download`);
      const zipBuf = Buffer.from(await zipRes.arrayBuffer());
      check('folder download is a ZIP', zipRes.status === 200 && zipBuf.slice(0, 2).toString() === 'PK', `ct=${zipRes.headers.get('content-type')}`);
      const zipStr = zipBuf.toString('latin1');
      check('ZIP preserves internal structure (alpha/beta/one.txt)', zipStr.includes('alpha/beta/one.txt'));
      check('ZIP preserves internal structure (delta/epsilon/three.txt)', zipStr.includes('delta/epsilon/three.txt'));
      check('ZIP contains file content (STORE)', zipStr.includes('deep-deep-content'));

      /* ---- direct single-file download from inside share ---- */
      const single = await fetch(`${BASE_URL}/s/${mdata.id}/file?path=alpha/gamma/two.txt`);
      const singleBody = await single.text();
      check('direct per-file download works', single.status === 200 && singleBody === 'hello-two-content');
      const traversal = await fetch(`${BASE_URL}/s/${mdata.id}/file?path=${encodeURIComponent('../../.secret')}`);
      check('path traversal blocked (..)', traversal.status === 400 || traversal.status === 404, `status=${traversal.status}`);

      /* ---- folder share with a single file must stay a folder ---- */
      const sfd = new FormData();
      sfd.append('kind', 'folder');
      sfd.append('files', new Blob(['solo-content']), 'solo.txt');
      sfd.append('paths', 'SoloFolder/solo.txt');
      const sres = await fetch(`${BASE_URL}/api/upload`, { method: 'POST', body: sfd });
      const sdata = await sres.json();
      check('upload single-file folder -> 201', sres.status === 201, JSON.stringify(sdata));

      const smeta = await (await fetch(`${BASE_URL}/api/share/${sdata.id}`)).json();
      check('folder share reports kind=folder + folderName', smeta.kind === 'folder' && smeta.folderName === 'SoloFolder', JSON.stringify({ kind: smeta.kind, folderName: smeta.folderName }));

      const szip = await fetch(`${BASE_URL}/s/${sdata.id}/download`);
      const sbuf = Buffer.from(await szip.arrayBuffer());
      check('single-file folder downloads as ZIP, not a loose file', szip.status === 200 && sbuf.slice(0, 2).toString() === 'PK', `ct=${szip.headers.get('content-type')}`);
      check('ZIP keeps folder root (SoloFolder/solo.txt)', sbuf.toString('latin1').includes('SoloFolder/solo.txt'));
      check('ZIP filename uses the folder name', /SoloFolder\.zip/.test(szip.headers.get('content-disposition') || ''), szip.headers.get('content-disposition'));
    }

    /* ---- 3. PASSWORD SHARE ---- */
    {
      const pfd = new FormData();
      pfd.append('text', 'top secret note protected by password');
      pfd.append('password', 'hunter2secret');
      const res = await fetch(`${BASE_URL}/api/upload`, { method: 'POST', body: pfd });
      const data = await res.json();
      check('upload password share -> 201, locked=true', res.status === 201 && data.locked === true);

      const meta = await fetch(`${BASE_URL}/api/share/${data.id}`);
      check('locked share metadata -> 401', meta.status === 401);
      const metaJson = await meta.json();
      check('locked metadata does not leak text or state', metaJson.locked === true &&metaJson.text === undefined);

      const dlNoAuth = await fetch(`${BASE_URL}/s/${data.id}/download`);
      check('locked download without cookie -> 401', dlNoAuth.status === 401);

      const bad = await fetch(`${BASE_URL}/api/share/${data.id}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' })
      });
      check('wrong password -> 401', bad.status === 401);
      check('wrong password sets no cookie', !bad.headers.get('set-cookie'));

      const good = await fetch(`${BASE_URL}/api/share/${data.id}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'hunter2secret' })
      });
      check('right password -> 200', good.status === 200);
      const cookie = getCookie(good);
      check('unlock sets short-lived signed cookie', !!cookie && /us_[A-Za-z0-9_-]+=\d+\.[a-f0-9]{64}/.test(cookie), cookie);
      check('cookie is HttpOnly and scoped to /s/<id>', /HttpOnly/.test(cookie) && cookie.includes(`Path=/s/${data.id}`), cookie);

      const setCookies = typeof good.headers.getSetCookie === 'function'
        ? good.headers.getSetCookie()
        : [good.headers.get('set-cookie') || ''];
      check('unlock cookie scoped to API metadata path', setCookies.some(c => c.includes(`Path=/api/share/${data.id}`)), setCookies.join(' | '));
      check('unlock cookie scoped to direct download path', setCookies.some(c => c.includes(`Path=/d/${data.id}`)), setCookies.join(' | '));

      const authedMeta = await fetch(`${BASE_URL}/api/share/${data.id}`, { headers: { Cookie: cookie } });
      const authedMetaJson = await authedMeta.json();
      check('metadata unlocks with cookie (share page flow)', authedMeta.status === 200 && authedMetaJson.text.includes('top secret note'), `status=${authedMeta.status}`);

      const authedDl = await fetch(`${BASE_URL}/s/${data.id}/download`, { headers: { Cookie: cookie } });
      const authedBody = await authedDl.text();
      check('download with cookie works', authedDl.status === 200 && authedBody.includes('top secret note'), `status=${authedDl.status}`);

      const directDl = await fetch(`${BASE_URL}/d/${data.id}`, { headers: { Cookie: cookie } });
      const directBody = await directDl.text();
      check('direct download works with cookie', directDl.status === 200 && directBody.includes('top secret note'), `status=${directDl.status}`);
      check('cookie never contains plain password', !cookie.includes('hunter2secret'));

      const tampered = await fetch(`${BASE_URL}/s/${data.id}/download`, {
        headers: { Cookie: cookie.replace(/\.[a-f0-9]{4}/, '.deadbeef') }
      });
      check('tampered cookie rejected -> 401', tampered.status === 401);
    }

    /* ---- 4. EXPIRED SHARE (expires_at injected directly in Postgres) ---- */
    {
      const efd = new FormData();
      efd.append('text', 'this note will expire');
      const res = await fetch(`${BASE_URL}/api/upload`, { method: 'POST', body: efd });
      const data = await res.json();
      check('upload share for expiry test -> 201', res.status === 201);

      const dbf = testDb;
      const upd = await dbf.query('UPDATE shares SET expires_at = $1 WHERE id = $2', [Date.now() - 60_000, data.id]);
      check('expires_at set to past timestamp directly in postgres', upd.rowCount === 1);

      const meta = await fetch(`${BASE_URL}/api/share/${data.id}`);
      check('expired share metadata -> 410', meta.status === 410);
      const edl = await fetch(`${BASE_URL}/s/${data.id}/download`);
      check('expired share download -> 410', edl.status === 410);
    }

    /* ---- 5. misc: nothing to share -> 400, garbage id -> 404 ---- */
    {
    const empty = await fetch(`${BASE_URL}/api/upload`, { method: 'POST', body: new FormData() });
    check('empty upload -> 400', empty.status === 400);

    const oversized = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(3 * 1024 * 1024)
    });
    check('oversized request rejected -> 413', oversized.status === 413);
      const junk = await fetch(`${BASE_URL}/api/share/not-a-real-share-id-9999`);
      check('unknown share -> 404', junk.status === 404);
    }
  } catch (err) {
    exitCode = 1;
    console.error('\nUnexpected error:', err);
  } finally {
    child.kill();
    if (testDb) {
      try { await testDb.query('DELETE FROM share_files'); } catch {}
      try { await testDb.query('DELETE FROM shares'); } catch {}
      try { await testDb.end(); } catch {}
    }
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length || exitCode) {
    console.log('--- server output tail ---');
    console.log(out.join('').slice(-2000));
    process.exitCode = 1;
  } else {
    console.log('ALL VERIFICATION CHECKS PASSED');
    try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
    console.log('cleaned test data dir');
  }
}

main();
