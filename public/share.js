const $ = id => document.getElementById(id);
const shareId = location.pathname.split('/')[2];

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
}

$('pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('pwInput').value;
  if (!pw) return;
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
