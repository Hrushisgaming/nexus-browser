// otpauth:// and otpauth-migration:// (Google Authenticator) parsing and building.
import { base32Decode, base32Encode, normalizeSecret } from './base32.js';

const te = new TextEncoder();
const td = new TextDecoder();

/* ---------- base64 ---------- */
export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
export function b64ToBytes(str) {
  let s = str.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- minimal protobuf ---------- */
class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  get done() { return this.pos >= this.buf.length; }
  varint() {
    let result = 0, shift = 0, b;
    do {
      if (this.pos >= this.buf.length) throw new Error('Truncated data');
      b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80 && shift < 70);
    return result;
  }
  bytes() {
    const len = this.varint();
    if (this.pos + len > this.buf.length) throw new Error('Truncated data');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error('Unsupported data format');
  }
}

function varintBytes(n) {
  const out = [];
  while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
const tag = (field, wire) => varintBytes((field << 3) | wire);
function lenField(field, bytes) {
  return [...tag(field, 2), ...varintBytes(bytes.length), ...bytes];
}
const intField = (field, n) => [...tag(field, 0), ...varintBytes(n)];

const ALG_FROM = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
const ALG_TO = { SHA1: 1, SHA256: 2, SHA512: 3 };

function parseOtpParameters(buf) {
  const r = new Reader(buf);
  const o = { secret: null, name: '', issuer: '', algorithm: 1, digits: 1, type: 2 };
  while (!r.done) {
    const t = r.varint();
    const field = Math.floor(t / 8), wire = t % 8;
    if (field === 1 && wire === 2) o.secret = r.bytes().slice();
    else if (field === 2 && wire === 2) o.name = td.decode(r.bytes());
    else if (field === 3 && wire === 2) o.issuer = td.decode(r.bytes());
    else if (field === 4 && wire === 0) o.algorithm = r.varint();
    else if (field === 5 && wire === 0) o.digits = r.varint();
    else if (field === 6 && wire === 0) o.type = r.varint();
    else r.skip(wire);
  }
  return o;
}

export function parseMigrationPayload(bytes) {
  const r = new Reader(bytes);
  const out = { entries: [], batchSize: 1, batchIndex: 0 };
  while (!r.done) {
    const t = r.varint();
    const field = Math.floor(t / 8), wire = t % 8;
    if (field === 1 && wire === 2) out.entries.push(parseOtpParameters(r.bytes()));
    else if (field === 3 && wire === 0) out.batchSize = r.varint() || 1;
    else if (field === 4 && wire === 0) out.batchIndex = r.varint();
    else r.skip(wire);
  }
  return out;
}

export function encodeMigrationPayload(accounts, batchSize, batchIndex, batchId) {
  const body = [];
  for (const a of accounts) {
    const label = a.issuer ? `${a.issuer}:${a.name}` : a.name;
    const otp = [
      ...lenField(1, base32Decode(a.secret)),
      ...lenField(2, te.encode(label)),
      ...lenField(3, te.encode(a.issuer || '')),
      ...intField(4, ALG_TO[a.algorithm || 'SHA1']),
      ...intField(5, (a.digits || 6) === 8 ? 2 : 1),
      ...intField(6, 2), // TOTP
    ];
    body.push(...lenField(1, otp));
  }
  body.push(...intField(2, 1)); // version
  body.push(...intField(3, batchSize));
  body.push(...intField(4, batchIndex));
  body.push(...intField(5, batchId));
  return Uint8Array.from(body);
}

/* ---------- accounts ---------- */
export function accountKey(a) {
  return [a.secret, (a.issuer || '').toLowerCase(), (a.name || '').toLowerCase()].join('|');
}

function makeAccount({ issuer, name, secret, algorithm = 'SHA1', digits = 6, period = 30 }) {
  return {
    id: crypto.randomUUID(),
    issuer: (issuer || '').trim(),
    name: (name || '').trim(),
    secret: normalizeSecret(secret),
    algorithm,
    digits: [6, 7, 8].includes(digits) ? digits : 6,
    period: period > 0 && period <= 300 ? period : 30,
  };
}
export { makeAccount };

function splitLabel(label, issuer) {
  let name = label;
  const i = label.indexOf(':');
  if (i >= 0) {
    const prefix = label.slice(0, i).trim();
    name = label.slice(i + 1).trim();
    if (!issuer) issuer = prefix;
  }
  return { issuer: issuer || '', name };
}

function parseOtpauth(uri, report) {
  const u = new URL(uri);
  const type = u.hostname.toLowerCase();
  if (type === 'hotp') { report.hotp++; return null; }
  if (type !== 'totp') throw new Error('Unsupported code type');
  const label = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const p = u.searchParams;
  const secret = p.get('secret');
  if (!secret) throw new Error('This link has no secret');
  const { issuer, name } = splitLabel(label, p.get('issuer'));
  const algorithm = (p.get('algorithm') || 'SHA1').toUpperCase().replace('-', '');
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) { report.unsupported++; return null; }
  return makeAccount({
    issuer, name, secret, algorithm,
    digits: parseInt(p.get('digits') || '6', 10),
    period: parseInt(p.get('period') || '30', 10),
  });
}

