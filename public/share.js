const $ = id => document.getElementById(id);
const shareId = location.pathname.split('/')[2];
let lastPassword = '';
let currentShareData = null;
let liveReceiver = null;
let liveFileResolver = null;

function api(path, opts) {
  return fetch(path, opts).then(async res => ({ status: res.status, data: await res.json().catch(() => ({})) }));
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  for (const unit of ['KB', 'MB', 'GB']) {
    n /= 1024;
    if (n < 1024) return `${n.toFixed(1)} ${unit}`;
  }
  return `${n.toFixed(1)} TB`;
}

function showError(title, msg) {
  $('pwCard').hidden = true;
  $('shareCard').hidden = true;
  $('errTitle').textContent = title;
  $('errMsg').textContent = msg;
  $('errCard').hidden = false;
}

async function loadShare() {
  const { status, data } = await api(`/api/share/${shareId}`);
  if (status === 401) {
    $('shareCard').hidden = true;
    $('errCard').hidden = true;
    $('pwCard').hidden = false;
    $('pwInput').focus();
    return;
  }
  if (status === 404) return showError('Share not found', data.error || 'This link is invalid.');
  if (status === 410) return showError('Share expired', data.error || 'This share has expired.');
  if (!status.toString().startsWith('2')) return showError('Something went wrong', data.error || 'Try again.');

  $('pwCard').hidden = true;
  $('errCard').hidden = true;

  const isFolder = data.kind === 'folder' && !!data.folderName;
  const files = data.files || [];

  $('shareTitle').textContent = isFolder ? data.folderName : (data.topName || 'Shared content');
  $('shareTagline').textContent = isFolder ? 'Folder · read-only · one link' : 'Read-only · one link';
  $('shareMeta').textContent = [
    new Date(data.createdAt).toLocaleString(),
    data.expiresAt ? `expires ${new Date(data.expiresAt).toLocaleString()}` : 'never expires'
  ].join(' · ');

  if (data.text) {
    $('textContent').textContent = data.text;
    $('textBlock').hidden = false;
  }
  if (files.length) {
    $('filesHeading').textContent = isFolder ? 'FOLDER' : 'FILES';
    $('fileTable').classList.toggle('tree', isFolder);
    const rows = $('fileRows');
    rows.innerHTML = '';
    if (isFolder) {
      const rootRow = document.createElement('tr');
      rootRow.className = 'folder-row';
      const rootTd = document.createElement('td');
      rootTd.colSpan = 2;
      rootTd.textContent = `▥ ${data.folderName}/`;
      rootRow.appendChild(rootTd);
      rows.appendChild(rootRow);
    }
    for (const f of files) {
      const tr = document.createElement('tr');
      const a = document.createElement('a');
      a.href = `/s/${shareId}/file?path=${encodeURIComponent(f.path)}`;
      a.textContent = isFolder && f.path.startsWith(`${data.folderName}/`)
        ? f.path.slice(data.folderName.length + 1)
        : f.path;
      const td1 = document.createElement('td');
      td1.appendChild(a);
      const td2 = document.createElement('td');
      td2.className = 'size';
      td2.textContent = fmtSize(f.size);
      tr.append(td1, td2);
      rows.appendChild(tr);
    }
    $('filesBlock').hidden = false;
  }

  const dl = $('downloadAll');
  dl.href = `/s/${shareId}/download`;
  if (isFolder) {
    dl.textContent = `↓ Download folder (${data.folderName}.zip)`;
    dl.setAttribute('download', `${data.folderName}.zip`);
  } else {
    dl.removeAttribute('download');
    dl.textContent = files.length
      ? `↓ Download all (${files.length} file${files.length > 1 ? 's' : ''})`
      : (data.text ? '↓ Download note' : '↓ Download');
  }
  $('shareCard').hidden = false;
  currentShareData = data;
  tryLive(data);
}

// --- Live P2P download (hybrid mode) ---------------------------------------
// If the sender's tab is still open, files stream straight from their browser
// over WebRTC. Otherwise the stored HTTP download above is the fallback.

