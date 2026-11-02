# ⛏️ GFM Gudang Alat — PT Sulawesi Cahaya Mineral

Sistem peminjaman, oper tangan (*handover*), dan pengembalian barang gudang berbasis **Login Akun HP + Scan QR Barang** untuk operasional lapangan **GFM (General Facility Management) — PT Sulawesi Cahaya Mineral**.

---

## 🔐 Sistem Akun & Aturan Main di Lapangan (100% Cukup Pakai HP)

Yang ditempeli stiker QR **hanya barang/alat gudang** (`T-001`, `T-002`, dst.). Setiap personel login di HP masing-masing:

| Peran | ID Login Bawaan | Password Awal | Fungsi di HP |
|---|---|---|---|
| **Penjaga Gudang (Admin)** | `ADMIN` | `123456` | Scan barang kembali, tambah barang baru & generate QR, kelola akun crew, stok opname, laporan |
| **20 Akun Crew Lapangan** | `CREW01` s/d `CREW20` | `123456` | Scan QR barang untuk meminjam, minta oper dari teman, setujui operan |

### 4 Aturan Otomatis Sistem:
1. **Pinjam Barang dari Gudang**: Crew login di HP → buka menu **📷 Scan & Alatku** → scan QR pada barang yang tersedia di gudang → barang langsung tercatat dipinjam atas nama akun Crew tersebut.
2. **Kunci Kepemilikan & Persetujuan Oper Tangan (*Handover*)**:
   - Jika **Barang X** sedang dipegang oleh **Crew A**, maka **Crew B tidak bisa mengambil/men-scan pinjam Barang X secara sepihak**.
   - Saat Crew B men-scan QR Barang X, sistem otomatis memblokir dan menampilkan tombol **🔄 Minta Persetujuan Oper dari Crew A**.
   - Di layar HP **Crew A**, langsung muncul notifikasi: *"Crew B meminta mengambil alih Barang X"*.
   - **Sebelum Crew A menekan `✅ Setujui Oper`, barang tidak bisa berpindah tangan.** Setelah disetujui, barulah tanggung jawab barang resmi berpindah ke Crew B.
3. **Pengembalian Wajib Di-Scan oleh Penjaga Gudang**:
   - Crew **tidak bisa** mengembalikan barang sendiri dari HP-nya (mencegah kecurangan scan dari lapangan).
   - Barang baru berstatus **SAH DIKEMBALIKAN KE GUDANG** apabila **Penjaga Gudang (`ADMIN`)** men-scan QR barang tersebut saat barang diserahkan kembali ke loket gudang.
4. **Tambah Barang Baru & Cara Generate QR Code**:
   - Penjaga Gudang membuka tab **🧰 Barang & QR** → isi form **➕ Tambah Barang Baru** (Nama Barang, Kategori, Lokasi Rak).
   - Sistem **otomatis membuat kode unik** (mis. `T-021`) beserta **QR Code**-nya detik itu juga!
   - Cara mengambil/mencetak QR:
     - **Unduh Stiker PNG ke HP**: Klik barang → tekan **⬇️ Unduh Stiker QR (.PNG)** (otomatis menghasilkan gambar stiker resolusi tinggi lengkap dengan logo GFM PT SCM, QR, Kode, Nama Barang, dan Lokasi Rak — siap kirim ke WhatsApp atau printer stiker Bluetooth/thermal).
     - **Cetak Lembar Stiker Kertas Vinyl/A4**: Tekan **🖨️ Cetak Stiker** (tersedia pilihan ukuran **Kecil 50×25mm**, **Sedang 66×32mm**, dan **Besar 85×42mm**).

---

## 🚀 Cara Memulai Sistem (Tinggal Klik 2x File `.bat`)

1. **[mulai-gudang.bat](file:///c:/Users/Pongo/Downloads/warehouse/mulai-gudang.bat)** — **Klik 2x untuk menyalakan server & membuka aplikasi di browser (`http://localhost:3050`).**
2. **[pasang-autostart-minipc.bat](file:///c:/Users/Pongo/Downloads/warehouse/pasang-autostart-minipc.bat)** — **Khusus di Mini PC Gudang (jalankan 1x saja)** agar server otomatis menyala setiap kali Mini PC dihidupkan (berjalan di Port 3050).
3. **[uninstall-autostart-minipc.bat](file:///c:/Users/Pongo/Downloads/warehouse/uninstall-autostart-minipc.bat)** — **Klik 2x untuk menghapus auto-start dan membebaskan Port 3000** agar sistem lain (seperti monitoring WTP/WWTP) dapat berjalan tanpa bentrok.
4. **[stop-gudang.bat](file:///c:/Users/Pongo/Downloads/warehouse/stop-gudang.bat)** — Klik 2x jika ingin menghentikan server yang sedang berjalan.

---

## 📱 Cara Scan QR dari HP Crew & Penjaga Gudang
Ada **2 tombol scan** di layar utama HP:
- **📸 Foto QR**: Langsung membuka kamera HP dan membaca stiker QR — **bisa langsung dipakai di semua HP melalui WiFi (`http://<IP-Mini-PC>:3050`) tanpa perlu pasang sertifikat apa pun**.
- **📷 Scan Kamera Live**: Membuka kamera video *real-time* (akses melalui `https://<IP-Mini-PC>:3450` setelah 1x pasang sertifikat di halaman `/setup`).