function parseMigrationUri(uri, report) {
  const u = new URL(uri);
  const data = u.searchParams.get('data');
  if (!data) throw new Error('This transfer link has no data');
  const payload = parseMigrationPayload(b64ToBytes(data));
  const accounts = [];
  for (const e of payload.entries) {
    if (e.type === 1) { report.hotp++; continue; }
    const algorithm = ALG_FROM[e.algorithm];
    if (!algorithm || algorithm === 'MD5' || !e.secret?.length) { report.unsupported++; continue; }
    const { issuer, name } = splitLabel(e.name, e.issuer);
    accounts.push(makeAccount({
      issuer, name, secret: base32Encode(e.secret), algorithm, digits: e.digits === 2 ? 8 : 6,
    }));
  }
  report.batch = { index: payload.batchIndex, size: payload.batchSize };
  return accounts;
}

/** Accepts otpauth://, otpauth-migration:// links (one or many) or a bare base32 secret. */
export function parseInput(text) {
  const report = { hotp: 0, unsupported: 0, batch: null };
  const links = text.match(/otpauth(?:-migration)?:\/\/[^\s"'<>]+/gi) || [];
  const accounts = [];
  if (links.length) {
    for (const link of links) {
      if (/^otpauth-migration:/i.test(link)) accounts.push(...parseMigrationUri(link, report));
      else { const a = parseOtpauth(link, report); if (a) accounts.push(a); }
    }
  } else {
    // bare secret
    accounts.push(makeAccount({ issuer: '', name: 'Imported account', secret: text }));
  }
  return { accounts, ...report };
}

/* ---------- export ---------- */
export function buildOtpauthUrl(a) {
  const label = (a.issuer ? `${encodeURIComponent(a.issuer)}:` : '') + encodeURIComponent(a.name);
  const q = new URLSearchParams({ secret: a.secret });
  if (a.issuer) q.set('issuer', a.issuer);
  q.set('algorithm', a.algorithm || 'SHA1');
  q.set('digits', String(a.digits || 6));
  q.set('period', String(a.period || 30));
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** Builds Google Authenticator transfer links, split into batches that fit one QR code each. */
export function buildMigrationUrls(accounts, perBatch = 7) {
  const usable = accounts.filter(
    (a) => ALG_TO[a.algorithm || 'SHA1'] && [6, 8].includes(a.digits || 6)
  );
  const warnings = [];
  const skipped = accounts.length - usable.length;
  if (skipped) warnings.push(`${skipped} account(s) use settings Google Authenticator doesn't support and were left out.`);
  if (usable.some((a) => (a.period || 30) !== 30)) {
    warnings.push("Some accounts use a period other than 30 seconds. Google Authenticator assumes 30 seconds, so their codes won't match.");
  }
  const batchId = Math.floor(Math.random() * 2 ** 31);
  const chunks = [];
  for (let i = 0; i < usable.length; i += perBatch) chunks.push(usable.slice(i, i + perBatch));
  const urls = chunks.map((chunk, i) => {
    const bytes = encodeMigrationPayload(chunk, chunks.length, i, batchId);
    return `otpauth-migration://offline?data=${encodeURIComponent(bytesToB64(bytes))}`;
  });
  return { urls, warnings };
}
