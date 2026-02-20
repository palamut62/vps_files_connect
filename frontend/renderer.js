const API = 'http://localhost:8899';
let currentPath = '.';
let connected = false;
let navHistory = ['.'];
let navIndex = 0;
let selectedFiles = new Set();
let allFileItems = []; // for search filtering
let allFiles = []; // raw file data for sorting
let viewMode = 'grid';
let showHidden = false;
let terminalVisible = false;
let termHistory = [];
let termHistIndex = -1;
let editorFilePath = null;
let editorOrigContent = '';
let termPromptText = '$';

// Load saved credentials on startup
window.addEventListener('DOMContentLoaded', () => {
  const saved = JSON.parse(localStorage.getItem('vps_credentials') || '{}');
  if (saved.host) document.getElementById('host').value = saved.host;
  if (saved.port) document.getElementById('port').value = saved.port;
  if (saved.user) document.getElementById('user').value = saved.user;
  if (saved.password) document.getElementById('password').value = saved.password;

  setupUploadZone();
  setupContextMenu();

  // Deselect when clicking empty grid area
  document.getElementById('fileList').addEventListener('click', (e) => {
    if (e.target.id === 'fileList') {
      document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
      selectedFiles.clear();
    }
  });
});

function saveCredentials() {
  const creds = {
    host: document.getElementById('host').value.trim(),
    port: document.getElementById('port').value,
    user: document.getElementById('user').value.trim(),
    password: document.getElementById('password').value,
  };
  localStorage.setItem('vps_credentials', JSON.stringify(creds));
}

function togglePassword() {
  const input = document.getElementById('password');
  const icon = document.getElementById('togglePass');
  if (input.type === 'password') {
    input.type = 'text';
    icon.innerHTML = '&#128064;';
  } else {
    input.type = 'password';
    icon.innerHTML = '&#128065;';
  }
}

function showStatus(msg, type) {
  const el = document.getElementById('statusBar');
  el.textContent = msg;
  el.className = 'status ' + type;
  if (type === 'success') setTimeout(() => { el.className = 'status'; }, 3000);
}

// Custom modal dialog
function showModal(icon, title, msg, buttons) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    document.getElementById('modalIcon').textContent = icon;
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalMsg').textContent = msg;
    const btnsDiv = document.getElementById('modalBtns');
    btnsDiv.innerHTML = '';

    buttons.forEach((btn) => {
      const b = document.createElement('button');
      b.textContent = btn.label;
      b.className = btn.class || '';
      b.onclick = () => { overlay.classList.remove('active'); resolve(btn.value); };
      btnsDiv.appendChild(b);
    });

    overlay.classList.add('active');
  });
}

function confirmDelete(fileName) {
  return showModal(
    '\u26A0\uFE0F',
    'Dosya Silinecek',
    `"${fileName}" kalici olarak silinecek. Devam edilsin mi?`,
    [
      { label: 'Iptal', class: 'modal-btn-cancel', value: false },
      { label: 'Sil', class: 'modal-btn-confirm', value: true },
    ]
  );
}

function showAlert(icon, title, msg) {
  return showModal(icon, title, msg, [
    { label: 'Tamam', class: 'modal-btn-ok', value: true },
  ]);
}

