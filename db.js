// Lapisan database: SQLite bawaan Node (node:sqlite), tanpa dependensi native.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __rootDir = path.dirname(fileURLToPath(import.meta.url));
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = process.env.DATA_DIR || (IS_VERCEL ? path.join(os.tmpdir(), 'gfm-warehouse-data') : path.join(process.cwd(), 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
export { DATA_DIR };
export const DB_PATH = path.join(DATA_DIR, 'gudang.db');

// Saat berjalan di Vercel (/tmp kosong saat cold-start), salin snapshot database awal jika tersedia
if (IS_VERCEL && !fs.existsSync(DB_PATH)) {
  const bundledSnapshot = path.join(__rootDir, 'seed-snapshot.db');
  if (fs.existsSync(bundledSnapshot)) {
    try { fs.copyFileSync(bundledSnapshot, DB_PATH); } catch { /* fallback ke seedDatabase */ }
  }
}

export const db = new DatabaseSync(DB_PATH);

export function hashPassword(pw) {
  return crypto.createHash('sha256').update('gfm-scm-salt:' + String(pw)).digest('hex');
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,           -- ID login (mis. ADMIN, CREW01..CREW20)
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'crew', -- 'admin' (Penjaga Gudang) | 'crew' (Pekerja)
    dept          TEXT DEFAULT '',
    phone         TEXT DEFAULT '',
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tools (
    code       TEXT PRIMARY KEY,              -- kode unik barang (T-001 untuk Tools, M-001 untuk Material)
    name       TEXT NOT NULL,
    item_type  TEXT NOT NULL DEFAULT 'tool',  -- 'tool' | 'material'
    category   TEXT DEFAULT '',
    location   TEXT DEFAULT '',               -- posisi rak / lemari di gudang
    status     TEXT NOT NULL DEFAULT 'ok',    -- 'ok' | 'rusak'
    condition  TEXT NOT NULL DEFAULT 'bagus', -- 'bagus' | 'kalibrasi' | 'eject'
    quantity   REAL NOT NULL DEFAULT 1,
    unit       TEXT NOT NULL DEFAULT 'Unit',
    note       TEXT DEFAULT '',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS loans (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_code        TEXT NOT NULL REFERENCES tools(code) ON UPDATE CASCADE,
    worker_code      TEXT NOT NULL REFERENCES users(username) ON UPDATE CASCADE,
    out_at           TEXT NOT NULL,
    transferred_from TEXT,                 -- diisi jika barang didapat dari operan crew lain
    in_at            TEXT,                 -- waktu di-scan kembali oleh penjaga gudang
    in_by            TEXT,                 -- username penjaga gudang yang men-scan kembali
    in_condition     TEXT DEFAULT 'ok',
    in_note          TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_loans_open ON loans(tool_code) WHERE in_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_loans_worker ON loans(worker_code) WHERE in_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_loans_out_at ON loans(out_at);

  -- Permintaan oper / ambil alih barang yang sedang dipegang orang lain (wajib disetujui pemegang)
  CREATE TABLE IF NOT EXISTS transfers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id     INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    tool_code   TEXT NOT NULL REFERENCES tools(code),
    from_user   TEXT NOT NULL REFERENCES users(username),
    to_user     TEXT NOT NULL REFERENCES users(username),
    status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'cancelled'
    note        TEXT DEFAULT '',
    created_at  TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_transfers_pending ON transfers(from_user, status) WHERE status = 'pending';

  CREATE TABLE IF NOT EXISTS opnames (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    by_user    TEXT DEFAULT '',
    found      TEXT NOT NULL,
    missing    TEXT NOT NULL,
    out_count  INTEGER NOT NULL
  );
`);

// Migrasi otomatis kolom baru pada database yang sudah ada (tanpa menghapus data)
const addCol = (sql) => { try { db.exec(sql); } catch { /* kolom sudah ada */ } };
addCol("ALTER TABLE tools ADD COLUMN item_type TEXT NOT NULL DEFAULT 'tool'");
addCol("ALTER TABLE tools ADD COLUMN condition TEXT NOT NULL DEFAULT 'bagus'");
addCol("ALTER TABLE tools ADD COLUMN quantity REAL NOT NULL DEFAULT 1");
addCol("ALTER TABLE tools ADD COLUMN unit TEXT NOT NULL DEFAULT 'Unit'");
addCol("ALTER TABLE loans ADD COLUMN qty REAL NOT NULL DEFAULT 1");
addCol("ALTER TABLE loans ADD COLUMN badge_id TEXT DEFAULT ''");

try {
  db.exec("UPDATE tools SET condition = 'eject' WHERE status = 'rusak' AND condition = 'bagus'");
  db.exec("UPDATE tools SET item_type = 'material' WHERE code LIKE 'M-%' AND item_type = 'tool'");
} catch { /* abaikan */ }

export const now = () => new Date().toISOString();

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- Backup otomatis harian ----------
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backup');
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 60);

export function snapshot(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  db.prepare('VACUUM INTO ?').run(target);
  return target;
}

export function dailyBackup() {
  try {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const target = path.join(BACKUP_DIR, `gudang-${stamp}.db`);
    if (!fs.existsSync(target)) {
      snapshot(target);
      console.log('[backup] ' + target);
    }
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^gudang-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (e) {
    console.error('[backup] gagal:', e.message);
  }
}