async function tryLive(data) {
  const liveEl = $('liveStatus');
  const liveBtn = $('liveDownload');
  if (!liveEl || !liveBtn) return;
  liveBtn.hidden = true;
  const files = data.files || [];
  if (!window.UniShareLive || !window.RTCPeerConnection || !files.length) return;
  try { if (liveReceiver) liveReceiver.close(); } catch {}
  liveReceiver = null;
  liveEl.hidden = false;
  liveEl.textContent = 'Checking for a live sender…';
  try {
    liveReceiver = await window.UniShareLive.startReceiver({
      id: shareId,
      password: lastPassword,
      timeoutMs: 5000,
      onStatus: msg => { liveEl.textContent = msg; },
      onManifest: () => {
        liveEl.textContent = 'Live sender online — files can stream straight from their browser.';
        liveBtn.hidden = false;
      },
      onFileComplete: (path, size, blob) => {
        if (liveFileResolver && liveFileResolver.path === path) {
          const r = liveFileResolver;
          liveFileResolver = null;
          r.resolve(blob);
        }
      },
      onError: err => {
        liveBtn.hidden = true;
        if (err && err.message === 'sender-offline') {
          liveEl.textContent = 'Sender is offline — using the stored copy below.';
        } else if (err && err.message === 'wrong-password') {
          liveEl.hidden = true;
        } else {
          liveEl.textContent = 'Live transfer unavailable — using the stored copy below.';
        }
        liveReceiver = null;
      }
    });
  } catch (err) {
    liveBtn.hidden = true;
    liveEl.textContent = 'Sender is offline — using the stored copy below.';
    liveReceiver = null;
  }
}

function requestOneLiveFile(path) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (liveFileResolver && liveFileResolver.path === path) liveFileResolver = null;
      reject(new Error('Live transfer timed out.'));
    }, 10 * 60 * 1000);
    liveFileResolver = {
      path,
      resolve: blob => { clearTimeout(timer); resolve(blob); }
    };
    liveReceiver.requestFile(path);
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function downloadLive() {
  const btn = $('liveDownload');
  const liveEl = $('liveStatus');
  if (!liveReceiver || !currentShareData) return;
  const files = currentShareData.files || [];
  if (!files.length) return;
  btn.disabled = true;
  const received = [];
  try {
    let done = 0;
    for (const f of files) {
      liveEl.textContent = `Live: receiving ${f.path} (${done + 1}/${files.length})…`;
      const blob = await requestOneLiveFile(f.path);
      received.push({ path: f.path, blob });
      done++;
    }
    const data = currentShareData;
    const isFolder = data.kind === 'folder' && !!data.folderName;
    if (received.length === 1 && !isFolder && !data.text) {
      saveBlob(received[0].blob, received[0].path.split('/').pop());
    } else if (window.JSZip) {
      const zip = new window.JSZip();
      for (const r of received) zip.file(r.path, r.blob);
      if (data.text) zip.file('note.txt', data.text);
      const zipName = isFolder && data.folderName ? data.folderName : (data.topName || 'unishare');
      const blob = await zip.generateAsync({ type: 'blob' });
      saveBlob(blob, `${zipName}.zip`);
    } else {
      for (const r of received) saveBlob(r.blob, r.path.split('/').pop());
    }
    liveEl.textContent = 'Live transfer complete.';
    try { liveReceiver.finish(); } catch {}
    liveReceiver = null;
    btn.hidden = true;
  } catch (err) {
    liveEl.textContent = 'Live transfer failed — use the stored download below.';
    btn.disabled = false;
  }
}

$('liveDownload').addEventListener('click', downloadLive);

window.addEventListener('pagehide', () => {
  try { if (liveReceiver) liveReceiver.close(); } catch {}
});