async function connect() {
  const host = document.getElementById('host').value.trim();
  const port = parseInt(document.getElementById('port').value) || 22;
  const user = document.getElementById('user').value.trim();
  const password = document.getElementById('password').value;

  if (!host || !user) {
    showStatus('Host ve kullanici gerekli', 'error');
    return;
  }

  showStatus('Baglaniyor...', 'info');

  try {
    const res = await fetch(`${API}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, user, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      showStatus(data.error || 'Baglanti hatasi', 'error');
      return;
    }

    connected = true;
    currentPath = '.';
    saveCredentials();
    document.getElementById('connectBtn').classList.add('hidden');
    document.getElementById('disconnectBtn').classList.remove('hidden');
    document.getElementById('fileSection').classList.remove('hidden');
    showStatus('Baglanti basarili', 'success');
    loadSysInfo();
    loadDiskInfo();
    listFiles();
    fetchTerminalMOTD();
  } catch (e) {
    showStatus('Backend\'e ulasilamiyor. Sunucu calisiyor mu?', 'error');
  }
}

async function disconnect() {
  try {
    await fetch(`${API}/disconnect`);
  } catch (_) { }

  connected = false;
  document.getElementById('connectBtn').classList.remove('hidden');
  document.getElementById('disconnectBtn').classList.add('hidden');
  document.getElementById('fileSection').classList.add('hidden');
  document.getElementById('sysInfo').innerHTML = '<div style="color:#5a6a8a; font-size:10px; text-align:center; padding:6px 0; grid-column:1/-1;">Baglanti bekleniyor...</div>';
  document.getElementById('diskBar').innerHTML = '';
  document.getElementById('fileList').innerHTML = '';
  showStatus('Baglanti kesildi', 'info');
}

async function listFiles() {
  if (!connected) return;

  try {
    const res = await fetch(`${API}/files?path=${encodeURIComponent(currentPath)}`);
    const files = await res.json();

    if (!res.ok) {
      showStatus(files.error || 'Dosya listelenemedi', 'error');
      return;
    }

    updateNavButtons();
    renderBreadcrumb();

    allFiles = files;
    document.getElementById('searchBox').value = '';
    renderFiles();
  } catch (e) {
    showStatus('Dosya listeleme hatasi', 'error');
  }
}

function renderFiles() {
  const grid = document.getElementById('fileList');
  grid.innerHTML = '';
  selectedFiles.clear();
  allFileItems = [];

  let files = allFiles.slice();

  // Filter hidden files
  if (!showHidden) {
    files = files.filter(f => !f.name.startsWith('.'));
  }

  // Sort
  const sortBy = document.getElementById('sortSelect').value;
  files.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (sortBy === 'size') return b.size - a.size;
    if (sortBy === 'date') return new Date(b.modTime) - new Date(a.modTime);
    return a.name.localeCompare(b.name);
  });

  // Apply view mode class
  grid.classList.toggle('list-view', viewMode === 'list');

  for (const f of files) {
    const fullPath = currentPath === '.' ? f.name : `${currentPath}/${f.name}`;
    const icon = getFileIcon(f.name, f.isDir);
    const size = f.isDir ? '' : formatSize(f.size);
    const dateStr = new Date(f.modTime).toLocaleString('tr-TR');

    const item = document.createElement('div');
    item.className = 'file-item';
    item.title = `${f.name}\n${size}\n${dateStr}`;
    item.dataset.path = fullPath;
    item.dataset.name = f.name;
    item.dataset.isDir = f.isDir;

    if (f.isDir) {
      item.ondblclick = () => navigateTo(fullPath);
    } else if (isEditableFile(f.name)) {
      item.ondblclick = () => openEditor(fullPath);
    }

    item.onclick = (e) => {
      if (e.ctrlKey) {
        item.classList.toggle('selected');
        if (item.classList.contains('selected')) selectedFiles.add(fullPath);
        else selectedFiles.delete(fullPath);
      } else {
        document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
        selectedFiles.clear();
        item.classList.add('selected');
        selectedFiles.add(fullPath);
      }
    };

    item.oncontextmenu = (e) => showContextMenu(e, fullPath, f.isDir);

    let html = `<div class="icon">${icon}</div><div class="fname">${escapeHtml(f.name)}</div><div class="fsize">${size}</div>`;
    if (viewMode === 'list') {
      html += `<div class="fdate">${dateStr}</div>`;
    }
    item.innerHTML = html;
    grid.appendChild(item);
    allFileItems.push(item);
  }
}

function navigateTo(dirPath) {
  navHistory = navHistory.slice(0, navIndex + 1);
  navHistory.push(dirPath);
  navIndex = navHistory.length - 1;
  currentPath = dirPath;
  listFiles();
}

function navigateUp() {
  if (currentPath === '.' || currentPath === '/') return;
  const parts = currentPath.split('/');
  parts.pop();
  const parent = parts.length === 0 ? '.' : parts.join('/');
  navigateTo(parent);
}

function navigateBack() {
  if (navIndex <= 0) return;
  navIndex--;
  currentPath = navHistory[navIndex];
  listFiles();
}

function navigateForward() {
  if (navIndex >= navHistory.length - 1) return;
  navIndex++;
  currentPath = navHistory[navIndex];
  listFiles();
}

function updateNavButtons() {
  document.getElementById('btnBack').disabled = navIndex <= 0;
  document.getElementById('btnForward').disabled = navIndex >= navHistory.length - 1;
  document.getElementById('btnUp').disabled = currentPath === '.' || currentPath === '/';
}

function renderBreadcrumb() {
  const bar = document.getElementById('pathBar');
  bar.innerHTML = '';

  if (currentPath === '.') {
    const span = document.createElement('span');
    span.className = 'crumb';
    span.textContent = '~ (home)';
    bar.appendChild(span);
    return;
  }

  const home = document.createElement('span');
  home.className = 'crumb';
  home.textContent = '~';
  home.onclick = () => navigateTo('.');
  bar.appendChild(home);

  const parts = currentPath.split('/');
  for (let i = 0; i < parts.length; i++) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    bar.appendChild(sep);

    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = parts[i];
    if (i < parts.length - 1) {
      const target = parts.slice(0, i + 1).join('/');
      crumb.onclick = () => navigateTo(target);
    }
    bar.appendChild(crumb);
  }
}

// Upload files to VPS
async function uploadFileList(files) {
  if (!connected || !files.length) {
    if (!connected) showStatus('Once sunucuya baglanin', 'error');
    return;
  }

  for (const file of files) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('path', currentPath);

    showStatus(`Yukleniyor: ${file.name}...`, 'info');

    try {
      const res = await fetch(`${API}/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) {
        showStatus(`Yukleme hatasi: ${data.error}`, 'error');
        return;
      }
    } catch (e) {
      showStatus('Yukleme hatasi', 'error');
      return;
    }
  }

  showStatus('Yukleme tamamlandi', 'success');
  listFiles();
  loadDiskInfo();
}

