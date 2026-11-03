/* GFM Gudang Alat — PT Sulawesi Cahaya Mineral (Mobile-First Frontend) */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (c) => String(c ?? '').trim().toUpperCase();

let CONFIG = { shiftHours: 12 };
let currentUser = null;
let currentTab = 'database';
let allToolsCache = [];
let allUsersCache = [];
let toolFilter = 'all';
let knownTransferIds = new Set();

// State untuk Halaman Utama DATABASE
let dbState = {
  itemType: 'all',      // 'all' (Semua Barang) | 'tool' (Tools) | 'material' (Material)
  avail: 'all',         // 'all' (Semua Status) | 'ready' (Ready) | 'out' (Keluar)
  cond: 'all',          // 'all' | 'bagus' | 'kalibrasi' | 'eject'
  sort: 'code_asc',     // 'code_asc' | 'name_asc' | 'name_desc' | 'date_desc' | 'date_asc'
  subCat: '',           // Filter sub-kategori
  search: '',           // Kata kunci pencarian
};

// ---------------- API & Auth ----------------
function getToken() { return localStorage.getItem('gfm_token') || ''; }
function setAuth(token, user) {
  if (token) localStorage.setItem('gfm_token', token);
  else localStorage.removeItem('gfm_token');
  currentUser = user || null;
}

async function api(url, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.includes('/api/auth/login')) {
    setAuth('', null);
    renderAuthView();
    throw new Error(data.error || 'Sesi berakhir, silakan login kembali');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const fmtClock = (d = new Date()) => d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return `${d}h ${h % 24}j`;
  if (h) return `${h}j ${m % 60}m`;
  return `${m}m`;
}
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const dateInput = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };

// ---------------- Suara & Getar ----------------
let actx;
function tone(seq, type = 'sine') {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    let t = actx.currentTime;
    for (const [f, d] of seq) {
      const o = actx.createOscillator(); const g = actx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d);
      t += d + 0.03;
    }
  } catch { /* tanpa suara */ }
}
const feedback = {
  ok() { tone([[880, .09], [1320, .14]]); navigator.vibrate?.(80); flash('ok'); },
  ret() { tone([[1320, .09], [880, .14]]); navigator.vibrate?.([60, 40, 60]); flash('ok'); },
  info() { tone([[1000, .07]]); },
  warn() { tone([[540, .12], [720, .12], [540, .12]], 'triangle'); navigator.vibrate?.([120, 60, 120]); },
  err() { tone([[210, .42]], 'square'); navigator.vibrate?.(380); flash('err'); },
};
function flash(kind) {
  const el = document.body;
  el.classList.remove('flash-ok', 'flash-err'); void el.offsetWidth;
  el.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-err');
}

// ---------------- Modal ----------------
function dialog(html, buttons = [{ label: 'Tutup', cls: 'btn-ghost', value: null }]) {
  return new Promise((resolve) => {
    $('#modalCard').innerHTML = `<div>${html}</div><div class="row wrap" style="justify-content:flex-end;margin-top:16px">${
      buttons.map((b, i) => `<button type="button" class="btn ${b.cls || 'btn-ghost'}" data-i="${i}">${esc(b.label)}</button>`).join('')
    }</div>`;
    $('#modal').classList.remove('hidden');
    $$('#modalCard [data-i]').forEach((btn) => btn.onclick = () => {
      const b = buttons[btn.dataset.i];
      if (b.keepOpen) { b.onClick?.(); return; }
      $('#modal').classList.add('hidden');
      resolve(b.value);
    });
  });
}
$('#modal').onclick = (e) => { if (e.target === $('#modal')) $('#modal').classList.add('hidden'); };
const confirmBox = (msg, okLabel = 'Ya') => dialog(`<p>${msg}</p>`, [{ label: 'Batal', value: false }, { label: okLabel, cls: 'btn-danger', value: true }]);

// ---------------- LOGIN & SESI (PILIH CEPAT WAJIB MASUKKAN PASSWORD) ----------------
function selectQuickAccount(username, label) {
  $('#loginUser').value = username;
  $('#loginPass').value = '';
  $('#loginError').classList.add('hidden');
  const banner = $('#quickPickedBanner');
  if (banner) {
    banner.innerHTML = `✅ Akun dipilih: <b>${esc(label || username)}</b><br><span class="small">Silakan ketik password Anda di bawah (Password awal: <code>1234</code>)</span>`;
    banner.classList.remove('hidden');
  }
  const pwInput = $('#loginPass');
  pwInput.classList.add('pw-highlight');
  pwInput.focus();
  setTimeout(() => pwInput.classList.remove('pw-highlight'), 1800);
}

$$('.quick-login [data-u]').forEach((btn) => btn.onclick = () => {
  selectQuickAccount(btn.dataset.u, btn.dataset.label || btn.textContent.trim());
});

$('#quickCrewSelect').onchange = (e) => {
  const val = e.target.value;
  if (!val) return;
  const label = e.target.options[e.target.selectedIndex]?.text || val;
  selectQuickAccount(val, label);
};

if ($('#btnToggleLoginPw')) {
  $('#btnToggleLoginPw').onclick = () => {
    const inp = $('#loginPass');
    const isPw = inp.type === 'password';
    inp.type = isPw ? 'text' : 'password';
    $('#btnToggleLoginPw').textContent = isPw ? '🙈' : '👁️';
    inp.focus();
  };
}

function renderQuickAccountsDropdown(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) return;
  // Pastikan hanya akun riil yang ditampilkan (abaikan jika ada teks skrip atau tag)
  const validAccounts = accounts.filter(
    (a) => a && a.username && /^[A-Z0-9_\-\.]{2,30}$/i.test(a.username) &&
           !/^(FUNCTION|VAR|LET|CONST|IF|RETURN|FRAMES|WINDOW|DOCUMENT|OPEN|FNSET)/i.test(a.username) &&
           !/<[^>]*>|[()\[\]{}'"=;\\\/]/.test(a.username)
  );
  try { localStorage.setItem('gfm_accounts_cache', JSON.stringify(validAccounts)); } catch { /* abaikan */ }
  const sel = $('#quickCrewSelect');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = `<option value="">-- Pilih Akun di Sini (${validAccounts.length} Akun) --</option>` +
    validAccounts.map((a) => {
      const ico = a.role === 'admin' ? '🛡️' : '👷';
      const deptTxt = a.dept ? ` (${a.dept})` : '';
      return `<option value="${esc(a.username)}">${ico} ${esc(a.username)} — ${esc(a.name)}${esc(deptTxt)}</option>`;
    }).join('');
  if (currentVal && validAccounts.some((a) => a.username === currentVal)) sel.value = currentVal;
}

async function loadQuickAccountsList() {
  try {
    const cached = JSON.parse(localStorage.getItem('gfm_accounts_cache') || 'null');
    if (Array.isArray(cached) && cached.length) renderQuickAccountsDropdown(cached);
  } catch { /* abaikan */ }
  try {
    const accounts = await api('/api/accounts-list?t=' + Date.now());
    renderQuickAccountsDropdown(accounts);
  } catch { /* gunakan cache / daftar bawaan */ }
}

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginError').classList.add('hidden');
  const username = $('#loginUser').value.trim().toUpperCase();
  const password = $('#loginPass').value;
  if (!password) {
    $('#loginError').textContent = 'Wajib masukkan password akun Anda (Password awal: 1234)';
    $('#loginError').classList.remove('hidden');
    $('#loginPass').focus();
    feedback.err();
    return;
  }
  try {
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    setAuth(r.token, r.user);
    $('#loginPass').value = '';
    $('#quickPickedBanner')?.classList.add('hidden');
    renderAuthView();
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#loginError').classList.remove('hidden');
    $('#loginPass').select();
    feedback.err();
  }
};

function getInitials(name) {
  return String(name || 'GF')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase() || 'GF';
}

function renderAuthView() {
  if (!currentUser) {
    currentUser = { username: 'ADMIN', name: 'Hendra Wijaya (Penjaga Gudang)', role: 'admin', dept: 'GFM Warehouse' };
  }
  $('#loginView')?.classList.add('hidden');
  $('#appView')?.classList.remove('hidden');

  const isAdmin = currentUser.role === 'admin';
  $('#topUserAvatar').textContent = getInitials(currentUser.name);
  $('#topUserAvatar').classList.toggle('admin', isAdmin);
  $('#topRoleBadge').textContent = isAdmin ? 'ADMIN' : currentUser.username;
  $('#topRoleBadge').classList.toggle('admin', isAdmin);
  $('#topUserName').textContent = currentUser.name.replace(/\s*\(Penjaga Gudang\)/i, '');
  $('#topUserDept').textContent = currentUser.dept || (isAdmin ? 'Penjaga Gudang GFM' : 'Crew Lapangan');
  $('#navAdmin')?.classList.toggle('hidden', !isAdmin);
  $('#adminAddToolBox')?.classList.toggle('hidden', !isAdmin);
  $('#adminDelegateBox')?.classList.toggle('hidden', !isAdmin);

  $('#roleBanner').className = 'role-card ' + (isAdmin ? 'admin' : '');
  $('#roleBanner').innerHTML = isAdmin
    ? `<div>
         <div class="rc-title">🛡️ Mode Penjaga Gudang — ${esc(currentUser.name)}</div>
         <div class="rc-sub">Scan QR barang yang dikembalikan Crew untuk <b>mengesahkan pengembalian</b> ke gudang.</div>
       </div>
       <div class="role-card-right">
         <button type="button" class="btn btn-primary btn-sm" id="btnBannerPw">🔑 Ubah Password Saya</button>
       </div>`
    : `<div>
         <div class="rc-title">👷 ${esc(currentUser.name)} <span style="opacity:.82">(${esc(currentUser.username)})</span></div>
         <div class="rc-sub">${esc(currentUser.dept || 'Crew Lapangan')} · Scan QR di barang untuk meminjam atau meminta oper dari rekan.</div>
       </div>
       <div class="role-card-right">
         <button type="button" class="btn btn-primary btn-sm" id="btnBannerPw">🔑 Ubah Password Saya</button>
       </div>`;

  const bp = $('#btnBannerPw');
  if (bp) bp.onclick = openChangePasswordModal;

  if (isAdmin) populateDelegateUsers();
  refreshMyState();
  refreshOutStats();
  showTab(currentTab === 'admin' && !isAdmin ? 'scan' : currentTab);
}

// Modal Ubah Password Sendiri (Tersimpan permanen di database lokal SQLite perangkat ini)
async function openChangePasswordModal() {
  if (!currentUser) return;
  await dialog(`
    <div class="muted small">PENGATURAN KEAMANAN AKUN</div>
    <h2 style="margin:2px 0 10px">🔑 Ubah Password — ${esc(currentUser.username)}</h2>
    <p class="small muted" style="margin-top:0">
      Akun: <b>${esc(currentUser.name)}</b> (${esc(currentUser.dept || '-')}).<br>
      Password baru akan langsung disimpan secara permanen di <b>database lokal</b> perangkat server gudang ini.
    </p>
    <form id="changePwForm" class="login-form" style="margin-top:10px">
      <label class="field">
        <span>Password Saat Ini <small class="muted">(Default awal: 1234)</small></span>
        <input id="cpOld" type="password" placeholder="Ketik password saat ini…" required autocomplete="current-password">
      </label>
      <label class="field">
        <span>Password Baru <small class="muted">(Minimal 4 karakter / angka)</small></span>
        <input id="cpNew" type="password" placeholder="Ketik password baru…" required minlength="4" autocomplete="new-password">
      </label>
      <label class="field">
        <span>Ulangi Password Baru</span>
        <input id="cpConfirm" type="password" placeholder="Ketik ulang password baru…" required minlength="4" autocomplete="new-password">
      </label>
      <label class="row small" style="cursor:pointer;margin-top:2px">
        <input type="checkbox" id="cpShowToggle" style="width:auto"> Tampilkan karakter password
      </label>
      <div id="cpMsg" class="alert-err hidden"></div>
      <button type="submit" class="btn btn-primary btn-block btn-lg">💾 Simpan Password Baru</button>
    </form>
  `, [{ label: 'Tutup', cls: 'btn-ghost' }]);
}

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'cpShowToggle') {
    const t = e.target.checked ? 'text' : 'password';
    ['#cpOld', '#cpNew', '#cpConfirm'].forEach((sel) => { if ($(sel)) $(sel).type = t; });
  }
});

document.addEventListener('submit', async (e) => {
  if (!e.target || e.target.id !== 'changePwForm') return;
  e.preventDefault();
  const oldPassword = $('#cpOld').value.trim();
  const newPassword = $('#cpNew').value.trim();
  const confirmPassword = $('#cpConfirm').value.trim();
  const msg = $('#cpMsg');
  msg.classList.add('hidden');

  if (newPassword.length < 4) {
    msg.textContent = 'Password baru minimal 4 karakter atau angka.';
    msg.classList.remove('hidden');
    feedback.err();
    return;
  }
  if (newPassword !== confirmPassword) {
    msg.textContent = 'Konfirmasi password baru tidak sama.';
    msg.classList.remove('hidden');
    feedback.err();
    return;
  }
  try {
    await api('/api/auth/password', { method: 'POST', body: { oldPassword, newPassword } });
    try {
      localStorage.setItem(`gfm_pw_updated_${currentUser.username}`, new Date().toISOString());
    } catch { /* abaikan */ }
    feedback.ok();
    $('#modal').classList.add('hidden');
    addEvent('borrowed', '🔑 Password Berhasil Diubah',
      `Password untuk akun <b>${esc(currentUser.username)} (${esc(currentUser.name)})</b> telah diperbarui dan tersimpan permanen di database lokal.`);
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.remove('hidden');
    feedback.err();
  }
});

async function openConnectHpModal() {
  try { CONFIG = await api('/api/config'); } catch { /* gunakan cache */ }
  const ip = (CONFIG.ips && CONFIG.ips[0]) || location.hostname || 'localhost';
  const httpPort = CONFIG.httpPort || 3050;
  const httpsPort = CONFIG.httpsPort || 3450;
  const httpUrl = `http://${ip}${httpPort === 80 ? '' : ':' + httpPort}`;
  const httpsUrl = `https://${ip}${httpsPort === 443 ? '' : ':' + httpsPort}`;

  dialog(`
    <div class="row between">
      <div>
        <div class="muted small">GFM — PT SULAWESI CAHAYA MINERAL</div>
        <h2 style="margin:2px 0">📲 Akses Web &amp; Kamera Live di HP</h2>
      </div>
    </div>

    <div class="qr-sticker-preview" style="background:#0f2942;color:#fff;border-color:#f59e0b">
      <img id="hpConnectQrImg" class="qr-img" src="/api/connect-qr.svg?url=${encodeURIComponent(httpsUrl)}" alt="QR Akses HP">
      <div style="min-width:0">
        <div style="color:#fcd34d;font-weight:900;font-size:.74rem;letter-spacing:.5px">SCAN QR INI DARI HP (MODE KAMERA LIVE)</div>
        <div id="hpConnectUrlTxt" style="font-size:1.02rem;font-weight:900;margin:4px 0;word-break:break-all">${esc(httpsUrl)}</div>
        <div style="font-size:.79rem;color:#cbd5e1">
          💡 Saat pertama kali dibuka di Chrome HP, jika muncul peringatan cukup ketuk <b>Lanjutan (Advanced) → Lanjutkan ke ${esc(ip)}</b> (cukup 1x, <b>tanpa perlu install sertifikat</b>) agar Kamera Live langsung aktif!
        </div>
        <div class="row wrap gap8" style="margin-top:8px">
          <button type="button" class="btn btn-primary btn-sm" id="btnQrModeHttps">📷 QR Mode Kamera Live (HTTPS)</button>
          <button type="button" class="btn btn-ghost btn-sm" id="btnQrModeHttp">🌐 QR Mode Biasa (HTTP)</button>
        </div>
      </div>
    </div>

    <div class="card" style="background:#f8fafc;margin:10px 0 0;font-size:.85rem">
      <b>Pastikan 2 Hal Ini:</b>
      <ol style="margin:6px 0 0;padding-left:18px">
        <li><b>Satu Jaringan Wi-Fi / Hotspot:</b> HP dan Laptop/Mini PC tersambung ke Wi-Fi atau Hotspot yang sama.</li>
        <li><b>Izin Firewall Windows (Cukup 1x):</b> Jika belum pernah dijalankan, klik 2x file <code>buka-akses-hp.bat</code> di folder komputer agar port <code>3050</code> &amp; <code>3450</code> terbuka untuk HP.</li>
      </ol>
    </div>
  `, [{ label: 'Tutup', cls: 'btn-primary' }]);

  const qrImg = $('#hpConnectQrImg');
  const urlTxt = $('#hpConnectUrlTxt');
  const bHttps = $('#btnQrModeHttps');
  const bHttp = $('#btnQrModeHttp');
  if (bHttps && bHttp) {
    bHttps.onclick = () => {
      qrImg.src = `/api/connect-qr.svg?url=${encodeURIComponent(httpsUrl)}`;
      urlTxt.textContent = httpsUrl;
      bHttps.className = 'btn btn-primary btn-sm';
      bHttp.className = 'btn btn-ghost btn-sm';
    };
    bHttp.onclick = () => {
      qrImg.src = `/api/connect-qr.svg?url=${encodeURIComponent(httpUrl)}`;
      urlTxt.textContent = httpUrl;
      bHttp.className = 'btn btn-primary btn-sm';
      bHttps.className = 'btn btn-ghost btn-sm';
    };
  }
}

$('#btnConnectHp').onclick = openConnectHpModal;
$('#btnLoginConnectHp').onclick = openConnectHpModal;
if ($('#btnChangePwTop')) $('#btnChangePwTop').onclick = openChangePasswordModal;

$('#btnUserMenu').onclick = async () => {
  const users = allUsersCache.length ? allUsersCache : (await api('/api/accounts-list').catch(() => []));
  const isAdm = currentUser?.role === 'admin';
  const act = await dialog(
    `<h3>👤 Pengguna & Ganti Akun</h3>
     <p>Akun aktif: <b>${esc(currentUser.name)}</b> (<code>${esc(currentUser.username)}</code>)<br>
     <span class="muted small">${esc(currentUser.dept || (isAdm ? 'Penjaga Gudang GFM' : 'Crew'))} · ${esc(currentUser.phone || '')}</span></p>
     <div style="margin:14px 0">
       <label class="field">
         <span><b>Pilih Akun / Ganti Mode:</b></span>
         <select id="dialogSwitchUser" class="quick-select" style="width:100%;padding:9px;font-size:.9rem;border-radius:8px">
           <option value="ADMIN" ${currentUser.username === 'ADMIN' ? 'selected' : ''}>🛡️ Mode Penjaga Gudang (ADMIN)</option>
           ${users.filter((u) => u.username !== 'ADMIN').map((u) => `<option value="${esc(u.username)}" ${u.username === currentUser.username ? 'selected' : ''}>👷 ${esc(u.username)} — ${esc(u.name)} (${esc(u.dept || 'Crew')})</option>`).join('')}
         </select>
       </label>
     </div>`,
    [
      { label: 'Tutup', value: null },
      { label: '🔄 Ganti Akun', cls: 'btn-primary', value: 'switch' },
      { label: '🔑 Ubah Password', cls: 'btn-dark', value: 'pw' },
    ]
  );
  if (act === 'switch') {
    const sel = $('#dialogSwitchUser');
    const targetUser = sel?.value || 'ADMIN';
    try {
      const res = await api('/api/auth/switch', { method: 'POST', body: { username: targetUser } });
      setAuth(res.token, res.user);
      currentUser = res.user;
      feedback.ok();
      renderAuthView();
      if (currentTab === 'database') loadDatabaseView();
    } catch (e) {
      feedback.err();
      alert('Gagal berganti akun: ' + e.message);
    }
  }
  if (act === 'pw') {
    openChangePasswordModal();
  }
};

