import express from 'express';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { db, now, tx, dailyBackup, snapshot, hashPassword, DATA_DIR } from './db.js';
import { seedDatabase } from './seed.js';
import { ensureCerts, localIPv4 } from './certs.js';

// Pastikan 1 akun Admin + 20 akun Crew + 20 barang awal tersedia (tanpa menimpa password yang sudah diubah)
seedDatabase();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTTPS_ON = !/^(0|off|false|no)$/i.test(process.env.HTTPS || 'on');
const PORT = Number(process.env.PORT || 3050);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3450);
const SHIFT_HOURS = Number(process.env.SHIFT_HOURS || 12);
const APP_TZ = process.env.APP_TZ || 'Asia/Makassar'; // WITA
const UNDO_WINDOW_MS = 5 * 60_000;

let activeHttpPort = PORT;
let activeHttpsPort = HTTPS_PORT;

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- helper ----------
const norm = (c) => {
  const raw = String(c ?? '').trim().toUpperCase();
  // Jika QR berisi URL atau teks panjang yang memuat kode T-XXX atau M-XXX, ambil kodenya
  const m = raw.match(/\b([TM]-\d{3,5})\b/);
  return m ? m[1] : raw;
};

const q = {
  user: db.prepare('SELECT username, password_hash, name, role, dept, phone, active, created_at FROM users WHERE username = ?'),
  userPublic: db.prepare('SELECT username, name, role, dept, phone, active, created_at FROM users WHERE username = ?'),
  tool: db.prepare('SELECT * FROM tools WHERE code = ?'),
  openLoan: db.prepare(`
    SELECT l.*, u.name AS worker_name, u.dept AS worker_dept, u.phone AS worker_phone,
           uf.name AS transferred_from_name
    FROM loans l
    JOIN users u ON u.username = l.worker_code
    LEFT JOIN users uf ON uf.username = l.transferred_from
    WHERE l.tool_code = ? AND l.in_at IS NULL`),
  insertLoan: db.prepare('INSERT INTO loans (tool_code, worker_code, out_at, transferred_from, qty, badge_id, in_note) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  closeLoan: db.prepare('UPDATE loans SET in_at = ?, in_by = ?, in_condition = ?, in_note = ? WHERE id = ?'),
  loanById: db.prepare('SELECT * FROM loans WHERE id = ?'),
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res) => {
  try {
    const r = fn(req, res);
    if (r !== undefined) res.json(r);
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Terjadi kesalahan server: ' + e.message });
  }
};

// Autentikasi berbasis token sesi (default otomatis: Admin Penjaga Gudang agar sistem langsung siap pakai tanpa blok login)
function getAuthUser(req) {
  const auth = String(req.get('authorization') || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.get('x-token') || '');
  if (token) {
    const row = db.prepare(`
      SELECT u.username, u.name, u.role, u.dept, u.phone, u.active
      FROM sessions s JOIN users u ON u.username = s.username
      WHERE s.token = ?`).get(token);
    if (row && row.active) {
      req.token = token;
      return row;
    }
  }
  // Fallback otomatis: Penjaga Gudang (Admin) agar sistem langsung masuk tanpa blok login
  const admin = db.prepare(`SELECT username, name, role, dept, phone, active FROM users WHERE role = 'admin' AND active = 1 LIMIT 1`).get();
  return admin || { username: 'ADMIN', name: 'Hendra Wijaya (Penjaga Gudang)', role: 'admin', dept: 'GFM Warehouse', phone: '0812-4000-0001', active: 1 };
}

const requireAuth = (req, res, next) => {
  const u = getAuthUser(req);
  if (!u) return res.status(401).json({ error: 'Sesi habis, silakan login kembali' });
  req.user = u;
  next();
};

const requireAdmin = (req, res, next) => {
  const u = getAuthUser(req);
  if (!u) return res.status(401).json({ error: 'Silakan login terlebih dahulu' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'Akses khusus Penjaga Gudang (Admin)' });
  req.user = u;
  next();
};

const fmtTime = (iso) =>
  iso ? new Intl.DateTimeFormat('id-ID', {
    timeZone: APP_TZ, dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(iso)) : '';

// ---------- static & logo ----------
const CUSTOM_LOGO_META = path.join(DATA_DIR, 'custom-logo.json');
app.get('/logo-active', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  // Jika browser masih memuat HTML lama dari cache Service Worker lama (tanpa ?v=22),
  // bersihkan otomatis cache & Service Worker lama di browser tersebut!
  if (req.query.v !== '22' && !req.query.t) {
    res.setHeader('Clear-Site-Data', '"cache", "storage"');
  }
  if (fs.existsSync(CUSTOM_LOGO_META)) {
    try {
      const { mime, data } = JSON.parse(fs.readFileSync(CUSTOM_LOGO_META, 'utf8'));
      res.setHeader('Content-Type', mime);
      return res.send(Buffer.from(data, 'base64'));
    } catch { /* fallback ke default */ }
  }
  res.sendFile(path.join(__dirname, 'public/logo.svg'));
});

// ---------- proteksi anti-rusak untuk public/app.js ----------
const APP_JS_PATH = path.join(__dirname, 'public/app.js');
const VERIFIED_APP_JS_PATH = path.join(DATA_DIR, 'app.verified.js');

function ensureValidFrontendJs() {
  try {
    const code = fs.readFileSync(APP_JS_PATH, 'utf8');
    new vm.Script(code, { filename: 'app.js' });
    // Jika sintaks 100% valid, simpan sebagai salinan aman (verified backup)
    fs.writeFileSync(VERIFIED_APP_JS_PATH, code, 'utf8');
  } catch (err) {
    console.error('[AUTO-HEAL] Terdeteksi SyntaxError pada public/app.js:', err.message);
    if (fs.existsSync(VERIFIED_APP_JS_PATH)) {
      try {
        const safeCode = fs.readFileSync(VERIFIED_APP_JS_PATH, 'utf8');
        new vm.Script(safeCode, { filename: 'app.verified.js' });
        fs.writeFileSync(APP_JS_PATH, safeCode, 'utf8');
        console.log('[AUTO-HEAL] Berhasil memulihkan public/app.js dari salinan aman (app.verified.js)!');
      } catch (e2) {
        console.error('[AUTO-HEAL] Gagal memulihkan salinan aman:', e2.message);
      }
    }
  }
}
ensureValidFrontendJs();

app.get('/app.js', (_req, res) => {
  ensureValidFrontendJs();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(APP_JS_PATH);
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (/\.(html|css|js|json)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));
app.get('/vendor/jsQR.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/jsqr/dist/jsQR.js')));

app.get('/api/config', (_req, res) => res.json({
  shiftHours: SHIFT_HOURS,
  tz: APP_TZ,
  httpsOn: HTTPS_ON,
  httpPort: activeHttpPort,
  httpsPort: activeHttpsPort,
  ips: localIPv4(),
}));

// Daftar akun aktif untuk halaman Login Cepat (tanpa password, wajib masukkan password sendiri)
app.get('/api/accounts-list', wrap((_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return db.prepare(`
    SELECT username, name, role, dept
    FROM users WHERE active = 1
    ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
             CASE WHEN username LIKE 'CREW%' THEN 0 ELSE 1 END,
             LENGTH(username), username`).all();
}));

// ---------- LOGIN & SESI AKUN ----------
app.post('/api/auth/login', wrap((req) => {
  const username = String(req.body.username || '').trim().toUpperCase();
  const password = String(req.body.password || '').trim();
  if (!username || !password) throw new HttpError(400, 'ID Akun dan Password wajib diisi');

  const u = q.user.get(username);
  if (!u || !u.active) throw new HttpError(401, 'Akun tidak ditemukan atau tidak aktif');
  if (u.password_hash !== hashPassword(password)) throw new HttpError(401, 'Password salah');

  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)').run(token, u.username, now());
  const { password_hash, ...userPublic } = u;
  return { token, user: userPublic };
}));

app.post('/api/auth/switch', wrap((req) => {
  const username = String(req.body.username || '').trim().toUpperCase();
  const u = q.user.get(username);
  if (!u || !u.active) throw new HttpError(404, 'Akun tidak ditemukan atau tidak aktif');
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)').run(token, u.username, now());
  const { password_hash, ...userPublic } = u;
  return { ok: true, token, user: userPublic };
}));

app.post('/api/auth/logout', wrap((req) => {
  const auth = String(req.get('authorization') || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return { ok: true };
}));

app.post('/api/auth/password', requireAuth, wrap((req) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || String(newPassword).trim().length < 4) {
    throw new HttpError(400, 'Password baru minimal 4 karakter/angka');
  }
  const u = q.user.get(req.user.username);
  if (u.password_hash !== hashPassword(String(oldPassword || '').trim())) {
    throw new HttpError(400, 'Password saat ini tidak sesuai');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
    .run(hashPassword(String(newPassword).trim()), req.user.username);
  try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }
  return { ok: true };
}));