// Upload zone: click, drag-drop, paste
function setupUploadZone() {
  const zone = document.getElementById('uploadZone');
  const input = document.getElementById('fileInput');

  // Click to select files
  zone.addEventListener('click', () => input.click());

  // File selected via dialog -> auto upload
  input.addEventListener('change', () => {
    if (input.files.length) {
      uploadFileList(input.files);
      input.value = '';
    }
  });

  // Paste (Ctrl+V) anywhere
  document.addEventListener('paste', (e) => {
    if (!connected) return;
    const items = e.clipboardData && e.clipboardData.files;
    if (items && items.length) {
      e.preventDefault();
      uploadFileList(items);
    }
  });
}

// Context menu
let ctxTargetPath = null;
let ctxTargetIsDir = false;

function setupContextMenu() {
  const menu = document.getElementById('ctxMenu');

  document.addEventListener('click', () => {
    menu.classList.remove('active');
    ctxTargetPath = null;
  });

  document.getElementById('ctxEdit').addEventListener('click', () => {
    menu.classList.remove('active');
    if (ctxTargetPath && !ctxTargetIsDir) openEditor(ctxTargetPath);
  });

  document.getElementById('ctxDelete').addEventListener('click', () => {
    menu.classList.remove('active');
    if (ctxTargetPath) deleteFile(ctxTargetPath);
  });

  document.getElementById('ctxRename').addEventListener('click', () => {
    menu.classList.remove('active');
    if (ctxTargetPath) promptRename(ctxTargetPath);
  });

  document.getElementById('ctxDownload').addEventListener('click', () => {
    menu.classList.remove('active');
    if (ctxTargetPath && !ctxTargetIsDir) downloadFile(ctxTargetPath);
  });

  document.getElementById('ctxDeleteSelected').addEventListener('click', () => {
    menu.classList.remove('active');
    deleteSelected();
  });

  document.getElementById('ctxDownloadSelected').addEventListener('click', () => {
    menu.classList.remove('active');
    downloadSelected();
  });
}

function showContextMenu(e, filePath, isDir) {
  e.preventDefault();
  e.stopPropagation();
  const menu = document.getElementById('ctxMenu');
  ctxTargetPath = filePath;
  ctxTargetIsDir = isDir;

  // Show/hide multi-select options
  const hasMulti = selectedFiles.size > 1;
  document.getElementById('ctxMultiSep').style.display = hasMulti ? '' : 'none';
  document.getElementById('ctxDeleteSelected').style.display = hasMulti ? '' : 'none';
  document.getElementById('ctxDownloadSelected').style.display = hasMulti ? '' : 'none';

  // Hide download for dirs
  document.getElementById('ctxDownload').style.display = isDir ? 'none' : '';

  // Show edit only for editable files
  const isEditable = !isDir && isEditableFile(filePath.split('/').pop());
  document.getElementById('ctxEdit').style.display = isEditable ? '' : 'none';

  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 160) + 'px';
  menu.classList.add('active');
}

