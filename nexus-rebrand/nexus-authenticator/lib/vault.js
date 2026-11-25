// Encrypted storage. Accounts are encrypted with AES-GCM using a key derived from
// the master password (PBKDF2-SHA256). Nothing readable is ever written to disk.
const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 600000;
const VAULT_KEY = 'vault';
const SETTINGS_KEY = 'settings';
const SESSION_KEY = 'session';
const LOCK_ALARM = 'auto-lock';

const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
}

async function seal(accounts, key, kdf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify({ accounts })));
  return { v: 1, kdf: { name: 'PBKDF2-SHA256', salt: toB64(kdf.salt), iter: kdf.iter }, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

async function openWithKey(blob, key) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
    return JSON.parse(dec.decode(pt)).accounts;
  } catch {
    throw new Error('Wrong password, or the data is damaged');
  }
}

async function openWithPassword(blob, password) {
  if (!blob || blob.v !== 1 || !blob.kdf) throw new Error('This file is not a Nexus Authenticator backup');
  const key = await deriveKey(password, fromB64(blob.kdf.salt), blob.kdf.iter);
  return { key, accounts: await openWithKey(blob, key) };
}

async function readBlob() {
  return (await chrome.storage.local.get(VAULT_KEY))[VAULT_KEY] || null;
}

export async function hasVault() { return !!(await readBlob()); }

export async function createVault(password) {
  const kdf = { salt: crypto.getRandomValues(new Uint8Array(16)), iter: ITERATIONS };
  const key = await deriveKey(password, kdf.salt, kdf.iter);
  await chrome.storage.local.set({ [VAULT_KEY]: await seal([], key, kdf) });
  return key;
}

export async function unlockVault(password) {
  const blob = await readBlob();
  if (!blob) throw new Error('No vault found');
  return openWithPassword(blob, password);
}

export async function unlockWithKey(key) {
  const blob = await readBlob();
  return openWithKey(blob, key);
}

export async function verifyPassword(password) {
  await unlockVault(password);
}

export async function saveAccounts(accounts, key) {
  const blob = await readBlob();
  await chrome.storage.local.set({
    [VAULT_KEY]: await seal(accounts, key, { salt: fromB64(blob.kdf.salt), iter: blob.kdf.iter }),
  });
}

export async function changePassword(accounts, newPassword) {
  const kdf = { salt: crypto.getRandomValues(new Uint8Array(16)), iter: ITERATIONS };
  const key = await deriveKey(newPassword, kdf.salt, kdf.iter);
  await chrome.storage.local.set({ [VAULT_KEY]: await seal(accounts, key, kdf) });
  return key;
}

export async function resetVault() {
  await chrome.storage.local.remove(VAULT_KEY);
  await clearSession();
}

/* ---- backups: same encrypted format, protected by a password of the user's choice ---- */
export async function exportBackup(accounts, password) {
  const kdf = { salt: crypto.getRandomValues(new Uint8Array(16)), iter: ITERATIONS };
  const key = await deriveKey(password, kdf.salt, kdf.iter);
  return JSON.stringify({ app: 'nexus-authenticator', ...(await seal(accounts, key, kdf)) }, null, 2);
}

export async function importBackup(jsonText, password) {
  let blob;
  try { blob = JSON.parse(jsonText); } catch { throw new Error('This file is not a Nexus Authenticator backup'); }
  return (await openWithPassword(blob, password)).accounts;
}

/* ---- settings ---- */
export async function getSettings() {
  const s = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  return { autoLockMinutes: 5, ...s };
}
export async function saveSettings(s) { await chrome.storage.local.set({ [SETTINGS_KEY]: s }); }

/* ---- session: the unlocked key lives in memory-only storage until auto-lock ---- */
export async function storeSession(key, minutes) {
  await clearSession();
  if (!minutes) return; // lock as soon as the popup closes
  const jwk = await crypto.subtle.exportKey('jwk', key);
  await chrome.storage.session.set({ [SESSION_KEY]: { jwk, until: Date.now() + minutes * 60000 } });
  chrome.alarms.create(LOCK_ALARM, { delayInMinutes: minutes });
}

export async function loadSession() {
  const s = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  if (!s) return null;
  if (s.until < Date.now()) { await clearSession(); return null; }
  return crypto.subtle.importKey('jwk', s.jwk, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export async function clearSession() {
  await chrome.storage.session.remove(SESSION_KEY);
  chrome.alarms.clear(LOCK_ALARM);
}