// Status lengkap untuk akun yang sedang aktif (dipakai di Beranda HP Crew maupun Admin)
app.get('/api/me/state', requireAuth, wrap((req) => {
  const username = req.user.username;
  let token = req.token;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)').run(token, username, now());
  }
  const myLoans = db.prepare(`
    SELECT l.id, l.out_at, l.tool_code, l.transferred_from,
           uf.name AS transferred_from_name,
           t.name AS tool_name, t.item_type, t.category, t.location, t.status AS tool_status, t.condition AS tool_condition, t.quantity, t.unit
    FROM loans l
    JOIN tools t ON t.code = l.tool_code
    LEFT JOIN users uf ON uf.username = l.transferred_from
    WHERE l.worker_code = ? AND l.in_at IS NULL
    ORDER BY l.out_at DESC`).all(username);

  // Permintaan oper yang masuk ke saya (saya pemegang barang, orang lain minta)
  const incomingTransfers = db.prepare(`
    SELECT tr.id, tr.loan_id, tr.tool_code, tr.from_user, tr.to_user, tr.note, tr.created_at,
           t.name AS tool_name, t.category,
           u.name AS to_name, u.dept AS to_dept, u.phone AS to_phone
    FROM transfers tr
    JOIN tools t ON t.code = tr.tool_code
    JOIN users u ON u.username = tr.to_user
    WHERE tr.from_user = ? AND tr.status = 'pending'
    ORDER BY tr.created_at DESC`).all(username);

  // Permintaan oper yang saya ajukan ke orang lain
  const outgoingTransfers = db.prepare(`
    SELECT tr.id, tr.loan_id, tr.tool_code, tr.from_user, tr.to_user, tr.status, tr.note, tr.created_at, tr.resolved_at,
           t.name AS tool_name, t.category,
           u.name AS from_name, u.dept AS from_dept, u.phone AS from_phone
    FROM transfers tr
    JOIN tools t ON t.code = tr.tool_code
    JOIN users u ON u.username = tr.from_user
    WHERE tr.to_user = ? AND (tr.status = 'pending' OR tr.resolved_at >= ?)
    ORDER BY tr.created_at DESC LIMIT 10`).all(username, new Date(Date.now() - 3600_000).toISOString());

  return { user: req.user, token, myLoans, incomingTransfers, outgoingTransfers };
}));

// ---------- PINJAM / AMBIL BARANG LANGSUNG (TOOLS & MATERIAL + JUMLAH + BADGE ID) ----------
app.post('/api/borrow', requireAuth, wrap((req) => {
  const code = norm(req.body.code);
  if (!code) throw new HttpError(400, 'Pilih barang (Tools / Material) terlebih dahulu');

  const tool = q.tool.get(code);
  if (!tool || !tool.active) {
    throw new HttpError(404, `Barang dengan kode "${code}" tidak ditemukan di database`);
  }

  const qty = Number(req.body.qty ?? 1);
  if (Number.isNaN(qty) || qty <= 0) {
    throw new HttpError(400, 'Jumlah barang yang dipinjam harus lebih dari 0');
  }

  if (tool.condition === 'eject' || tool.status === 'rusak') {
    throw new HttpError(400, `${tool.name} (${tool.code}) berstatus EJECT / Rusak dan tidak bisa dipinjam`);
  }
  if (tool.condition === 'kalibrasi') {
    throw new HttpError(400, `${tool.name} (${tool.code}) sedang dalam status KALIBRASI dan tidak bisa dipinjam sementara`);
  }

  const availQty = Number(tool.quantity ?? 0);
  const unitTxt = tool.unit || (tool.item_type === 'material' ? 'Pcs' : 'Unit');
  if (availQty <= 0) {
    throw new HttpError(400, `Stok ${tool.name} (${tool.code}) di database saat ini habis (0 ${unitTxt})`);
  }
  if (qty > availQty) {
    throw new HttpError(400, `Jumlah yang diminta (${qty} ${unitTxt}) melebihi stok tersedia di database (${availQty} ${unitTxt})`);
  }

  const rawWorker = String(req.body.workerCode || '').trim().toUpperCase();
  const rawBadge = String(req.body.badgeId || rawWorker || '').trim().toUpperCase();
  const rawName = String(req.body.borrowerName || '').trim();
  const rawDept = String(req.body.borrowerDept || '').trim();
  const note = String(req.body.note || '').trim();

  if (!rawWorker && !rawBadge) {
    throw new HttpError(400, 'Pilih nama peminjam dari daftar akun atau masukkan Badge ID terlebih dahulu');
  }

  return tx(() => {
    const t = now();
    let targetUser = rawWorker ? q.userPublic.get(rawWorker) : null;
    if (!targetUser && rawBadge) {
      targetUser = q.userPublic.get(rawBadge);
      if (!targetUser) {
        const numMatch = rawBadge.match(/^\d+$/);
        if (numMatch) {
          const crewId = 'CREW' + numMatch[0].padStart(2, '0');
          targetUser = q.userPublic.get(crewId);
        }
      }
    }

    // Jika menginput Badge ID baru di luar 30+ akun yang ada, daftarkan otomatis agar tersimpan rapi
    if (!targetUser) {
      const newUsername = rawBadge.replace(/[^A-Z0-9_\-]/gi, '').slice(0, 24) || ('BADGE-' + Date.now());
      const existing = q.user.get(newUsername);
      if (!existing) {
        db.prepare(`INSERT INTO users (username, password_hash, name, role, dept, phone, active, created_at)
                    VALUES (?, ?, ?, 'crew', ?, '', 1, ?)`)
          .run(newUsername, hashPassword('1234'), rawName || `Peminjam (${rawBadge})`, rawDept || 'Crew Lapangan', t);
      } else if (!existing.active) {
        db.prepare('UPDATE users SET active = 1 WHERE username = ?').run(newUsername);
      }
      targetUser = q.userPublic.get(newUsername);
    }

    const badgeToSave = rawBadge || targetUser.username;
    const newStock = Math.max(0, Number((availQty - qty).toFixed(4)));

    // 1. Kurangi stok barang di database secara otomatis
    db.prepare('UPDATE tools SET quantity = ? WHERE code = ?').run(newStock, code);

    // 2. Simpan transaksi ke Riwayat (loans)
    // Strategi: TOOLS = Pinjam (wajib kembali), MATERIAL = Habis Pakai (langsung selesai / tidak perlu dikembalikan)
    const isMaterial = (tool.item_type || (tool.code.startsWith('M-') ? 'material' : 'tool')) === 'material';
    const finalNote = note || (isMaterial ? 'Habis Pakai' : '');
    const info = q.insertLoan.run(code, targetUser.username, t, null, qty, badgeToSave, finalNote);
    if (isMaterial) {
      db.prepare("UPDATE loans SET in_at = ?, in_by = ?, in_condition = 'consumed', in_note = ? WHERE id = ?")
        .run(t, targetUser.username, finalNote, info.lastInsertRowid);
    }
    const loan = q.loanById.get(info.lastInsertRowid);
    const updatedTool = q.tool.get(code);

    try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }

    return {
      ok: true,
      kind: isMaterial ? 'consumed' : 'borrowed',
      isMaterial,
      tool: updatedTool,
      worker: { ...targetUser, badge_id: badgeToSave },
      loan,
      qty,
      remainingStock: newStock,
    };
  });
}));

// ---------- PENGEMBALIAN BARANG KE GUDANG (OTOMATIS KEMBALIKAN STOK DATABASE) ----------
app.post('/api/return-loan', requireAuth, wrap((req) => {
  const loanId = req.body.loanId ? Number(req.body.loanId) : null;
  const code = req.body.code ? norm(req.body.code) : null;

  return tx(() => {
    let open = null;
    if (loanId) {
      open = db.prepare(`
        SELECT l.*, u.name AS worker_name, u.dept AS worker_dept, u.phone AS worker_phone
        FROM loans l JOIN users u ON u.username = l.worker_code
        WHERE l.id = ? AND l.in_at IS NULL`).get(loanId);
    } else if (code) {
      open = q.openLoan.get(code);
    }
    if (!open) throw new HttpError(404, 'Data peminjaman aktif tidak ditemukan atau sudah dikembalikan');

    const t = now();
    const rawCond = String(req.body.condition || '').toLowerCase();
    const newCond = rawCond === 'eject' || rawCond === 'rusak'
      ? 'eject'
      : (rawCond === 'kalibrasi' ? 'kalibrasi' : 'bagus');
    const legacyStatus = newCond === 'eject' ? 'rusak' : 'ok';
    const note = String(req.body.note || open.in_note || '').trim();
    const returnQty = Number(open.qty ?? 1);

    q.closeLoan.run(t, req.user.username, newCond, note, open.id);
    db.prepare("UPDATE transfers SET status = 'cancelled', resolved_at = ? WHERE loan_id = ? AND status = 'pending'")
      .run(t, open.id);

    // Tambah kembali jumlah stok di database saat barang dikembalikan
    db.prepare('UPDATE tools SET quantity = quantity + ? WHERE code = ?').run(returnQty, open.tool_code);

    if (rawCond) {
      db.prepare('UPDATE tools SET condition = ?, status = ? WHERE code = ?')
        .run(newCond, legacyStatus, open.tool_code);
    }

    try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }

    return {
      ok: true,
      kind: 'returned',
      tool: q.tool.get(open.tool_code),
      loan: { ...open, in_at: t, in_by: req.user.username, in_condition: newCond, in_note: note },
      holder: { username: open.worker_code, name: open.worker_name, dept: open.worker_dept, badge_id: open.badge_id || open.worker_code },
      returnedQty: returnQty,
    };
  });
}));

