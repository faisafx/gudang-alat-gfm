// Sertifikat HTTPS lokal untuk jaringan gudang (LAN), supaya kamera HP/tablet bisa dipakai.
// - Membuat CA lokal SEKALI (dipasang di tiap HP/tablet satu kali saja).
// - Sertifikat server dibuat ulang otomatis jika IP mini PC berubah / hampir kedaluwarsa,
//   tanpa perlu memasang ulang CA di perangkat.
import forge from 'node-forge';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { pki, md } = forge;

export function localIPv4() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => i.address);
}

function serial() {
  return '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
}

function createCA() {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400_000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400_000);
  const attrs = [{ name: 'commonName', value: `Gudang Alat Local CA (${os.hostname()})` }, { name: 'organizationName', value: 'Gudang Alat' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, md.sha256.create());
  return { cert, key: keys.privateKey };
}

function createServerCert(ca, ips, hostnames) {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400_000);
  cert.validity.notAfter = new Date(Date.now() + 800 * 86400_000); // < 825 hari (batas Apple/Android)
  cert.setSubject([{ name: 'commonName', value: ips[0] || hostnames[0] }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [
      ...hostnames.map((h) => ({ type: 2, value: h })),
      ...ips.map((ip) => ({ type: 7, ip })),
    ] },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(ca.key, md.sha256.create());
  return { cert, key: keys.privateKey };
}

/** Pastikan CA & sertifikat server ada dan cocok dengan IP saat ini. */
export function ensureCerts(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  let ca;
  if (fs.existsSync(f('ca.key')) && fs.existsSync(f('ca.crt'))) {
    ca = { cert: pki.certificateFromPem(fs.readFileSync(f('ca.crt'), 'utf8')), key: pki.privateKeyFromPem(fs.readFileSync(f('ca.key'), 'utf8')) };
  } else {
    console.log('[cert] Membuat CA lokal baru…');
    ca = createCA();
    fs.writeFileSync(f('ca.key'), pki.privateKeyToPem(ca.key), { mode: 0o600 });
    fs.writeFileSync(f('ca.crt'), pki.certificateToPem(ca.cert));
  }
  if (!fs.existsSync(f('ca.cer'))) {
    // versi DER (.cer) — sebagian Android lebih mudah memasang format ini
    fs.writeFileSync(f('ca.cer'), Buffer.from(forge.asn1.toDer(pki.certificateToAsn1(ca.cert)).getBytes(), 'binary'));
  }

  const ips = [...new Set([...localIPv4(), '127.0.0.1'])];
  const host = os.hostname().toLowerCase();
  const hostnames = [...new Set(['localhost', host, `${host}.local`, ...(process.env.EXTRA_HOSTNAMES || '').split(',').map((s) => s.trim()).filter(Boolean)])];

  let needNew = true;
  if (fs.existsSync(f('server.crt')) && fs.existsSync(f('server.key'))) {
    try {
      const cur = pki.certificateFromPem(fs.readFileSync(f('server.crt'), 'utf8'));
      const san = cur.getExtension('subjectAltName')?.altNames || [];
      const have = new Set(san.map((a) => a.ip || a.value));
      const fresh = cur.validity.notAfter.getTime() - Date.now() > 30 * 86400_000;
      const signedByCA = ca.cert.verify(cur);
      needNew = !(fresh && signedByCA && ips.every((ip) => have.has(ip)) && hostnames.every((h) => have.has(h)));
    } catch { needNew = true; }
  }
  if (needNew) {
    console.log(`[cert] Membuat sertifikat server untuk: ${[...ips, ...hostnames].join(', ')}`);
    const s = createServerCert(ca, ips, hostnames);
    fs.writeFileSync(f('server.key'), pki.privateKeyToPem(s.key), { mode: 0o600 });
    fs.writeFileSync(f('server.crt'), pki.certificateToPem(s.cert) + pki.certificateToPem(ca.cert));
  }
  return { key: fs.readFileSync(f('server.key')), cert: fs.readFileSync(f('server.crt')), caPath: f('ca.crt'), caDerPath: f('ca.cer'), ips, hostnames, changed: needNew };
}