$('pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('pwInput').value;
  if (!pw) return;
  lastPassword = pw;
  const { status, data } = await api(`/api/share/${shareId}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  if (status === 401) {
    $('pwStatus').textContent = data.error || 'Wrong password.';
    $('pwInput').focus();
    return;
  }
  if (!status.toString().startsWith('2')) {
    $('pwStatus').textContent = data.error || 'Unlock failed.';
    return;
  }
  $('pwStatus').textContent = '';
  loadShare();
});

function tickClock() {
  const el = $('clock');
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
tickClock();
setInterval(tickClock, 15000);

const idTag = $('shareIdTag');
if (idTag && shareId) idTag.textContent = `ID ${shareId.slice(0, 8).toUpperCase()}`;

function flashDock(action, label) {
  const btn = document.querySelector(`.dock-btn[data-action="${action}"]`);
  if (!btn) return;
  const span = btn.querySelector('.di');
  if (!span) return;
  const old = span.textContent;
  span.textContent = label;
  setTimeout(() => { span.textContent = old; }, 1200);
}

function copyCurrent() {
  const url = location.href;
  const done = () => flashDock('copy', 'OK');
  navigator.clipboard.writeText(url).then(done).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  });
}

function downloadAll() {
  if ($('shareCard').hidden) {
    if (!$('pwCard').hidden) $('pwInput').focus();
    return;
  }
  $('downloadAll').click();
}

const actions = {
  download: () => downloadAll(),
  copy: () => copyCurrent(),
  palette: () => openPalette()
};

document.querySelectorAll('[data-action]').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    const fn = actions[el.dataset.action];
    if (fn) fn();
  });
});

const commands = [
  { label: 'Download all', hint: 'DOWNLOAD', run: () => downloadAll() },
  { label: 'Copy share link', hint: 'COPY', run: () => copyCurrent() },
  { label: 'Focus password field', hint: 'UNLOCK', run: () => $('pwInput').focus() },
  { label: 'Reload this share', hint: 'REFRESH', run: () => location.reload() },
  { label: 'Upload a new share', hint: 'HOME', run: () => { location.href = '/'; } }
];

const palette = $('palette');
const paletteInput = $('paletteInput');
const paletteList = $('paletteList');
let filtered = commands.slice();
let selected = 0;

function openPalette() {
  palette.hidden = false;
  paletteInput.value = '';
  selected = 0;
  filtered = commands.slice();
  renderPalette();
  paletteInput.focus();
}

function closePalette() {
  palette.hidden = true;
}

function renderPalette() {
  paletteList.innerHTML = '';
  if (!filtered.length) {
    const li = document.createElement('li');
    li.textContent = 'No matching command.';
    paletteList.appendChild(li);
    return;
  }
  filtered.forEach((cmd, i) => {
    const li = document.createElement('li');
    li.className = i === selected ? 'sel' : '';
    const label = document.createElement('span');
    label.textContent = cmd.label;
    const hint = document.createElement('span');
    hint.className = 'k';
    hint.textContent = cmd.hint;
    li.append(label, hint);
    li.addEventListener('mouseenter', () => {
      selected = i;
      [...paletteList.children].forEach((el, idx) => el.classList.toggle('sel', idx === i));
    });
    li.addEventListener('click', () => runCommand(cmd));
    paletteList.appendChild(li);
  });
}

function runCommand(cmd) {
  closePalette();
  if (cmd) cmd.run();
}

paletteInput.addEventListener('input', () => {
  const q = paletteInput.value.trim().toLowerCase();
  filtered = commands.filter(c => c.label.toLowerCase().includes(q));
  selected = 0;
  renderPalette();
});

paletteInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selected = (selected + 1) % Math.max(filtered.length, 1);
    renderPalette();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selected = (selected - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1);
    renderPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runCommand(filtered[selected]);
  }
});

palette.addEventListener('click', e => {
  if (e.target === palette) closePalette();
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (palette.hidden) openPalette();
    else closePalette();
  } else if (e.key === 'Escape' && !palette.hidden) {
    closePalette();
  }
});

loadShare();