// ---------- SCAN QR BARANG ----------
app.post('/api/scan', requireAuth, wrap((req) => {
  const code = norm(req.body.code);
  const delegateUser = req.body.delegateUser ? String(req.body.delegateUser).trim().toUpperCase() : null;
  if (!code) throw new HttpError(400, 'Kode QR kosong');

  const tool = q.tool.get(code);
  if (!tool || !tool.active) {
    return { kind: 'error', reason: 'UNKNOWN', message: `Kode QR "${code}" tidak terdaftar sebagai barang gudang` };
  }

  return tx(() => {
    const open = q.openLoan.get(code);
    const t = now();

    // ==================== PENJAGA GUDANG / ADMIN ====================
    if (req.user.role === 'admin') {
      // A. Barang sedang dipinjam & tidak sedang memilih peminjam baru -> SAH DIKEMBALIKAN KE GUDANG
      if (open && !delegateUser) {
        const rawCond = String(req.body.condition || '').toLowerCase();
        const newCond = rawCond === 'eject' || rawCond === 'rusak'
          ? 'eject'
          : (rawCond === 'kalibrasi' ? 'kalibrasi' : 'bagus');
        const legacyStatus = newCond === 'eject' ? 'rusak' : 'ok';
        const note = String(req.body.note || open.in_note || '').trim();
        const returnQty = Number(open.qty ?? 1);
        q.closeLoan.run(t, req.user.username, newCond, note, open.id);
        db.prepare("UPDATE transfers SET status = 'cancelled', resolved_at = ? WHERE loan_id = ? AND status = 'pending'")
          .run(t, open.id);
        db.prepare('UPDATE tools SET quantity = quantity + ? WHERE code = ?').run(returnQty, code);
        if (rawCond) {
          db.prepare('UPDATE tools SET condition = ?, status = ?, note = ? WHERE code = ?')
            .run(newCond, legacyStatus, note || (newCond !== 'bagus' ? `Status ${newCond.toUpperCase()} saat dikembalikan oleh ${open.worker_name}` : ''), code);
        }
        try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }
        return {
          kind: 'returned',
          tool: q.tool.get(code),
          loan: { ...open, in_at: t, in_by: req.user.username, in_condition: newCond, in_note: note },
          holder: { username: open.worker_code, name: open.worker_name, dept: open.worker_dept, badge_id: open.badge_id || open.worker_code },
          receivedBy: req.user.name,
        };
      }

      // B. Barang ada di gudang & Penjaga Gudang meminjamkan atas nama Crew tertentu
      if (delegateUser) {
        const target = q.userPublic.get(delegateUser);
        if (!target || !target.active) throw new HttpError(400, 'Akun crew tidak valid');
        if (tool.condition === 'eject' || tool.status === 'rusak') {
          return { kind: 'error', reason: 'TOOL_BROKEN', tool, message: `${tool.name} berstatus EJECT / Rusak, tidak bisa dipinjamkan` };
        }
        if (tool.condition === 'kalibrasi') {
          return { kind: 'error', reason: 'TOOL_CALIBRATION', tool, message: `${tool.name} sedang dalam status KALIBRASI dan tidak bisa dipinjamkan sementara` };
        }
        const borrowQty = Math.max(1, Number(req.body.qty || 1));
        const availQty = Number(tool.quantity ?? 0);
        if (availQty < borrowQty) {
          return { kind: 'error', reason: 'OUT_OF_STOCK', tool, message: `Stok ${tool.name} tersisa ${availQty} ${tool.unit || 'Unit'}` };
        }
        db.prepare('UPDATE tools SET quantity = MAX(0, quantity - ?) WHERE code = ?').run(borrowQty, code);
        const info = q.insertLoan.run(code, target.username, t, null, borrowQty, target.username, '');
        try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }
        return { kind: 'borrowed', tool: q.tool.get(code), worker: target, loan: q.loanById.get(info.lastInsertRowid), byAdmin: true };
      }

      // C. Barang ada di gudang & di-scan untuk dipilih di form
      return { kind: 'warehouse_ready', tool, message: `${tool.name} siap dipinjam (Stok: ${tool.quantity ?? 1} ${tool.unit || 'Unit'})` };
    }

    // ==================== CREW / PEKERJA LAPANGAN ====================
    if (open && open.worker_code === req.user.username) {
      return {
        kind: 'holding_self',
        tool,
        loan: open,
        message: `Barang ini sedang tercatat di tangan Anda.`,
      };
    }

    if (open && open.worker_code !== req.user.username && Number(tool.quantity ?? 0) <= 0) {
      const existingTransfer = db.prepare(`
        SELECT * FROM transfers
        WHERE loan_id = ? AND to_user = ? AND status = 'pending'`).get(open.id, req.user.username);

      return {
        kind: 'locked_by_other',
        tool,
        loan: open,
        holder: {
          username: open.worker_code,
          name: open.worker_name,
          dept: open.worker_dept,
          phone: open.worker_phone,
        },
        existingTransfer,
        message: `${tool.name} sedang dipegang oleh ${open.worker_name} (${open.worker_dept}).`,
      };
    }

    if (tool.condition === 'eject' || tool.status === 'rusak') {
      return { kind: 'error', reason: 'TOOL_BROKEN', tool, message: `${tool.name} sedang berstatus EJECT / Rusak dan tidak boleh dipinjam` };
    }
    if (tool.condition === 'kalibrasi') {
      return { kind: 'error', reason: 'TOOL_CALIBRATION', tool, message: `${tool.name} sedang dalam proses KALIBRASI dan tidak boleh dipinjam` };
    }

    db.prepare('UPDATE tools SET quantity = MAX(0, quantity - 1) WHERE code = ?').run(code);
    const info = q.insertLoan.run(code, req.user.username, t, null, 1, req.user.username, '');
    try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }
    return {
      kind: 'borrowed',
      tool: q.tool.get(code),
      worker: req.user,
      loan: q.loanById.get(info.lastInsertRowid),
    };
  });
}));

