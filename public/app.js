const $ = id => document.getElementById(id);
const fileInput = $('fileInput');
const folderInput = $('folderInput');
const textInput = $('textInput');
const passwordInput = $('passwordInput');
const expiryValue = $('expiryValue');
const expiryUnit = $('expiryUnit');
const uploadBtn = $('uploadBtn');
const statusEl = $('status');
const pickedList = $('picked');
const drop = $('drop');

const QUALIFIED = [];
let pickedFiles = [];
let pickedKind = 'files';

function relPath(file) {
  if (file.webkitRelativePath) return file.webkitRelativePath;
  const match = QUALIFIED.find(q => q.file === file);
  return match ? match.path : file.name;
}

function refreshPicked() {
  pickedList.hidden = pickedFiles.length === 0;
  pickedList.innerHTML = '';
  const max = 40;
  if (pickedKind === 'folder' && pickedFiles.length) {
    const top = relPath(pickedFiles[0]).split('/')[0];
    const li = document.createElement('li');
    li.className = 'picked-folder';
    li.textContent = `▥ Folder: ${top}/ — ${pickedFiles.length} file${pickedFiles.length > 1 ? 's' : ''}`;
    pickedList.appendChild(li);
  }
  pickedFiles.slice(0, max).forEach(f => {
    const li = document.createElement('li');
    li.textContent = `${relPath(f)} (${f.size} bytes)`;
    pickedList.appendChild(li);
  });
  if (pickedFiles.length > max) {
    const li = document.createElement('li');
    li.textContent = `…and ${pickedFiles.length - max} more`;
    pickedList.appendChild(li);
  }
}

function setPicked(list, kind) {
  pickedFiles = [...list];
  const computed = pickedFiles.map(f => relPath(f));
  QUALIFIED.length = 0;
  pickedFiles.forEach((f, i) => QUALIFIED.push({ file: f, path: computed[i] }));
  pickedKind = kind || (computed.some(p => p.includes('/')) ? 'folder' : 'files');
  if (pickedFiles.length && fileInput.files.length) fileInput.value = '';
  refreshPicked();
}

$('pickFiles').addEventListener('click', () => fileInput.click());
$('pickFolder').addEventListener('click', () => folderInput.click());

fileInput.addEventListener('change', () => { setPicked(fileInput.files, 'files'); folderInput.value = ''; });
folderInput.addEventListener('change', () => { setPicked(folderInput.files, 'folder'); fileInput.value = ''; });

['dragenter', 'dragover'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => {
  const items = [...(e.dataTransfer.items || [])];
  const entries = items.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) {
    setPicked(e.dataTransfer.files, 'files');
    return;
  }
  const hasDir = entries.some(en => en.isDirectory);
  readAllEntries(entries, '').then(files => setPicked(files, hasDir ? 'folder' : 'files'));
});

function readAllEntries(entries, prefix) {
  const files = [];
  return Promise.all(entries.map(entry => walkEntry(entry, prefix, files)))
    .then(() => files);
}

function walkEntry(entry, prefix, files) {
  return new Promise(resolve => {
    if (entry.isFile) {
      entry.file(f => {
        QUALIFIED.push({ file: f, path: prefix + f.name });
        files.push(f);
        resolve();
      }, resolve);
    } else {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => reader.readEntries(batch => {
        if (!batch.length) {
          Promise.all(all.map(e => walkEntry(e, prefix + entry.name + '/', files)))
            .then(resolve);
          return;
        }
        all.push(...batch);
        readBatch();
      }, resolve);
      readBatch();
    }
  });
}

uploadBtn.addEventListener('click', doUpload);

const EXPIRY_UNITS = { minutes: 60e3, hours: 3600e3, days: 86400e3 };

// --- Live P2P share --------------------------------------------------------
// No upload: files and text stay in this tab. Creating a link registers this
// tab as the live sender; the receiver downloads straight from here.
let liveSender = null;
let liveDone = false;
let liveFileState = new Map(); // path -> 'waiting' | 'sending' | 'done'