async function populateDelegateUsers() {
  try {
    const users = await api('/api/users');
    allUsersCache = users;
    renderQuickAccountsDropdown(users);
    const crews = users.filter((u) => u.role === 'crew');
    $('#delegateSelect').innerHTML = `<option value="">🔍 Hanya Cek / Verifikasi Pengembalian Barang</option>` +
      crews.map((u) => `<option value="${esc(u.username)}">📌 Pinjamkan untuk: ${esc(u.username)} — ${esc(u.name)} (${esc(u.dept)})</option>`).join('');
  } catch { /* abaikan */ }
}

// ---------------- Navigasi Tab (5 HALAMAN UTAMA) ----------------
function showTab(name) {
  if (name === 'tools') name = 'database';
  if (name === 'out') name = 'database';
  if (name === 'admin' && currentUser?.role !== 'admin') name = 'database';
  currentTab = name;
  $$('.navbars button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name !== 'scan') closeCamera();
  if (name !== 'admin') stopOpCam();

  if (name === 'database') loadDatabaseView();
  if (name === 'entry') loadDataEntryView();
  if (name === 'scan') {
    loadScanBorrowView();
    refreshMyState();
  }
  if (name === 'history') loadHistory();
  if (name === 'admin') {
    loadAdminUsers();
    loadOpnameBalanceView();
    loadOut();
  }
}
window.showTab = showTab;
$$('.navbars button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));

// =====================================================================
// STATE BERANDA & DAFTAR PINJAMAN AKTIF DI HALAMAN SCAN
// =====================================================================
async function refreshMyState() {
  if (!currentUser) return;
  try {
    const [st, outData] = await Promise.all([
      api('/api/me/state'),
      api('/api/out?since=' + encodeURIComponent(startOfToday().toISOString())),
    ]);
    renderIncomingTransfers(st.incomingTransfers || []);
    renderActiveBorrowingsList(outData.out || [], st.outgoingTransfers || []);
  } catch { /* abaikan sementara */ }
}

function renderIncomingTransfers(list) {
  const box = $('#incomingTransfersBox');
  const badge = $('#myBadge');
  if (!box || !badge) return;
  const newIncoming = list.some((tr) => !knownTransferIds.has(tr.id));
  if (newIncoming) feedback.warn();
  knownTransferIds = new Set(list.map((tr) => tr.id));

  if (!list.length) {
    box.classList.add('hidden');
    badge.classList.add('hidden');
    return;
  }
  badge.textContent = list.length;
  badge.classList.remove('hidden');
  box.classList.remove('hidden');
  box.innerHTML = `<div class="transfer-alert">
    <div style="font-weight:900;font-size:1.05rem;color:#92400e">🔔 Permintaan Persetujuan Oper Barang (${list.length})</div>
    ${list.map((tr) => `
      <div class="transfer-item">
        <div>
          <div><b>${esc(tr.tool_name)}</b> <code>${esc(tr.tool_code)}</code></div>
          <div class="small">Diminta oleh: <b>${esc(tr.to_name)}</b> (${esc(tr.to_user)} · ${esc(tr.to_dept)})</div>
          ${tr.note ? `<div class="small muted">Catatan: "${esc(tr.note)}"</div>` : ''}
        </div>
        <div class="row gap8">
          <button class="btn btn-ok btn-sm" data-tr-act="approve" data-id="${tr.id}">✅ Setujui Oper</button>
          <button class="btn btn-danger btn-sm" data-tr-act="reject" data-id="${tr.id}">❌ Tolak</button>
        </div>
      </div>`).join('')}
  </div>`;

  $$('[data-tr-act]', box).forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.id;
    const decision = btn.dataset.trAct;
    try {
      btn.disabled = true;
      await api(`/api/transfers/${id}/respond`, { method: 'POST', body: { decision } });
      feedback.ok();
      refreshMyState();
      refreshOutStats();
    } catch (e) { feedback.err(); alert(e.message); }
  });
}

function renderActiveBorrowingsList(activeLoans, outgoing) {
  const countEl = $('#myHoldingCount');
  const listEl = $('#myHoldingList');
  if (!countEl || !listEl) return;

  countEl.textContent = activeLoans.length;

  if (!activeLoans.length) {
    listEl.innerHTML = `<p class="muted small" style="margin:6px 0 0">Semua barang berada di gudang. Belum ada barang yang sedang dipinjam saat ini.</p>`;
  } else {
    listEl.innerHTML = activeLoans.map((l) => {
      const dur = fmtDur(Date.now() - Date.parse(l.out_at));
      const isMat = (l.item_type || (l.tool_code?.startsWith('M-') ? 'material' : 'tool')) === 'material';
      const codeCls = isMat ? 'code-pill material' : 'code-pill tool';
      const qtyTxt = `${l.qty ?? 1} ${esc(l.unit || (isMat ? 'Pcs' : 'Unit'))}`;
      const badgeTxt = esc(l.badge_id || l.worker_code);

      return `<div class="item" style="align-items:center;gap:8px;padding:8px 10px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px">
        <div style="flex:1;min-width:0">
          <div class="row wrap gap6">
            <span class="${codeCls}" style="font-size:.74rem">${esc(l.tool_code)}</span>
            <b>${esc(l.tool_name)}</b>
            <span class="excel-badge out" style="font-size:.72rem">${qtyTxt}</span>
          </div>
          <div class="small" style="margin-top:3px">
            👷 <b>${esc(l.worker_name)}</b> · <span class="code-pill tool" style="font-size:.7rem;padding:1px 5px">🪪 ${badgeTxt}</span> · <span class="muted">${esc(l.worker_dept || '-')}</span>
          </div>
          <div class="small muted">Dipinjam ${fmtTime(l.out_at)} (${dur})${l.in_note ? ` · "${esc(l.in_note)}"` : ''}</div>
        </div>
        <button type="button" class="btn btn-ok btn-sm" onclick="returnBorrowedLoan(${l.id})" title="Kembalikan ke gudang & pulihkan stok">↩️ Kembalikan</button>
      </div>`;
    }).join('');
  }

  const outBox = $('#outgoingTransfersBox');
  if (outBox) outBox.innerHTML = '';
}

$('#btnToggleReturnBox')?.addEventListener('click', () => {
  $('#myHoldingCard')?.classList.toggle('hidden');
});
$('#btnCloseReturnBox')?.addEventListener('click', () => {
  $('#myHoldingCard')?.classList.add('hidden');
});

async function returnBorrowedLoan(loanId) {
  try {
    const r = await api('/api/return-loan', { method: 'POST', body: { loanId } });
    feedback.ret();
    const unitTxt = r.tool?.unit || 'Unit';
    const ev = addEvent(
      'returned',
      `↩️ DIKEMBALIKAN KE GUDANG: ${esc(r.tool.name)} (${r.returnedQty || 1} ${esc(unitTxt)})`,
      `Dikembalikan dari <b>${esc(r.holder.name)}</b> (Badge ID: <code>${esc(r.holder.badge_id)}</code>) · Stok di Database otomatis bertambah menjadi <b>${r.tool.quantity} ${esc(unitTxt)}</b>.`,
      [
        { label: '↶ Batal Kembalikan', cls: 'btn-ghost btn-sm', fn: () => undoLoan('return', r.loan.id, ev) },
      ]
    );
    await loadScanBorrowView();
    await refreshMyState();
    await refreshOutStats();
    if (currentTab === 'database') await loadDatabaseView();
    if (currentTab === 'history') await loadHistory();
  } catch (err) {
    feedback.err();
    alert('Gagal mengembalikan barang: ' + err.message);
  }
}
window.returnBorrowedLoan = returnBorrowedLoan;

// =====================================================================
// KAMERA LIVE & FOTO QR (BEKERJA DI HTTPS MAUPUN HTTP)
// =====================================================================
class CameraScanner {
  constructor(video, onCode, { autoStop = true, onStop } = {}) {
    this.video = video;
    this.onCode = onCode;
    this.autoStop = autoStop;
    this.onStop = onStop;
    this.facingMode = 'environment';
    this.torchOn = false;
    this.last = { code: '', at: 0 };
  }

  async start() {
    // Jika dibuka di HP melalui HTTP biasa (bukan HTTPS / localhost), arahkan ke HTTPS secara simpel & otomatis bawa sesi login!
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const p = CONFIG.httpsPort && CONFIG.httpsPort !== 443 ? ':' + CONFIG.httpsPort : '';
      const token = getToken();
      const httpsLink = `https://${location.hostname}${p}/?autoCam=1${token ? '#auth=' + encodeURIComponent(token) : ''}`;
      const act = await dialog(
        `<h3>📷 Aktifkan Kamera Live di HP</h3>
         <p class="small">Agar kamera live langsung terbuka di HP tanpa ribet, klik <b>⚡ Buka Mode Kamera Live</b> di bawah (cukup 1x klik <i>Lanjutan → Lanjutkan</i> jika muncul di browser), atau gunakan <b>📸 Jepret QR</b>:</p>`,
        [
          { label: 'Batal', value: 'cancel' },
          { label: '📸 Jepret QR Cepat', cls: 'btn-dark', value: 'photo' },
          { label: '⚡ Buka Mode Kamera Live', cls: 'btn-primary', value: 'https' },
        ]
      );
      if (act === 'photo') $('#photoQrInput').click();
      if (act === 'https') location.href = httpsLink;
      return false;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (e) {
        await dialog(`<h3>Kamera belum diizinkan</h3><p>Pastikan izin kamera di browser di-klik <b>Allow / Izinkan</b> (${esc(e.message)}), atau gunakan tombol <b>📸 Jepret QR</b>.</p>`, [{ label: 'OK', cls: 'btn-primary' }]);
        return false;
      }
    }

    this.video.srcObject = this.stream;
    await this.video.play();

    // Cek dukungan lampu senter (torch) pada kamera HP
    const track = this.stream.getVideoTracks?.()[0];
    const caps = track?.getCapabilities ? track.getCapabilities() : {};
    const torchBtn = $('#btnCamTorch');
    if (torchBtn) {
      torchBtn.classList.toggle('hidden', !caps.torch);
      this.torchOn = false;
      torchBtn.textContent = '🔦 Senter';
    }

    if ('BarcodeDetector' in window && !this.detector) {
      try {
        const supported = await BarcodeDetector.getSupportedFormats();
        const want = ['qr_code', 'code_128', 'code_39'].filter((f) => supported.includes(f));
        if (want.length) this.detector = new BarcodeDetector({ formats: want });
      } catch { /* fallback jsQR */ }
    }
    this.canvas ||= document.createElement('canvas');
    this.running = true;
    this.loop();
    return true;
  }

  async toggleTorch() {
    const track = this.stream?.getVideoTracks?.()[0];
    if (!track?.applyConstraints) return;
    try {
      this.torchOn = !this.torchOn;
      await track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
      const torchBtn = $('#btnCamTorch');
      if (torchBtn) torchBtn.textContent = this.torchOn ? '🔦 Matikan' : '🔦 Senter';
    } catch { /* abaikan */ }
  }

  async flipCamera() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    if (this.running) {
      this.stop();
      await this.start();
    }
  }

  async loop() {
    if (!this.running) return;
    try {
      let code = null;
      if (this.video.readyState >= 2) {
        if (this.detector) {
          const r = await this.detector.detect(this.video);
          if (r.length) code = r[0].rawValue;
        }
        if (!code && window.jsQR) {
          const vw = this.video.videoWidth, vh = this.video.videoHeight;
          if (vw > 0 && vh > 0) {
            const scale = Math.min(1, 720 / vw);
            const w = this.canvas.width = Math.floor(vw * scale);
            const h = this.canvas.height = Math.floor(vh * scale);
            const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(this.video, 0, 0, w, h);
            const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
            if (r?.data) code = r.data;
          }
        }
      }
      if (code) {
        const n = norm(code);
        if (n) {
          // Jika autoStop aktif, langsung hentikan kamera begitu QR barang terdeteksi!
          if (this.autoStop) {
            this.running = false;
            const ret = $('#camReticle');
            const hint = $('#camHint');
            if (ret) ret.classList.add('hit');
            if (hint) hint.textContent = `✅ QR Terdeteksi (${n}) — Kamera Dihentikan`;
            setTimeout(() => {
              if (ret) ret.classList.remove('hit');
              if (hint) hint.textContent = 'Arahkan kotak ke stiker QR barang — otomatis stop saat terbaca';
              this.stop();
              this.onStop?.();
            }, 180);
            this.onCode(n);
            return;
          }
          if (n !== this.last.code || Date.now() - this.last.at > 2200) {
            this.onCode(n);
            this.last = { code: n, at: Date.now() };
          }
        }
      }
    } catch { /* abaikan frame gagal */ }
    if (this.running) setTimeout(() => this.loop(), 90);
  }

  stop() {
    this.running = false;
    this.torchOn = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }
}

// Decode QR dari foto kamera HP (bekerja walau tanpa HTTPS)
async function decodeQrFromFile(file) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const maxDim = 1000;
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  canvas.width = Math.floor(bmp.width * scale);
  canvas.height = Math.floor(bmp.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);

  if ('BarcodeDetector' in window) {
    try {
      const det = new BarcodeDetector({ formats: ['qr_code', 'code_128'] });
      const res = await det.detect(canvas);
      if (res.length) return norm(res[0].rawValue);
    } catch { /* lanjut jsQR */ }
  }
  if (window.jsQR) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const res = jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
    if (res?.data) return norm(res.data);
  }
  return null;
}

const scanCam = new CameraScanner($('#video'), (c) => enqueueScan(c), {
  autoStop: true,
  onStop: () => {
    $('#cameraBox').classList.add('hidden');
    $('#btnCamera').textContent = '📷 Buka Kamera Live';
  },
});

async function startMainCamera() {
  if (scanCam.running) return closeCamera();
  $('#cameraBox').classList.remove('hidden');
  $('#btnCamera').textContent = '⏹ Matikan Kamera Live';
  if (!(await scanCam.start())) {
    $('#cameraBox').classList.add('hidden');
    $('#btnCamera').textContent = '📷 Buka Kamera Live';
  }
}

$('#btnCamera').onclick = startMainCamera;
function closeCamera() {
  scanCam.stop();
  $('#cameraBox').classList.add('hidden');
  if ($('#btnCamera')) $('#btnCamera').textContent = '📷 Buka Kamera Live';
}
$('#btnCamClose').onclick = closeCamera;
if ($('#btnCamTorch')) $('#btnCamTorch').onclick = () => scanCam.toggleTorch();
if ($('#btnCamFlip')) $('#btnCamFlip').onclick = () => scanCam.flipCamera();

$('#btnPhotoQr').onclick = () => $('#photoQrInput').click();
$('#photoQrInput').onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const code = await decodeQrFromFile(file);
  if (!code) {
    feedback.err();
    addEvent('error', '⚠️ QR Tidak Terbaca', 'Pastikan stiker QR terlihat jelas dan terang, lalu coba foto ulang.');
    return;
  }
  enqueueScan(code);
};

// =====================================================================
// HALAMAN 3: SCAN & PINJAM (SIMPEL & BERTAHAP — MUNCUL SAAT DITEKAN)
// =====================================================================
const scanState = {
  itemType: '',
  selectedCode: '',
  selectedWorker: '',
  searchItem: '',
  searchCrew: '',
};

