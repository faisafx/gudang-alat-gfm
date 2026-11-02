// Isi data awal: 1 akun Penjaga Gudang (ADMIN) + 20 akun Crew + 20 Barang Gudang
import { db, tx, hashPassword } from './db.js';

const DEFAULT_PW = hashPassword('1234');
const ADMIN_PW = hashPassword(process.env.ADMIN_PIN || '1234');

const users = [
  // Akun Penjaga Gudang / Admin
  ['ADMIN', ADMIN_PW, 'Hendra Wijaya (Penjaga Gudang)', 'admin', 'GFM Warehouse', '0812-4000-0001'],

  // 20 Akun Crew Lapangan PT Sulawesi Cahaya Mineral
  ['CREW01', DEFAULT_PW, 'Budi Santoso', 'crew', 'Crew A - Mekanik Alat Berat', '0812-4000-0101'],
  ['CREW02', DEFAULT_PW, 'Andi Pratama', 'crew', 'Crew A - Elektrikal', '0812-4000-0102'],
  ['CREW03', DEFAULT_PW, 'Joko Susilo', 'crew', 'Crew A - Welder / Las', '0812-4000-0103'],
  ['CREW04', DEFAULT_PW, 'Rahmat Hidayat', 'crew', 'Crew A - Drilling & Blasting', '0812-4000-0104'],
  ['CREW05', DEFAULT_PW, 'La Ode Muhammad', 'crew', 'Crew A - Mekanik Pompa', '0812-4000-0105'],
  ['CREW06', DEFAULT_PW, 'Syahrul Ramadhan', 'crew', 'Crew B - Mekanik Dump Truck', '0812-4000-0106'],
  ['CREW07', DEFAULT_PW, 'Arif Setiawan', 'crew', 'Crew B - Elektrikal Genset', '0812-4000-0107'],
  ['CREW08', DEFAULT_PW, 'Muh. Fadli', 'crew', 'Crew B - Fabrikasi', '0812-4000-0108'],
  ['CREW09', DEFAULT_PW, 'Irwan Saputra', 'crew', 'Crew B - Civil & GFM', '0812-4000-0109'],
  ['CREW10', DEFAULT_PW, 'Dedi Kurniawan', 'crew', 'Crew B - Tireman', '0812-4000-0110'],
  ['CREW11', DEFAULT_PW, 'Zulkifli Hasan', 'crew', 'Crew C - Mekanik Excavator', '0812-4000-0111'],
  ['CREW12', DEFAULT_PW, 'Rizky Maulana', 'crew', 'Crew C - Instrument & Radio', '0812-4000-0112'],
  ['CREW13', DEFAULT_PW, 'Agus Salim', 'crew', 'Crew C - Plumbing & Water', '0812-4000-0113'],
  ['CREW14', DEFAULT_PW, 'Heri Kusuma', 'crew', 'Crew C - Survey & Geologi', '0812-4000-0114'],
  ['CREW15', DEFAULT_PW, 'Fajar Nugroho', 'crew', 'Crew C - Welder / Las', '0812-4000-0115'],
  ['CREW16', DEFAULT_PW, 'Wahyu Hidayat', 'crew', 'Crew D - Facility Maintenance', '0812-4000-0116'],
  ['CREW17', DEFAULT_PW, 'Ruslan Abdul', 'crew', 'Crew D - AC & Pendingin', '0812-4000-0117'],
  ['CREW18', DEFAULT_PW, 'Ilham Jaya', 'crew', 'Crew D - Genset & Power', '0812-4000-0118'],
  ['CREW19', DEFAULT_PW, 'Taufik Akbar', 'crew', 'Crew D - Carpentry & Sipil', '0812-4000-0119'],
  ['CREW20', DEFAULT_PW, 'Nasrul Amin', 'crew', 'Crew D - HSE & Safety', '0812-4000-0120'],
];