async function deleteFile(filePath) {
  const ok = await confirmDelete(filePath.split('/').pop());
  if (!ok) return;

  try {
    const res = await fetch(`${API}/delete?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
    const data = await res.json();

    if (!res.ok) {
      showStatus(`Silme hatasi: ${data.error}`, 'error');
      return;
    }

    showStatus('Dosya silindi', 'success');
    listFiles();
    loadDiskInfo();
  } catch (e) {
    showStatus('Silme hatasi', 'error');
  }
}

// Rename
async function promptRename(filePath) {
  const oldName = filePath.split('/').pop();
  const newName = await showInputModal('\u270F\uFE0F', 'Yeniden Adlandir', oldName);
  if (!newName || newName === oldName) return;

  const dir = filePath.substring(0, filePath.length - oldName.length);
  const newPath = dir + newName;

  try {
    const res = await fetch(`${API}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath: filePath, newPath }),
    });
    const data = await res.json();
    if (!res.ok) { showStatus(`Hata: ${data.error}`, 'error'); return; }
    showStatus('Yeniden adlandirildi', 'success');
    listFiles();
  } catch (e) { showStatus('Hata', 'error'); }
}

// New folder
async function promptNewFolder() {
  if (!connected) return;
  const name = await showInputModal('\u{1F4C1}', 'Yeni Klasor', '');
  if (!name) return;

  const folderPath = currentPath === '.' ? name : `${currentPath}/${name}`;

  try {
    const res = await fetch(`${API}/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath }),
    });
    const data = await res.json();
    if (!res.ok) { showStatus(`Hata: ${data.error}`, 'error'); return; }
    showStatus('Klasor olusturuldu', 'success');
    listFiles();
  } catch (e) { showStatus('Hata', 'error'); }
}

// Download file
function downloadFile(filePath) {
  const url = `${API}/download?path=${encodeURIComponent(filePath)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filePath.split('/').pop();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showStatus('Indiriliyor...', 'info');
}

// Multi-select delete
async function deleteSelected() {
  if (selectedFiles.size === 0) return;
  const ok = await confirmDelete(`${selectedFiles.size} dosya`);
  if (!ok) return;

  for (const fp of selectedFiles) {
    try {
      const res = await fetch(`${API}/delete?path=${encodeURIComponent(fp)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        showStatus(`Hata: ${data.error}`, 'error');
        return;
      }
    } catch (e) { showStatus('Hata', 'error'); return; }
  }

  selectedFiles.clear();
  showStatus('Secilen dosyalar silindi', 'success');
  listFiles();
  loadDiskInfo();
}

// Multi-select download
function downloadSelected() {
  for (const fp of selectedFiles) {
    downloadFile(fp);
  }
}

// Search/filter
function filterFiles() {
  const query = document.getElementById('searchBox').value.toLowerCase();
  for (const item of allFileItems) {
    const name = item.dataset.name.toLowerCase();
    item.style.display = name.includes(query) ? '' : 'none';
  }
}

// Input modal (for rename/new folder)
function showInputModal(icon, title, defaultVal) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    document.getElementById('modalIcon').textContent = icon;
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalMsg').innerHTML = `<input type="text" class="modal-input" id="modalInputField" value="${escapeHtml(defaultVal)}">`;

    const btnsDiv = document.getElementById('modalBtns');
    btnsDiv.innerHTML = '';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Iptal';
    cancelBtn.className = 'modal-btn-cancel';
    cancelBtn.onclick = () => { overlay.classList.remove('active'); resolve(null); };
    btnsDiv.appendChild(cancelBtn);

    const okBtn = document.createElement('button');
    okBtn.textContent = 'Tamam';
    okBtn.className = 'modal-btn-ok';
    okBtn.onclick = () => {
      const val = document.getElementById('modalInputField').value.trim();
      overlay.classList.remove('active');
      resolve(val || null);
    };
    btnsDiv.appendChild(okBtn);

    overlay.classList.add('active');
    setTimeout(() => {
      const inp = document.getElementById('modalInputField');
      inp.focus();
      inp.select();
      inp.onkeydown = (e) => { if (e.key === 'Enter') okBtn.click(); if (e.key === 'Escape') cancelBtn.click(); };
    }, 50);
  });
}

// Handle drop on upload zone (called from HTML inline handler)
function handleZoneDrop(e) {
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    uploadFileList(e.dataTransfer.files);
  }
}

// Prevent Electron from navigating when files are dragged elsewhere
document.ondragover = function (e) { e.preventDefault(); return false; };
document.ondrop = function (e) { e.preventDefault(); return false; };

async function loadSysInfo() {
  try {
    const res = await fetch(`${API}/sysinfo`);
    const info = await res.json();
    if (!res.ok) return;

    const c = document.getElementById('sysInfo');
    c.innerHTML = '';

    const rows = [
      { icon: '\u{1F4BB}', label: '', val: info.hostname, full: false },
      { icon: '\u{1F310}', label: '', val: info.ip, full: false },
      { icon: '\u{1F4E6}', label: '', val: info.os, full: true },
      { icon: '\u2699\uFE0F', label: '', val: info.cpu, full: true },
      { icon: '\u{1F9E9}', label: '', val: info.cores ? info.cores + ' Core' : '', full: false },
      { icon: '\u{1F4D0}', label: '', val: info.arch, full: false },
      { icon: '\u{1F4CA}', label: 'Load', val: info.load, full: false },
      { icon: '\u{1F552}', label: '', val: info.uptime ? info.uptime.replace('up ', '') : '', full: false },
    ];

    for (const r of rows) {
      if (!r.val) continue;
      const div = document.createElement('div');
      div.className = 'sys-row' + (r.full ? ' sys-full' : '');
      div.innerHTML = `<span class="si">${r.icon}</span>${r.label ? '<span class="sl">' + r.label + '</span>' : ''}<span class="sv">${r.val}</span>`;
      c.appendChild(div);
    }

    // RAM
    if (info.ram_total && info.ram_used) {
      const total = parseInt(info.ram_total);
      const used = parseInt(info.ram_used);
      const pct = Math.round((used / total) * 100);
      const color = pct < 70 ? '#4a6cf7' : pct < 90 ? '#f39c12' : '#e74c3c';

      const ramDiv = document.createElement('div');
      ramDiv.className = 'ram-row';
      ramDiv.innerHTML = `<span class="si">\u{1F4BE}</span><div class="ram-bar"><div class="ram-fill" style="width:${pct}%;background:${color}"></div></div><span class="ram-text">${formatSize(used)}/${formatSize(total)} ${pct}%</span>`;
      c.appendChild(ramDiv);
    }
  } catch (e) {
    console.error('Sys info error:', e);
  }
}

async function loadDiskInfo() {
  try {
    const res = await fetch(`${API}/diskinfo`);
    const disks = await res.json();
    if (!res.ok) return;

    const bar = document.getElementById('diskBar');
    bar.innerHTML = '';

    for (let i = 0; i < disks.length; i++) {
      const d = disks[i];
      const pct = parseInt(d.usePercent) || 0;
      const colorClass = pct < 70 ? 'low' : pct < 90 ? 'mid' : 'high';
      const avail = formatSize(d.available);
      const total = formatSize(d.total);

      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'sb-sep';
        sep.textContent = '|';
        bar.appendChild(sep);
      }

      const item = document.createElement('div');
      item.className = 'sb-disk';
      item.innerHTML = `<span class="sb-disk-name">${d.mountedOn}</span><div class="sb-disk-bar"><div class="sb-disk-fill ${colorClass}" style="width:${pct}%"></div></div><span class="sb-disk-text">${avail} bos / ${total}</span>`;
      bar.appendChild(item);
    }
  } catch (e) {
    console.error('Disk info error:', e);
  }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getFileIcon(name, isDir) {
  if (isDir) return '\u{1F4C1}';
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    png: '\u{1F5BC}', jpg: '\u{1F5BC}', jpeg: '\u{1F5BC}', gif: '\u{1F5BC}', bmp: '\u{1F5BC}', svg: '\u{1F5BC}', webp: '\u{1F5BC}', ico: '\u{1F5BC}',
    mp4: '\u{1F3AC}', mkv: '\u{1F3AC}', avi: '\u{1F3AC}', mov: '\u{1F3AC}', wmv: '\u{1F3AC}', flv: '\u{1F3AC}', webm: '\u{1F3AC}',
    mp3: '\u{1F3B5}', wav: '\u{1F3B5}', flac: '\u{1F3B5}', aac: '\u{1F3B5}', ogg: '\u{1F3B5}', wma: '\u{1F3B5}',
    zip: '\u{1F4E6}', rar: '\u{1F4E6}', '7z': '\u{1F4E6}', tar: '\u{1F4E6}', gz: '\u{1F4E6}', bz2: '\u{1F4E6}', xz: '\u{1F4E6}',
    js: '\u{1F4DC}', ts: '\u{1F4DC}', py: '\u{1F4DC}', go: '\u{1F4DC}', rs: '\u{1F4DC}', java: '\u{1F4DC}', c: '\u{1F4DC}', cpp: '\u{1F4DC}', h: '\u{1F4DC}', cs: '\u{1F4DC}', rb: '\u{1F4DC}', php: '\u{1F4DC}', sh: '\u{1F4DC}', bat: '\u{1F4DC}',
    pdf: '\u{1F4D5}', doc: '\u{1F4C4}', docx: '\u{1F4C4}', xls: '\u{1F4CA}', xlsx: '\u{1F4CA}', ppt: '\u{1F4CA}', pptx: '\u{1F4CA}',
    txt: '\u{1F4DD}', md: '\u{1F4DD}', log: '\u{1F4DD}', csv: '\u{1F4DD}', json: '\u{1F4DD}', xml: '\u{1F4DD}', yaml: '\u{1F4DD}', yml: '\u{1F4DD}', ini: '\u{1F4DD}', cfg: '\u{1F4DD}', conf: '\u{1F4DD}',
    html: '\u{1F310}', htm: '\u{1F310}', css: '\u{1F310}',
    exe: '\u2699\uFE0F', msi: '\u2699\uFE0F', deb: '\u2699\uFE0F', rpm: '\u2699\uFE0F', apk: '\u2699\uFE0F',
    iso: '\u{1F4BF}', img: '\u{1F4BF}',
    db: '\u{1F5C3}', sql: '\u{1F5C3}', sqlite: '\u{1F5C3}',
    pem: '\u{1F510}', key: '\u{1F510}', crt: '\u{1F510}', cer: '\u{1F510}',
  };
  return icons[ext] || '\u{1F4C4}';
}

// View toggle
function setView(mode) {
  viewMode = mode;
  document.getElementById('btnGridView').classList.toggle('active', mode === 'grid');
  document.getElementById('btnListView').classList.toggle('active', mode === 'list');
  if (allFiles.length) renderFiles();
}

// Sort
function sortFiles() {
  if (allFiles.length) renderFiles();
}

// Hidden files toggle
function toggleHidden() {
  showHidden = !showHidden;
  document.getElementById('btnHidden').classList.toggle('active', showHidden);
  if (allFiles.length) renderFiles();
}

// Terminal
function toggleTerminal() {
  terminalVisible = !terminalVisible;
  const panel = document.getElementById('terminalPanel');
  // Clear any inline height from resize so CSS transition works
  panel.style.height = '';
  panel.style.transition = '';
  panel.classList.toggle('open', terminalVisible);
  document.getElementById('btnTerminal').classList.toggle('active', terminalVisible);
  if (terminalVisible) {
    setTimeout(() => document.getElementById('termInput').focus(), 260);
  }
}

// Fetch SSH MOTD (welcome message) on connect
async function fetchTerminalMOTD() {
  const output = document.getElementById('termOutput');
  output.innerHTML = '';

  try {
    // Get hostname for prompt
    const hostRes = await fetch(`${API}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'hostname' }),
    });
    const hostData = await hostRes.json();
    const hostname = hostData.output ? hostData.output.trim() : 'vps';
    const user = document.getElementById('user').value.trim() || 'root';
    termPromptText = `${user}@${hostname}:~#`;
    document.getElementById('termPrompt').textContent = termPromptText;

    // Get MOTD
    const motdRes = await fetch(`${API}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'cat /etc/motd 2>/dev/null; cat /run/motd.dynamic 2>/dev/null; echo ""' }),
    });
    const motdData = await motdRes.json();

    if (motdData.output && motdData.output.trim()) {
      output.innerHTML += `<span class="term-motd">${escapeHtml(motdData.output)}</span>`;
    }

    // Get last login info
    const loginRes = await fetch(`${API}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'last -1 -R | head -1' }),
    });
    const loginData = await loginRes.json();
    if (loginData.output && loginData.output.trim()) {
      output.innerHTML += `<span class="term-motd">Last login: ${escapeHtml(loginData.output.trim())}</span>\n`;
    }

    output.innerHTML += `<span class="term-success">Baglanti kuruldu — ${escapeHtml(hostname)}</span>\n\n`;
  } catch (e) {
    output.innerHTML += `<span class="term-error">Terminal bilgisi alinamadi</span>\n`;
  }

  output.scrollTop = output.scrollHeight;
}