function setLiveStatus(msg, cls) {
  const el = $('liveStatus');
  el.hidden = false;
  el.textContent = msg;
  el.className = `status ${cls || ''}`.trim();
}

function renderLiveFiles() {
  const list = $('liveFiles');
  list.innerHTML = '';
  if (!liveFileState.size) { list.hidden = true; return; }
  list.hidden = false;
  for (const [p, state] of liveFileState) {
    const li = document.createElement('li');
    if (state === 'done') li.className = 'done';
    li.textContent = state === 'done' ? `✓ ${p}` : state === 'sending' ? `⇅ ${p} — sending…` : `○ ${p} — waiting for receiver`;
    list.appendChild(li);
  }
}

function updateTabWarning() {
  const warn = $('tabWarning');
  if (!liveSender || liveDone) { warn.hidden = true; return; }
  warn.hidden = false;
  warn.textContent = '⚠ Don\'t close this tab until the receiver has downloaded. Keep it open and in the foreground — the files live only in this tab, and closing or backgrounding it ends the share.';
}

window.addEventListener('beforeunload', e => {
  if (liveSender && !liveDone) {
    e.preventDefault();
    e.returnValue = '';
  }
});

window.addEventListener('pagehide', () => {
  try { if (liveSender) liveSender.close(); } catch {}
});

$('stopShareBtn').addEventListener('click', () => {
  try { if (liveSender) liveSender.close(); } catch {}
  liveSender = null;
  liveDone = false;
  $('stopShareBtn').hidden = true;
  setLiveStatus('Share ended. This link no longer works.', 'err');
  updateTabWarning();
});

async function doUpload() {
  const text = textInput.value;
  if (!pickedFiles.length && !text.trim()) {
    statusEl.textContent = 'Add files, a folder, or a text note first.';
    statusEl.classList.add('err');
    return;
  }
  if (expiryValue.value && expiryUnit.value === 'none') {
    statusEl.textContent = 'Pick a unit (minutes/hours/days) for the expiry you entered.';
    statusEl.classList.add('err');
    return;
  }
  if (!window.UniShareLive || !window.RTCPeerConnection) {
    statusEl.textContent = 'Live sharing needs WebRTC, which this browser does not support.';
    statusEl.classList.add('err');
    return;
  }
  uploadBtn.disabled = true;
  statusEl.classList.remove('err');
  statusEl.textContent = 'Creating live share…';

  try {
    try { if (liveSender) liveSender.close(); } catch {}
    liveSender = null;
    liveDone = false;

    const id = window.UniShareLive.makeId();
    const password = passwordInput.value;
    const passwordHash = password ? await window.UniShareLive.sha256Hex(password) : null;

    let expiresAt = null;
    const evVal = Number(expiryValue.value);
    if (evVal > 0 && EXPIRY_UNITS[expiryUnit.value]) {
      expiresAt = Date.now() + Math.round(evVal * EXPIRY_UNITS[expiryUnit.value]);
    }

    const files = pickedFiles.map(f => ({ file: f, path: relPath(f) }));
    let kind;
    let folderName = null;
    if (!files.length) {
      kind = 'note';
    } else {
      const tops = new Set(files.map(f => f.path.split('/')[0]));
      const allNested = files.every(f => f.path.includes('/'));
      if (pickedKind === 'folder' || (pickedKind !== 'files' && tops.size === 1 && allNested)) {
        if (tops.size !== 1 || !allNested) throw new Error('A folder upload must keep its files inside one top-level folder.');
        kind = 'folder';
        folderName = files[0].path.split('/')[0];
      } else {
        kind = 'files';
      }
    }
    let topName;
    if (kind === 'note') topName = 'note.txt';
    else if (kind === 'folder') topName = folderName;
    else if (files.length === 1) topName = files[0].path.split('/').pop();
    else topName = 'files';

    const listing = {
      kind,
      topName,
      folderName,
      files: files.map(f => ({ path: f.path, size: f.file.size })),
      hasText: !!text.trim()
    };

    liveFileState = new Map(files.map(f => [f.path, 'waiting']));
    renderLiveFiles();

    liveSender = await window.UniShareLive.startSender({
      id,
      files,
      text,
      listing,
      passwordHash,
      expiresAt,
      onStatus: msg => setLiveStatus(msg),
      onReceiverJoin: () => {
        setLiveStatus('Receiver connected. Sending directly from this tab…');
        updateTabWarning();
      },
      onReceiverLeft: () => {
        setLiveStatus('Receiver left. Keep this tab open for another download, or stop sharing below.');
        updateTabWarning();
      },
      onProgress: (path, done, total) => {
        liveFileState.set(path, 'sending');
        renderLiveFiles();
        setLiveStatus(`Sending ${path} — ${Math.round((done / total) * 100)}%`);
      },
      onFileSent: path => {
        liveFileState.set(path, 'done');
        renderLiveFiles();
      },
      onTransferComplete: () => {
        liveDone = true;
        for (const p of liveFileState.keys()) liveFileState.set(p, 'done');
        renderLiveFiles();
        setLiveStatus('✓ Receiver downloaded everything. You can safely close this tab now.', 'ok');
        updateTabWarning();
      }
    });

    const url = new URL(`/s/${id}`, location.href).href;
    $('shareLink').textContent = url;
    $('shareLink').href = url;
    $('resultMeta').textContent = [
      kind === 'folder' ? `Folder · ${folderName}` : (kind === 'note' ? 'Text note' : 'Files'),
      password ? 'Password protected' : 'No password',
      expiresAt ? `Expires ${new Date(expiresAt).toLocaleString()}` : 'Never expires',
      'Live P2P — no server storage'
    ].join(' · ');
    $('result').hidden = false;
    $('stopShareBtn').hidden = false;
    $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    statusEl.textContent = '';
    setLiveStatus('Live: waiting for the receiver. Keep this tab open.');
    updateTabWarning();

    navigator.clipboard.writeText(url).catch(() => {});
  } catch (err) {
    statusEl.textContent = err.message || 'Could not create the share.';
    statusEl.classList.add('err');
  } finally {
    uploadBtn.disabled = false;
  }
}

