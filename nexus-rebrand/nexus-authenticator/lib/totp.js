// TOTP (RFC 6238) on top of WebCrypto.
import { base32Decode } from './base32.js';

const HASHES = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };
const keyCache = new Map();

async function hmacKey(secret, algorithm) {
  const id = `${algorithm}:${secret}`;
  let key = keyCache.get(id);
  if (!key) {
    const hash = HASHES[algorithm];
    if (!hash) throw new Error(`Unsupported algorithm ${algorithm}`);
    key = await crypto.subtle.importKey(
      'raw', base32Decode(secret), { name: 'HMAC', hash }, false, ['sign']
    );
    keyCache.set(id, key);
  }
  return key;
}

export async function generateCode(account, now = Date.now()) {
  const period = account.period || 30;
  const digits = account.digits || 6;
  const counter = Math.floor(now / 1000 / period);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await hmacKey(account.secret, account.algorithm || 'SHA1');
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const off = sig[sig.length - 1] & 0x0f;
  const bin =
    ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function secondsRemaining(account, now = Date.now()) {
  const period = account.period || 30;
  return period - ((now / 1000) % period);
}