// ---------- PERSETUJUAN OPER ALAT ANTAR CREW (HANDOVER) ----------
// Crew B mengajukan permintaan ambil alih barang yang sedang dipegang Crew A
app.post('/api/transfers/request', requireAuth, wrap((req) => {
  const code = norm(req.body.toolCode);
  const note = String(req.body.note || '').trim();
  const open = q.openLoan.get(code);
  if (!open) throw new HttpError(400, 'Barang ini sudah berada di gudang, silakan scan langsung untuk meminjam.');
  if (open.worker_code === req.user.username) throw new HttpError(400, 'Barang ini sudah tercatat atas nama Anda.');

  return tx(() => {
    const existing = db.prepare(`
      SELECT * FROM transfers WHERE loan_id = ? AND to_user = ? AND status = 'pending'`).get(open.id, req.user.username);
    if (existing) return { ok: true, transfer: existing, alreadyRequested: true };

    const t = now();
    const info = db.prepare(`
      INSERT INTO transfers (loan_id, tool_code, from_user, to_user, status, note, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(open.id, code, open.worker_code, req.user.username, note, t);
    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(info.lastInsertRowid);
    return { ok: true, transfer };
  });
}));

// Pemegang barang (Crew A) menyetujui atau menolak permintaan oper dari Crew B
app.post('/api/transfers/:id/respond', requireAuth, wrap((req) => {
  const id = Number(req.params.id);
  const decision = req.body.decision === 'approve' ? 'approve' : 'reject';
  const tr = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
  if (!tr || tr.status !== 'pending') throw new HttpError(404, 'Permintaan oper sudah tidak aktif');

  // Hanya pemegang sah (from_user) atau Admin yang boleh menyetujui
  if (tr.from_user !== req.user.username && req.user.role !== 'admin') {
    throw new HttpError(403, 'Hanya pemegang barang saat ini yang berhak memberikan persetujuan');
  }

  return tx(() => {
    const t = now();
    const open = q.loanById.get(tr.loan_id);
    if (!open || open.in_at) {
      db.prepare("UPDATE transfers SET status = 'cancelled', resolved_at = ? WHERE id = ?").run(t, id);
      throw new HttpError(400, 'Barang sudah dikembalikan atau berpindah tangan');
    }

    if (decision === 'reject') {
      db.prepare("UPDATE transfers SET status = 'rejected', resolved_at = ? WHERE id = ?").run(t, id);
      return { ok: true, status: 'rejected' };
    }

    // SETUJUI OPER:
    // 1. Tutup pinjaman lama milik Crew A dengan keterangan dioper ke Crew B
    const toUser = q.userPublic.get(tr.to_user);
    const fromUser = q.userPublic.get(tr.from_user);
    q.closeLoan.run(t, tr.to_user, 'ok', `Dioper ke ${toUser?.name || tr.to_user} (Disetujui oleh ${fromUser?.name || tr.from_user})`, open.id);

    // 2. Buat pinjaman baru atas nama Crew B dengan penanda transferred_from = Crew A
    const newLoanInfo = q.insertLoan.run(tr.tool_code, tr.to_user, t, tr.from_user, open.qty || 1, tr.to_user, '');

    // 3. Tandai transfer ini approved, dan batalkan permintaan lain pada pinjaman lama
    db.prepare("UPDATE transfers SET status = 'approved', resolved_at = ? WHERE id = ?").run(t, id);
    db.prepare("UPDATE transfers SET status = 'rejected', resolved_at = ? WHERE loan_id = ? AND status = 'pending' AND id != ?")
      .run(t, open.id, id);

    return { ok: true, status: 'approved', newLoanId: newLoanInfo.lastInsertRowid };
  });
}));

// Pembatalan permintaan oper oleh pengaju
app.post('/api/transfers/:id/cancel', requireAuth, wrap((req) => {
  const id = Number(req.params.id);
  const tr = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
  if (!tr || tr.status !== 'pending') throw new HttpError(404, 'Permintaan tidak ditemukan');
  if (tr.to_user !== req.user.username && req.user.role !== 'admin') throw new HttpError(403, 'Tidak diizinkan');
  db.prepare("UPDATE transfers SET status = 'cancelled', resolved_at = ? WHERE id = ?").run(now(), id);
  return { ok: true };
}));

// Batalkan aksi terakhir (salah scan — dalam 5 menit)
app.post('/api/undo', requireAuth, wrap((req) => {
  const { action, loanId } = req.body;
  const loan = q.loanById.get(Number(loanId));
  if (!loan) throw new HttpError(404, 'Transaksi tidak ditemukan');
  return tx(() => {
    const qty = Number(loan.qty ?? 1);
    if (action === 'borrow' || action === 'consume') {
      if (loan.worker_code !== req.user.username && req.user.role !== 'admin') throw new HttpError(403, 'Tidak diizinkan');
      if (loan.in_at && loan.in_condition !== 'consumed') throw new HttpError(400, 'Barang sudah dikembalikan');
      if (Date.now() - Date.parse(loan.out_at) > UNDO_WINDOW_MS) throw new HttpError(400, 'Batas waktu batal (5 menit) lewat');
      db.prepare('UPDATE tools SET quantity = quantity + ? WHERE code = ?').run(qty, loan.tool_code);
      db.prepare('DELETE FROM loans WHERE id = ?').run(loan.id);
      try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }
      return { ok: true };
    }
    if (action === 'return') {
      if (req.user.role !== 'admin') throw new HttpError(403, 'Hanya Penjaga Gudang yang dapat membatalkan pengembalian');
      if (!loan.in_at) throw new HttpError(400, 'Transaksi masih terbuka');
      if (Date.now() - Date.parse(loan.in_at) > UNDO_WINDOW_MS) throw new HttpError(400, 'Batas waktu batal (5 menit) lewat');
      db.prepare('UPDATE tools SET quantity = MAX(0, quantity - ?) WHERE code = ?').run(qty, loan.tool_code);
      db.prepare("UPDATE loans SET in_at = NULL, in_by = NULL, in_note = '' WHERE id = ?").run(loan.id);
      try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }
      return { ok: true };
    }
    throw new HttpError(400, 'Aksi tidak dikenal');
  });
}));

// Tandai alat rusak (saat pengembalian / pengecekan oleh Penjaga Gudang)
app.post('/api/tools/:code/broken', requireAdmin, wrap((req) => {
  const code = norm(req.params.code);
  const r = db.prepare("UPDATE tools SET status = 'rusak', condition = 'eject', note = ? WHERE code = ?")
    .run(String(req.body.note || 'Dilaporkan rusak / eject saat pengecekan'), code);
  if (!r.changes) throw new HttpError(404, 'Barang tidak ditemukan');
  return { ok: true };
}));

// Ubah kondisi barang: 'bagus' | 'kalibrasi' | 'eject'
app.post('/api/tools/:code/condition', requireAuth, wrap((req) => {
  const code = norm(req.params.code);
  const condRaw = String(req.body.condition || 'bagus').trim().toLowerCase();
  const validCond = ['bagus', 'kalibrasi', 'eject'].includes(condRaw) ? condRaw : 'bagus';
  const statusVal = validCond === 'eject' ? 'rusak' : 'ok';
  const tool = q.tool.get(code);
  if (!tool || !tool.active) throw new HttpError(404, 'Barang tidak ditemukan');
  const noteVal = req.body.note !== undefined ? String(req.body.note) : tool.note;
  db.prepare('UPDATE tools SET condition = ?, status = ?, note = ? WHERE code = ?')
    .run(validCond, statusVal, noteVal, code);
  try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }
  return { ok: true, tool: q.tool.get(code) };
}));

// Ubah jumlah stok & satuan barang langsung dari tabel atau Data Entry
app.post('/api/tools/:code/quantity', requireAuth, wrap((req) => {
  const code = norm(req.params.code);
  const tool = q.tool.get(code);
  if (!tool || !tool.active) throw new HttpError(404, 'Barang tidak ditemukan');
  let newQty = Number(tool.quantity ?? 1);
  if (req.body.delta !== undefined) {
    newQty = Math.max(0, newQty + Number(req.body.delta));
  } else if (req.body.quantity !== undefined && req.body.quantity !== '' && !Number.isNaN(Number(req.body.quantity))) {
    newQty = Math.max(0, Number(req.body.quantity));
  }
  const newUnit = req.body.unit !== undefined && String(req.body.unit).trim()
    ? String(req.body.unit).trim()
    : (tool.unit || (tool.item_type === 'material' ? 'Pcs' : 'Unit'));
  db.prepare('UPDATE tools SET quantity = ?, unit = ? WHERE code = ?')
    .run(newQty, newUnit, code);
  try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }
  return { ok: true, tool: q.tool.get(code) };
}));

// ---------- DASHBOARD & MONITORING ----------
app.get('/api/out', requireAuth, wrap((req) => {
  const out = db.prepare(`
    SELECT l.id, l.out_at, l.tool_code, l.transferred_from, l.qty, l.badge_id, l.in_note,
           uf.name AS transferred_from_name,
           t.name AS tool_name, t.category, t.location, t.item_type, t.condition, t.quantity, t.unit,
           l.worker_code, u.name AS worker_name, u.dept AS worker_dept, u.phone AS worker_phone
    FROM loans l
    JOIN tools t ON t.code = l.tool_code
    JOIN users u ON u.username = l.worker_code
    LEFT JOIN users uf ON uf.username = l.transferred_from
    WHERE l.in_at IS NULL
    ORDER BY l.out_at DESC`).all();

  const pendingTransfers = db.prepare(`
    SELECT tr.*, t.name AS tool_name, t.item_type,
           uf.name AS from_name, ut.name AS to_name
    FROM transfers tr
    JOIN tools t ON t.code = tr.tool_code
    JOIN users uf ON uf.username = tr.from_user
    JOIN users ut ON ut.username = tr.to_user
    WHERE tr.status = 'pending'
    ORDER BY tr.created_at DESC`).all();

  const s = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN item_type = 'material' THEN 1 ELSE 0 END) AS totalMaterial,
           SUM(CASE WHEN item_type != 'material' THEN 1 ELSE 0 END) AS totalTools,
           SUM(CASE WHEN status = 'rusak' OR condition = 'eject' THEN 1 ELSE 0 END) AS broken,
           SUM(CASE WHEN condition = 'kalibrasi' THEN 1 ELSE 0 END) AS calibration
    FROM tools WHERE active = 1`).get();
  const since = req.query.since || new Date(Date.now() - 86400_000).toISOString();
  const todayCount = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE out_at >= ?').get(String(since)).n;

  return {
    out,
    pendingTransfers,
    stats: {
      total: s.total || 0,
      totalTools: s.totalTools || 0,
      totalMaterial: s.totalMaterial || 0,
      out: out.length,
      broken: s.broken || 0,
      calibration: s.calibration || 0,
      available: Math.max(0, (s.total || 0) - out.length - (s.broken || 0) - (s.calibration || 0)),
      todayLoans: todayCount,
      pendingTransfers: pendingTransfers.length,
    },
  };
}));

// ---------- KATALOG BARANG & DETAIL BARANG (+ QR CODE) ----------
app.get('/api/tools', requireAuth, wrap(() => db.prepare(`
  SELECT t.*,
         ol.loan_id,
         ol.holder_code,
         ol.holder_since,
         ol.holder,
         ol.holder_dept,
         ol.holder_phone,
         ol.holder_badge,
         COALESCE(ol.borrowed_qty, 0) AS borrowed_qty,
         COALESCE(ol.open_loans_count, 0) AS open_loans_count,
         COALESCE(cl.consumed_qty, 0) AS consumed_qty,
         COALESCE(cl.consumed_count, 0) AS consumed_count
  FROM tools t
  LEFT JOIN (
    SELECT l.tool_code,
           MAX(l.id) AS loan_id,
           l.worker_code AS holder_code,
           MAX(l.out_at) AS holder_since,
           GROUP_CONCAT(DISTINCT u.name) AS holder,
           u.dept AS holder_dept,
           u.phone AS holder_phone,
           l.badge_id AS holder_badge,
           SUM(COALESCE(l.qty, 1)) AS borrowed_qty,
           COUNT(l.id) AS open_loans_count
    FROM loans l
    JOIN users u ON u.username = l.worker_code
    WHERE l.in_at IS NULL
    GROUP BY l.tool_code
  ) ol ON ol.tool_code = t.code
  LEFT JOIN (
    SELECT l.tool_code,
           SUM(COALESCE(l.qty, 1)) AS consumed_qty,
           COUNT(l.id) AS consumed_count
    FROM loans l
    WHERE l.in_condition = 'consumed'
    GROUP BY l.tool_code
  ) cl ON cl.tool_code = t.code
  WHERE t.active = 1
  ORDER BY t.code`).all()));

app.get('/api/tools/:code/detail', requireAuth, wrap((req) => {
  const code = norm(req.params.code);
  const tool = q.tool.get(code);
  if (!tool || !tool.active) throw new HttpError(404, 'Barang tidak ditemukan');
  const openLoan = q.openLoan.get(code);
  const history = db.prepare(`
    SELECT l.*, u.name AS worker_name, u.dept AS worker_dept,
           uf.name AS transferred_from_name,
           ub.name AS in_by_name
    FROM loans l
    JOIN users u ON u.username = l.worker_code
    LEFT JOIN users uf ON uf.username = l.transferred_from
    LEFT JOIN users ub ON ub.username = l.in_by
    WHERE l.tool_code = ?
    ORDER BY l.out_at DESC LIMIT 25`).all(code);
  return { tool, openLoan, history };
}));

// Generate SVG QR Code tunggal untuk barang apa pun
app.get('/api/qr/:code.svg', async (req, res) => {
  const code = norm(req.params.code.replace(/\.svg$/i, ''));
  const svg = await QRCode.toString(code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 280 });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

// Generate SVG QR Code untuk URL koneksi HP (Wi-Fi LAN)
app.get('/api/connect-qr.svg', async (req, res) => {
  const url = String(req.query.url || `http://${localIPv4()[0] || 'localhost'}:${activeHttpPort}/`);
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 260 });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

// ---------- RIWAYAT ----------
function historyRows(qs) {
  const where = [];
  const params = [];
  if (qs.from) { where.push('l.out_at >= ?'); params.push(qs.from); }
  if (qs.to) { where.push('l.out_at < ?'); params.push(qs.to); }
  if (qs.item_type && (qs.item_type === 'tool' || qs.item_type === 'material')) {
    where.push('t.item_type = ?');
    params.push(qs.item_type);
  }
  if (qs.q) {
    where.push('(t.name LIKE ? OR t.code LIKE ? OR u.name LIKE ? OR u.username LIKE ? OR l.badge_id LIKE ?)');
    const like = `%${qs.q}%`;
    params.push(like, like, like, like, like);
  }
  return db.prepare(`
    SELECT l.id, l.out_at, l.in_at, l.in_by, l.in_condition, l.in_note, l.transferred_from, l.qty, l.badge_id,
           uf.name AS transferred_from_name, ub.name AS in_by_name,
           l.tool_code, t.name AS tool_name, t.category, t.location, t.item_type, t.condition, t.quantity, t.unit,
           l.worker_code, u.name AS worker_name, u.dept AS worker_dept
    FROM loans l
    JOIN tools t ON t.code = l.tool_code
    JOIN users u ON u.username = l.worker_code
    LEFT JOIN users uf ON uf.username = l.transferred_from
    LEFT JOIN users ub ON ub.username = l.in_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY l.out_at DESC LIMIT 2000`).all(...params);
}
app.get('/api/history', requireAuth, wrap((req) => historyRows(req.query)));
app.get(['/api/history.csv', '/api/history.xls'], requireAuth, wrap((req, res) => {
  const isCsv = req.path.endsWith('.csv') || req.query.format === 'csv';
  const rows = historyRows(req.query);
  const stamp = new Date().toISOString().slice(0, 10);
  const headers = ['Waktu Pinjam', 'Waktu Kembali', 'Tipe', 'Kode Barang', 'Nama Barang', 'Jumlah', 'Badge ID / Akun', 'Nama Peminjam', 'Divisi/Crew', 'Catatan'];

  if (isCsv) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(esc).join(';')];
    for (const r of rows) {
      lines.push([
        fmtTime(r.out_at),
        r.in_at ? fmtTime(r.in_at) : 'MASIH DIPINJAM',
        r.item_type === 'material' ? 'Material' : 'Tools',
        r.tool_code,
        r.tool_name,
        `${r.qty ?? 1} ${r.unit || 'Unit'}`,
        r.badge_id || r.worker_code,
        r.worker_name,
        r.worker_dept,
        r.in_note,
      ].map(esc).join(';'));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="riwayat-gudang-gfm-${stamp}.csv"`);
    return res.send('\uFEFF' + lines.join('\r\n'));
  }

  const rRows = rows.map((r) => ({
    cells: [
      fmtTime(r.out_at),
      r.in_at ? fmtTime(r.in_at) : 'MASIH DIPINJAM',
      r.item_type === 'material' ? 'Material' : 'Tools',
      r.tool_code,
      r.tool_name,
      `${r.qty ?? 1} ${r.unit || 'Unit'}`,
      r.badge_id || r.worker_code,
      r.worker_name,
      r.worker_dept || '',
      r.transferred_from ? `Oper dari ${r.transferred_from_name || r.transferred_from}` : 'Gudang',
      r.in_by_name || r.in_by || '-',
      r.in_note || '',
    ],
    isExample: false,
  }));

  const html = makeExcelHtml({
    sheetName: 'Riwayat Pinjam Gudang',
    title: 'GFM — PT SULAWESI CAHAYA MINERAL',
    subtitle: `LAPORAN RIWAYAT PEMINJAMAN ALAT & MATERIAL GUDANG (${rows.length} Transaksi)`,
    note: `Diunduh pada: ${new Date().toLocaleString('id-ID')}`,
    headers,
    rows: rRows,
  });

  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="riwayat-gudang-gfm-${stamp}.xls"`);
  res.send(html);
}));

// ---------- STOK OPNAME (KHUSUS PENJAGA GUDANG) ----------
app.post('/api/opname', requireAdmin, wrap((req) => {
  const found = [...new Set((req.body.found || []).map(norm))];
  const foundSet = new Set(found);
  const tools = db.prepare('SELECT code, name, location, status, item_type, condition FROM tools WHERE active = 1').all();
  const openMap = new Map(db.prepare(`
    SELECT l.tool_code, u.name AS worker_name FROM loans l JOIN users u ON u.username = l.worker_code
    WHERE l.in_at IS NULL`).all().map((r) => [r.tool_code, r.worker_name]));

  const missing = tools.filter((t) => !openMap.has(t.code) && !foundSet.has(t.code));
  const foundButOut = tools.filter((t) => openMap.has(t.code) && foundSet.has(t.code))
    .map((t) => ({ ...t, holder: openMap.get(t.code) }));
  const stillOut = tools.filter((t) => openMap.has(t.code) && !foundSet.has(t.code))
    .map((t) => ({ ...t, holder: openMap.get(t.code) }));

  db.prepare('INSERT INTO opnames (at, by_user, found, missing, out_count) VALUES (?, ?, ?, ?, ?)')
    .run(now(), req.user.username, JSON.stringify(found), JSON.stringify(missing.map((m) => m.code)), stillOut.length);
  return { missing, foundButOut, stillOut, foundCount: found.length };
}));

// Balancing Stok Gudang (Stok Opname Aktual vs Sistem)
app.post('/api/opname/balance', requireAdmin, wrap((req) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw new HttpError(400, 'Tidak ada data stok untuk disesuaikan');

  return tx(() => {
    let updatedCount = 0;
    const adjustedCodes = [];
    for (const item of items) {
      const code = norm(item.code);
      if (!code) continue;
      const tool = q.tool.get(code);
      if (!tool || !tool.active) continue;
      const newQty = Number(item.actualQty);
      if (Number.isNaN(newQty) || newQty < 0) continue;

      let newCond = String(item.condition || tool.condition || 'bagus').toLowerCase();
      if (!['bagus', 'kalibrasi', 'eject'].includes(newCond)) newCond = tool.condition || 'bagus';
      const newStatus = newCond === 'eject' ? 'rusak' : 'ok';

      if (Number(tool.quantity ?? 0) !== newQty || tool.condition !== newCond) {
        db.prepare('UPDATE tools SET quantity = ?, condition = ?, status = ? WHERE code = ?')
          .run(newQty, newCond, newStatus, code);
        updatedCount++;
        adjustedCodes.push(`${code}:${tool.quantity}->${newQty}`);
      }
    }

    db.prepare('INSERT INTO opnames (at, by_user, found, missing, out_count) VALUES (?, ?, ?, ?, ?)')
      .run(now(), req.user.username, JSON.stringify(adjustedCodes), '[]', updatedCount);
    try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }
    return { ok: true, updatedCount };
  });
}));