async function runTermCommand() {
  const input = document.getElementById('termInput');
  const output = document.getElementById('termOutput');
  const cmd = input.value.trim();
  if (!cmd) return;

  if (!connected) {
    output.innerHTML += `<span class="term-error">Hata: once sunucuya baglanin</span>\n`;
    output.scrollTop = output.scrollHeight;
    return;
  }

  termHistory.push(cmd);
  termHistIndex = termHistory.length;
  input.value = '';

  output.innerHTML += `<span class="term-cmd">${escapeHtml(termPromptText)} ${escapeHtml(cmd)}</span>\n`;

  if (cmd === 'clear') {
    output.innerHTML = '';
    return;
  }

  try {
    const res = await fetch(`${API}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    });
    const data = await res.json();
    if (!res.ok) {
      output.innerHTML += `<span class="term-error">${escapeHtml(data.error || 'Bilinmeyen hata')}</span>\n`;
    } else {
      const out = data.output || '';
      if (out) output.innerHTML += escapeHtml(out);
      if (!out.endsWith('\n')) output.innerHTML += '\n';
      if (data.exitCode !== 0) {
        output.innerHTML += `<span class="term-warn">exit code: ${data.exitCode}</span>\n`;
      }
    }
  } catch (e) {
    output.innerHTML += `<span class="term-error">Hata: backend'e ulasilamiyor - ${escapeHtml(e.message)}</span>\n`;
  }

  output.scrollTop = output.scrollHeight;
}

// Editable file extensions
const EDITABLE_EXTS = new Set([
  'txt','md','log','csv','json','xml','yaml','yml','ini','cfg','conf','toml',
  'js','ts','jsx','tsx','py','go','rs','java','c','cpp','h','cs','rb','php','sh','bat','ps1',
  'html','htm','css','scss','less','sql','env','gitignore','dockerignore',
  'dockerfile','makefile','cmake','gradle','properties','lock','map','svg',
]);

function isEditableFile(name) {
  const ext = name.split('.').pop().toLowerCase();
  const baseName = name.toLowerCase();
  return EDITABLE_EXTS.has(ext) || ['dockerfile','makefile','.gitignore','.env','.dockerignore'].includes(baseName);
}

function getLang(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = { js:'JavaScript', ts:'TypeScript', py:'Python', go:'Go', rs:'Rust', java:'Java',
    c:'C', cpp:'C++', cs:'C#', rb:'Ruby', php:'PHP', sh:'Shell', html:'HTML', css:'CSS',
    json:'JSON', xml:'XML', yaml:'YAML', yml:'YAML', sql:'SQL', md:'Markdown', txt:'Text',
    toml:'TOML', ini:'INI', svg:'SVG', scss:'SCSS', less:'LESS', jsx:'JSX', tsx:'TSX' };
  return map[ext] || ext.toUpperCase();
}

async function openEditor(filePath) {
  showStatus('Dosya aciliyor...', 'info');
  try {
    const res = await fetch(`${API}/readfile?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (!res.ok) { showStatus(data.error || 'Dosya acilamadi', 'error'); return; }

    editorFilePath = filePath;
    editorOrigContent = data.content;
    const fileName = filePath.split('/').pop();

    document.getElementById('editorFilename').textContent = filePath;
    document.getElementById('editorLang').textContent = getLang(fileName);
    document.getElementById('editorSize').textContent = formatSize(data.size);
    document.getElementById('editorModified').textContent = '';
    document.getElementById('editorModified').className = '';

    const ta = document.getElementById('editorTextarea');
    ta.value = data.content;
    updateEditorLines();
    updateEditorCursor();

    document.getElementById('editorOverlay').classList.add('active');
    ta.focus();
    showStatus('', '');
  } catch (e) {
    showStatus('Dosya acma hatasi', 'error');
  }
}

function closeEditor() {
  const ta = document.getElementById('editorTextarea');
  if (ta.value !== editorOrigContent) {
    showModal('\u26A0\uFE0F', 'Kaydedilmemis Degisiklik', 'Degisiklikler kaydedilmedi. Kapatilsin mi?', [
      { label: 'Iptal', class: 'modal-btn-cancel', value: false },
      { label: 'Kapat', class: 'modal-btn-confirm', value: true },
    ]).then(ok => {
      if (ok) { document.getElementById('editorOverlay').classList.remove('active'); editorFilePath = null; }
    });
  } else {
    document.getElementById('editorOverlay').classList.remove('active');
    editorFilePath = null;
  }
}

async function saveEditorFile() {
  if (!editorFilePath) return;
  const content = document.getElementById('editorTextarea').value;

  showStatus('Kaydediliyor...', 'info');
  try {
    const res = await fetch(`${API}/writefile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: editorFilePath, content }),
    });
    const data = await res.json();
    if (!res.ok) { showStatus(data.error || 'Kaydetme hatasi', 'error'); return; }

    editorOrigContent = content;
    document.getElementById('editorModified').textContent = '';
    document.getElementById('editorModified').className = '';
    document.getElementById('editorSize').textContent = formatSize(data.size);
    showStatus('Kaydedildi', 'success');
    listFiles();
  } catch (e) {
    showStatus('Kaydetme hatasi', 'error');
  }
}

