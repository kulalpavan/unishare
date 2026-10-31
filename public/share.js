const $ = id => document.getElementById(id);
const shareId = location.pathname.split('/')[2];

let passwordHash = null;
let liveReceiver = null;
let listing = null;
let liveFileResolver = null;
let transferNotified = false;
let downloading = false;

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

function setLiveStatus(msg) {
  const el = $('liveStatus');
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
}

function notifyDownloaded() {
  if (transferNotified || !liveReceiver) return;
  transferNotified = true;
  try { liveReceiver.notifyDownloaded(); } catch {}
}

async function connectShare() {
  if (!window.UniShareLive || !window.RTCPeerConnection) {
    showError('Not supported', 'Live sharing needs WebRTC, which this browser does not support.');
    return;
  }
  try { if (liveReceiver) liveReceiver.close(); } catch {}
  liveReceiver = null;
  listing = null;
  transferNotified = false;
  $('errCard').hidden = true;
  $('pwCard').hidden = true;
  $('shareCard').hidden = true;
  setLiveStatus('Connecting to the sender…');

  try {
    liveReceiver = await window.UniShareLive.startReceiver({
      id: shareId,
      passwordHash,
      timeoutMs: 8000,
      onStatus: msg => setLiveStatus(msg),
      onJoin: serverListing => {
        // Show the listing as soon as the sender is found, from the
        // manifest the server already holds — don't wait for the direct
        // data channel before showing the user what was shared.
        if (!listing) {
          listing = serverListing;
          renderListing(listing);
        }
        setLiveStatus('Live sender found. Connecting directly…');
      },
      onManifest: msg => {
        listing = msg.listing || { kind: 'files', files: [], hasText: !!msg.hasText };
        renderListing(listing);
        setLiveStatus('Connected directly to the sender.');
        if (listing.hasText) liveReceiver.requestText();
      },
      onText: text => {
        $('textContent').textContent = text;
        $('textBlock').hidden = false;
        if (listing && listing.kind === 'note') notifyDownloaded();
      },
      onFileStart: (path, size) => setLiveStatus(`Receiving ${path}…`),
      onFileProgress: (path, done, total) =>
        setLiveStatus(`Receiving ${path} — ${Math.round((done / total) * 100)}%`),
      onFileComplete: (path, size, blob) => {
        if (liveFileResolver && liveFileResolver.path === path) {
          const r = liveFileResolver;
          liveFileResolver = null;
          r.resolve(blob);
        }
      },
      onError: err => {
        const code = err && err.message;
        if (code === 'wrong-password') {
          $('pwStatus').textContent = passwordHash ? 'Wrong password.' : '';
          $('shareCard').hidden = true;
          $('errCard').hidden = true;
          $('pwCard').hidden = false;
          $('pwInput').focus();
          setLiveStatus('');
          $('liveStatus').hidden = true;
          return;
        }
        if (code === 'share-expired') {
          return showError('Share expired', 'This share has expired.');
        }
        if (code === 'sender-offline' || code === 'share-not-found') {
          return showError(
            'Sender is offline',
            'This link only works while the sender keeps the tab open. Ask them to create the link again.'
          );
        }
        if (code === 'connection-failed') {
          return showError(
            'Direct connection failed',
            'The sender was found, but the browsers could not connect directly — usually a restrictive network or firewall. Ask the sender to keep the tab open and try again, ideally on the same Wi-Fi.'
          );
        }
        return showError('Something went wrong', `Could not reach the sender. Try reloading the page.${code && !['sender-offline', 'share-not-found', 'share-expired', 'wrong-password'].includes(code) ? ` (${code})` : ''}`);
      }
    });
  } catch (err) {
    showError(
      'Sender is offline',
      'This link only works while the sender keeps the tab open. Ask them to create the link again.'
    );
  }
}

function renderListing(data) {
  const isFolder = data.kind === 'folder' && !!data.folderName;
  const files = data.files || [];

  $('shareTitle').textContent = isFolder ? data.folderName : (data.topName || 'Shared content');
  $('shareTagline').textContent = isFolder ? 'Folder · live P2P · one link' : 'Live P2P · one link';
  $('shareMeta').textContent = 'Shared live from the sender\'s browser — no server storage';

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
      a.href = '#';
      a.textContent = isFolder && f.path.startsWith(`${data.folderName}/`)
        ? f.path.slice(data.folderName.length + 1)
        : f.path;
      a.addEventListener('click', e => {
        e.preventDefault();
        downloadLive([f.path]);
      });
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
  if (isFolder) {
    dl.textContent = `↓ Download folder (${data.folderName}.zip)`;
    dl.setAttribute('download', `${data.folderName}.zip`);
  } else {
    dl.removeAttribute('download');
    dl.textContent = files.length
      ? `↓ Download all (${files.length} file${files.length > 1 ? 's' : ''})`
      : (data.hasText ? '↓ Download note' : '↓ Download');
  }
  $('shareCard').hidden = false;
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

async function downloadLive(paths) {
  if (!liveReceiver || !listing || downloading) return;
  const files = (listing.files || []).filter(f => paths.includes(f.path));
  if (!files.length) return;
  downloading = true;
  const received = [];
  try {
    let done = 0;
    for (const f of files) {
      setLiveStatus(`Receiving ${f.path} (${done + 1}/${files.length})…`);
      const blob = await requestOneLiveFile(f.path);
      received.push({ path: f.path, blob });
      done++;
    }
    const isFolder = listing.kind === 'folder' && !!listing.folderName;
    const singleOnly = received.length === 1 && !isFolder && files.length === 1
      && (listing.files || []).length === 1 && !listing.hasText;
    if (singleOnly) {
      saveBlob(received[0].blob, received[0].path.split('/').pop());
    } else if (window.JSZip) {
      const zip = new window.JSZip();
      for (const r of received) zip.file(r.path, r.blob);
      const zipName = isFolder && listing.folderName ? listing.folderName : (listing.topName || 'unishare');
      const blob = await zip.generateAsync({ type: 'blob' });
      saveBlob(blob, `${zipName}.zip`);
    } else {
      for (const r of received) saveBlob(r.blob, r.path.split('/').pop());
    }
    setLiveStatus('✓ Download complete. The sender has been notified.');
    notifyDownloaded();
  } catch (err) {
    setLiveStatus('Download failed — the sender may have closed the tab. Ask them to share again.');
  } finally {
    downloading = false;
  }
}

$('downloadAll').addEventListener('click', e => {
  e.preventDefault();
  const files = (listing && listing.files) || [];
  downloadLive(files.map(f => f.path));
});

$('pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('pwInput').value;
  if (!pw || !window.UniShareLive) return;
  $('pwStatus').textContent = '';
  passwordHash = await window.UniShareLive.sha256Hex(pw);
  connectShare();
});

window.addEventListener('pagehide', () => {
  try { if (liveReceiver) liveReceiver.close(); } catch {}
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

function downloadAllAction() {
  if ($('shareCard').hidden) {
    if (!$('pwCard').hidden) $('pwInput').focus();
    return;
  }
  const files = (listing && listing.files) || [];
  downloadLive(files.map(f => f.path));
}

const actions = {
  download: () => downloadAllAction(),
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
  { label: 'Download all', hint: 'DOWNLOAD', run: () => downloadAllAction() },
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

connectShare();