async function loadScanBorrowView() {
  try {
    const [tools, users] = await Promise.all([
      api('/api/tools'),
      api('/api/users'),
    ]);
    allToolsCache = tools;
    allUsersCache = users;

    const countTools = tools.filter((t) => (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'tool').length;
    const countMaterial = tools.filter((t) => (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'material').length;
    if ($('#scanCountTool')) $('#scanCountTool').textContent = countTools;
    if ($('#scanCountMaterial')) $('#scanCountMaterial').textContent = countMaterial;

    renderScanCrewScrollList();
    if (scanState.itemType) {
      renderScanItemScrollList();
    }
  } catch (err) {
    console.error('loadScanBorrowView err:', err);
  }
}

function updateScanModeLabels(validType) {
  const isMat = validType === 'material';
  if ($('#scanStepItemsTitle')) {
    $('#scanStepItemsTitle').textContent = isMat
      ? '① Pilih Material (Habis Pakai) & Jumlah yang Diambil'
      : '① Pilih Tools (Alat Kerja) & Jumlah yang Dipinjam';
  }
  if ($('#selItemQtyLabel')) {
    $('#selItemQtyLabel').textContent = isMat ? 'Jumlah Diambil' : 'Jumlah Pinjam';
  }
  if ($('#scanStepBorrowerTitle')) {
    $('#scanStepBorrowerTitle').textContent = isMat
      ? '② Siapa yang mengambil Material (Habis Pakai)?'
      : '② Siapa yang meminjam Tools?';
  }
  if ($('#btnSubmitBorrow')) {
    $('#btnSubmitBorrow').textContent = isMat
      ? '✅ KELUARKAN MATERIAL (HABIS PAKAI)'
      : '✅ SIMPAN PINJAMAN TOOLS';
  }
}

function setScanItemType(type) {
  const validType = type === 'material' ? 'material' : 'tool';
  scanState.itemType = validType;
  scanState.selectedCode = '';

  $('#btnScanTypeTool')?.classList.toggle('active', validType === 'tool');
  $('#btnScanTypeMaterial')?.classList.toggle('active', validType === 'material');

  updateScanModeLabels(validType);

  // Munculkan kotak pilih barang, dan sembunyikan kotak peminjam sampai barang dipilih
  $('#scanStepItems')?.classList.remove('hidden');
  $('#selectedItemBox')?.classList.add('hidden');
  $('#scanStepBorrower')?.classList.add('hidden');

  renderScanItemScrollList();
}

$('#btnScanTypeTool')?.addEventListener('click', () => setScanItemType('tool'));
$('#btnScanTypeMaterial')?.addEventListener('click', () => setScanItemType('material'));

function renderScanItemScrollList() {
  const box = $('#scanItemScrollList');
  if (!box || !scanState.itemType) return;
  const q = scanState.searchItem.toLowerCase();
  const list = allToolsCache.filter((t) => {
    const it = t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool');
    if (it !== scanState.itemType) return false;
    if (!q) return true;
    return [t.code, t.name, t.category].some((v) => String(v || '').toLowerCase().includes(q));
  });

  if (!list.length) {
    box.innerHTML = `<div class="muted small" style="padding:12px;text-align:center">Tidak ada ${scanState.itemType === 'material' ? 'Material' : 'Tools'} yang cocok dengan pencarian.</div>`;
    return;
  }

  box.innerHTML = list.map((t) => {
    const isMat = (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'material';
    const codeCls = isMat ? 'code-pill material' : 'code-pill tool';
    const qtyNum = Number(t.quantity ?? 0);
    const unitTxt = esc(t.unit || (isMat ? 'Pcs' : 'Unit'));
    const cond = t.condition || (t.status === 'rusak' ? 'eject' : 'bagus');
    const isBlocked = qtyNum <= 0 || cond !== 'bagus';
    const isSel = t.code === scanState.selectedCode;

    let badgeHtml = '';
    if (cond === 'eject' || t.status === 'rusak') {
      badgeHtml = `<span class="excel-badge eject">🔴 Eject</span>`;
    } else if (cond === 'kalibrasi') {
      badgeHtml = `<span class="excel-badge kalibrasi">🟡 Kalibrasi</span>`;
    } else if (qtyNum <= 0) {
      badgeHtml = `<span class="excel-badge out">Habis (0 ${unitTxt})${t.holder ? ` · Dipinjam ${esc(t.holder)}` : ''}</span>`;
    } else {
      badgeHtml = `<span class="excel-badge ready">Stok: <b>${qtyNum} ${unitTxt}</b></span>`;
    }

    return `<div class="quick-item-row ${isSel ? 'selected' : ''} ${isBlocked ? 'out-of-stock' : ''}" data-pick-code="${esc(t.code)}">
      <div class="row wrap gap6" style="min-width:0">
        <span class="${codeCls}" style="font-size:.75rem">${esc(t.code)}</span>
        <b>${esc(t.name)}</b>
        ${t.category ? `<span class="muted small">· ${esc(t.category)}</span>` : ''}
      </div>
      <div style="flex:none">${badgeHtml}</div>
    </div>`;
  }).join('');

  $$('[data-pick-code]', box).forEach((el) => {
    el.onclick = () => selectScanItem(el.dataset.pickCode, true);
  });
}

function selectScanItem(code, resetQty = true) {
  const t = allToolsCache.find((x) => x.code === code);
  if (!t) return;
  scanState.selectedCode = t.code;
  const it = t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool');
  if (it !== scanState.itemType) {
    scanState.itemType = it;
    $('#btnScanTypeTool')?.classList.toggle('active', it === 'tool');
    $('#btnScanTypeMaterial')?.classList.toggle('active', it === 'material');
  }
  updateScanModeLabels(it);
  $('#scanStepItems')?.classList.remove('hidden');
  $('#selectedItemBox')?.classList.remove('hidden');
  $('#scanStepBorrower')?.classList.remove('hidden');

  renderScanItemScrollList();
  updateSelectedItemBanner(t, resetQty);
}
window.selectScanItem = selectScanItem;

function updateSelectedItemBanner(t, resetQty = false) {
  const titleEl = $('#selItemTitle');
  const stockEl = $('#selItemStockInfo');
  const unitEl = $('#borrowUnitLabel');
  const qtyInp = $('#borrowQtyInput');
  if (!titleEl || !stockEl || !t) return;

  const isMat = (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'material';
  const unitTxt = t.unit || (isMat ? 'Pcs' : 'Unit');
  const qtyAvail = Number(t.quantity ?? 0);

  titleEl.innerHTML = `<span class="${isMat ? 'code-pill material' : 'code-pill tool'}">${esc(t.code)}</span> ${esc(t.name)}`;
  stockEl.innerHTML = qtyAvail > 0
    ? `Stok tersedia: <b style="color:#15803d">${qtyAvail} ${esc(unitTxt)}</b>`
    : `<span style="color:#b91c1c;font-weight:700">⚠️ Stok habis (0 ${esc(unitTxt)})</span>`;

  if (unitEl) unitEl.textContent = unitTxt;
  if (qtyInp) {
    qtyInp.max = qtyAvail > 0 ? String(qtyAvail) : '1';
    if (resetQty || Number(qtyInp.value) > qtyAvail) {
      qtyInp.value = qtyAvail > 0 ? 1 : 0;
    }
  }
}

$('#btnBorrowQtyMinus')?.addEventListener('click', () => {
  const inp = $('#borrowQtyInput');
  if (!inp) return;
  const cur = Number(inp.value) || 1;
  inp.value = Math.max(1, cur - 1);
});

$('#btnBorrowQtyPlus')?.addEventListener('click', () => {
  const inp = $('#borrowQtyInput');
  if (!inp) return;
  const t = allToolsCache.find((x) => x.code === scanState.selectedCode);
  const maxStock = t ? Math.max(1, Number(t.quantity ?? 1)) : 9999;
  const cur = Number(inp.value) || 0;
  inp.value = Math.min(maxStock, cur + 1);
});

function renderScanCrewScrollList() {
  const sel = $('#borrowQuickSelect');
  if (sel) {
    sel.innerHTML = `<option value="">-- Pilih Crew (${allUsersCache.length}) --</option>` +
      allUsersCache.map((u) => `<option value="${esc(u.username)}" ${u.username === scanState.selectedWorker ? 'selected' : ''}>${esc(u.username)} — ${esc(u.name)}</option>`).join('');
  }

  const box = $('#borrowCrewScrollList');
  if (!box) return;
  const q = (scanState.searchCrew || '').toLowerCase();
  const list = allUsersCache.filter((u) => {
    if (!q) return true;
    return `${u.username} ${u.name} ${u.dept || ''}`.toLowerCase().includes(q);
  });

  if (!list.length) {
    box.innerHTML = `<div class="muted small" style="padding:10px;text-align:center;grid-column:1/-1">Nama baru — langsung klik <b>Simpan Pinjaman</b> di bawah.</div>`;
    return;
  }

  box.innerHTML = list.map((u) => {
    const isSel = u.username === scanState.selectedWorker;
    return `<button type="button" class="crew-quick-btn ${isSel ? 'selected' : ''}" data-pick-crew="${esc(u.username)}">
      <div style="min-width:0">
        <div style="font-weight:800;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(u.name)}</div>
        <div class="small muted" style="font-size:.73rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(u.dept || 'Crew')}</div>
      </div>
      <span class="crew-badge">${esc(u.username)}</span>
    </button>`;
  }).join('');

  $$('[data-pick-crew]', box).forEach((btn) => {
    btn.onclick = () => selectScanCrew(btn.dataset.pickCrew);
  });
}

if ($('#borrowQuickSelect')) {
  $('#borrowQuickSelect').onchange = (e) => {
    if (e.target.value) selectScanCrew(e.target.value);
  };
}

function selectScanCrew(username) {
  const u = allUsersCache.find((x) => x.username === username);
  if (!u) return;
  scanState.selectedWorker = u.username;
  scanState.searchCrew = '';
  if ($('#borrowBadgeId')) $('#borrowBadgeId').value = u.username;
  if ($('#borrowerNameInput')) $('#borrowerNameInput').value = u.name;
  if ($('#borrowerDeptInput')) $('#borrowerDeptInput').value = u.dept || '';
  renderScanCrewScrollList();
}

// Saat pengguna mengetik Badge ID atau Nama di kotak pencarian peminjam, saring daftar & cocokkan otomatis
if ($('#borrowBadgeId')) {
  $('#borrowBadgeId').oninput = (e) => {
    const rawTrim = e.target.value.trim();
    const raw = rawTrim.toUpperCase();
    scanState.searchCrew = rawTrim;
    if (!raw) {
      scanState.selectedWorker = '';
      renderScanCrewScrollList();
      return;
    }
    let matched = allUsersCache.find((u) => u.username.toUpperCase() === raw);
    if (!matched && /^\d+$/.test(raw)) {
      const codeTry = 'CREW' + raw.padStart(2, '0');
      matched = allUsersCache.find((u) => u.username.toUpperCase() === codeTry);
    }
    if (matched) {
      scanState.selectedWorker = matched.username;
      scanState.searchCrew = '';
      if ($('#borrowerNameInput')) $('#borrowerNameInput').value = matched.name;
      if ($('#borrowerDeptInput')) $('#borrowerDeptInput').value = matched.dept || '';
    } else {
      scanState.selectedWorker = '';
    }
    renderScanCrewScrollList();
  };
}

if ($('#scanInput')) {
  $('#scanInput').oninput = (e) => {
    scanState.searchItem = e.target.value.trim();
    renderScanItemScrollList();
  };
}

let scanQueue = Promise.resolve();
$('#scanForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#scanInput').value.trim();
  if (v) {
    $('#scanInput').value = '';
    scanState.searchItem = '';
    enqueueScan(v);
  }
};

const enqueueScan = (code) => { scanQueue = scanQueue.then(() => processScan(norm(code))).catch(() => {}); };

async function processScan(code) {
  const exactTool = allToolsCache.find((t) => t.code.toUpperCase() === code.toUpperCase())
    || allToolsCache.find((t) => t.name.toLowerCase().includes(code.toLowerCase()));

  if (exactTool) {
    selectScanItem(exactTool.code, true);
    feedback.info();
    if (Number(exactTool.quantity ?? 0) <= 0 && Number(exactTool.open_loans_count || 0) > 0) {
      const confirmRet = confirm(`Barang "${exactTool.name}" (${exactTool.code}) sedang dipinjam oleh ${exactTool.holder || 'Crew'}.\n\nApakah Anda ingin memproses PENGEMBALIAN barang ini ke gudang (stok otomatis bertambah kembali)?`);
      if (confirmRet && exactTool.loan_id) {
        await returnBorrowedLoan(exactTool.loan_id);
        return;
      }
    }
    return;
  }

  feedback.err();
  alert(`Barang dengan kode "${code}" tidak ditemukan di database.`);
}

async function submitBorrowForm() {
  const code = scanState.selectedCode;
  if (!code) {
    feedback.err();
    return alert('Pilih barang terlebih dahulu.');
  }
  const qty = Number($('#borrowQtyInput')?.value || 1);
  if (!qty || qty <= 0) {
    feedback.err();
    return alert('Masukkan jumlah barang yang valid (minimal 1).');
  }
  const badgeId = $('#borrowBadgeId')?.value.trim() || '';
  const workerCode = scanState.selectedWorker || badgeId;
  const borrowerName = $('#borrowerNameInput')?.value.trim() || '';
  const borrowerDept = $('#borrowerDeptInput')?.value.trim() || '';
  const note = $('#borrowNoteInput')?.value.trim() || '';

  if (!workerCode && !badgeId) {
    feedback.err();
    $('#borrowBadgeId')?.focus();
    return alert('Pilih akun peminjam atau masukkan Badge ID terlebih dahulu!');
  }

  try {
    const r = await api('/api/borrow', {
      method: 'POST',
      body: { code, qty, workerCode, badgeId, borrowerName, borrowerDept, note },
    });
    feedback.ok();
    const isMat = r.isMaterial || r.kind === 'consumed' || String(r.tool?.code || '').startsWith('M-');
    const unitTxt = r.tool?.unit || (isMat ? 'Pcs' : 'Unit');
    const ev = addEvent(
      'borrowed',
      isMat
        ? `📦 MATERIAL KELUAR (HABIS PAKAI): ${r.qty} ${esc(unitTxt)} ${esc(r.tool.name)} (${esc(r.tool.code)})`
        : `✅ PINJAMAN TOOLS TERSIMPAN: ${r.qty} ${esc(unitTxt)} ${esc(r.tool.name)} (${esc(r.tool.code)})`,
      isMat
        ? `Diambil oleh: <b>${esc(r.worker.name)}</b> (Badge ID: <code>${esc(r.worker.badge_id || r.worker.username)}</code>) · Stok Material di Database otomatis berkurang menjadi <b>${r.remainingStock} ${esc(unitTxt)}</b> (Habis Pakai — Tidak Perlu Dikembalikan).`
        : `Peminjam: <b>${esc(r.worker.name)}</b> (Badge ID: <code>${esc(r.worker.badge_id || r.worker.username)}</code>) · Sisa stok di Database: <b>${r.remainingStock} ${esc(unitTxt)}</b> (Wajib Dikembalikan).`,
      [
        { label: '↶ Batal', cls: 'btn-ghost btn-sm', fn: () => undoLoan(isMat ? 'consume' : 'borrow', r.loan.id, ev) },
      ]
    );

    // Kembalikan tampilan ke kondisi bersih (tutup kotak tahap 2 & 3) setelah selesai
    scanState.selectedCode = '';
    scanState.itemType = '';
    $('#btnScanTypeTool')?.classList.remove('active');
    $('#btnScanTypeMaterial')?.classList.remove('active');
    $('#scanStepItems')?.classList.add('hidden');
    $('#selectedItemBox')?.classList.add('hidden');
    $('#scanStepBorrower')?.classList.add('hidden');

    await loadScanBorrowView();
    await refreshMyState();
    await refreshOutStats();
  } catch (err) {
    feedback.err();
    alert('Gagal memproses barang keluar: ' + err.message);
  }
}

$('#btnSubmitBorrow')?.addEventListener('click', submitBorrowForm);

async function undoLoan(action, loanId, ev) {
  try {
    await api('/api/undo', { method: 'POST', body: { action, loanId } });
    ev.classList.add('undone');
    ev.querySelector('.acts')?.remove();
    feedback.info();
    await loadScanBorrowView();
    await refreshMyState();
    await refreshOutStats();
  } catch (e) { feedback.err(); alert(e.message); }
}

function addEvent(kind, title, detail, actions = []) {
  const feed = $('#feed');
  feed.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = `ev ${kind}`;
  el.innerHTML = `<span class="time">${fmtClock()}</span><div class="t">${title}</div><div class="d">${detail}</div>`;
  if (actions.length) {
    const box = document.createElement('div');
    box.className = 'acts';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (a.cls || 'btn-ghost btn-sm');
      b.textContent = a.label;
      b.onclick = async () => { try { await a.fn(b); } catch (e) { feedback.err(); alert(e.message); } };
      box.appendChild(b);
    }
    el.appendChild(box);
  }
  feed.prepend(el);
  while (feed.children.length > 30) feed.lastChild.remove();
  return el;
}

// =====================================================================
// HALAMAN 1 (UTAMA): DATABASE (TOOLS & MATERIAL, READY & KELUAR, KONDISI)
// =====================================================================
async function loadDatabaseView() {
  try {
    const [tools, outData] = await Promise.all([
      api('/api/tools'),
      api('/api/out?since=' + encodeURIComponent(startOfToday().toISOString())).catch(() => null),
    ]);
    allToolsCache = tools;
    if ($('#dlToolsCount')) $('#dlToolsCount').textContent = tools.length;
    if (outData) renderOutStatsBar(outData);

    populateDbCategoryFilter();
    updateDbCounterBadges();
    renderDatabaseTable();
  } catch (err) {
    console.error('loadDatabaseView error:', err);
  }
}

function renderOutStatsBar(d) {
  const s = d.stats;
  const statsEl = $('#stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="stat"><div class="n">${s.totalTools || 0}</div><div class="l">Total Tools (T)</div></div>
      <div class="stat"><div class="n">${s.totalMaterial || 0}</div><div class="l">Total Material (M)</div></div>
      <div class="stat av"><div class="n">${s.available}</div><div class="l">Ready di Gudang</div></div>
      <div class="stat out"><div class="n">${s.out}</div><div class="l">Sedang Keluar</div></div>
      <div class="stat br"><div class="n">${s.calibration || 0}</div><div class="l">Perlu Kalibrasi</div></div>
      <div class="stat br"><div class="n">${s.broken || 0}</div><div class="l">Eject / Rusak</div></div>`;
  }

  if ($('#printTime')) $('#printTime').textContent = new Date().toLocaleString('id-ID');

  const ptBox = $('#pendingTransfersOverview');
  if (ptBox) {
    if (d.pendingTransfers?.length) {
      ptBox.classList.remove('hidden');
      ptBox.innerHTML = `<div class="card" style="background:#fffbeb;border-color:#f59e0b">
        <h3>🔄 Menunggu Persetujuan Oper Antar Crew (${d.pendingTransfers.length})</h3>
        ${d.pendingTransfers.map((tr) => `
          <div class="item small">
            <span><b>${esc(tr.tool_name)}</b> (<code>${esc(tr.tool_code)}</code>)</span>
            <span>Pemegang: <b>${esc(tr.from_name)}</b> → Diminta oleh: <b>${esc(tr.to_name)}</b></span>
          </div>`).join('')}
      </div>`;
    } else {
      ptBox.classList.add('hidden');
    }
  }
}

function updateDbCounterBadges() {
  const tools = allToolsCache;
  const isType = (t, type) => {
    if (type === 'all') return true;
    const it = t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool');
    return it === type;
  };

  const countTools = tools.filter((t) => (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'tool').length;
  const countMaterial = tools.filter((t) => (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'material').length;
  const countTotal = tools.length;

  if ($('#badgeTypeAll')) $('#badgeTypeAll').textContent = countTotal;
  if ($('#badgeTypeTool')) $('#badgeTypeTool').textContent = countTools;
  if ($('#badgeTypeMaterial')) $('#badgeTypeMaterial').textContent = countMaterial;

  // Item yang sesuai dengan sheet tab aktif saat ini ('all' / 'tool' / 'material')
  const currentPool = tools.filter((t) => isType(t, dbState.itemType));

  const isReady = (t) => Number(t.quantity ?? 0) > 0 && (t.condition || 'bagus') !== 'eject' && t.status !== 'rusak';
  const isOut = (t) => !!t.holder || Number(t.borrowed_qty || 0) > 0;

  const countReady = currentPool.filter(isReady).length;
  const countOut = currentPool.filter(isOut).length;
  const countAll = currentPool.length;

  if ($('#cntAvailReady')) $('#cntAvailReady').textContent = countReady;
  if ($('#cntAvailOut')) $('#cntAvailOut').textContent = countOut;
  if ($('#cntAvailAll')) $('#cntAvailAll').textContent = countAll;

  // Hitung kondisi untuk tipe aktif
  const condBagus = currentPool.filter((t) => (t.condition || 'bagus') === 'bagus' && t.status !== 'rusak').length;
  const condKalibrasi = currentPool.filter((t) => t.condition === 'kalibrasi').length;
  const condEject = currentPool.filter((t) => t.condition === 'eject' || t.status === 'rusak').length;

  if ($('#cntCondAll')) $('#cntCondAll').textContent = countAll;
  if ($('#cntCondBagus')) $('#cntCondBagus').textContent = condBagus;
  if ($('#cntCondKalibrasi')) $('#cntCondKalibrasi').textContent = condKalibrasi;
  if ($('#cntCondEject')) $('#cntCondEject').textContent = condEject;
}

function populateDbCategoryFilter() {
  const currentPool = allToolsCache.filter((t) => {
    if (dbState.itemType === 'all') return true;
    const it = t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool');
    return it === dbState.itemType;
  });
  const cats = [...new Set(currentPool.map((t) => t.category).filter(Boolean))].sort();
  const sel = $('#dbSubCat');
  if (!sel) return;
  const curVal = sel.value;
  sel.innerHTML = `<option value="">📂 Semua Kategori (${cats.length})</option>` +
    cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (curVal && cats.includes(curVal)) sel.value = curVal;
}

// Handler Switcher Sheet Tab: Semua Barang vs Tools vs Material
function setDbItemType(type) {
  dbState.itemType = type;
  $('#btnTypeAll')?.classList.toggle('active', type === 'all');
  $('#btnTypeTool')?.classList.toggle('active', type === 'tool');
  $('#btnTypeMaterial')?.classList.toggle('active', type === 'material');

  // Perbarui heading cetak
  const typeLabel = dbState.itemType === 'tool' ? '🧰 KATEGORI 1: TOOLS (ALAT KERJA)' : (dbState.itemType === 'material' ? '📦 KATEGORI 2: MATERIAL & SPAREPART' : '📋 SEMUA BARANG GUDANG');
  if ($('#printDbTitle')) $('#printDbTitle').textContent = typeLabel;

  populateDbCategoryFilter();
  updateDbCounterBadges();
  renderDatabaseTable();
}

$('#btnTypeAll')?.addEventListener('click', () => setDbItemType('all'));
$('#btnTypeTool')?.addEventListener('click', () => setDbItemType('tool'));
$('#btnTypeMaterial')?.addEventListener('click', () => setDbItemType('material'));

// Tombol Unduh Excel langsung dari Database Toolbar
$('#btnDlExcelFromDb')?.addEventListener('click', () => {
  downloadTemplate('tools', 'xls');
});

// Handler Sub-Tab Status Ketersediaan: SEMUA vs READY vs KELUAR
$$('#dbAvailTabs button').forEach((btn) => btn.onclick = () => {
  dbState.avail = btn.dataset.avail || 'all';
  $$('#dbAvailTabs button').forEach((b) => b.classList.toggle('active', b === btn));
  renderDatabaseTable();
});

// Handler Kondisi Filter: Semua | Bagus | Kalibrasi | Eject
$$('#dbCondPills button').forEach((btn) => btn.onclick = () => {
  dbState.cond = btn.dataset.cond || 'all';
  $$('#dbCondPills button').forEach((b) => b.classList.toggle('active', b === btn));
  renderDatabaseTable();
});

// Handler Input Pencarian, Sortir, dan Sub-Kategori
if ($('#dbSearch')) {
  $('#dbSearch').oninput = (e) => {
    dbState.search = e.target.value.trim().toLowerCase();
    renderDatabaseTable();
  };
}

if ($('#dbSort')) {
  $('#dbSort').onchange = (e) => {
    dbState.sort = e.target.value;
    renderDatabaseTable();
  };
}

if ($('#dbSubCat')) {
  $('#dbSubCat').onchange = (e) => {
    dbState.subCat = e.target.value;
    renderDatabaseTable();
  };
}

$('#btnQuickAddFromDb')?.addEventListener('click', () => {
  showTab('entry');
  const targetType = dbState.itemType === 'material' ? 'material' : 'tool';
  setEntryItemType(targetType);
  setTimeout(() => $('#entryNameInput')?.focus(), 80);
});

// Mengubah Kondisi Barang (Bagus / Kalibrasi / Eject) Langsung dari Tabel
async function changeToolCondition(code, newCond) {
  try {
    const res = await api(`/api/tools/${encodeURIComponent(code)}/condition`, {
      method: 'POST',
      body: { condition: newCond },
    });
    const idx = allToolsCache.findIndex((t) => t.code === code);
    if (idx !== -1 && res.tool) {
      allToolsCache[idx] = { ...allToolsCache[idx], ...res.tool };
    }
    feedback.ok();
    updateDbCounterBadges();
    renderDatabaseTable();
    renderToolsCatalog();
  } catch (err) {
    feedback.err();
    alert('Gagal mengubah kondisi barang: ' + err.message);
  }
}
window.changeToolCondition = changeToolCondition;

// Mengubah Jumlah Stok Barang (+ / - atau ketik langsung) dari Tabel Database & Data Entry
async function changeToolQuantity(code, valOrDelta, isDelta = false) {
  try {
    const body = isDelta ? { delta: Number(valOrDelta) } : { quantity: Number(valOrDelta) };
    const res = await api(`/api/tools/${encodeURIComponent(code)}/quantity`, {
      method: 'POST',
      body,
    });
    const idx = allToolsCache.findIndex((t) => t.code === code);
    if (idx !== -1 && res.tool) {
      allToolsCache[idx] = { ...allToolsCache[idx], ...res.tool };
    }
    feedback.info();
    updateDbCounterBadges();
    renderDatabaseTable();
    renderToolsCatalog();
  } catch (err) {
    feedback.err();
    alert('Gagal mengubah jumlah barang: ' + err.message);
  }
}
window.changeToolQuantity = changeToolQuantity;

function renderDatabaseTable() {
  const isType = (t, type) => {
    if (type === 'all') return true;
    const it = t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool');
    return it === type;
  };
  const isReady = (t) => Number(t.quantity ?? 0) > 0 && (t.condition || 'bagus') !== 'eject' && t.status !== 'rusak';
  const isOut = (t) => !!t.holder || Number(t.borrowed_qty || 0) > 0;

  let list = allToolsCache.filter((t) => isType(t, dbState.itemType));

  // Filter Ketersediaan (Semua vs Ready vs Keluar)
  if (dbState.avail === 'ready') list = list.filter(isReady);
  else if (dbState.avail === 'out') list = list.filter(isOut);

  // Filter Kondisi (Bagus vs Kalibrasi vs Eject)
  if (dbState.cond === 'bagus') list = list.filter((t) => (t.condition || 'bagus') === 'bagus' && t.status !== 'rusak');
  else if (dbState.cond === 'kalibrasi') list = list.filter((t) => t.condition === 'kalibrasi');
  else if (dbState.cond === 'eject') list = list.filter((t) => t.condition === 'eject' || t.status === 'rusak');

  // Filter Sub-Kategori
  if (dbState.subCat) list = list.filter((t) => t.category === dbState.subCat);

  // Filter Pencarian Teks
  if (dbState.search) {
    const q = dbState.search;
    list = list.filter((t) => [t.code, t.name, t.category, t.holder, t.holder_code, t.note].some((v) => String(v || '').toLowerCase().includes(q)));
  }

  // Pengurutan (Kode, Abjad A-Z, Z-A, Tanggal Ditambahkan Terbaru, Terlama)
  list.sort((a, b) => {
    switch (dbState.sort) {
      case 'code_asc': return (a.code || '').localeCompare(b.code || '', 'id', { numeric: true });
      case 'name_asc': return (a.name || '').localeCompare(b.name || '', 'id');
      case 'name_desc': return (b.name || '').localeCompare(a.name || '', 'id');
      case 'date_desc': return Date.parse(b.created_at || '2026-01-01') - Date.parse(a.created_at || '2026-01-01');
      case 'date_asc': return Date.parse(a.created_at || '2026-01-01') - Date.parse(b.created_at || '2026-01-01');
      default: return 0;
    }
  });

  // Perbarui Teks Heading Tabel
  const availText = dbState.avail === 'ready' ? 'Ready' : (dbState.avail === 'out' ? 'Sedang Dipinjam' : 'Semua Status');
  const typeText = dbState.itemType === 'tool' ? 'Tools' : (dbState.itemType === 'material' ? 'Material' : 'Semua Barang');
  const heading = $('#dbTableHeading');
  if (heading) heading.textContent = `Tabel Database: ${list.length} ${typeText} (${availText})`;

  const table = $('#dbTable');
  const cardsBox = $('#dbCards');

  if (!list.length) {
    if (table) table.innerHTML = `<tbody><tr><td colspan="9" style="text-align:center;padding:32px;color:#64748b;font-weight:600;">Tidak ada barang yang cocok.</td></tr></tbody>`;
    if (cardsBox) cardsBox.innerHTML = `<div class="empty">Tidak ada barang yang cocok.</div>`;
    return;
  }

  // Render Kartu Visual Besar untuk HP (Mudah dibaca & disentuh)
  if (cardsBox) {
    cardsBox.innerHTML = list.map((t) => {
      const isTool = (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'tool';
      const codeCls = isTool ? 'code-pill tool' : 'code-pill material';
      const cond = t.condition || (t.status === 'rusak' ? 'eject' : 'bagus');
      const qtyNum = t.quantity ?? 1;
      const borrowedQty = Number(t.borrowed_qty || 0);
      const unitTxt = esc(t.unit || (isTool ? 'Unit' : 'Pcs'));
      const canBorrow = Number(qtyNum) > 0 && cond === 'bagus' && t.status !== 'rusak';

      let stateCls = 'ready';
      let badgeHtml = `<span class="excel-badge ready"><span class="hl-dot"></span> Ready</span>`;
      if (cond === 'eject' || t.status === 'rusak') {
        stateCls = 'eject';
        badgeHtml = `<span class="excel-badge eject"><span class="hl-dot"></span> Rusak</span>`;
      } else if (cond === 'kalibrasi') {
        stateCls = 'kalibrasi';
        badgeHtml = `<span class="excel-badge kalibrasi"><span class="hl-dot"></span> Kalibrasi</span>`;
      } else if (t.holder && Number(qtyNum) <= 0) {
        stateCls = 'out';
        badgeHtml = `<span class="excel-badge out"><span class="hl-dot"></span> Dipinjam ${esc(t.holder)}</span>`;
      } else if (t.holder && Number(qtyNum) > 0) {
        stateCls = 'out';
        badgeHtml = `<span class="excel-badge out"><span class="hl-dot"></span> ${borrowedQty} dipinjam ${esc(t.holder)}</span>`;
      } else if (Number(qtyNum) <= 0) {
        stateCls = 'eject';
        badgeHtml = `<span class="excel-badge eject"><span class="hl-dot"></span> Habis</span>`;
      }

      return `<div class="m-card m-state-${stateCls}">
        <div class="mc-top">
          <div class="mc-title-wrap">
            <div class="mc-name">${esc(t.name)}</div>
            <div class="mc-meta">
              <span class="${codeCls}">${esc(t.code)}</span>
              ${t.category ? `<span class="muted small">· ${esc(t.category)}</span>` : ''}
            </div>
          </div>
          ${badgeHtml}
        </div>
        <div class="mc-bottom">
          <div class="inline-qty-wrap mc-qty">
            <button type="button" class="inline-qty-btn" onclick="changeToolQuantity('${esc(t.code)}', -1, true)">−</button>
            <input type="number" inputmode="decimal" step="any" min="0" class="inline-qty-input" value="${qtyNum}" onchange="changeToolQuantity('${esc(t.code)}', this.value, false)">
            <button type="button" class="inline-qty-btn" onclick="changeToolQuantity('${esc(t.code)}', 1, true)">+</button>
            <span class="inline-qty-unit">${unitTxt}</span>
          </div>
          <div class="mc-actions">
            ${canBorrow ? `<button type="button" class="btn btn-ok btn-sm" onclick="quickBorrowItem('${esc(t.code)}')">🤝 Pinjam</button>` : ''}
            <button type="button" class="btn btn-ghost btn-sm" onclick="openToolModal('${esc(t.code)}')">🔲 QR</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  if (!table) return;

  const thead = `<thead>
    <tr>
      <th style="width:42px;text-align:center">No</th>
      <th style="width:100px">Kode</th>
      <th>Nama Barang</th>
      <th style="width:110px">Tipe</th>
      <th>Kategori</th>
      <th style="width:165px">Jumlah / Stok</th>
      <th style="width:140px">Kondisi</th>
      <th>Status</th>
      <th style="width:155px;text-align:center">Aksi</th>
    </tr>
  </thead>`;

  const tbody = `<tbody>` + list.map((t, idx) => {
    const isTool = (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'tool';
    const codeCls = isTool ? 'code-pill tool' : 'code-pill material';
    const cond = t.condition || (t.status === 'rusak' ? 'eject' : 'bagus');

    const qtyNum = t.quantity ?? 1;
    const borrowedQty = Number(t.borrowed_qty || 0);
    const unitTxt = esc(t.unit || (isTool ? 'Unit' : 'Pcs'));
    const typeLabel = isTool ? '🧰 Tools' : '📦 Material';
    const canBorrow = Number(qtyNum) > 0 && cond === 'bagus' && t.status !== 'rusak';

    // Status Ketersediaan & Highlight Baris ala Spreadsheet Elegan
    let availHtml = '';
    let rowStateCls = 'row-state-ready';

    if (cond === 'eject' || t.status === 'rusak') {
      rowStateCls = 'row-state-eject';
      availHtml = `<span class="excel-badge eject"><span class="hl-dot"></span> Rusak</span>`;
    } else if (cond === 'kalibrasi') {
      rowStateCls = 'row-state-kalibrasi';
      availHtml = `<span class="excel-badge kalibrasi"><span class="hl-dot"></span> Kalibrasi</span>`;
    } else if (!isTool) {
      // Strategi Material = Habis Pakai (Bukan Pinjam)
      if (Number(qtyNum) <= 0) {
        rowStateCls = 'row-state-eject';
        availHtml = `<span class="excel-badge eject"><span class="hl-dot"></span> Stok Habis (0 ${unitTxt})</span>`;
      } else {
        rowStateCls = 'row-state-ready';
        availHtml = `<span class="excel-badge ready"><span class="hl-dot"></span> Stok Tersedia (${qtyNum} ${unitTxt})</span>`;
      }
    } else if (t.holder && Number(qtyNum) <= 0) {
      rowStateCls = 'row-state-out';
      availHtml = `<span class="excel-badge out"><span class="hl-dot"></span> Dipinjam: <b>${esc(t.holder)}</b> (${borrowedQty || 1} ${unitTxt})</span>`;
    } else if (t.holder && Number(qtyNum) > 0) {
      rowStateCls = 'row-state-out';
      availHtml = `<div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
        <span class="excel-badge ready"><span class="hl-dot"></span> Ready (${qtyNum} ${unitTxt})</span>
        <span class="excel-badge out"><span class="hl-dot"></span> Dipinjam: <b>${esc(t.holder)}</b> (${borrowedQty} ${unitTxt})</span>
      </div>`;
    } else if (Number(qtyNum) <= 0) {
      rowStateCls = 'row-state-eject';
      availHtml = `<span class="excel-badge eject"><span class="hl-dot"></span> Habis (0 ${unitTxt})</span>`;
    } else {
      rowStateCls = 'row-state-ready';
      availHtml = `<span class="excel-badge ready"><span class="hl-dot"></span> Ready</span>`;
    }

    const actionBtnLabel = isTool ? '🤝 Pinjam' : '📦 Ambil';
    const actionBtnCls = isTool ? 'btn btn-ok btn-sm' : 'btn btn-primary btn-sm';

    return `<tr class="${rowStateCls}">
      <td class="excel-row-num">${idx + 1}</td>
      <td>
        <span class="${codeCls}">${esc(t.code)}</span>
      </td>
      <td>
        <b>${esc(t.name)}</b>
      </td>
      <td>
        <span class="muted small">${typeLabel}</span>
      </td>
      <td>
        <span>${esc(t.category || '-')}</span>
      </td>
      <td>
        <div class="inline-qty-wrap" title="Klik - / + atau ketik langsung untuk mengubah jumlah stok">
          <button type="button" class="inline-qty-btn" onclick="changeToolQuantity('${esc(t.code)}', -1, true)">−</button>
          <input type="number" step="any" min="0" class="inline-qty-input" value="${qtyNum}" onchange="changeToolQuantity('${esc(t.code)}', this.value, false)">
          <button type="button" class="inline-qty-btn" onclick="changeToolQuantity('${esc(t.code)}', 1, true)">+</button>
          <span class="inline-qty-unit">${unitTxt}</span>
        </div>
      </td>
      <td>
        <select class="cond-select-inline ${cond}" onchange="changeToolCondition('${esc(t.code)}', this.value)" title="Ubah kondisi barang">
          <option value="bagus" ${cond === 'bagus' ? 'selected' : ''}>🟢 Bagus</option>
          <option value="kalibrasi" ${cond === 'kalibrasi' ? 'selected' : ''}>🟡 Kalibrasi</option>
          <option value="eject" ${cond === 'eject' ? 'selected' : ''}>🔴 Rusak</option>
        </select>
      </td>
      <td>
        ${availHtml}
      </td>
      <td style="text-align:center;white-space:nowrap">
        ${canBorrow ? `<button type="button" class="${actionBtnCls}" onclick="quickBorrowItem('${esc(t.code)}')">${actionBtnLabel}</button>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" onclick="openToolModal('${esc(t.code)}')">🔲 QR</button>
      </td>
    </tr>`;
  }).join('') + `</tbody>`;

  table.innerHTML = thead + tbody;
}

// Pintasan 1-Klik Pinjam langsung dari daftar Stok
async function quickBorrowItem(code) {
  showTab('scan');
  await loadScanBorrowView();
  selectScanItem(code, true);
  setTimeout(() => {
    $('#scanStepBorrower')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
}
window.quickBorrowItem = quickBorrowItem;

$('#btnToggleDbFilter')?.addEventListener('click', () => {
  const box = $('#dbMoreFilters');
  if (!box) return;
  box.classList.toggle('open');
});

// =====================================================================
// HALAMAN 2: DATA ENTRY (COMPACT, SIMPEL & MUDAH DIGUNAKAN AWAM)
// =====================================================================
let entryQuickFilter = 'all';

async function loadDataEntryView() {
  try {
    const tools = await api('/api/tools');
    allToolsCache = tools;
    if ($('#dlToolsCount')) $('#dlToolsCount').textContent = tools.length;
    if ($('#entryTotalCount')) $('#entryTotalCount').textContent = tools.length;

    const countTools = tools.filter((t) => (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'tool').length;
    const countMaterial = tools.filter((t) => (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'material').length;
    if ($('#entryCountTool')) $('#entryCountTool').textContent = countTools;
    if ($('#entryCountMaterial')) $('#entryCountMaterial').textContent = countMaterial;

    if ($('#catList')) {
      $('#catList').innerHTML = [...new Set(tools.map((t) => t.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('');
    }
    updateDataEntryCodePlaceholder();
    renderToolsCatalog();
  } catch (err) {
    console.error('loadDataEntryView err:', err);
  }
}

function setEntryItemType(type, updateDefaults = true) {
  const validType = type === 'material' ? 'material' : 'tool';
  const inp = $('#entryItemType');
  if (inp) inp.value = validType;

  $('#btnEntryTypeTool')?.classList.toggle('active', validType === 'tool');
  $('#btnEntryTypeMaterial')?.classList.toggle('active', validType === 'material');

  if (updateDefaults) {
    const unitSel = $('#entryUnit');
    if (unitSel) unitSel.value = validType === 'material' ? 'Pcs' : 'Unit';
    const nameInp = $('#entryNameInput');
    if (nameInp) {
      nameInp.placeholder = validType === 'material'
        ? 'Contoh: Kawat Las RB-26 / Mata Gerinda / Oli Hidrolik…'
        : 'Contoh: Kunci Inggris 15" / Gerinda Makita / Multimeter…';
    }
  }
  updateDataEntryCodePlaceholder();
}

$('#btnEntryTypeTool')?.addEventListener('click', () => setEntryItemType('tool', true));
$('#btnEntryTypeMaterial')?.addEventListener('click', () => setEntryItemType('material', true));

// Tombol Stepper Jumlah (- dan +) di Form Data Entry
$('#btnQtyMinus')?.addEventListener('click', () => {
  const inp = $('#entryQty');
  if (!inp) return;
  const cur = Number(inp.value) || 0;
  inp.value = Math.max(0, cur - 1);
});

$('#btnQtyPlus')?.addEventListener('click', () => {
  const inp = $('#entryQty');
  if (!inp) return;
  const cur = Number(inp.value) || 0;
  inp.value = cur + 1;
});

// Tombol Cepat Upload Excel & Toggle Kotak Copy-Paste
$('#btnUploadCsvQuick')?.addEventListener('click', () => $('#importFile')?.click());
$('#btnTogglePasteBox')?.addEventListener('click', () => {
  const box = $('#importDataCard');
  if (!box) return;
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) $('#importText')?.focus();
});

function updateDataEntryCodePlaceholder() {
  const type = $('#entryItemType')?.value || 'tool';
  const prefix = type === 'material' ? 'M-' : 'T-';
  const items = allToolsCache.filter((t) => t.code && t.code.startsWith(prefix));
  const max = items.reduce((m, r) => Math.max(m, Number(r.code.replace(/\D+/g, '')) || 0), 0);
  const nextCode = prefix + String(max + 1).padStart(3, '0');

  const inp = $('#entryCodeInput');
  if (inp && (!inp.value || /^([TM]-\d{3,5})$/i.test(inp.value))) {
    inp.placeholder = `Otomatis: ${nextCode}`;
  }
}

$('#entryItemType')?.addEventListener('change', (e) => {
  setEntryItemType(e.target.value, true);
});

// Submit Form Tambah / Edit Data Entry
$('#toolForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const itemType = $('#entryItemType')?.value || 'tool';
  const codeVal = (f.code?.value || '').trim().toUpperCase();
  const nameVal = (f.name?.value || '').trim();
  const catVal = (f.category?.value || '').trim();
  const locVal = f.location ? f.location.value.trim() : '';
  const condVal = f.condition ? f.condition.value : 'bagus';
  const rawQty = $('#entryQty') ? $('#entryQty').value : (f.quantity ? f.quantity.value : 1);
  const qtyVal = rawQty !== '' && !Number.isNaN(Number(rawQty)) ? Math.max(0, Number(rawQty)) : 1;
  const unitVal = f.unit ? f.unit.value : (itemType === 'material' ? 'Pcs' : 'Unit');
  const noteVal = f.note ? f.note.value.trim() : '';

  try {
    const saved = await api('/api/admin/tools', {
      method: 'POST',
      body: {
        code: codeVal,
        name: nameVal,
        category: catVal,
        location: locVal,
        item_type: itemType,
        condition: condVal,
        quantity: qtyVal,
        unit: unitVal,
        note: noteVal,
      },
    });

    f.reset();
    if ($('#entryQty')) $('#entryQty').value = 1;
    if ($('#btnSubmitEntry')) $('#btnSubmitEntry').textContent = '💾 Simpan Barang';
    setEntryItemType(itemType, true);
    feedback.ok();
    await loadDataEntryView();
    await loadDatabaseView();
    openToolModal(saved.code, true);
  } catch (err) {
    feedback.err();
    alert('Gagal menyimpan data barang: ' + err.message);
  }
});

$('#btnResetEntry')?.addEventListener('click', () => {
  const curType = $('#entryItemType')?.value || 'tool';
  setTimeout(() => {
    if ($('#entryQty')) $('#entryQty').value = 1;
    if ($('#btnSubmitEntry')) $('#btnSubmitEntry').textContent = '💾 Simpan Barang';
    setEntryItemType(curType, true);
  }, 30);
});

function editToolInEntry(code) {
  const t = allToolsCache.find((x) => x.code === code);
  if (!t) return;
  showTab('entry');
  const f = $('#toolForm');
  if (!f) return;
  const itemType = t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool');
  setEntryItemType(itemType, false);
  if (f.code) f.code.value = t.code;
  if (f.name) f.name.value = t.name;
  if (f.category) f.category.value = t.category || '';
  if (f.condition) f.condition.value = t.condition || 'bagus';
  if ($('#entryQty')) $('#entryQty').value = t.quantity ?? 1;
  if (f.unit) f.unit.value = t.unit || (itemType === 'material' ? 'Pcs' : 'Unit');
  if (f.note) f.note.value = t.note || '';
  if ($('#btnSubmitEntry')) $('#btnSubmitEntry').textContent = `💾 Update (${t.code})`;
  $('#entryNameInput')?.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
window.editToolInEntry = editToolInEntry;

$('#btnToggleAdv')?.addEventListener('click', () => {
  const f = $('#toolForm');
  if (!f) return;
  const open = f.classList.toggle('show-adv');
  $('#btnToggleAdv').textContent = open ? '✕ Sembunyikan Kelompok & Kode' : '＋ Kelompok & Kode (opsional)';
});

// Filter Pills di Tabel Bawah Data Entry
$$('#entryFilterPills button').forEach((btn) => btn.onclick = () => {
  entryQuickFilter = btn.dataset.efilter || 'all';
  $$('#entryFilterPills button').forEach((b) => b.classList.toggle('active', b === btn));
  renderToolsCatalog();
});

// Render Tabel Ringkas & Kartu HP di Bawah Data Entry
function renderToolsCatalog() {
  const q = $('#toolSearch') ? $('#toolSearch').value.trim().toLowerCase() : '';
  const filtered = allToolsCache.filter((t) => {
    const it = t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool');
    if (entryQuickFilter !== 'all' && it !== entryQuickFilter) return false;
    if (!q) return true;
    return [t.code, t.name, t.category, t.item_type, t.holder].some((v) => String(v || '').toLowerCase().includes(q));
  });

  if ($('#entryTotalCount')) $('#entryTotalCount').textContent = filtered.length;
  const countTools = allToolsCache.filter((t) => (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'tool').length;
  const countMaterial = allToolsCache.filter((t) => (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'material').length;
  if ($('#entryCountTool')) $('#entryCountTool').textContent = countTools;
  if ($('#entryCountMaterial')) $('#entryCountMaterial').textContent = countMaterial;

  const tbl = $('#entryQuickTable');
  const cardsBox = $('#entryCards');

  if (!filtered.length) {
    if (tbl) tbl.innerHTML = `<tbody><tr><td colspan="8" style="text-align:center;padding:24px;color:#64748b;font-weight:600">Tidak ada barang yang cocok.</td></tr></tbody>`;
    if (cardsBox) cardsBox.innerHTML = `<div class="empty">Tidak ada barang yang cocok.</div>`;
    return;
  }

  if (cardsBox) {
    cardsBox.innerHTML = filtered.map((t) => {
      const isTool = (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'tool';
      const codeCls = isTool ? 'code-pill tool' : 'code-pill material';
      const cond = t.condition || (t.status === 'rusak' ? 'eject' : 'bagus');
      const qtyNum = t.quantity ?? 1;
      const unitTxt = esc(t.unit || (isTool ? 'Unit' : 'Pcs'));
      return `<div class="m-card">
        <div class="mc-top">
          <div class="mc-title-wrap">
            <div class="mc-name">${esc(t.name)}</div>
            <div class="mc-meta"><span class="${codeCls}">${esc(t.code)}</span></div>
          </div>
          <select class="cond-select-inline ${cond}" onchange="changeToolCondition('${esc(t.code)}', this.value)">
            <option value="bagus" ${cond === 'bagus' ? 'selected' : ''}>🟢 Bagus</option>
            <option value="kalibrasi" ${cond === 'kalibrasi' ? 'selected' : ''}>🟡 Kalibrasi</option>
            <option value="eject" ${cond === 'eject' ? 'selected' : ''}>🔴 Rusak</option>
          </select>
        </div>
        <div class="mc-bottom">
          <div class="inline-qty-wrap mc-qty">
            <button type="button" class="inline-qty-btn" onclick="changeToolQuantity('${esc(t.code)}', -1, true)">−</button>
            <input type="number" inputmode="decimal" step="any" min="0" class="inline-qty-input" value="${qtyNum}" onchange="changeToolQuantity('${esc(t.code)}', this.value, false)">
            <button type="button" class="inline-qty-btn" onclick="changeToolQuantity('${esc(t.code)}', 1, true)">+</button>
            <span class="inline-qty-unit">${unitTxt}</span>
          </div>
          <div class="mc-actions">
            <button type="button" class="btn btn-ghost btn-sm" onclick="editToolInEntry('${esc(t.code)}')">✏️ Edit</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="openToolModal('${esc(t.code)}')">🔲 QR</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  if (!tbl) return;

  const thead = `<thead>
    <tr>
      <th style="width:40px;text-align:center">No</th>
      <th style="width:95px">Kode</th>
      <th>Nama Barang</th>
      <th style="width:110px">Tipe</th>
      <th>Kelompok</th>
      <th style="width:165px">Atur Jumlah Stok</th>
      <th style="width:135px">Kondisi</th>
      <th style="width:150px;text-align:center">Aksi Cepat</th>
    </tr>
  </thead>`;

  const tbody = `<tbody>` + filtered.map((t, idx) => {
    const isTool = (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'tool';
    const codeCls = isTool ? 'code-pill tool' : 'code-pill material';
    const cond = t.condition || (t.status === 'rusak' ? 'eject' : 'bagus');
    const qtyNum = t.quantity ?? 1;
    const unitTxt = esc(t.unit || (isTool ? 'Unit' : 'Pcs'));

    return `<tr>
      <td class="excel-row-num">${idx + 1}</td>
      <td><span class="${codeCls}">${esc(t.code)}</span></td>
      <td><b>${esc(t.name)}</b></td>
      <td><span class="muted small">${isTool ? '🧰 Tools' : '📦 Material'}</span></td>
      <td>${esc(t.category || '-')}</td>
      <td>
        <div class="inline-qty-wrap">
          <button type="button" class="inline-qty-btn" onclick="changeToolQuantity('${esc(t.code)}', -1, true)">−</button>
          <input type="number" step="any" min="0" class="inline-qty-input" value="${qtyNum}" onchange="changeToolQuantity('${esc(t.code)}', this.value, false)">
          <button type="button" class="inline-qty-btn" onclick="changeToolQuantity('${esc(t.code)}', 1, true)">+</button>
          <span class="inline-qty-unit">${unitTxt}</span>
        </div>
      </td>
      <td>
        <select class="cond-select-inline ${cond}" onchange="changeToolCondition('${esc(t.code)}', this.value)">
          <option value="bagus" ${cond === 'bagus' ? 'selected' : ''}>🟢 Bagus</option>
          <option value="kalibrasi" ${cond === 'kalibrasi' ? 'selected' : ''}>🟡 Kalibrasi</option>
          <option value="eject" ${cond === 'eject' ? 'selected' : ''}>🔴 Eject</option>
        </select>
      </td>
      <td style="text-align:center;white-space:nowrap">
        <button type="button" class="btn btn-ghost btn-sm" onclick="editToolInEntry('${esc(t.code)}')" title="Edit di form atas">✏️ Edit</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="openToolModal('${esc(t.code)}')" title="Lihat QR & Detail">🔲 QR</button>
      </td>
    </tr>`;
  }).join('') + `</tbody>`;

  tbl.innerHTML = thead + tbody;
}

if ($('#toolSearch')) $('#toolSearch').oninput = renderToolsCatalog;

// Modal Detail Barang + Generator Stiker QR (Bisa Download PNG atau Cetak!)
async function openToolModal(code, newlyCreated = false) {
  const d = await api(`/api/tools/${encodeURIComponent(code)}/detail`);
  const t = d.tool;
  const open = d.openLoan;
  const isAdmin = currentUser?.role === 'admin';
  const isTool = (t.item_type || 'tool') === 'tool';

  const statusHtml = open
    ? `<div class="card" style="background:#fffbeb;border-color:#f59e0b;margin:10px 0">
         <div style="font-weight:800;color:#92400e">🔒 Sedang Dipinjam oleh: ${esc(open.worker_name)} (${esc(open.worker_code)})</div>
         <div class="small">Divisi: ${esc(open.worker_dept || '-')} · No. HP: ${esc(open.worker_phone || '-')}</div>
         <div class="small muted">Sejak: ${fmtTime(open.out_at)} (${fmtDur(Date.now() - Date.parse(open.out_at))})</div>
         ${open.transferred_from ? `<div class="small"><span class="tag info">Hasil Oper dari ${esc(open.transferred_from_name || open.transferred_from)}</span></div>` : ''}
       </div>`
    : t.condition === 'eject' || t.status === 'rusak'
    ? `<div class="card" style="background:#fee2e2;border-color:#dc2626;margin:10px 0">
         <b style="color:#dc2626">🔴 Status Kondisi: EJECT / AFKIR</b>
         <div class="small">${esc(t.note || 'Barang rusak / tidak layak pakai')}</div>
       </div>`
    : t.condition === 'kalibrasi'
    ? `<div class="card" style="background:#fef3c7;border-color:#d97706;margin:10px 0">
         <b style="color:#b45309">🟡 Status Kondisi: PERLU KALIBRASI</b>
         <div class="small">${esc(t.note || 'Perlu proses kalibrasi berkala')}</div>
       </div>`
    : `<div class="card" style="background:#dcfce7;border-color:#16a34a;margin:10px 0">
         <b style="color:#15803d">🟢 Kondisi Bagus &amp; Tersedia di Gudang (${esc(t.location || 'Rak Gudang')})</b>
       </div>`;

  // Tombol aksi kontekstual
  let actionBtns = '';
  if (!open && t.status !== 'rusak' && t.condition !== 'eject' && !isAdmin) {
    actionBtns += `<button type="button" id="mBtnBorrowNow" class="btn btn-primary btn-block" style="margin-bottom:8px">📥 Pinjam Barang Ini Sekarang</button>`;
  }
  if (open && open.worker_code !== currentUser?.username && !isAdmin) {
    actionBtns += `<button type="button" id="mBtnReqTransfer" class="btn btn-primary btn-block" style="margin-bottom:8px">🔄 Minta Persetujuan Oper dari ${esc(open.worker_name)}</button>`;
  }
  if (open && isAdmin) {
    actionBtns += `<button type="button" id="mBtnAdminReturn" class="btn btn-ok btn-block" style="margin-bottom:8px">↩️ Verifikasi Barang Kembali ke Gudang</button>`;
  }

  const adminControls = isAdmin ? `
    <div class="row wrap gap8" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
      <div class="small muted" style="width:100%;font-weight:700">Ubah Kondisi Cepat:</div>
      <button type="button" id="mBtnCondBagus" class="btn btn-ghost btn-sm ${t.condition === 'bagus' ? 'btn-ok' : ''}">🟢 Bagus</button>
      <button type="button" id="mBtnCondKalibrasi" class="btn btn-ghost btn-sm ${t.condition === 'kalibrasi' ? 'btn-primary' : ''}">🟡 Kalibrasi</button>
      <button type="button" id="mBtnCondEject" class="btn btn-ghost btn-sm ${t.condition === 'eject' ? 'btn-danger' : ''}">🔴 Eject</button>
      <button type="button" id="mBtnEditTool" class="btn btn-ghost btn-sm">✏️ Edit di Data Entry</button>
      <button type="button" id="mBtnDelTool" class="btn btn-danger btn-sm">🗑️ Hapus</button>
    </div>` : '';

  const historyHtml = d.history.length
    ? `<div style="margin-top:12px">
         <div class="small" style="font-weight:800;margin-bottom:6px">Riwayat Peminjaman &amp; Oper Terakhir:</div>
         ${d.history.slice(0, 6).map((h) => `
           <div class="item small">
             <div>
               <b>${esc(h.worker_name)}</b> (${esc(h.worker_code)})
               ${h.transferred_from ? `<span class="tag info">Oper dari ${esc(h.transferred_from_name || h.transferred_from)}</span>` : ''}
               <div class="muted">${fmtTime(h.out_at)} → ${h.in_at ? fmtTime(h.in_at) : '<b>Masih Dipinjam</b>'}</div>
             </div>
             <div class="muted">${h.in_by_name ? 'Diterima: ' + esc(h.in_by_name) : ''}</div>
           </div>`).join('')}
       </div>`
    : '';

  dialog(`
    ${newlyCreated ? `<div class="tag ok" style="margin-bottom:8px">🎉 Barang berhasil disimpan &amp; QR Code otomatis dibuat!</div>` : ''}
    <div class="row between">
      <div>
        <div class="muted small">${isTool ? '🧰 Tools' : '📦 Material'} · ${esc(t.category || 'Barang Gudang')}</div>
        <h2 style="margin:2px 0">${esc(t.name)}</h2>
        <div class="small">Stok: <b>${t.quantity ?? 1} ${esc(t.unit || (isTool ? 'Unit' : 'Pcs'))}</b></div>
      </div>
      <code style="font-size:1.1rem">${esc(t.code)}</code>
    </div>

    <!-- Preview Stiker QR Barang -->
    <div class="qr-sticker-preview">
      <img class="qr-img" src="/api/qr/${encodeURIComponent(t.code)}.svg" alt="QR ${esc(t.code)}">
      <div style="min-width:0">
        <div style="font-size:.72rem;font-weight:900;color:#0f2942;letter-spacing:.4px">GFM · PT SULAWESI CAHAYA MINERAL</div>
        <div style="font-size:1.3rem;font-weight:900;color:#0f2942">${esc(t.code)}</div>
        <div style="font-weight:800;font-size:.95rem">${esc(t.name)}</div>
        <div class="small muted">${esc([t.category, `${t.quantity ?? 1} ${t.unit || ''}`].filter(Boolean).join(' · '))}</div>
        <div class="row wrap gap8" style="margin-top:8px">
          <button type="button" id="mBtnDlPng" class="btn btn-primary btn-sm">⬇️ Unduh Stiker QR (.PNG)</button>
          <a class="btn btn-dark btn-sm" href="/labels?codes=${encodeURIComponent(t.code)}" target="_blank">🖨️ Cetak Stiker</a>
        </div>
      </div>
    </div>

    ${statusHtml}
    ${actionBtns}
    ${adminControls}
    ${historyHtml}
  `, [{ label: 'Tutup', cls: 'btn-ghost' }]);

  const btnDl = $('#mBtnDlPng');
  if (btnDl) btnDl.onclick = () => downloadQrStickerPng(t);

  const btnBorrow = $('#mBtnBorrowNow');
  if (btnBorrow) btnBorrow.onclick = async () => {
    $('#modal').classList.add('hidden');
    showTab('scan');
    await processScan(t.code);
  };

  const btnReq = $('#mBtnReqTransfer');
  if (btnReq) btnReq.onclick = async () => {
    const note = prompt(`Catatan permintaan oper untuk ${open.worker_name} (opsional):`, '') ?? '';
    try {
      await api('/api/transfers/request', { method: 'POST', body: { toolCode: t.code, note } });
      $('#modal').classList.add('hidden');
      feedback.ok();
      showTab('scan');
      addEvent('info', '🔄 Permintaan Oper Terkirim', `Menunggu persetujuan dari <b>${esc(open.worker_name)}</b> untuk barang <b>${esc(t.name)}</b>.`);
    } catch (e) { alert(e.message); }
  };

  const btnRet = $('#mBtnAdminReturn');
  if (btnRet) btnRet.onclick = async () => {
    $('#modal').classList.add('hidden');
    showTab('scan');
    await processScan(t.code);
  };

  const btnCondB = $('#mBtnCondBagus');
  if (btnCondB) btnCondB.onclick = async () => {
    await changeToolCondition(t.code, 'bagus');
    openToolModal(t.code);
  };

  const btnCondK = $('#mBtnCondKalibrasi');
  if (btnCondK) btnCondK.onclick = async () => {
    await changeToolCondition(t.code, 'kalibrasi');
    openToolModal(t.code);
  };

  const btnCondE = $('#mBtnCondEject');
  if (btnCondE) btnCondE.onclick = async () => {
    await changeToolCondition(t.code, 'eject');
    openToolModal(t.code);
  };

  const btnEdit = $('#mBtnEditTool');
  if (btnEdit) btnEdit.onclick = () => {
    $('#modal').classList.add('hidden');
    editToolInEntry(t.code);
  };

  const btnDel = $('#mBtnDelTool');
  if (btnDel) btnDel.onclick = async () => {
    if (!confirm(`Hapus barang ${t.code} (${t.name})?`)) return;
    try {
      await api('/api/admin/tools/' + encodeURIComponent(t.code), { method: 'DELETE' });
      $('#modal').classList.add('hidden');
      loadDatabaseView();
    } catch (e) { alert(e.message); }
  };
}

// Render stiker QR beresolusi tinggi (PNG) siap cetak / kirim ke WA
async function downloadQrStickerPng(tool) {
  const W = 720, H = 360;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Background & border
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#0f2942';
  ctx.lineWidth = 6;
  ctx.strokeRect(10, 10, W - 20, H - 20);

  // Header bar
  ctx.fillStyle = '#0f2942';
  ctx.fillRect(10, 10, W - 20, 54);
  ctx.fillStyle = '#fcd34d';
  ctx.font = 'bold 20px Arial, sans-serif';
  ctx.fillText('GFM — PT SULAWESI CAHAYA MINERAL', 28, 44);

  // Gambar QR
  const qrImg = new Image();
  qrImg.crossOrigin = 'anonymous';
  await new Promise((res, rej) => {
    qrImg.onload = res; qrImg.onerror = rej;
    qrImg.src = `/api/qr/${encodeURIComponent(tool.code)}.svg`;
  });
  ctx.drawImage(qrImg, 24, 76, 250, 250);

  // Teks Informasi Barang
  ctx.fillStyle = '#0f2942';
  ctx.font = '900 54px Arial, sans-serif';
  ctx.fillText(tool.code, 292, 140);

  ctx.fillStyle = '#111827';
  ctx.font = 'bold 28px Arial, sans-serif';
  const words = String(tool.name).split(' ');
  let line = '', y = 188;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > 395 && line) {
      ctx.fillText(line, 292, y);
      line = w; y += 34;
    } else line = test;
  }
  if (line) ctx.fillText(line, 292, y);

  ctx.fillStyle = '#475569';
  ctx.font = 'bold 21px Arial, sans-serif';
  ctx.fillText([tool.category, `${tool.quantity ?? 1} ${tool.unit || 'Unit'}`].filter(Boolean).join('  ·  ') || 'Gudang SCM', 292, 275);

  ctx.fillStyle = '#b45309';
  ctx.font = 'bold 18px Arial, sans-serif';
  ctx.fillText('MILIK GUDANG GFM — WAJIB SCAN QR', 292, 318);

  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `QR-${tool.code}-${tool.name.replace(/[^a-z0-9]+/gi, '-')}.png`;
  a.click();
}

// =====================================================================
// TAB 3: MONITORING DI LUAR & LAPORAN SHIFT
// =====================================================================
async function refreshOutStats() {
  if (!currentUser) return;
  try {
    const d = await api('/api/out?since=' + encodeURIComponent(startOfToday().toISOString()));
    const b = $('#outBadge');
    if (b) {
      b.textContent = d.stats.out;
      b.classList.toggle('hidden', !d.stats.out);
    }
    if (currentTab === 'out' || currentTab === 'admin') renderOut(d);
  } catch { /* abaikan */ }
}

async function loadOut() { await refreshOutStats(); }

function renderOut(d) {
  const s = d.stats;
  if ($('#stats')) {
    $('#stats').innerHTML = `
      <div class="stat"><div class="n">${s.total}</div><div class="l">Total Jenis Barang</div></div>
      <div class="stat av"><div class="n">${s.available}</div><div class="l">Ready di Gudang</div></div>
      <div class="stat out"><div class="n">${s.out}</div><div class="l">Sedang Dipinjam</div></div>
      <div class="stat br"><div class="n">${s.broken}</div><div class="l">Eject / Rusak</div></div>
      <div class="stat"><div class="n">${s.todayLoans}</div><div class="l">Pinjaman Hari Ini</div></div>`;
  }

  if ($('#printTime')) $('#printTime').textContent = new Date().toLocaleString('id-ID');

  const ptBox = $('#pendingTransfersOverview');
  if (ptBox) {
    if (d.pendingTransfers?.length) {
      ptBox.classList.remove('hidden');
      ptBox.innerHTML = `<div class="card" style="background:#fffbeb;border-color:#f59e0b">
        <h3>🔄 Menunggu Persetujuan Oper Tangan (${d.pendingTransfers.length})</h3>
        ${d.pendingTransfers.map((tr) => `
          <div class="item small">
            <span><b>${esc(tr.tool_name)}</b> (<code>${esc(tr.tool_code)}</code>)</span>
            <span>Pemegang: <b>${esc(tr.from_name)}</b> → Diminta oleh: <b>${esc(tr.to_name)}</b></span>
          </div>`).join('')}
      </div>`;
    } else {
      ptBox.classList.add('hidden');
    }
  }

  if (!$('#outList')) return;
  if (!d.out.length) {
    $('#outList').innerHTML = '<div class="empty">🎉 Semua barang berada lengkap dan aman di dalam gudang.</div>';
    return;
  }

  const groups = new Map();
  for (const o of d.out) {
    const key = o.badge_id || o.worker_code;
    if (!groups.has(key)) {
      groups.set(key, {
        code: key, name: o.worker_name, dept: o.worker_dept, phone: o.worker_phone, items: [],
      });
    }
    groups.get(key).items.push(o);
  }

  const limit = CONFIG.shiftHours * 3600_000;
  $('#outList').innerHTML = [...groups.values()].map((g) => `
    <div class="who">
      <div class="who-head">
        <span>👷 <b>${esc(g.name)}</b> <span class="code-pill tool" style="font-size:.74rem;margin-left:4px">🪪 Badge: ${esc(g.code)}</span> <span class="muted small">${g.dept ? '· ' + esc(g.dept) : ''}</span></span>
        <span class="tag out">${g.items.length} transaksi aktif</span>
      </div>
      ${g.items.map((i) => {
        const age = Date.now() - Date.parse(i.out_at);
        const qtyTxt = `${i.qty ?? 1} ${esc(i.unit || 'Unit')}`;
        return `<div class="item ${age > limit ? 'overdue' : ''}" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div>
            <b>${esc(i.tool_name)}</b> <code>${esc(i.tool_code)}</code> · <b style="color:#0369a1">${qtyTxt}</b>
            <div class="small muted">Dipinjam: ${fmtTime(i.out_at)} (${fmtDur(age)})${age > limit ? ' ⚠️ LEWAT SHIFT' : ''}</div>
          </div>
          <button type="button" class="btn btn-ok btn-sm print-hide" onclick="returnBorrowedLoan(${i.id})">↩️ Kembalikan ke Gudang</button>
        </div>`;
      }).join('')}
    </div>`).join('');
}

// =====================================================================
// TAB 4: RIWAYAT & EXPORT EXCEL
// =====================================================================
$('#hFrom').value = $('#hTo').value = dateInput(new Date());
function historyParams() {
  const p = new URLSearchParams();
  if ($('#hFrom').value) p.set('from', new Date($('#hFrom').value + 'T00:00').toISOString());
  if ($('#hTo').value) { const d = new Date($('#hTo').value + 'T00:00'); d.setDate(d.getDate() + 1); p.set('to', d.toISOString()); }
  if ($('#hType') && $('#hType').value) p.set('item_type', $('#hType').value);
  if ($('#hQ').value.trim()) p.set('q', $('#hQ').value.trim());
  return p.toString();
}
async function loadHistory() {
  const rows = await api('/api/history?' + historyParams());
  if ($('#hTable')) {
    $('#hTable').innerHTML = `<thead><tr><th>Waktu Keluar / Pinjam</th><th>Status</th><th>Barang</th><th>Jumlah</th><th>Crew</th><th>Aksi</th></tr></thead><tbody>${
      rows.map((r) => {
        const isMat = r.item_type === 'material' || String(r.tool_code || '').startsWith('M-');
        const isConsumed = r.in_condition === 'consumed' || (isMat && r.in_at && r.in_at === r.out_at);
        const unitTxt = esc(r.unit || (isMat ? 'Pcs' : 'Unit'));
        const qtyTxt = `${r.qty ?? 1} ${unitTxt}`;
        const badgeId = esc(r.badge_id || r.worker_code);

        let statusBadge = '';
        if (isConsumed) {
          statusBadge = `<span class="excel-badge" style="background:#f3e8ff;color:#6b21a8;border:1px solid #d8b4fe">📦 HABIS PAKAI (KELUAR)</span>`;
        } else if (r.in_at) {
          statusBadge = `<span class="excel-badge ready">✔ Kembali ${fmtTime(r.in_at)}</span>`;
        } else {
          statusBadge = `<span class="excel-badge out">🟠 Sedang Dipinjam</span>`;
        }

        return `<tr class="${r.in_at ? 'row-state-ready' : 'row-state-out'}">
          <td>${fmtTime(r.out_at)}</td>
          <td>${statusBadge}</td>
          <td>
            <span class="${isMat ? 'code-pill material' : 'code-pill tool'}" style="font-size:.74rem">${esc(r.tool_code)}</span>
            <b>${esc(r.tool_name)}</b>
          </td>
          <td><b style="font-size:.92rem">${qtyTxt}</b></td>
          <td>
            <b>${esc(r.worker_name)}</b>
            <div class="small muted">🪪 ${badgeId}${r.worker_dept ? ' · ' + esc(r.worker_dept) : ''}</div>
          </td>
          <td class="small">
            ${!r.in_at ? `<button type="button" class="btn btn-ok btn-sm" onclick="returnBorrowedLoan(${r.id})">↩️ Kembalikan</button>` : (isConsumed ? '<span class="muted small">Habis Pakai</span>' : '-')}
          </td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">Belum ada riwayat pada tanggal ini.</td></tr>'}</tbody>`;
  }
}
$('#hGo').onclick = loadHistory;
$('#hQ').onkeydown = (e) => { if (e.key === 'Enter') loadHistory(); };
$('#hCsv').onclick = async () => {
  try {
    const rows = await api('/api/history?' + historyParams());
    if (!rows || !rows.length) return alert('Belum ada data riwayat pada filter tanggal yang dipilih.');
    const stamp = new Date().toISOString().slice(0, 10);
    const headers = ['Waktu Keluar', 'Status / Kembali', 'Tipe', 'Kode Barang', 'Nama Barang', 'Jumlah', 'Badge ID', 'Nama Crew', 'Divisi/Crew', 'Catatan'];
    const rRows = rows.map((r) => {
      const isMat = r.item_type === 'material' || String(r.tool_code || '').startsWith('M-');
      const isConsumed = r.in_condition === 'consumed' || (isMat && r.in_at && r.in_at === r.out_at);
      return {
        cells: [
          fmtTime(r.out_at),
          isConsumed ? 'HABIS PAKAI (KELUAR)' : (r.in_at ? fmtTime(r.in_at) : 'MASIH DIPINJAM'),
          isMat ? 'Material (Habis Pakai)' : 'Tools (Pinjam)',
          r.tool_code,
          r.tool_name,
          `${r.qty ?? 1} ${r.unit || 'Unit'}`,
          r.badge_id || r.worker_code,
          r.worker_name,
          r.worker_dept || '',
          r.in_note || '',
        ],
        isExample: false,
      };
    });
    const html = buildExcelWorkbookHtml({
      sheetName: 'Riwayat Gudang',
      title: 'GFM — PT SULAWESI CAHAYA MINERAL',
      subtitle: `LAPORAN RIWAYAT PINJAMAN TOOLS & MATERIAL HABIS PAKAI (${rows.length} Transaksi)`,
      note: `Filter: ${$('#hFrom').value || 'Awal'} s/d ${$('#hTo').value || 'Sekarang'}. Diunduh pada: ${new Date().toLocaleString('id-ID')}`,
      headers,
      rows: rRows,
    });
    triggerFileDownload(html, `riwayat-gudang-gfm-${stamp}.xls`, 'application/vnd.ms-excel;charset=utf-8');
    feedback.ok();
  } catch (err) {
    try {
      const res = await fetch('/api/history.csv?' + historyParams(), { headers: { Authorization: 'Bearer ' + getToken() } });
      const blob = await res.blob();
      triggerFileDownload(blob, `riwayat-gudang-gfm-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
      feedback.ok();
    } catch (e2) { alert('Gagal mengunduh riwayat: ' + err.message); }
  }
};

// =====================================================================
// TAB 5: PUSAT KENDALI ADMIN (CREW, DATA OPNAME / BALANCING STOK, REKAP, QR & BACKUP)
// =====================================================================
$$('.subtabs button').forEach((b) => b.onclick = () => {
  const sub = b.dataset.sub;
  $$('.subtabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('#tab-admin .sub').forEach((s) => s.classList.toggle('hidden', s.id !== 'sub-' + sub));
  if (sub !== 'opname') stopOpCam();
  if (sub === 'opname') loadOpnameBalanceView();
  if (sub === 'outlist') refreshOutStats();
});

function suggestNextCrewId(users) {
  const nums = (users || []).map((u) => {
    const m = String(u.username || '').match(/^CREW(\d+)$/i);
    return m ? Number(m[1]) : 0;
  });
  const next = Math.max(30, ...nums) + 1;
  return 'CREW' + String(next).padStart(2, '0');
}

function resetUserFormToCreate() {
  const f = $('#userForm');
  if (!f) return;
  f.reset();
  if ($('#ufUsername')) {
    $('#ufUsername').value = '';
    $('#ufUsername').readOnly = false;
    $('#ufUsername').placeholder = `Otomatis (${suggestNextCrewId(allUsersCache)})`;
  }
  if ($('#ufName')) $('#ufName').value = '';
  if ($('#ufDept')) $('#ufDept').value = '';
  if ($('#ufPhone')) $('#ufPhone').value = '';
  if ($('#ufRole')) $('#ufRole').value = 'crew';
  if ($('#ufPassword')) $('#ufPassword').value = '';
  if ($('#userFormTitle')) $('#userFormTitle').textContent = '➕ Tambah Crew';
  if ($('#ufSubmitBtn')) $('#ufSubmitBtn').textContent = '➕ Simpan Crew';
  $('#ufCancelBtn')?.classList.add('hidden');
}

if ($('#ufCancelBtn')) {
  $('#ufCancelBtn').onclick = () => resetUserFormToCreate();
}

function bindUserActionButtons(root) {
  $$('[data-uact]', root).forEach((b) => b.onclick = async () => {
    const u = allUsersCache.find((x) => x.username === b.dataset.u);
    if (!u) return;
    if (b.dataset.uact === 'edit') {
      if ($('#ufUsername')) $('#ufUsername').value = u.username;
      if ($('#ufName')) $('#ufName').value = u.name;
      if ($('#ufDept')) $('#ufDept').value = u.dept || '';
      if ($('#ufPhone')) $('#ufPhone').value = u.phone || '';
      if ($('#ufRole')) $('#ufRole').value = u.role || 'crew';
      if ($('#ufPassword')) $('#ufPassword').value = '';
      if ($('#userFormTitle')) $('#userFormTitle').textContent = `✏️ Edit Crew: ${u.name}`;
      if ($('#ufSubmitBtn')) $('#ufSubmitBtn').textContent = '💾 Simpan';
      $('#ufCancelBtn')?.classList.remove('hidden');
      $('#ufName')?.focus();
      $('#userForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (b.dataset.uact === 'del') {
      if (!(await confirmBox(`Hapus crew <b>${esc(u.username)} (${esc(u.name)})</b>?`, 'Ya, Hapus'))) return;
      try {
        await api('/api/admin/users/' + encodeURIComponent(u.username), { method: 'DELETE' });
        await loadAdminUsers();
        populateDelegateUsers();
      } catch (e) { alert(e.message); }
    }
  });
}

function renderAdminUsersTable() {
  const q = ($('#userSearchInput')?.value || '').trim().toLowerCase();
  const filtered = (allUsersCache || []).filter((u) => {
    if (!q) return true;
    return `${u.username} ${u.name} ${u.dept || ''}`.toLowerCase().includes(q);
  });

  if ($('#userTable')) {
    $('#userTable').innerHTML = `<thead><tr>
      <th style="width:42px;text-align:center">No</th>
      <th style="width:130px">Badge ID</th>
      <th>Nama Crew</th>
      <th>Divisi</th>
      <th style="width:155px">Status</th>
      <th style="width:155px;text-align:center">Aksi</th>
    </tr></thead><tbody>${
      filtered.map((u, idx) => `<tr class="${u.holding ? 'row-state-out' : 'row-state-ready'}">
        <td class="cell-no">${idx + 1}</td>
        <td><span class="code-pill tool">🪪 ${esc(u.username)}</span></td>
        <td><b>${esc(u.name)}</b></td>
        <td>${esc(u.dept || '-')}</td>
        <td>${u.holding ? `<span class="excel-badge out"><span class="hl-dot out"></span>Pinjam ${u.holding}</span>` : '<span class="excel-badge ready"><span class="hl-dot ready"></span>Bebas</span>'}</td>
        <td class="cell-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-uact="edit" data-u="${esc(u.username)}">✏️ Edit</button>
          ${u.username !== currentUser?.username ? `<button type="button" class="btn btn-danger btn-sm" data-uact="del" data-u="${esc(u.username)}">🗑️</button>` : ''}
        </td></tr>`).join('') || '<tr><td colspan="6" class="muted" style="text-align:center;padding:20px">Tidak ada crew yang cocok.</td></tr>'}</tbody>`;
    bindUserActionButtons($('#userTable'));
  }

  const userCards = $('#userCards');
  if (userCards) {
    userCards.innerHTML = filtered.map((u) => `<div class="m-card ${u.holding ? 'm-state-out' : 'm-state-ready'}">
      <div class="mc-top">
        <div class="mc-title-wrap">
          <div class="mc-name">👷 ${esc(u.name)}</div>
          <div class="mc-meta"><span class="code-pill tool">🪪 ${esc(u.username)}</span> <span class="muted small">· ${esc(u.dept || 'Crew')}</span></div>
        </div>
        ${u.holding ? `<span class="excel-badge out">Pinjam ${u.holding}</span>` : `<span class="excel-badge ready">Bebas</span>`}
      </div>
      <div class="mc-bottom" style="justify-content:flex-end">
        <div class="mc-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-uact="edit" data-u="${esc(u.username)}">✏️ Edit</button>
          ${u.username !== currentUser?.username ? `<button type="button" class="btn btn-danger btn-sm" data-uact="del" data-u="${esc(u.username)}">🗑️ Hapus</button>` : ''}
        </div>
      </div>
    </div>`).join('') || '<div class="empty">Tidak ada crew yang cocok.</div>';
    bindUserActionButtons(userCards);
  }
}

if ($('#userSearchInput')) {
  $('#userSearchInput').oninput = () => renderAdminUsersTable();
}

async function loadAdminUsers() {
  const users = await api('/api/users');
  allUsersCache = users;
  renderQuickAccountsDropdown(users);
  if ($('#dlUsersCount')) $('#dlUsersCount').textContent = users.length;
  if ($('#adminCrewCountTab')) $('#adminCrewCountTab').textContent = users.length;
  if ($('#dlToolsCount') && allToolsCache.length) $('#dlToolsCount').textContent = allToolsCache.length;
  if ($('#ufUsername') && !$('#ufUsername').value) {
    $('#ufUsername').placeholder = `Otomatis (${suggestNextCrewId(users)})`;
  }
  renderAdminUsersTable();
}

$('#userForm').onsubmit = async (e) => {
  e.preventDefault();
  const usernameVal = ($('#ufUsername')?.value || '').trim();
  const nameVal = ($('#ufName')?.value || '').trim();
  const deptVal = ($('#ufDept')?.value || '').trim();
  if (!nameVal) {
    feedback.err();
    $('#ufName')?.focus();
    return alert('Nama Lengkap Crew wajib diisi.');
  }
  try {
    const saved = await api('/api/admin/users', {
      method: 'POST',
      body: {
        username: usernameVal,
        name: nameVal,
        dept: deptVal,
        phone: $('#ufPhone')?.value || '',
        role: $('#ufRole')?.value || 'crew',
        password: $('#ufPassword')?.value || '',
      },
    });
    resetUserFormToCreate();
    feedback.ok();
    await loadAdminUsers();
    populateDelegateUsers();
    alert(`✅ Crew ${saved.username} (${saved.name}) berhasil disimpan!`);
  } catch (err) { alert(err.message); }
};

// Pintasan Cepat Admin: Tambah Tools / Material & Download Rekap Laporan 1-Klik
['#btnAdminQuickAddTool', '#btnSysAddTool'].forEach((sel) => {
  if ($(sel)) $(sel).onclick = () => {
    showTab('entry');
    if (typeof setEntryItemType === 'function') setEntryItemType('tool', true);
    setTimeout(() => $('#entryNameInput')?.focus(), 80);
  };
});
['#btnAdminQuickAddMat', '#btnSysAddMat'].forEach((sel) => {
  if ($(sel)) $(sel).onclick = () => {
    showTab('entry');
    if (typeof setEntryItemType === 'function') setEntryItemType('material', true);
    setTimeout(() => $('#entryNameInput')?.focus(), 80);
  };
});
if ($('#btnRecapStockExcel')) {
  $('#btnRecapStockExcel').onclick = () => downloadTemplate('tools', 'xls');
}
if ($('#btnRecapHistoryExcel')) {
  $('#btnRecapHistoryExcel').onclick = () => $('#hCsv')?.click();
}

// =====================================================================
// SUB 2: DATA OPNAME — BALANCING STOK GUDANG (SISTEM VS FISIK AKTUAL)
// =====================================================================
const opBalanceState = {
  filter: 'all', // 'all' | 'tool' | 'material' | 'diff'
  search: '',
  actualQtyMap: new Map(), // code -> actual physical quantity
  actualCondMap: new Map(), // code -> condition
};

function stopOpCam() { /* kompatibilitas navigasi */ }

async function loadOpnameBalanceView(forceReset = false) {
  try {
    const tools = await api('/api/tools');
    allToolsCache = tools;
    for (const t of tools) {
      if (forceReset || !opBalanceState.actualQtyMap.has(t.code)) {
        opBalanceState.actualQtyMap.set(t.code, Number(t.quantity ?? 0));
      }
      if (forceReset || !opBalanceState.actualCondMap.has(t.code)) {
        opBalanceState.actualCondMap.set(t.code, t.condition || (t.status === 'rusak' ? 'eject' : 'bagus'));
      }
    }
    renderOpnameBalanceTable();
  } catch (err) {
    console.error('loadOpnameBalanceView err:', err);
  }
}

function updateOpnameSummaryCounts() {
  const tools = allToolsCache || [];
  let matchCount = 0;
  let diffCount = 0;

  for (const t of tools) {
    const sysQty = Number(t.quantity ?? 0);
    const actQty = Number(opBalanceState.actualQtyMap.get(t.code) ?? sysQty);
    const sysCond = t.condition || (t.status === 'rusak' ? 'eject' : 'bagus');
    const actCond = opBalanceState.actualCondMap.get(t.code) || sysCond;
    if (actQty !== sysQty || actCond !== sysCond) diffCount++;
    else matchCount++;
  }

  if ($('#opTotalItems')) $('#opTotalItems').textContent = tools.length;
  if ($('#opMatchCount')) $('#opMatchCount').textContent = matchCount;
  if ($('#opDiffCount')) $('#opDiffCount').textContent = diffCount;
  if ($('#opDiffActionCount')) $('#opDiffActionCount').textContent = diffCount;
}

function renderOpnameBalanceTable() {
  updateOpnameSummaryCounts();
  const tbl = $('#opBalanceTable');
  if (!tbl) return;

  const q = (opBalanceState.search || '').toLowerCase();
  const list = (allToolsCache || []).filter((t) => {
    const it = t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool');
    const sysQty = Number(t.quantity ?? 0);
    const actQty = Number(opBalanceState.actualQtyMap.get(t.code) ?? sysQty);
    const sysCond = t.condition || (t.status === 'rusak' ? 'eject' : 'bagus');
    const actCond = opBalanceState.actualCondMap.get(t.code) || sysCond;
    const hasDiff = actQty !== sysQty || actCond !== sysCond;

    if (opBalanceState.filter === 'tool' && it !== 'tool') return false;
    if (opBalanceState.filter === 'material' && it !== 'material') return false;
    if (opBalanceState.filter === 'diff' && !hasDiff) return false;
    if (!q) return true;
    return [t.code, t.name, t.category].some((v) => String(v || '').toLowerCase().includes(q));
  });

  if (!list.length) {
    tbl.innerHTML = `<tbody><tr><td colspan="11" style="text-align:center;padding:28px;color:#64748b;font-weight:600">Tidak ada barang pada filter opname ini.</td></tr></tbody>`;
    return;
  }

  const thead = `<thead>
    <tr>
      <th style="width:38px;text-align:center">No</th>
      <th style="width:92px">Kode</th>
      <th>Nama Barang</th>
      <th style="width:105px">Tipe</th>
      <th style="width:120px;text-align:center">Total Awal / Aset</th>
      <th style="width:155px;text-align:center">Tercatat Keluar</th>
      <th style="width:130px;text-align:center">Sisa Sistem (di Rak)</th>
      <th style="width:168px">Fisik Aktual (di Rak)</th>
      <th style="width:165px;text-align:center">Status Balance / Selisih</th>
      <th style="width:128px">Kondisi</th>
      <th style="width:125px;text-align:center">Aksi</th>
    </tr>
  </thead>`;

  const tbody = `<tbody>` + list.map((t, idx) => {
    const isTool = (t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool')) === 'tool';
    const codeCls = isTool ? 'code-pill tool' : 'code-pill material';
    const unitTxt = esc(t.unit || (isTool ? 'Unit' : 'Pcs'));
    const sysQty = Number(t.quantity ?? 0);
    const borrowedQty = Number(t.borrowed_qty || 0);
    const consumedQty = Number(t.consumed_qty || 0);
    const totalInitialOrAsset = isTool ? (sysQty + borrowedQty) : (sysQty + consumedQty);

    const actQty = Number(opBalanceState.actualQtyMap.get(t.code) ?? sysQty);
    const diff = Number((actQty - sysQty).toFixed(2));
    const sysCond = t.condition || (t.status === 'rusak' ? 'eject' : 'bagus');
    const actCond = opBalanceState.actualCondMap.get(t.code) || sysCond;
    const hasDiff = diff !== 0 || actCond !== sysCond;

    // Kolom Tercatat Keluar (Pengurangan)
    let outInfoHtml = '';
    if (isTool) {
      outInfoHtml = borrowedQty > 0
        ? `<span class="excel-badge out">🟠 Dipinjam: <b>${borrowedQty} ${unitTxt}</b></span>${t.holder ? `<div class="small muted" style="margin-top:2px">👷 ${esc(t.holder)}</div>` : ''}`
        : `<span class="small muted">0 Dipinjam</span>`;
    } else {
      outInfoHtml = consumedQty > 0
        ? `<span class="excel-badge" style="background:#f3e8ff;color:#6b21a8;border:1px solid #d8b4fe">📦 Habis Pakai: <b>-${consumedQty} ${unitTxt}</b></span>`
        : `<span class="small muted">0 Keluar</span>`;
    }

    // Kolom Status Balance / Selisih
    let diffBadge = `<span class="excel-badge ready">✔ BALANCE (0)</span>`;
    let rowCls = 'row-state-ready';
    if (diff > 0) {
      const hint = isTool ? 'Alat di rak belum klik kembali?' : 'Stok masuk belum diinput?';
      diffBadge = `<span class="excel-badge" style="background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd">➕ Lebih +${diff} ${unitTxt}</span><div class="small muted" style="margin-top:2px">${hint}</div>`;
      rowCls = 'row-state-kalibrasi';
    } else if (diff < 0) {
      const hint = isTool ? 'Keluar belum tercatat / hilang' : 'Ambil material belum tercatat';
      diffBadge = `<span class="excel-badge eject">➖ Kurang ${diff} ${unitTxt}</span><div class="small muted" style="margin-top:2px">${hint}</div>`;
      rowCls = 'row-state-out';
    } else if (actCond !== sysCond) {
      diffBadge = `<span class="excel-badge kalibrasi">🔄 Ubah Kondisi</span>`;
      rowCls = 'row-state-kalibrasi';
    }

    return `<tr class="${rowCls}">
      <td class="excel-row-num">${idx + 1}</td>
      <td><span class="${codeCls}">${esc(t.code)}</span></td>
      <td>
        <b>${esc(t.name)}</b>
        ${t.category ? `<div class="small muted">${esc(t.category)}</div>` : ''}
      </td>
      <td><span class="muted small">${isTool ? '🧰 Tools (Aset)' : '📦 Material'}</span></td>
      <td style="text-align:center">
        <b>${totalInitialOrAsset} ${unitTxt}</b>
        <div class="small muted">${isTool ? 'Total Aset' : 'Stok Awal'}</div>
      </td>
      <td style="text-align:center">${outInfoHtml}</td>
      <td style="text-align:center">
        <b style="font-size:.98rem;color:#0f2942">${sysQty} ${unitTxt}</b>
        <div class="small muted">Wajib ada di rak</div>
      </td>
      <td>
        <div class="inline-qty-wrap">
          <button type="button" class="inline-qty-btn" onclick="changeOpnameActualQty('${esc(t.code)}', -1, true)">−</button>
          <input type="number" step="any" min="0" class="inline-qty-input" value="${actQty}" onchange="changeOpnameActualQty('${esc(t.code)}', this.value, false)">
          <button type="button" class="inline-qty-btn" onclick="changeOpnameActualQty('${esc(t.code)}', 1, true)">+</button>
          <span class="inline-qty-unit">${unitTxt}</span>
        </div>
      </td>
      <td style="text-align:center">${diffBadge}</td>
      <td>
        <select class="cond-select-inline ${actCond}" onchange="changeOpnameActualCond('${esc(t.code)}', this.value)">
          <option value="bagus" ${actCond === 'bagus' ? 'selected' : ''}>🟢 Bagus</option>
          <option value="kalibrasi" ${actCond === 'kalibrasi' ? 'selected' : ''}>🟡 Kalibrasi</option>
          <option value="eject" ${actCond === 'eject' ? 'selected' : ''}>🔴 Rusak</option>
        </select>
      </td>
      <td style="text-align:center;white-space:nowrap">
        ${hasDiff
          ? `<button type="button" class="btn btn-primary btn-sm" onclick="balanceSingleItem('${esc(t.code)}')" title="Sesuaikan stok database dengan fisik aktual">⚖️ Balance</button>`
          : `<span class="small muted">✔ Balance</span>`}
      </td>
    </tr>`;
  }).join('') + `</tbody>`;

  tbl.innerHTML = thead + tbody;
}

function changeOpnameActualQty(code, valOrDelta, isDelta = false) {
  const t = allToolsCache.find((x) => x.code === code);
  const sysQty = Number(t?.quantity ?? 0);
  const cur = Number(opBalanceState.actualQtyMap.get(code) ?? sysQty);
  const next = isDelta ? Math.max(0, cur + Number(valOrDelta)) : Math.max(0, Number(valOrDelta) || 0);
  opBalanceState.actualQtyMap.set(code, next);
  renderOpnameBalanceTable();
}
window.changeOpnameActualQty = changeOpnameActualQty;

function changeOpnameActualCond(code, newCond) {
  opBalanceState.actualCondMap.set(code, newCond);
  renderOpnameBalanceTable();
}
window.changeOpnameActualCond = changeOpnameActualCond;

async function balanceSingleItem(code) {
  const t = allToolsCache.find((x) => x.code === code);
  if (!t) return;
  const actualQty = Number(opBalanceState.actualQtyMap.get(code) ?? t.quantity ?? 0);
  const condition = opBalanceState.actualCondMap.get(code) || t.condition || 'bagus';
  try {
    await api('/api/opname/balance', {
      method: 'POST',
      body: { items: [{ code, actualQty, condition }] },
    });
    feedback.ok();
    await loadOpnameBalanceView(true);
    await loadDatabaseView();
  } catch (err) {
    feedback.err();
    alert('Gagal melakukan balancing stok: ' + err.message);
  }
}
window.balanceSingleItem = balanceSingleItem;

async function saveAllOpnameBalance() {
  const adjustments = [];
  for (const t of (allToolsCache || [])) {
    const sysQty = Number(t.quantity ?? 0);
    const actQty = Number(opBalanceState.actualQtyMap.get(t.code) ?? sysQty);
    const sysCond = t.condition || (t.status === 'rusak' ? 'eject' : 'bagus');
    const actCond = opBalanceState.actualCondMap.get(t.code) || sysCond;
    if (actQty !== sysQty || actCond !== sysCond) {
      adjustments.push({ code: t.code, actualQty: actQty, condition: actCond });
    }
  }

  if (!adjustments.length) {
    feedback.info();
    return alert('✅ Semua stok fisik aktual sudah sama (Balance) dengan stok sistem di Database.');
  }

  try {
    const res = await api('/api/opname/balance', {
      method: 'POST',
      body: { items: adjustments },
    });
    feedback.ok();
    await loadOpnameBalanceView(true);
    await loadDatabaseView();
    alert(`✅ Berhasil menyeimbangkan (Balance) stok untuk ${res.updatedCount || adjustments.length} barang di Database!`);
  } catch (err) {
    feedback.err();
    alert('Gagal menyimpan hasil opname: ' + err.message);
  }
}

$('#btnOpReset')?.addEventListener('click', () => {
  loadOpnameBalanceView(true);
  feedback.info();
});
$('#btnOpSaveAll')?.addEventListener('click', saveAllOpnameBalance);

$$('#opFilterPills button').forEach((btn) => btn.onclick = () => {
  opBalanceState.filter = btn.dataset.opfilter || 'all';
  $$('#opFilterPills button').forEach((b) => b.classList.toggle('active', b === btn));
  renderOpnameBalanceTable();
});

if ($('#opSearchInput')) {
  $('#opSearchInput').oninput = (e) => {
    opBalanceState.search = e.target.value.trim();
    renderOpnameBalanceTable();
  };
}

if ($('#opQuickScanForm')) {
  $('#opQuickScanForm').onsubmit = (e) => {
    e.preventDefault();
    const inp = $('#opQuickScanInput');
    const raw = (inp?.value || '').trim().toUpperCase();
    if (!raw) return;
    const t = (allToolsCache || []).find((x) => x.code.toUpperCase() === raw);
    if (!t) {
      feedback.err();
      alert(`Kode barang "${raw}" tidak ditemukan.`);
      return;
    }
    inp.value = '';
    changeOpnameActualQty(t.code, 1, true);
    feedback.ok();
  };
}

// ---------------- Sistem: Logo, Import & Backup ----------------
$('#btnLogo').onclick = async () => {
  const act = await dialog(
    `<h3>Logo GFM — PT Sulawesi Cahaya Mineral</h3>
     <p class="small muted">Pilih file gambar (PNG, JPG, SVG, atau WebP) untuk mengganti logo di aplikasi dan stiker QR, atau kembalikan ke logo bawaan GFM PT SCM.</p>`,
    [
      { label: 'Batal', value: 'cancel' },
      { label: '↺ Logo Bawaan GFM SCM', cls: 'btn-ghost', value: 'reset' },
      { label: '📂 Pilih File Gambar…', cls: 'btn-primary', value: 'upload' },
    ]
  );
  if (act === 'upload') $('#logoFile').click();
  if (act === 'reset') {
    await api('/api/admin/logo', { method: 'POST', body: { reset: true } });
    $$('img[src^="/logo-active"]').forEach((img) => { img.src = '/logo-active?t=' + Date.now(); });
  }
};
$('#logoFile').onchange = (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await api('/api/admin/logo', { method: 'POST', body: { dataUrl: reader.result } });
      $$('img[src^="/logo-active"]').forEach((img) => { img.src = '/logo-active?t=' + Date.now(); });
    } catch (err) { alert('Gagal mengganti logo: ' + err.message); }
  };
  reader.readAsDataURL(file);
};

$('#btnBackup').onclick = async () => {
  try {
    const res = await fetch('/api/admin/backup', { headers: { Authorization: 'Bearer ' + getToken() } });
    if (!res.ok) throw new Error('Gagal mengunduh backup');
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="(.+?)"/)?.[1] || 'gudang-backup.db';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob()); a.download = name; a.click();
  } catch (e) { alert(e.message); }
};

function triggerFileDownload(content, filename, mimeType = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function buildExcelWorkbookHtml({ sheetName, title, subtitle, note, headers, rows }) {
  const escXml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const headerHtml = headers
    .map((h) => `<th style="background-color:#0f172a;color:#ffffff;font-weight:bold;padding:10px 14px;border:1px solid #334155;text-align:left;font-size:11pt;">${escXml(h)}</th>`)
    .join('');

  const rowsHtml = rows
    .map((r) => {
      const isEx = r.isExample;
      const bg = isEx ? 'background-color:#fef9c3;color:#854d0e;font-style:italic;' : '';
      const cells = r.cells
        .map((c, i) => {
          const isText = i === 0 || i === 3 || typeof c === 'string';
          const mso = isText ? "mso-number-format:'\\@';" : '';
          const cellStyle = `border:1px solid #cbd5e1;padding:8px 12px;font-size:10.5pt;${bg}${mso}`;
          return `<td style="${cellStyle}">${escXml(c)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\r\n');

  const colSpan = headers.length || 4;

  return `\uFEFF<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<!--[if gte mso 9]>
<xml>
  <x:ExcelWorkbook>
    <x:ExcelWorksheets>
      <x:ExcelWorksheet>
        <x:Name>${escXml(sheetName || 'Data Gudang')}</x:Name>
        <x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
      </x:ExcelWorksheet>
    </x:ExcelWorksheets>
  </x:ExcelWorkbook>
</xml>
<![endif]-->
<style>
  body, table { font-family: Calibri, 'Segoe UI', Arial, sans-serif; }
  th { background-color: #0f172a; color: #ffffff; }
</style>
</head>
<body>
<table border="1" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;">
  <tr><td colspan="${colSpan}" style="background-color:#0f2942;color:#fcd34d;font-size:14pt;font-weight:bold;padding:12px;border:none;">${escXml(title)}</td></tr>
  <tr><td colspan="${colSpan}" style="background-color:#f1f5f9;color:#334155;font-size:11pt;font-weight:bold;padding:8px 12px;border:none;">${escXml(subtitle)}</td></tr>
  <tr><td colspan="${colSpan}" style="background-color:#e0f2fe;color:#0369a1;font-size:10pt;padding:8px 12px;border:none;">${escXml(note)}</td></tr>
  <tr style="height:8px;"><td colspan="${colSpan}" style="border:none;"></td></tr>
  <thead><tr>${headerHtml}</tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
</body>
</html>`;
}

function buildCsvString(headers, rows) {
  const escCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    'sep=;',
    headers.map(escCsv).join(';'),
    ...rows.map((r) => r.cells.map(escCsv).join(';')),
  ];
  return '\uFEFF' + lines.join('\r\n');
}

async function downloadTemplate(type, format = 'csv') {
  try {
    const isTools = type === 'tools';
    let list = [];
    try {
      list = await api(isTools ? '/api/tools' : '/api/users');
      if (isTools) allToolsCache = list;
      else allUsersCache = list;
    } catch {
      list = isTools ? allToolsCache : allUsersCache;
    }

    if (!list || !list.length) {
      list = (await api(isTools ? '/api/tools' : '/api/users')) || [];
      if (isTools) allToolsCache = list;
      else allUsersCache = list;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    let filename = '';
    let content = '';
    let mimeType = '';

    if (isTools) {
      if ($('#dlToolsCount')) $('#dlToolsCount').textContent = list.length;
      filename = `format-tambah-barang-${list.length}-barang-${stamp}.${format}`;

      const toolsList = list.filter((r) => !String(r.code || '').startsWith('M-'));
      const matList = list.filter((r) => String(r.code || '').startsWith('M-'));
      const nextToolNum = toolsList.reduce((m, r) => Math.max(m, Number(String(r.code || '').replace(/\D+/g, '')) || 0), 0) + 1;
      const nextMatNum = matList.reduce((m, r) => Math.max(m, Number(String(r.code || '').replace(/\D+/g, '')) || 0), 0) + 1;

      const headers = ['Kode Barang', 'Nama Barang', 'Kategori', 'Tipe (tool/material)', 'Kondisi (bagus/kalibrasi/eject)', 'Jumlah/Stok', 'Satuan'];

      const rows = list.map((t) => ({
        cells: [
          t.code,
          t.name,
          t.category || '',
          t.item_type || (t.code?.startsWith('M-') ? 'material' : 'tool'),
          t.condition || 'bagus',
          t.quantity ?? 1,
          t.unit || (t.item_type === 'material' ? 'Pcs' : 'Unit'),
        ],
        isExample: false,
      }));

      rows.push({
        cells: [`T-${String(nextToolNum).padStart(3, '0')}`, '(Contoh: Tambah Tools Baru)', 'Power Tool', 'tool', 'bagus', 1, 'Unit'],
        isExample: true,
      });
      rows.push({
        cells: [`M-${String(nextMatNum).padStart(3, '0')}`, '(Contoh: Tambah Material Baru)', 'Consumable Las', 'material', 'bagus', 20, 'Box'],
        isExample: true,
      });

      if (format === 'xls') {
        content = buildExcelWorkbookHtml({
          sheetName: 'Format Tambah Barang',
          title: 'GFM — PT SULAWESI CAHAYA MINERAL',
          subtitle: `FORMAT TAMBAH TOOLS & MATERIAL GUDANG (${list.length} Barang Saat Ini di Database)`,
          note: `Petunjuk: Baris di bawah adalah seluruh ${list.length} barang (Tools & Material) yang sudah aktif di database. Tambahkan data barang baru Anda pada baris kosong di bawah. Kolom Tipe diisi "tool" atau "material". Kondisi diisi "bagus", "kalibrasi", atau "eject".`,
          headers,
          rows,
        });
        mimeType = 'application/vnd.ms-excel;charset=utf-8';
      } else {
        content = buildCsvString(headers, rows);
        mimeType = 'text/csv;charset=utf-8';
      }
    } else {
      if ($('#dlUsersCount')) $('#dlUsersCount').textContent = list.length;
      filename = `format-tambah-akun-${list.length}-akun-${stamp}.${format}`;

      const nextNum = list.reduce((m, r) => Math.max(m, Number(String(r.username || '').replace(/\D+/g, '')) || 0), 0) + 1;
      const headers = ['ID Akun', 'Nama Lengkap', 'Divisi / Crew', 'No HP / Radio', 'Peran (crew/admin)', 'Password Baru (opsional)'];

      const rows = list.map((u) => ({
        cells: [u.username, u.name, u.dept || '', u.phone || '', u.role || 'crew', '(tersimpan)'],
        isExample: false,
      }));

      rows.push({
        cells: [`CREW${String(nextNum).padStart(2, '0')}`, '(Contoh: Nama Crew Baru 1)', 'Crew E - Mekanik Fabrikasi', '0812-4000-0124', 'crew', '1234'],
        isExample: true,
      });
      rows.push({
        cells: [`CREW${String(nextNum + 1).padStart(2, '0')}`, '(Contoh: Nama Crew Baru 2)', 'Crew E - Elektrikal', '0812-4000-0125', 'crew', '1234'],
        isExample: true,
      });

      if (format === 'xls') {
        content = buildExcelWorkbookHtml({
          sheetName: 'Format Tambah Akun',
          title: 'GFM — PT SULAWESI CAHAYA MINERAL',
          subtitle: `FORMAT TAMBAH AKUN CREW & PENJAGA GUDANG (${list.length} Akun Saat Ini di Database)`,
          note: `Petunjuk: Baris di bawah adalah seluruh ${list.length} akun yang sudah aktif di database. Tambahkan akun crew baru pada baris kosong. Password awal jika dikosongkan adalah 1234. Peran: crew (pekerja) atau admin (penjaga gudang).`,
          headers,
          rows,
        });
        mimeType = 'application/vnd.ms-excel;charset=utf-8';
      } else {
        content = buildCsvString(headers, rows);
        mimeType = 'text/csv;charset=utf-8';
      }
    }

    triggerFileDownload(content, filename, mimeType);
    feedback.ok();
  } catch (err) {
    console.error('downloadTemplate client error:', err);
    try {
      const res = await fetch(`/api/admin/template/${type}.${format}`, {
        headers: { Authorization: 'Bearer ' + getToken() },
      });
      if (!res.ok) throw new Error('Gagal mengunduh format Excel dari server');
      const blob = await res.blob();
      const filename = `format-${type}.${format}`;
      triggerFileDownload(blob, filename, format === 'xls' ? 'application/vnd.ms-excel' : 'text/csv');
      feedback.ok();
    } catch (e2) {
      feedback.err();
      alert('Gagal mengunduh format Excel: ' + (err.message || e2.message));
    }
  }
}

function goToImport(target = 'tools') {
  showTab('entry');
  const card = $('#importDataCard');
  if (card) {
    card.classList.remove('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const ta = $('#importText');
    if (ta) {
      ta.focus();
      if (!ta.value.trim()) {
        if (target === 'tools') {
          ta.placeholder = 'Kode\tNama Barang\tKategori\tJumlah\tSatuan\nT-022\tKunci Momen 3/4\tKunci\t2\tUnit\nM-009\tKawat Las LB-52\tConsumable\t10\tBox';
        } else {
          ta.placeholder = 'ID Akun\tNama Lengkap\tDivisi / Crew\tNo HP / Radio\tPeran\tPassword\nCREW24\tNama Crew Baru\tCrew E - Mekanik\t0812-4000-0124\tcrew\t1234';
        }
      }
    }
  }
}

function parseCsvLine(line, sep) {
  if (line.includes('"')) {
    const escSep = sep === '\t' ? '\\t' : (sep === ';' ? ';' : ',');
    const regex = new RegExp('(?:^|' + escSep + ')(?:"([^"]*(?:""[^"]*)*)"|([^"' + escSep + ']*))', 'g');
    const cols = [];
    let match;
    while ((match = regex.exec(line)) !== null) {
      cols.push((match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2] || '').trim());
    }
    return cols;
  }
  return line.split(sep).map((x) => x.trim().replace(/^"|"$/g, ''));
}

async function runImport(type) {
  const raw = $('#importText').value;
  if (!raw.trim()) return alert('Tempel atau upload data yang ingin di-import terlebih dahulu.');

  let lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Filter baris judul, catatan, header, sep=, dan contoh
  lines = lines.filter((l) => {
    const low = l.toLowerCase();
    if (low.startsWith('sep=') || low.startsWith('sep ;') || low.startsWith('sep ,')) return false;
    if (low.includes('gfm — pt sulawesi') || low.includes('format tambah') || low.includes('petunjuk:')) return false;
    if (low.startsWith('kode barang') || low.startsWith('id akun') || low.startsWith('username') || low.startsWith('kode\t') || low.startsWith('kode;')) return false;
    if (l.includes('(Contoh:')) return false;
    // Tolak jika baris adalah tag HTML atau skrip JS
    if (/<[^>]*>/i.test(l)) return false;
    if (/\b(function|var|let|const|frames\[|window\.|document\.|return|fnset|scrolltab)\b/i.test(l)) return false;
    return true;
  });

  if (!lines.length) return alert('Tidak ada baris data valid untuk di-import. Pastikan format kolom sudah sesuai.');

  const sep = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') ? ';' : ',');
  const rows = lines.map((l) => parseCsvLine(l, sep)).map(([a, b, c, d, e, f, g, h]) => {
    a = String(a || '').trim();
    b = String(b || '').trim();
    if (type === 'tools') {
      // Mendukung format pendek (Kode, Nama, Kategori, Jumlah, Satuan) maupun format template lengkap (Kode, Nama, Kategori, Tipe, Kondisi, Jumlah, Satuan)
      const dIsNumber = d !== undefined && d !== '' && !Number.isNaN(Number(d));
      const rawType = dIsNumber ? '' : String(d || e || '').toLowerCase();
      const isMat = rawType.includes('mat') || a.toUpperCase().startsWith('M-');
      let qty = 1;
      let unit = isMat ? 'Pcs' : 'Unit';
      let cond = 'bagus';

      if (dIsNumber) {
        qty = Number(d);
        if (e) unit = e.trim();
        if (f && ['bagus', 'kalibrasi', 'eject'].includes(f.toLowerCase().trim())) cond = f.toLowerCase().trim();
      } else {
        if (e && ['bagus', 'kalibrasi', 'eject'].includes(e.toLowerCase().trim())) cond = e.toLowerCase().trim();
        else if (f && ['bagus', 'kalibrasi', 'eject'].includes(f.toLowerCase().trim())) cond = f.toLowerCase().trim();

        if (f !== undefined && f !== '' && !Number.isNaN(Number(f))) {
          qty = Number(f);
          if (g) unit = g.trim();
        } else if (g !== undefined && g !== '' && !Number.isNaN(Number(g))) {
          qty = Number(g);
          if (h) unit = h.trim();
        }
      }

      return {
        code: a,
        name: b,
        category: c || '',
        location: '',
        item_type: isMat ? 'material' : 'tool',
        condition: cond,
        quantity: qty,
        unit,
      };
    }
    return {
      username: a,
      name: b,
      dept: c || '',
      phone: d || '',
      role: (e && e.toLowerCase().includes('admin')) ? 'admin' : 'crew',
      password: f && !f.includes('(tersimpan)') ? f : '',
    };
  }).filter((r) => {
    if (!r.name || !r.name.trim()) return false;
    if (/<[^>]*>|[{}'"=\\]/.test(r.name) || /\b(function|var|let|frames\[|window\.|return)\b/i.test(r.name)) return false;
    if (type === 'tools') {
      if (r.code && (!/^[A-Z0-9_\-\.]{2,30}$/i.test(r.code) || /\b(function|frames|window)\b/i.test(r.code))) return false;
    } else {
      if (r.username && (!/^[A-Z0-9_\-\.]{2,30}$/i.test(r.username) || /\b(function|frames|window)\b/i.test(r.username))) return false;
    }
    return true;
  });

  if (!rows.length) return alert('Tidak ada data dengan nama valid yang dapat di-import.');

  try {
    const r = await api('/api/admin/import', { method: 'POST', body: { type, rows } });
    feedback.ok();
    alert(`🎉 Berhasil! ${r.count} data ${type === 'tools' ? 'barang (Tools / Material)' : 'akun crew'} berhasil di-import ke database.`);
    $('#importText').value = '';
    if (type === 'tools') {
      await loadDatabaseView();
      await loadDataEntryView();
    } else {
      await loadAdminUsers();
    }
  } catch (e) {
    feedback.err();
    alert('Import gagal: ' + e.message);
  }
}

// Hubungkan semua tombol download format & import di berbagai tab/menu
const bindClick = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };

bindClick('#btnDlFormatTools', () => downloadTemplate('tools', 'csv'));
bindClick('#btnDlFormatToolsTop', () => downloadTemplate('tools', 'csv'));
bindClick('#btnDlFormatToolsQuick', () => downloadTemplate('tools', 'csv'));
bindClick('#btnDlCsvTools', () => downloadTemplate('tools', 'xls'));

bindClick('#btnDlFormatUsers', () => downloadTemplate('users', 'csv'));
bindClick('#btnDlFormatUsersTop', () => downloadTemplate('users', 'csv'));
bindClick('#btnDlFormatUsersQuick', () => downloadTemplate('users', 'csv'));
bindClick('#btnDlCsvUsers', () => downloadTemplate('users', 'xls'));

bindClick('#btnGoImportTools', () => goToImport('tools'));
bindClick('#btnGoImportUsers', () => goToImport('users'));

bindClick('#btnImportTools', () => runImport('tools'));
bindClick('#btnImportUsers', () => runImport('users'));
bindClick('#btnUploadCsv', () => $('#importFile')?.click());

if ($('#importFile')) {
  $('#importFile').onchange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.name.endsWith('.xlsx')) {
      alert(`⚠️ File "${file.name}" tersimpan dalam format .XLSX Excel.\n\n💡 Cara termudah dan tercepat:\n1. Buka file Anda di Microsoft Excel\n2. Blok baris data yang baru Anda ketik di Excel, lalu tekan Ctrl + C (Copy)\n3. Tempel (Ctrl + V) langsung ke kotak teks Import di web ini!\n\nAtau di Excel klik File -> Save As -> pilih tipe "CSV (Comma delimited / Titik koma) (*.csv)".`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      let content = String(reader.result || '');

      // Jika file berupa dokumen HTML atau Web Page dari Excel:
      if (/<html|<table|<frameset|<body/i.test(content)) {
        // Hapus seluruh script, style, head, frameset, dan komentar
        content = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        content = content.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
        content = content.replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, '');
        content = content.replace(/<!--[\s\S]*?-->/g, '');

        if (/<tr|<td/i.test(content)) {
          try {
            const doc = new DOMParser().parseFromString(content, 'text/html');
            const trs = [...doc.querySelectorAll('tr')];
            const lines = [];
            for (const tr of trs) {
              const cells = [...tr.querySelectorAll('th, td')].map((c) => c.textContent.trim().replace(/\r?\n+/g, ' '));
              if (cells.length < 2) continue;
              const first = cells[0].toLowerCase();
              if (first.includes('gfm') || first.includes('format') || first.includes('petunjuk') || first.includes('kode barang') || first.includes('id akun')) continue;
              if (cells.some((c) => c.includes('(Contoh:'))) continue;
              lines.push(cells.join('\t'));
            }
            if (lines.length) content = lines.join('\n');
          } catch (pe) { console.warn('HTML parse warn:', pe); }
        } else {
          // File HTML tetapi tidak berisi tabel (seperti file frameset pembungkus Excel)
          alert(`⚠️ File "${file.name}" adalah file pembungkus tampilan Excel dan tidak berisi tabel data.\n\n💡 Solusi Termudah:\n1. Buka file di Excel\n2. Blok baris data yang baru Anda ketik, tekan Ctrl + C (Copy)\n3. Tempel (Ctrl + V) ke kotak teks di bawah ini!`);
          return;
        }
      }

      // Bersihkan baris kode / skrip yang tidak valid
      const cleanLines = content.split(/\r?\n/).filter((line) => {
        const l = line.trim();
        if (!l) return false;
        if (/^<|function\b|var\b|let\b|const\b|frames\[|window\.|return\b|fnset|scrolltab/i.test(l)) return false;
        return true;
      });

      if (!cleanLines.length) {
        alert('Tidak ditemukan baris data tabel yang valid dalam file yang diunggah.');
        return;
      }

      $('#importDataCard')?.classList.remove('hidden');
      $('#importText').value = cleanLines.join('\n');
      feedback.info();
      const count = cleanLines.length;
      alert(`File "${file.name}" berhasil dibaca (${count} baris data). Silakan periksa datanya di kotak teks, lalu klik "Simpan / Import Data Barang" atau "Simpan / Import Akun Crew".`);
    };
    reader.readAsText(file);
  };
}

// ---------------- Polling Real-Time & Inisialisasi ----------------
setInterval(() => {
  if (!currentUser) return;
  refreshMyState();
  refreshOutStats();
}, 6000);

(async () => {
  // Jika berpindah dari HTTP ke HTTPS dengan membawa token sesi (#auth=...), simpan otomatis agar tidak perlu login ulang!
  if (location.hash.startsWith('#auth=')) {
    const passedToken = decodeURIComponent(location.hash.slice(6));
    if (passedToken) localStorage.setItem('gfm_token', passedToken);
    history.replaceState(null, '', location.pathname + location.search);
  }

  try { CONFIG = await api('/api/config'); } catch { /* default */ }

  // Otomatis autentikasi langsung ke sistem tanpa hambatan halaman login
  try {
    const st = await api('/api/me/state');
    if (st && st.user) {
      currentUser = st.user;
      if (st.token) setAuth(st.token, st.user);
    }
  } catch (err) {
    console.warn('Auto auth fetch err:', err);
  }

  if (!currentUser) {
    currentUser = { username: 'ADMIN', name: 'Hendra Wijaya (Penjaga Gudang)', role: 'admin', dept: 'GFM Warehouse' };
  }

  renderAuthView();
  loadDatabaseView();

  // Jika diarahkan dengan ?autoCam=1 setelah login, langsung nyalakan kamera live!
  if (currentUser && new URLSearchParams(location.search).get('autoCam') === '1') {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => startMainCamera(), 300);
  }

  // Pastikan tidak ada Service Worker / Cache lama yang mengunci tampilan
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister());
    }).catch(() => {});
  }
  if ('caches' in window) {
    caches.keys().then((keys) => {
      keys.forEach((k) => caches.delete(k));
    }).catch(() => {});
  }
})();