function updateEditorLines() {
  const ta = document.getElementById('editorTextarea');
  const lines = ta.value.split('\n').length;
  const linesDiv = document.getElementById('editorLines');
  let html = '';
  for (let i = 1; i <= lines; i++) html += i + '<br>';
  linesDiv.innerHTML = `<div style="padding:0 6px">${html}</div>`;
}

function updateEditorCursor() {
  const ta = document.getElementById('editorTextarea');
  const pos = ta.selectionStart;
  const text = ta.value.substring(0, pos);
  const line = text.split('\n').length;
  const col = pos - text.lastIndexOf('\n');
  document.getElementById('editorCursor').textContent = `Satir ${line}, Sutun ${col}`;

  // Modified indicator
  if (ta.value !== editorOrigContent) {
    document.getElementById('editorModified').textContent = 'Degistirildi';
    document.getElementById('editorModified').className = 'editor-modified';
  } else {
    document.getElementById('editorModified').textContent = '';
    document.getElementById('editorModified').className = '';
  }
}

// Editor event listeners
document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('editorTextarea');
  ta.addEventListener('input', () => { updateEditorLines(); updateEditorCursor(); });
  ta.addEventListener('click', updateEditorCursor);
  ta.addEventListener('keyup', updateEditorCursor);
  ta.addEventListener('scroll', () => {
    document.getElementById('editorLines').scrollTop = ta.scrollTop;
  });

  // Tab key support in editor
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
      updateEditorLines();
      updateEditorCursor();
    }
    // Ctrl+S to save
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      saveEditorFile();
    }
    // Escape to close
    if (e.key === 'Escape') {
      closeEditor();
    }
  });
});

// Terminal history navigation, global shortcut, and resize
document.addEventListener('DOMContentLoaded', () => {
  const termInput = document.getElementById('termInput');
  termInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (termHistIndex > 0) { termHistIndex--; termInput.value = termHistory[termHistIndex]; }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (termHistIndex < termHistory.length - 1) { termHistIndex++; termInput.value = termHistory[termHistIndex]; }
      else { termHistIndex = termHistory.length; termInput.value = ''; }
    }
  });

  // Global shortcut for terminal toggle (Ctrl + Backtick)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      toggleTerminal();
    }
  });

  // Terminal close button
  document.getElementById('btnTermClose').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTerminal();
  });

  // Resize handle for terminal
  const resizeHandle = document.getElementById('termResizeHandle');
  const termPanel = document.getElementById('terminalPanel');
  let isResizing = false;
  let startY = 0;
  let startH = 0;

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startY = e.clientY;
    startH = termPanel.offsetHeight;
    termPanel.style.transition = 'none';
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const delta = startY - e.clientY;
    const newH = Math.max(100, Math.min(startH + delta, window.innerHeight * 0.7));
    termPanel.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    termPanel.style.transition = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
});
