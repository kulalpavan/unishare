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
  uploadBtn.disabled = true;
  statusEl.classList.remove('err');
  statusEl.textContent = 'Uploading…';

  try {
    const fd = new FormData();
    for (const f of pickedFiles) {
      fd.append('files', f, f.name);
      fd.append('paths', relPath(f));
    }
    fd.append('kind', pickedFiles.length ? pickedKind : 'note');
    fd.append('text', text);
    fd.append('password', passwordInput.value);
    fd.append('expiryValue', expiryValue.value || expiryUnit.value);
    fd.append('expiryUnit', expiryUnit.value);

    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed.');

    const url = new URL(data.url, location.href).href;
    $('shareLink').textContent = url;
    $('shareLink').href = url;
    $('resultMeta').textContent = [
      data.kind === 'folder' ? `Folder · ${data.folderName}` : (data.kind === 'note' ? 'Text note' : 'Files'),
      data.locked ? 'Password protected' : 'No password',
      data.expiresAt ? `Expires ${new Date(data.expiresAt).toLocaleString()}` : 'Never expires'
    ].join(' · ');
    $('result').hidden = false;
    $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    statusEl.textContent = '';

    navigator.clipboard.writeText(url).catch(() => {});
  } catch (err) {
    statusEl.textContent = err.message;
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