$('copyBtn').addEventListener('click', () => copyLink($('shareLink').textContent));

function copyLink(v) {
  if (!v) {
    statusEl.textContent = 'Create a share link first.';
    statusEl.classList.add('err');
    return;
  }
  navigator.clipboard.writeText(v).then(() => {
    flashCopy('Copied!');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = v;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    flashCopy('Copied!');
  });
}

function flashCopy(label) {
  const btn = $('copyBtn');
  btn.textContent = label;
  setTimeout(() => { btn.textContent = '⧉ Copy'; }, 1500);
}

function tickClock() {
  const el = $('clock');
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
tickClock();
setInterval(tickClock, 15000);

const commands = [
  { label: 'Choose files', hint: 'FILES', run: () => $('pickFiles').click() },
  { label: 'Choose folder', hint: 'FOLDER', run: () => $('pickFolder').click() },
  { label: 'Focus text note', hint: 'NOTE', run: () => { textInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); textInput.focus(); } },
  { label: 'Set a password', hint: 'LOCK', run: () => { passwordInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); passwordInput.focus(); } },
  { label: 'Create share link', hint: 'ENTER', run: () => doUpload() },
  { label: 'Copy share link', hint: 'COPY', run: () => copyLink($('shareLink').textContent) },
  { label: 'Open share link', hint: 'OPEN', run: () => { const url = $('shareLink').href; if (url) window.open(url, '_blank', 'noopener'); } }
];

const palette = $('palette');
const paletteInput = $('paletteInput');
const paletteList = $('paletteList');
let filtered = commands.slice();
let selected = 0;

const actions = {
  files: () => $('pickFiles').click(),
  folder: () => $('pickFolder').click(),
  note: () => { textInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); textInput.focus(); },
  lock: () => { passwordInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); passwordInput.focus(); },
  upload: () => doUpload(),
  copy: () => copyLink($('shareLink').textContent),
  palette: () => openPalette()
};

document.querySelectorAll('[data-action]').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    const fn = actions[el.dataset.action];
    if (fn) fn();
  });
});

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
