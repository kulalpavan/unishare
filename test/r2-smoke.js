'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('../storage');

if (process.env.STORAGE_DRIVER !== 'r2') {
  console.error('Set STORAGE_DRIVER=r2 and the R2_* environment variables first.');
  process.exit(1);
}

(async () => {
  storage.init();
  const id = `smoketest-${Date.now()}`;
  const tmp = path.join(os.tmpdir(), `unishare-r2-${Date.now()}.txt`);
  fs.writeFileSync(tmp, 'unishare r2 smoke test');
  try {
    await storage.put(id, 'nested/hello.txt', tmp, 'text/plain');
    const files = await storage.list(id);
    console.log('listed:', JSON.stringify(files));
    if (files.length !== 1 || files[0].path !== 'nested/hello.txt') {
      throw new Error('unexpected object listing');
    }
    const { stream, size } = await storage.openFile(id, 'nested/hello.txt');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    console.log(`downloaded (${size} bytes):`, text);
    if (!text.includes('smoke test')) throw new Error('content mismatch');
  } finally {
    await storage.remove(id);
    try { fs.unlinkSync(tmp); } catch {}
    console.log('cleaned up');
  }
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