app.post('/api/return-bulk', requireAdmin, wrap((req) => {
  const codes = (req.body.codes || []).map(norm);
  const note = String(req.body.note || 'Ditemukan di rak saat opname oleh Penjaga Gudang');
  let n = 0;
  tx(() => {
    for (const c of codes) {
      const open = q.openLoan.get(c);
      if (open) { q.closeLoan.run(now(), req.user.username, 'ok', note, open.id); n++; }
    }
  });
  return { ok: true, closed: n };
}));

// ---------- KELOLA BARANG & AKUN CREW (KHUSUS ADMIN / PENJAGA GUDANG) ----------
app.get('/api/users', requireAuth, wrap((req) => {
  const rows = db.prepare(`
    SELECT u.username, u.name, u.role, u.dept, u.phone, u.active,
           (SELECT COUNT(*) FROM loans l WHERE l.worker_code = u.username AND l.in_at IS NULL) AS holding
    FROM users u WHERE u.active = 1
    ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END,
             CASE WHEN u.username LIKE 'CREW%' THEN 0 ELSE 1 END,
             LENGTH(u.username), u.username`).all();
  return rows;
}));

function nextToolCode(itemType = 'tool') {
  const prefix = itemType === 'material' ? 'M-' : 'T-';
  const rows = db.prepare('SELECT code FROM tools WHERE code LIKE ?').all(`${prefix}%`);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.code.slice(prefix.length)) || 0), 0);
  return prefix + String(max + 1).padStart(3, '0');
}

function nextCrewCode() {
  const rows = db.prepare("SELECT username FROM users WHERE username LIKE 'CREW%'").all();
  const max = rows.reduce((m, r) => Math.max(m, Number(r.username.replace(/\D+/g, '')) || 0), 0);
  return 'CREW' + String(max + 1).padStart(2, '0');
}

