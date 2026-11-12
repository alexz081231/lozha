// Самоподписанный сертификат для `npm run https`: свой маленький центр сертификации + сертификат сервера.
// Написано на чистом Node (DER/X.509 вручную), без openssl и внешних пакетов.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DIRS, lanAddresses } from './config.js';

const cat = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...content) => { const body = cat(...content); return cat([tag], len(body.length), body); };
const seq = (...c) => tlv(0x30, ...c);
const set = (...c) => tlv(0x31, ...c);
const int = (bytes) => {
  let b = Buffer.from(bytes);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = cat([0], b);
  return tlv(0x02, b);
};
const oid = (s) => {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (let v of p.slice(2)) {
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bitstr = (b, unused = 0) => tlv(0x03, [unused], b);
const octet = (b) => tlv(0x04, b);
const bool = (v) => tlv(0x01, [v ? 0xff : 0]);
const utc = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'ascii'));
};
const ctx = (n, ...c) => tlv(0xa0 | n, ...c);
const dn = (cn) => seq(set(seq(oid('2.5.4.10'), utf8('Lozha'))), set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octet(value));
const ALG = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256

const pem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
const keyId = (publicKey) => crypto.createHash('sha1').update(publicKey.export({ type: 'spki', format: 'der' })).digest();

function makeCert({ subject, issuer, publicKey, signKey, days, extensions }) {
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const from = new Date(Date.now() - 24 * 3600e3);
  const to = new Date(Date.now() + days * 86400e3);
  const tbs = seq(
    ctx(0, int([2])), int(serial), ALG, dn(issuer), seq(utc(from), utc(to)), dn(subject),
    publicKey.export({ type: 'spki', format: 'der' }), ctx(3, seq(...extensions)),
  );
  const sig = crypto.sign('sha256', tbs, signKey);
  return pem(seq(tbs, ALG, bitstr(sig)));
}

function ipBytes(ip) {
  if (ip.includes(':')) {
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    return Buffer.from(groups.flatMap((g) => { const v = parseInt(g, 16); return [v >> 8, v & 255]; }));
  }
  return Buffer.from(ip.split('.').map(Number));
}

function hostNames() {
  const names = new Set(['localhost']);
  const h = os.hostname();
  if (/^[a-z0-9.-]+$/i.test(h)) { names.add(h); if (!h.includes('.')) names.add(`${h}.local`); }
  return [...names];
}

export function ensureCert() {
  const f = (n) => path.join(DIRS.certs, n);
  const ips = ['127.0.0.1', '::1', ...lanAddresses()];
  const names = hostNames();
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(f('meta.json'), 'utf8')); } catch {}
  const now = Date.now();
  const fresh = meta && meta.leafUntil - now > 20 * 86400e3 && meta.caUntil - now > 60 * 86400e3
    && ips.every((ip) => meta.ips.includes(ip)) && ['ca.crt', 'ca.key', 'server.crt', 'server.key'].every((n) => fs.existsSync(f(n)));
  if (fresh) return { key: fs.readFileSync(f('server.key')), cert: fs.readFileSync(f('server.crt')), ca: f('ca.crt'), created: false };

  // Центр сертификации переиспользуем, если он ещё живой: тогда установленное на телефон доверие сохраняется.
  let caKey, caCert, caUntil;
  if (meta && meta.caUntil - now > 60 * 86400e3 && fs.existsSync(f('ca.key')) && fs.existsSync(f('ca.crt'))) {
    caKey = crypto.createPrivateKey(fs.readFileSync(f('ca.key')));
    caCert = fs.readFileSync(f('ca.crt'), 'utf8');
    caUntil = meta.caUntil;
  } else {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    caKey = pair.privateKey;
    caCert = makeCert({
      subject: 'Lozha Local CA', issuer: 'Lozha Local CA', publicKey: pair.publicKey, signKey: caKey, days: 3650,
      extensions: [
        ext('2.5.29.19', true, seq(bool(true), int([0]))),
        ext('2.5.29.15', true, bitstr(Buffer.from([0x86]), 1)),
        ext('2.5.29.14', false, octet(keyId(pair.publicKey))),
      ],
    });
    caUntil = now + 3650 * 86400e3;
    fs.writeFileSync(f('ca.key'), caKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(f('ca.crt'), caCert);
  }
  const caPub = crypto.createPublicKey(caKey);
  const leaf = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const san = seq(...names.map((n) => tlv(0x82, Buffer.from(n, 'ascii'))), ...ips.map((ip) => tlv(0x87, ipBytes(ip))));
  const leafCert = makeCert({
    subject: 'Lozha', issuer: 'Lozha Local CA', publicKey: leaf.publicKey, signKey: caKey, days: 397,
    extensions: [
      ext('2.5.29.19', true, seq()),
      ext('2.5.29.15', true, bitstr(Buffer.from([0x80]), 7)),
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      ext('2.5.29.17', false, san),
      ext('2.5.29.14', false, octet(keyId(leaf.publicKey))),
      ext('2.5.29.35', false, seq(tlv(0x80, keyId(caPub)))),
    ],
  });
  const chain = leafCert + caCert;
  const keyPem = leaf.privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(f('server.key'), keyPem, { mode: 0o600 });
  fs.writeFileSync(f('server.crt'), chain);
  fs.writeFileSync(f('meta.json'), JSON.stringify({ ips, names, leafUntil: now + 397 * 86400e3, caUntil }));
  return { key: Buffer.from(keyPem), cert: Buffer.from(chain), ca: f('ca.crt'), created: true };
}