const tools = [
  ['T-001', 'Kunci Pas Set Tekiro 8-24mm', 'Kunci & Hand Tool', 'Rak A-1'],
  ['T-002', 'Kunci Ring Ratchet 17-19mm', 'Kunci & Hand Tool', 'Rak A-1'],
  ['T-003', 'Kunci Inggris Heavy Duty 15"', 'Kunci & Hand Tool', 'Rak A-2'],
  ['T-004', 'Kunci Pipa (Pipe Wrench) 24"', 'Kunci & Hand Tool', 'Rak A-2'],
  ['T-005', 'Socket Set 1/2" 24 Pcs', 'Kunci & Hand Tool', 'Rak A-3'],
  ['T-006', 'Torque Wrench 40-200 Nm', 'Kunci & Hand Tool', 'Rak A-3'],
  ['T-007', 'Gerinda Tangan Makita 4" GA4030', 'Power Tool', 'Rak B-1'],
  ['T-008', 'Gerinda Potong Bosch 7"', 'Power Tool', 'Rak B-1'],
  ['T-009', 'Bor Listrik Impact Bosch GSB 16RE', 'Power Tool', 'Rak B-2'],
  ['T-010', 'Cordless Impact Wrench Dewalt 20V', 'Power Tool', 'Rak B-2'],
  ['T-011', 'Rotary Hammer Drill Makita HR2470', 'Power Tool', 'Rak B-3'],
  ['T-012', 'Mesin Las Inverter Lakoni 160A', 'Welding & Cutting', 'Rak C-1'],
  ['T-013', 'Palu Godam (Sledge Hammer) 5 Kg', 'Manual & Konstruksi', 'Rak C-2'],
  ['T-014', 'Linggis Baja 150 cm', 'Manual & Konstruksi', 'Rak C-2'],
  ['T-015', 'Dongkrak Botol Hidrolik 20 Ton', 'Lifting & Jack', 'Rak C-3'],
  ['T-016', 'Chain Block Takel 2 Ton x 5m', 'Lifting & Jack', 'Rak C-3'],
  ['T-017', 'Multimeter Digital Fluke 117', 'Alat Ukur & Elektrik', 'Lemari D-1'],
  ['T-018', 'Tang Ampere (Clamp Meter) Kyoritsu', 'Alat Ukur & Elektrik', 'Lemari D-1'],
  ['T-019', 'Laser Distance Meter 100m', 'Alat Ukur & Elektrik', 'Lemari D-2'],
  ['T-020', 'Multi Gas Detector Portable', 'Safety & Inspeksi', 'Lemari D-2'],
];

const materials = [
  ['M-001', 'Kawat Las / Elektroda Kobe RB-26 3.2mm', 'material', 'Consumable Las', 'Rak E-1', 'bagus', 25, 'Box'],
  ['M-002', 'Batu Gerinda Potong WD 4" x 1.2mm', 'material', 'Consumable Abrasive', 'Rak E-1', 'bagus', 100, 'Pcs'],
  ['M-003', 'Batu Gerinda Poles Kinik 4" x 6mm', 'material', 'Consumable Abrasive', 'Rak E-1', 'bagus', 50, 'Pcs'],
  ['M-004', 'Oli Hidrolik Shell Tellus S2 M46', 'material', 'Lubricant & Oli', 'Area Drum F-1', 'bagus', 200, 'Liter'],
  ['M-005', 'Grease / Gemuk Pertamini EP-2 Heavy Duty', 'material', 'Lubricant & Oli', 'Area Drum F-2', 'bagus', 15, 'Pail'],
  ['M-006', 'Baut & Mur High Tensile M16 x 50mm', 'material', 'Fastener & Baut', 'Rak E-2', 'bagus', 150, 'Set'],
  ['M-007', 'Isolasi Listrik 3M Vinyl Tape Hitam', 'material', 'Material Elektrik', 'Rak E-3', 'bagus', 40, 'Roll'],
  ['M-008', 'Majun Pembersih Katun Jahit', 'material', 'Housekeeping & Safety', 'Rak E-4', 'bagus', 30, 'Kg'],
];

export function seedDatabase({ reset = false } = {}) {
  tx(() => {
    if (reset) {
      db.exec('DELETE FROM transfers; DELETE FROM loans; DELETE FROM sessions; DELETE FROM users;');
      const uReset = db.prepare('INSERT INTO users (username, password_hash, name, role, dept, phone, active) VALUES (?, ?, ?, ?, ?, ?, 1)');
      users.forEach((r) => uReset.run(...r));
    } else {
      const u = db.prepare('INSERT OR IGNORE INTO users (username, password_hash, name, role, dept, phone) VALUES (?, ?, ?, ?, ?, ?)');
      users.forEach((r) => u.run(...r));
      // Migrasi otomatis akun yang masih memakai password default lama (123456) menjadi 1234
      db.prepare('UPDATE users SET password_hash = ? WHERE password_hash = ?')
        .run(DEFAULT_PW, hashPassword('123456'));
    }
    const t = db.prepare("INSERT OR IGNORE INTO tools (code, name, item_type, category, location, condition, quantity, unit) VALUES (?, ?, 'tool', ?, ?, 'bagus', 1, 'Unit')");
    tools.forEach((r) => t.run(...r));

    const m = db.prepare('INSERT OR IGNORE INTO tools (code, name, item_type, category, location, condition, quantity, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    materials.forEach((r) => m.run(...r));
  });
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const isReset = process.argv.includes('--reset');
  seedDatabase({ reset: isReset });
  console.log(`Database siap: 1 akun Admin (ADMIN) + 20 akun Crew (CREW01..CREW20) [Password awal: 1234] + ${tools.length} Tools + ${materials.length} Material.`);
}