function upsertTool({ code, name, category = '', location = '', status, note, item_type, condition, quantity, unit }) {
  code = norm(code);
  name = String(name || '').trim();
  if (!name) throw new HttpError(400, 'Nama barang wajib diisi');
  if (code && (!/^[A-Z0-9_\-\.]{2,30}$/i.test(code) || /^(FUNCTION|VAR|LET|IF|RETURN|FRAMES|WINDOW)/i.test(code) || /<[^>]*>|[()\[\]{}'"=;\\\/]/.test(code))) {
    throw new HttpError(400, `Kode barang "${code}" tidak valid (hanya huruf, angka, strip, titik, atau garis bawah)`);
  }
  if (/<[^>]*>|[{}'"=\\]/.test(name) || /^(FUNCTION|VAR|LET|IF|RETURN|FRAMES|WINDOW)/i.test(name)) {
    throw new HttpError(400, `Nama barang "${name}" tidak valid`);
  }

  let resolvedType = String(item_type || '').trim().toLowerCase();
  if (resolvedType !== 'material' && resolvedType !== 'tool') {
    resolvedType = code && /^M-/i.test(code) ? 'material' : 'tool';
  }
  if (!code) code = nextToolCode(resolvedType);

  let resolvedCond = String(condition || '').trim().toLowerCase();
  if (!['bagus', 'kalibrasi', 'eject'].includes(resolvedCond)) {
    resolvedCond = status === 'rusak' ? 'eject' : 'bagus';
  }
  const resolvedStatus = resolvedCond === 'eject' ? 'rusak' : 'ok';
  const resolvedQty = quantity !== undefined && quantity !== '' && !Number.isNaN(Number(quantity)) ? Math.max(0, Number(quantity)) : 1;
  const resolvedUnit = String(unit || (resolvedType === 'material' ? 'Pcs' : 'Unit')).trim() || 'Unit';

  const existing = q.tool.get(code);
  if (existing) {
    db.prepare(`
      UPDATE tools
      SET name = ?, category = ?, location = ?, item_type = ?, condition = ?, quantity = ?, unit = ?, status = ?, note = ?, active = 1
      WHERE code = ?
    `).run(
      name,
      String(category),
      String(location),
      resolvedType,
      resolvedCond,
      resolvedQty,
      resolvedUnit,
      resolvedStatus,
      note ?? existing.note,
      code
    );
  } else {
    db.prepare(`
      INSERT INTO tools (code, name, category, location, item_type, condition, quantity, unit, status, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code,
      name,
      String(category),
      String(location),
      resolvedType,
      resolvedCond,
      resolvedQty,
      resolvedUnit,
      resolvedStatus,
      note || '',
      now()
    );
  }
  return q.tool.get(code);
}

function upsertUser({ username, password, name, role = 'crew', dept = '', phone = '' }) {
  username = String(username || '').trim().toUpperCase();
  name = String(name || '').trim();
  if (!name) throw new HttpError(400, 'Nama lengkap wajib diisi');
  if (username && (!/^[A-Z0-9_\-\.]{2,30}$/i.test(username) || /^(FUNCTION|VAR|LET|IF|RETURN|FRAMES|WINDOW)/i.test(username) || /<[^>]*>|[()\[\]{}'"=;\\\/]/.test(username))) {
    throw new HttpError(400, `ID Akun "${username}" tidak valid (hanya huruf, angka, strip, atau garis bawah)`);
  }
  if (/<[^>]*>|[{}'"=\\]/.test(name) || /^(FUNCTION|VAR|LET|IF|RETURN|FRAMES|WINDOW)/i.test(name)) {
    throw new HttpError(400, `Nama lengkap "${name}" tidak valid`);
  }
  if (!username) username = nextCrewCode();
  const validRole = role === 'admin' ? 'admin' : 'crew';
  const existing = q.user.get(username);
  if (existing) {
    const pwHash = password && String(password).trim() ? hashPassword(String(password).trim()) : existing.password_hash;
    db.prepare('UPDATE users SET password_hash = ?, name = ?, role = ?, dept = ?, phone = ?, active = 1 WHERE username = ?')
      .run(pwHash, name, validRole, String(dept), String(phone), username);
  } else {
    const pwHash = hashPassword(password && String(password).trim() ? String(password).trim() : '1234');
    db.prepare('INSERT INTO users (username, password_hash, name, role, dept, phone) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, pwHash, name, validRole, String(dept), String(phone));
  }
  try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* abaikan */ }
  return q.userPublic.get(username);
}

app.post('/api/admin/tools', requireAdmin, wrap((req) => tx(() => upsertTool(req.body))));
app.post('/api/admin/users', requireAdmin, wrap((req) => tx(() => upsertUser(req.body))));

app.delete('/api/admin/tools/:code', requireAdmin, wrap((req) => {
  const code = norm(req.params.code);
  if (q.openLoan.get(code)) throw new HttpError(400, 'Barang masih sedang dipinjam, scan kembali dulu ke gudang');
  db.prepare('UPDATE tools SET active = 0 WHERE code = ?').run(code);
  return { ok: true };
}));

app.delete('/api/admin/users/:username', requireAdmin, wrap((req) => {
  const username = String(req.params.username || '').trim().toUpperCase();
  if (username === req.user.username) throw new HttpError(400, 'Tidak bisa menghapus akun Anda sendiri');
  const n = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE worker_code = ? AND in_at IS NULL').get(username).n;
  if (n) throw new HttpError(400, `Pekerja ini masih memegang ${n} barang gudang`);
  db.prepare('UPDATE users SET active = 0 WHERE username = ?').run(username);
  db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
  return { ok: true };
}));

app.post('/api/admin/import', requireAdmin, wrap((req) => {
  const { type, rows } = req.body;
  if (!Array.isArray(rows)) throw new HttpError(400, 'Data tidak valid');
  return tx(() => {
    let count = 0;
    for (const r of rows) {
      if (!r || !r.name || typeof r.name !== 'string' || !r.name.trim()) continue;
      if (/<[^>]*>|[{}'"=\\]/.test(r.name) || /^(FUNCTION|VAR|LET|IF|RETURN|FRAMES|WINDOW)/i.test(r.name)) continue;
      if (type === 'tools') {
        if (r.code && (!/^[A-Z0-9_\-\.]{2,30}$/i.test(r.code) || /^(FUNCTION|VAR|LET|IF|RETURN|FRAMES)/i.test(r.code))) continue;
        upsertTool(r);
        count++;
      } else {
        if (r.username && (!/^[A-Z0-9_\-\.]{2,30}$/i.test(r.username) || /^(FUNCTION|VAR|LET|IF|RETURN|FRAMES)/i.test(r.username))) continue;
        upsertUser(r);
        count++;
      }
    }
    return { ok: true, count };
  });
}));

function makeExcelHtml({ sheetName, title, subtitle, note, headers, rows }) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const headerHtml = headers.map((h) => `<th style="background-color:#0f172a;color:#ffffff;font-weight:bold;padding:10px 14px;border:1px solid #334155;text-align:left;font-size:11pt;">${esc(h)}</th>`).join('');

  const rowsHtml = rows.map((r) => {
    const isEx = r.isExample;
    const bg = isEx ? 'background-color:#fef9c3;color:#854d0e;font-style:italic;' : '';
    const cells = r.cells.map((c, i) => {
      const isText = i === 0 || i === 3 || typeof c === 'string';
      const mso = isText ? "mso-number-format:'\\@';" : '';
      const cellStyle = `border:1px solid #cbd5e1;padding:8px 12px;font-size:10.5pt;${bg}${mso}`;
      return `<td style="${cellStyle}">${esc(c)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('\r\n');

  const colSpan = headers.length || 4;

  return `\uFEFF<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<!--[if gte mso 9]>
<xml>
  <x:ExcelWorkbook>
    <x:ExcelWorksheets>
      <x:ExcelWorksheet>
        <x:Name>${esc(sheetName || 'Data Gudang')}</x:Name>
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
  <tr><td colspan="${colSpan}" style="background-color:#0f2942;color:#fcd34d;font-size:14pt;font-weight:bold;padding:12px;border:none;">${esc(title)}</td></tr>
  <tr><td colspan="${colSpan}" style="background-color:#f1f5f9;color:#334155;font-size:11pt;font-weight:bold;padding:8px 12px;border:none;">${esc(subtitle)}</td></tr>
  <tr><td colspan="${colSpan}" style="background-color:#e0f2fe;color:#0369a1;font-size:10pt;padding:8px 12px;border:none;">${esc(note)}</td></tr>
  <tr style="height:8px;"><td colspan="${colSpan}" style="border:none;"></td></tr>
  <thead><tr>${headerHtml}</tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
</body>
</html>`;
}

// Download format Excel tambah barang (sesuai jumlah saat ini di database + baris contoh baru)
app.get(['/api/admin/template/tools', '/api/admin/template/tools.xls', '/api/admin/template/tools.csv'], requireAuth, wrap((req, res) => {
  const isCsv = req.path.endsWith('.csv') || req.query.format === 'csv';
  const tools = db.prepare('SELECT code, name, category, item_type, condition, quantity, unit FROM tools WHERE active = 1 ORDER BY item_type DESC, code').all();
  const nextTool = nextToolCode('tool');
  const nextMat = nextToolCode('material');
  const stamp = new Date().toISOString().slice(0, 10);
  const headers = ['Kode Barang', 'Nama Barang', 'Tipe (tool/material)', 'Kategori', 'Kondisi (bagus/kalibrasi/eject)', 'Jumlah/Stok', 'Satuan'];

  if (isCsv) {
    const escCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(escCsv).join(';')];
    for (const t of tools) lines.push([t.code, t.name, t.item_type || 'tool', t.category, t.condition || 'bagus', t.quantity ?? 1, t.unit || 'Unit'].map(escCsv).join(';'));
    lines.push([nextTool, '(Contoh: Tambah Tools Baru)', 'tool', 'Power Tool', 'bagus', 1, 'Unit'].map(escCsv).join(';'));
    lines.push([nextMat, '(Contoh: Tambah Material Baru)', 'material', 'Consumable Las', 'bagus', 20, 'Box'].map(escCsv).join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="format-tambah-barang-${tools.length}-barang-${stamp}.csv"`);
    return res.send('\uFEFF' + lines.join('\r\n'));
  }

  const rows = tools.map((t) => ({ cells: [t.code, t.name, t.item_type || 'tool', t.category || '', t.condition || 'bagus', t.quantity ?? 1, t.unit || 'Unit'], isExample: false }));
  rows.push({ cells: [nextTool, '(Contoh: Tambah Tools Baru)', 'tool', 'Power Tool', 'bagus', 1, 'Unit'], isExample: true });
  rows.push({ cells: [nextMat, '(Contoh: Tambah Material Baru)', 'material', 'Consumable Las', 'bagus', 20, 'Box'], isExample: true });

  const html = makeExcelHtml({
    sheetName: 'Format Tambah Barang',
    title: 'GFM — PT SULAWESI CAHAYA MINERAL',
    subtitle: `FORMAT TAMBAH TOOLS & MATERIAL GUDANG (${tools.length} Barang Saat Ini di Database)`,
    note: `Petunjuk: Baris di bawah adalah seluruh ${tools.length} barang aktif di gudang. Ketik data Tools (T-xxx) atau Material (M-xxx) baru Anda pada baris kosong di bawah contoh, lalu import ke sistem.`,
    headers,
    rows,
  });

  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="format-tambah-barang-${tools.length}-barang-${stamp}.xls"`);
  res.send(html);
}));

// Download format Excel tambah akun (sesuai jumlah saat ini di database + baris contoh baru)
app.get(['/api/admin/template/users', '/api/admin/template/users.xls', '/api/admin/template/users.csv'], requireAuth, wrap((req, res) => {
  const isCsv = req.path.endsWith('.csv') || req.query.format === 'csv';
  const users = db.prepare(`
    SELECT username, name, dept, phone, role
    FROM users WHERE active = 1
    ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
             CASE WHEN username LIKE 'CREW%' THEN 0 ELSE 1 END,
             LENGTH(username), username`).all();
  const nextNum = users.reduce((m, r) => Math.max(m, Number(r.username.replace(/\D+/g, '')) || 0), 0) + 1;
  const stamp = new Date().toISOString().slice(0, 10);
  const headers = ['ID Akun', 'Nama Lengkap', 'Divisi / Crew', 'No HP / Radio', 'Peran (crew/admin)', 'Password Baru (opsional)'];

  if (isCsv) {
    const escCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(escCsv).join(';')];
    for (const u of users) lines.push([u.username, u.name, u.dept, u.phone, u.role, '(tersimpan)'].map(escCsv).join(';'));
    lines.push([`CREW${String(nextNum).padStart(2, '0')}`, '(Contoh: Nama Crew Baru 1)', 'Crew E - Mekanik Fabrikasi', '0812-4000-0124', 'crew', '1234'].map(escCsv).join(';'));
    lines.push([`CREW${String(nextNum + 1).padStart(2, '0')}`, '(Contoh: Nama Crew Baru 2)', 'Crew E - Elektrikal', '0812-4000-0125', 'crew', '1234'].map(escCsv).join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="format-tambah-akun-${users.length}-akun-${stamp}.csv"`);
    return res.send('\uFEFF' + lines.join('\r\n'));
  }

  const rows = users.map((u) => ({ cells: [u.username, u.name, u.dept || '', u.phone || '', u.role || 'crew', '(tersimpan)'], isExample: false }));
  rows.push({ cells: [`CREW${String(nextNum).padStart(2, '0')}`, '(Contoh: Nama Crew Baru 1)', 'Crew E - Mekanik Fabrikasi', '0812-4000-0124', 'crew', '1234'], isExample: true });
  rows.push({ cells: [`CREW${String(nextNum + 1).padStart(2, '0')}`, '(Contoh: Nama Crew Baru 2)', 'Crew E - Elektrikal', '0812-4000-0125', 'crew', '1234'], isExample: true });

  const html = makeExcelHtml({
    sheetName: 'Format Tambah Akun',
    title: 'GFM — PT SULAWESI CAHAYA MINERAL',
    subtitle: `FORMAT TAMBAH AKUN CREW & PENJAGA GUDANG (${users.length} Akun Saat Ini di Database)`,
    note: `Petunjuk: Baris di bawah adalah seluruh ${users.length} akun aktif di database lokal. Tambahkan akun crew baru pada baris kosong. Password awal default 1234 jika dikosongkan. Peran: crew (pekerja) atau admin (penjaga gudang).`,
    headers,
    rows,
  });

  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="format-tambah-akun-${users.length}-akun-${stamp}.xls"`);
  res.send(html);
}));

// Download salinan database
app.get('/api/admin/backup', requireAdmin, (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const tmp = path.join(DATA_DIR, `download-${Date.now()}.db`);
  try {
    snapshot(tmp);
    res.download(tmp, `gudang-backup-${stamp}.db`, () => fs.rm(tmp, { force: true }, () => {}));
  } catch (e) {
    fs.rm(tmp, { force: true }, () => {});
    res.status(500).json({ error: 'Backup gagal: ' + e.message });
  }
});

// Ganti / reset logo perusahaan (GFM PT Sulawesi Cahaya Mineral)
app.post('/api/admin/logo', requireAdmin, wrap((req) => {
  if (req.body.reset) {
    fs.rmSync(CUSTOM_LOGO_META, { force: true });
    return { ok: true, custom: false };
  }
  const m = String(req.body.dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new HttpError(400, 'Format gambar harus PNG, JPG, WebP, atau SVG');
  if (m[2].length > 1_500_000) throw new HttpError(400, 'Ukuran file logo maksimal 1 MB');
  fs.writeFileSync(CUSTOM_LOGO_META, JSON.stringify({ mime: m[1], data: m[2] }));
  return { ok: true, custom: true };
}));

// ---------- CETAK STIKER LABEL QR BARANG ----------
app.get('/labels', async (req, res) => {
  const size = ['sm', 'md', 'lg'].includes(req.query.size) ? req.query.size : 'md';
  const only = req.query.codes ? new Set(String(req.query.codes).split(',').map(norm)) : null;
  let items = db.prepare('SELECT code, name, category, location FROM tools WHERE active = 1 ORDER BY code').all();
  if (only) items = items.filter((i) => only.has(i.code));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cards = await Promise.all(items.map(async (i) => {
    const svg = await QRCode.toString(i.code, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    return `<div class="lbl sz-${size}"><div class="qr">${svg}</div><div class="txt">
      <div class="lbl-hdr"><img src="/logo-active" alt="GFM"><span>GFM · PT SCM</span></div>
      <div class="code">${esc(i.code)}</div>
      <div class="name">${esc(i.name)}</div>
      <div class="sub">${esc([i.category, i.location].filter(Boolean).join(' · '))}</div>
      <div class="brand">GUDANG ALAT — WAJIB SCAN QR</div></div></div>`;
  }));
  res.send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cetak Stiker QR Barang — GFM PT Sulawesi Cahaya Mineral</title>
<style>
  body{font-family:Arial,sans-serif;margin:8mm;background:#f8fafc;color:#111}
  .bar{background:#0f2942;color:#fff;padding:12px 16px;border-radius:12px;margin-bottom:8mm;display:flex;flex-wrap:wrap;align-items:center;gap:12px}
  .bar button,.bar a{font-size:14px;font-weight:bold;padding:8px 14px;border-radius:8px;border:0;cursor:pointer;text-decoration:none}
  .btn-print{background:#f59e0b;color:#1f1300}
  .btn-sz{background:#1e3a5f;color:#fff} .btn-sz.active{background:#10b981;color:#fff}
  .grid{display:flex;flex-wrap:wrap;gap:3.5mm}
  .lbl{background:#fff;border:1.5px dashed #64748b;border-radius:6px;display:flex;gap:2.5mm;padding:2.5mm;box-sizing:border-box;page-break-inside:avoid; align-items:center}
  .lbl.sz-sm{width:50mm;height:25mm} .lbl.sz-sm .qr{width:19mm;height:19mm} .lbl.sz-sm .code{font-size:11pt} .lbl.sz-sm .name{font-size:7.5pt} .lbl.sz-sm .sub,.lbl.sz-sm .brand{font-size:5.5pt}
  .lbl.sz-md{width:66mm;height:32mm} .lbl.sz-md .qr{width:26mm;height:26mm} .lbl.sz-md .code{font-size:14pt} .lbl.sz-md .name{font-size:9.5pt} .lbl.sz-md .sub{font-size:7.5pt} .lbl.sz-md .brand{font-size:6pt}
  .lbl.sz-lg{width:85mm;height:42mm} .lbl.sz-lg .qr{width:35mm;height:35mm} .lbl.sz-lg .code{font-size:17pt} .lbl.sz-lg .name{font-size:11pt} .lbl.sz-lg .sub{font-size:8.5pt} .lbl.sz-lg .brand{font-size:7pt}
  .qr{flex:none} .qr svg{width:100%;height:100%}
  .txt{display:flex;flex-direction:column;min-width:0;flex:1;height:100%}
  .lbl-hdr{display:flex;align-items:center;gap:1.5mm;font-size:6.5pt;font-weight:bold;color:#0f2942;letter-spacing:.4px}
  .lbl-hdr img{width:4mm;height:4mm;object-fit:contain}
  .code{font-weight:900;line-height:1.1;color:#0f2942}
  .name{font-weight:bold;line-height:1.15;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .sub{color:#475569;margin-top:1px}
  .brand{margin-top:auto;letter-spacing:.4px;color:#b45309;font-weight:bold}
  @media print{.bar{display:none} body{margin:4mm;background:#fff}}
</style></head><body>
<div class="bar">
  <img src="/logo-active" style="height:38px">
  <div><b>Stiker QR Barang Gudang (${items.length} unit)</b><br><small style="color:#fcd34d">GFM — PT Sulawesi Cahaya Mineral</small></div>
  <div style="display:flex;gap:6px;margin-left:auto;flex-wrap:wrap">
    <a class="btn-sz ${size === 'sm' ? 'active' : ''}" href="?size=sm${req.query.codes ? '&codes=' + encodeURIComponent(req.query.codes) : ''}">Kecil (50×25mm)</a>
    <a class="btn-sz ${size === 'md' ? 'active' : ''}" href="?size=md${req.query.codes ? '&codes=' + encodeURIComponent(req.query.codes) : ''}">Sedang (66×32mm)</a>
    <a class="btn-sz ${size === 'lg' ? 'active' : ''}" href="?size=lg${req.query.codes ? '&codes=' + encodeURIComponent(req.query.codes) : ''}">Besar (85×42mm)</a>
    <button class="btn-print" onclick="print()">🖨️ Cetak Stiker QR</button>
  </div>
</div>
<div class="grid">${cards.join('')}</div></body></html>`);
});

