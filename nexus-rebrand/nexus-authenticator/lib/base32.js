// RFC 4648 base32 (the alphabet used by TOTP secrets).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const clean = String(input).replace(/[\s=-]/g, '').toUpperCase();
  if (!clean) throw new Error('Secret is empty');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Secret must only contain letters A-Z and digits 2-7');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  if (!out.length) throw new Error('Secret is too short');
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function normalizeSecret(input) {
  const s = String(input).replace(/[\s=-]/g, '').toUpperCase();
  base32Decode(s); // throws if invalid
  return s;
}