// ---------- HALAMAN SETUP PERANGKAT (pasang sertifikat agar kamera HP bisa dipakai) ----------
let certInfo = null;
const httpsUrl = (host) => `https://${host}${activeHttpsPort === 443 ? '' : ':' + activeHttpsPort}/`;
const httpUrl = (host) => `http://${host}${activeHttpPort === 80 ? '' : ':' + activeHttpPort}/`;

async function setupPage(req, res) {
  const ips = localIPv4();
  const reqHost = String(req.hostname || ips[0] || 'localhost');
  const targetHttps = httpsUrl(reqHost);
  const targetHttp = httpUrl(reqHost);
  const qr = await QRCode.toString(HTTPS_ON ? targetHttps : targetHttp, { type: 'svg', margin: 1 });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res.send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setup HP &amp; Tablet — GFM PT Sulawesi Cahaya Mineral</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:740px;margin:0 auto;padding:16px;line-height:1.5;color:#111;background:#0f172a}
.hdr{display:flex;align-items:center;gap:14px;background:#1e293b;color:#fff;padding:16px;border-radius:14px;margin-bottom:14px;border:1px solid #334155}
.hdr img{width:54px;height:54px;object-fit:contain}
.hdr h1{font-size:1.2rem;margin:0} .hdr .sub{color:#fcd34d;font-size:.8rem;font-weight:700;letter-spacing:.5px}
.card{background:#1e293b;color:#f1f5f9;border-radius:14px;padding:16px;margin:12px 0;border:1px solid #334155}
.btn{display:inline-block;background:#f59e0b;color:#1f1300;font-weight:700;padding:12px 18px;border-radius:12px;text-decoration:none;margin:4px 4px 4px 0}
.btn.dark{background:#334155;color:#fff} code{background:#0f172a;color:#fcd34d;padding:2px 6px;border-radius:6px} .qr{width:200px;background:#fff;padding:8px;border-radius:10px} ol li{margin:6px 0}</style></head><body>
<div class="hdr">
  <img src="/logo-active" alt="Logo GFM SCM">
  <div>
    <div class="sub">GFM — PT SULAWESI CAHAYA MINERAL</div>
    <h1>Setup HP Crew &amp; Penjaga Gudang</h1>
  </div>
</div>
${HTTPS_ON ? `
<div class="card"><b>Langkah 1 — Pasang Sertifikat Kamera HP (Cukup 1x Seumur Hidup per HP)</b>
<p>Agar kamera HP bisa langsung men-scan QR barang di jaringan WiFi gudang tanpa peringatan browser:</p>
<a class="btn" href="/ca.crt">⬇️ 1. Download Sertifikat (.crt)</a> <a class="btn dark" href="/ca.cer">Alternatif (.cer)</a>
<ol><li>Tekan tombol download sertifikat di atas.</li>
<li>Di HP Android: buka <b>Setelan → Keamanan &amp; privasi → Setelan keamanan lainnya → Enkripsi &amp; kredensial → Instal sertifikat → Sertifikat CA</b>
<br><small>(atau ketik <b>"Instal sertifikat"</b> di kolom pencarian Setelan HP)</small></li>
<li>Pilih <b>Tetap instal</b>, lalu pilih file <code>gudang-alat-ca.crt</code> yang tadi diunduh.</li>
<li>Tutup lalu buka kembali Chrome, kemudian tekan tombol di bawah:</li></ol>
<a class="btn" href="${targetHttps}">🔒 2. Buka Aplikasi HTTPS (${esc(targetHttps)})</a>
<p>Atau scan QR ini dari HP Crew lain di WiFi yang sama:</p><div class="qr">${qr}</div>
<p><small>Tips: Di Chrome tekan menu ⋮ → <b>Tambahkan ke layar utama</b> agar menjadi ikon aplikasi di HP.</small></p></div>
<div class="card"><b>Alternatif — Tanpa Kamera Live (Pakai Foto Kamera / Scanner Bluetooth)</b>
<p>Jika belum memasang sertifikat, Anda tetap bisa membuka <a style="color:#fcd34d" href="${targetHttp}">${esc(targetHttp)}</a> lalu gunakan tombol <b>📸 Ambil Foto QR</b> di dalam aplikasi.</p></div>
<div class="card"><small>Alamat IP Server Mini PC: ${ips.map((ip) => `<code>${esc(httpsUrl(ip))}</code> · <code>${esc(httpUrl(ip))}</code>`).join(' ') || 'localhost'}</small></div>
` : `<div class="card">Server berjalan di <a class="btn" href="${targetHttp}">${esc(targetHttp)}</a></div>`}
</body></html>`);
}
const sendCA = (der) => (_req, res) => {
  if (!certInfo) return res.status(404).send('HTTPS tidak aktif');
  res.setHeader('Content-Type', der ? 'application/pkix-cert' : 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', `attachment; filename="gudang-alat-ca.${der ? 'cer' : 'crt'}"`);
  res.send(fs.readFileSync(der ? certInfo.caDerPath : certInfo.caPath));
};
app.get('/setup', setupPage);
app.get('/ca.crt', sendCA(false));
app.get('/ca.cer', sendCA(true));

// SPA fallback
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// ---------- start ----------
export default app;

if (!process.env.VERCEL) {
  dailyBackup();
  setInterval(dailyBackup, 60 * 60_000);

  const banner = (proto, port) => {
    const p = (proto === 'https' && port === 443) || (proto === 'http' && port === 80) ? '' : ':' + port;
    return [...localIPv4(), 'localhost'].map((h) => `   ${proto}://${h}${p}/`).join('\n');
  };

  function listenWithFallback(srv, preferredPort, fallbackPort, proto, label) {
    const tryListen = (port, canFallback) => {
      const onError = (err) => {
        if (canFallback && (err.code === 'EACCES' || err.code === 'EADDRINUSE') && port !== fallbackPort) {
          console.warn(`[server] Port ${port} (${proto}) tidak tersedia (${err.code}), beralih ke port ${fallbackPort}…`);
          srv.removeListener('error', onError);
          tryListen(fallbackPort, false);
        } else {
          console.error(`[server] Gagal membuka port ${port} (${proto}):`, err.message);
        }
      };
      srv.once('error', onError);
      srv.listen(port, '0.0.0.0', () => {
        srv.removeListener('error', onError);
        if (proto === 'http') activeHttpPort = port;
        if (proto === 'https') activeHttpsPort = port;
        console.log(`${label} (${proto.toUpperCase()} port ${port}):\n${banner(proto, port)}`);
      });
    };
    tryListen(preferredPort, true);
  }

  const { SSL_KEY, SSL_CERT } = process.env;
  if (SSL_KEY && SSL_CERT) {
    const srv = https.createServer({ key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) }, app);
    listenWithFallback(srv, PORT, 3450, 'https', 'GFM Gudang Alat — PT Sulawesi Cahaya Mineral');
  } else {
    const httpSrv = http.createServer(app);
    listenWithFallback(httpSrv, PORT, 3050, 'http', 'GFM Gudang Alat (HTTP)');

    if (HTTPS_ON) {
      try {
        certInfo = ensureCerts(path.join(DATA_DIR, 'certs'));
        const httpsSrv = https.createServer({ key: certInfo.key, cert: certInfo.cert }, app);
        listenWithFallback(httpsSrv, HTTPS_PORT, 3450, 'https', 'GFM Gudang Alat (HTTPS Kamera HP)');
        setInterval(() => {
          try {
            const c = ensureCerts(path.join(DATA_DIR, 'certs'));
            if (c.changed) { httpsSrv.setSecureContext({ key: c.key, cert: c.cert }); certInfo = c; }
          } catch (e) { console.error('[cert]', e.message); }
        }, 10 * 60_000);
      } catch (e) {
        console.error('[cert] Gagal menyiapkan HTTPS:', e.message);
      }
    }
  }
}
