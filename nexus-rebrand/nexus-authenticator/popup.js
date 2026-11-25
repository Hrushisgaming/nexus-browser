import { generateCode, secondsRemaining } from './lib/totp.js';
import { parseInput, makeAccount, accountKey, buildMigrationUrls, buildOtpauthUrl } from './lib/otp-uri.js';
import * as vault from './lib/vault.js';

const app = document.getElementById('app');
const state = { accounts: [], key: null, settings: { autoLockMinutes: 5 }, view: 'loading', addTab: 'scan', ticker: null, qrTimer: null };

/* ---------- tiny DOM helpers (all user text goes through textContent) ---------- */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else if (/^on[A-Z]/.test(k)) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  export: '<path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
};
function icon(name) {
  const w = document.createElement('span');
  w.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return w.firstChild;
}
function iconBtn(name, label, onClick) {
  return h('button', { class: 'icon-btn', title: label, 'aria-label': label, type: 'button', onClick }, icon(name));
}

let toastTimer;
function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), bad ? 4200 : 2400);
}

function modal({ title, body, actions }) {
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const bar = h('div', { class: 'actions' }, actions.map((a) =>
    h('button', {
      class: 'btn' + (a.kind ? ' ' + a.kind : ''), type: 'button',
      onClick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try { if ((await a.run?.(close)) !== false) close(); } finally { btn.disabled = false; }
      },
    }, a.label)));
  const scrim = h('div', { class: 'scrim' }, h('div', { class: 'modal', role: 'dialog', 'aria-label': title }, h('h2', { text: title }), body, bar));
  document.body.append(scrim);
  document.addEventListener('keydown', onKey, true);
  scrim.querySelector('input')?.focus();
  return close;
}

function show(...nodes) {
  clearInterval(state.ticker); clearInterval(state.qrTimer);
  app.replaceChildren(...nodes);
}

function header(title, { back, tools = [] } = {}) {
  return h('div', { class: 'top' },
    back ? iconBtn('back', 'Back', back) : h('img', { class: 'logo', src: 'icons/icon32.png', alt: '' }),
    h('h1', { text: title }), ...tools);
}

const formatCode = (c) => (c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : `${c.slice(0, 3)} ${c.slice(3)}`);
const labelOf = (a) => [a.issuer, a.name].filter(Boolean).join(' · ') || 'Account';

/* ---------- accounts ---------- */
async function addAccounts(list) {
  const seen = new Set(state.accounts.map(accountKey));
  let added = 0, dupes = 0;
  for (const a of list) {
    const k = accountKey(a);
    if (seen.has(k)) { dupes++; continue; }
    seen.add(k); state.accounts.push(a); added++;
  }
  if (added) await vault.saveAccounts(state.accounts, state.key);
  return { added, dupes };
}

async function importText(text) {
  let res;
  try { res = parseInput(text); } catch (e) { toast(e.message || "That isn't a valid code", true); return false; }
  if (!res.accounts.length) {
    toast(res.hotp ? 'Counter-based (HOTP) codes are not supported.' : 'No usable accounts found.', true);
    return false;
  }
  const { added, dupes } = await addAccounts(res.accounts);
  const bits = [added ? `Added ${added} account${added === 1 ? '' : 's'}` : 'Nothing new to add'];
  if (dupes) bits.push(`${dupes} already saved`);
  if (res.hotp) bits.push(`${res.hotp} counter-based skipped`);
  if (res.batch && res.batch.size > 1) bits.push(`batch ${res.batch.index + 1} of ${res.batch.size}`);
  toast(bits.join(', '));
  return true;
}

async function decodeImageBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const long = Math.max(bmp.width, bmp.height);
  const base = Math.min(1, 2000 / long);
  for (const scale of [base, base / 2, Math.min(base * 2, 2400 / long)]) {
    const w = Math.max(21, Math.round(bmp.width * scale)), hgt = Math.max(21, Math.round(bmp.height * scale));
    const pad = 24;
    const c = document.createElement('canvas');
    c.width = w + pad * 2; c.height = hgt + pad * 2;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, pad, pad, w, hgt);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const code = window.jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
    if (code?.data) return code.data;
  }
  return null;
}

async function consumePending() {
  const { pendingScan } = await chrome.storage.session.get('pendingScan');
  if (!pendingScan) return false;
  await chrome.storage.session.remove('pendingScan');
  chrome.action.setBadgeText({ text: '' });
  if (Date.now() - pendingScan.at > 10 * 60000) return false;
  if (pendingScan.error) { toast(pendingScan.error, true); return false; }
  return importText(pendingScan.text);
}

/* ---------- password gate ---------- */
function askPassword({ title, text, confirmLabel = 'Continue', run }) {
  const input = h('input', { type: 'password', placeholder: 'Master password', autocomplete: 'current-password' });
  const err = h('div', { class: 'error' });
  const body = h('div', {}, text && h('p', { class: 'muted small', text }), input, err);
  const go = async (close) => {
    try { await vault.verifyPassword(input.value); } catch (e) { err.textContent = e.message; return false; }
    close(); await run(); return false;
  };
  const close = modal({ title, body, actions: [{ label: 'Cancel' }, { label: confirmLabel, kind: 'primary', run: go }] });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(close); } });
}

/* ---------- views ---------- */
function setupView() {
  state.view = 'setup';
  const p1 = h('input', { type: 'password', placeholder: 'Master password (8+ characters)', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', placeholder: 'Repeat password', autocomplete: 'new-password' });
  const err = h('div', { class: 'error' });
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    if (p1.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    if (p1.value !== p2.value) { err.textContent = "The passwords don't match."; return; }
    err.textContent = 'Creating vault…';
    state.key = await vault.createVault(p1.value);
    state.accounts = [];
    await vault.storeSession(state.key, state.settings.autoLockMinutes);
    listView();
  } }, p1, p2, err, h('button', { class: 'btn primary block', type: 'submit', text: 'Create vault' }));
  show(h('div', { class: 'body center' },
    h('img', { class: 'logo', src: 'icons/icon128.png', alt: '', style: 'width:48px;height:48px;border-radius:12px' }),
    h('h2', { text: 'Create your vault' }),
    h('p', { class: 'muted', text: 'Your master password encrypts every account on this device. It can’t be recovered. If you forget it, the only option is to wipe the vault and re-import your accounts.' }),
    form));
  p1.focus();
}

async function lockedView() {
  state.view = 'locked';
  const { pendingScan } = await chrome.storage.session.get('pendingScan');
  const input = h('input', { type: 'password', placeholder: 'Master password', autocomplete: 'current-password' });
  const err = h('div', { class: 'error' });
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    err.textContent = 'Unlocking…';
    try {
      const { key, accounts } = await vault.unlockVault(input.value);
      await afterUnlock(key, accounts);
    } catch (e2) { err.textContent = e2.message; input.select(); }
  } }, input, err, h('button', { class: 'btn primary block', type: 'submit', text: 'Unlock' }));
  show(h('div', { class: 'body center' },
    h('img', { class: 'logo', src: 'icons/icon128.png', alt: '', style: 'width:48px;height:48px;border-radius:12px' }),
    h('h2', { text: 'Nexus Authenticator' }),
    pendingScan && !pendingScan.error && h('div', { class: 'notice', text: 'A scanned QR code is waiting. Unlock to add it.' }),
    form,
    h('button', { class: 'link', type: 'button', text: 'Forgot password? Wipe the vault', onClick: () => modal({
      title: 'Wipe the vault?',
      body: h('p', { class: 'muted', text: 'This deletes every saved account from this browser. You’ll need to re-import them from Google Authenticator or a backup.' }),
      actions: [{ label: 'Cancel' }, { label: 'Wipe vault', kind: 'danger', run: async () => { await vault.resetVault(); state.accounts = []; setupView(); } }],
    }) })));
  input.focus();
}

async function afterUnlock(key, accounts) {
  state.key = key; state.accounts = accounts;
  state.settings = await vault.getSettings();
  await vault.storeSession(key, state.settings.autoLockMinutes);
  await consumePending();
  listView();
}

async function lockNow() {
  await vault.clearSession();
  state.key = null; state.accounts = [];
  lockedView();
}

function ringEl() {
  const C = 2 * Math.PI * 11;
  const w = document.createElement('span');
  w.innerHTML = `<svg class="ring" viewBox="0 0 28 28" aria-hidden="true"><circle class="track" cx="14" cy="14" r="11"/><circle class="prog" cx="14" cy="14" r="11" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg>`;
  const svg = w.firstChild;
  return { el: svg, prog: svg.querySelector('.prog'), C };
}

function listView() {
  state.view = 'list';
  const rows = [];
  const list = h('div');
  for (const a of state.accounts) {
    const ring = ringEl();
    const codeEl = h('div', { class: 'code', text: '••• •••' });
    const row = { a, codeEl, ring, code: '', counter: null };
    const copy = async () => {
      if (!row.code) return;
      await navigator.clipboard.writeText(row.code);
      toast(`Copied code for ${a.issuer || a.name || 'account'}`);
    };
    row.el = h('div', { class: 'acct', tabindex: '0', role: 'button', 'aria-label': `Copy code for ${labelOf(a)}`,
      onClick: copy, onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); } } },
      h('div', { class: 'meta' },
        h('div', { class: 'issuer', text: a.issuer || a.name || 'Account' }),
        a.issuer && h('div', { class: 'name', text: a.name }),
        codeEl),
      ring.el,
      h('div', { class: 'tools' },
        iconBtn('pencil', 'Edit', (e) => { e.stopPropagation(); editAccount(a); }),
        iconBtn('trash', 'Remove', (e) => { e.stopPropagation(); removeAccount(a); })));
    rows.push(row); list.append(row.el);
  }

  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search accounts', 'aria-label': 'Search accounts',
    onInput: (e) => {
      const q = e.target.value.trim().toLowerCase();
      rows.forEach((r) => { r.el.hidden = q && !labelOf(r.a).toLowerCase().includes(q); });
    } });

  const empty = h('div', { class: 'empty' },
    h('h2', { text: 'No accounts yet' }),
    h('p', { class: 'muted', text: 'Scan a QR code from the page, or import your accounts from Google Authenticator.' }),
    h('button', { class: 'btn primary', type: 'button', text: 'Add account', onClick: () => addView('scan') }));

  show(
    header('Nexus Authenticator', { tools: [
      iconBtn('plus', 'Add account', () => addView()),
      iconBtn('export', 'Export', exportView),
      iconBtn('gear', 'Settings', settingsView),
      iconBtn('lock', 'Lock', lockNow),
    ] }),
    h('div', { class: 'body' }, state.accounts.length > 4 && search, state.accounts.length ? list : empty));

  const tick = async () => {
    const now = Date.now();
    for (const r of rows) {
      const period = r.a.period || 30;
      const rem = secondsRemaining(r.a, now);
      r.ring.prog.style.strokeDashoffset = String(r.ring.C * (1 - rem / period));
      r.el.classList.toggle('expiring', rem <= 5);
      const counter = Math.floor(now / 1000 / period);
      if (r.counter !== counter) {
        r.counter = counter;
        try { r.code = await generateCode(r.a, now); r.codeEl.textContent = formatCode(r.code); }
        catch { r.codeEl.textContent = 'Invalid secret'; }
      }
    }
  };
  tick();
  if (rows.length) state.ticker = setInterval(tick, 250);
}

function editAccount(a) {
  const issuer = h('input', { type: 'text', value: a.issuer, placeholder: 'Service, e.g. GitHub' });
  const name = h('input', { type: 'text', value: a.name, placeholder: 'Account, e.g. you@example.com' });
  modal({
    title: 'Edit account',
    body: h('div', {}, h('label', {}, h('span', { text: 'Service' }), issuer), h('label', {}, h('span', { text: 'Account' }), name)),
    actions: [{ label: 'Cancel' }, { label: 'Save changes', kind: 'primary', run: async () => {
      a.issuer = issuer.value.trim(); a.name = name.value.trim();
      await vault.saveAccounts(state.accounts, state.key); listView();
    } }],
  });
}

function removeAccount(a) {
  modal({
    title: `Remove ${a.issuer || a.name || 'account'}?`,
    body: h('p', { class: 'muted', text: 'Make sure you can still sign in to this account some other way (another device or its recovery codes) before removing it.' }),
    actions: [{ label: 'Cancel' }, { label: 'Remove account', kind: 'danger', run: async () => {
      state.accounts = state.accounts.filter((x) => x.id !== a.id);
      await vault.saveAccounts(state.accounts, state.key); listView();
    } }],
  });
}

/* ---------- add account ---------- */
function addView(tab) {
  state.view = 'add';
  if (tab) state.addTab = tab;
  const tabs = [['scan', 'Scan screen'], ['image', 'Image'], ['link', 'Link / key'], ['manual', 'Manual']];
  const panel = h('div');
  const bar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) =>
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(id === state.addTab), text: label,
      onClick: () => { state.addTab = id; addView(); } })));
  show(header('Add account', { back: listView }), h('div', { class: 'body' }, bar, panel));
  panel.append(({ scan: scanTab, image: imageTab, link: linkTab, manual: manualTab })[state.addTab]());
}

async function done(ok) { if (ok) listView(); }

function scanTab() {
  const err = h('div', { class: 'error' });
  const send = async (type) => {
    err.textContent = '';
    const res = await chrome.runtime.sendMessage({ type });
    if (!res?.ok) { err.textContent = res?.error || 'Could not scan this page.'; return; }
    if (type === 'start-region-scan') window.close();
    else done(await consumePending());
  };
  return h('div', { class: 'stack' },
    h('p', { class: 'muted', text: 'Show the QR code in the tab you were just viewing, then drag a box around it.' }),
    h('button', { class: 'btn primary block', type: 'button', text: 'Select area on page', onClick: () => send('start-region-scan') }),
    h('button', { class: 'btn block', type: 'button', text: 'Scan the whole visible page', onClick: () => send('scan-visible') }),
    err,
    h('p', { class: 'muted small', text: 'Shortcut: Alt+Shift+Q on any page (you can change it on your browser’s extension shortcuts page). Browser pages such as settings and the new tab page can’t be captured, so use the Image tab for those.' }));
}

function imageTab() {
  const err = h('div', { class: 'error' });
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const handle = async (blob) => {
    err.textContent = 'Reading image…';
    try {
      const text = await decodeImageBlob(blob);
      if (!text) { err.textContent = 'No QR code found in that image. Try a sharper or larger one.'; return; }
      err.textContent = '';
      done(await importText(text));
    } catch { err.textContent = 'That file could not be read as an image.'; }
  };
  const zone = h('div', { class: 'drop', tabindex: '0', role: 'button',
    onClick: () => file.click(), onKeydown: (e) => { if (e.key === 'Enter') file.click(); },
    onDragover: (e) => { e.preventDefault(); zone.classList.add('over'); },
    onDragleave: () => zone.classList.remove('over'),
    onDrop: (e) => { e.preventDefault(); zone.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) handle(f); } },
    h('strong', { text: 'Drop a QR image here' }),
    h('span', { class: 'small', text: 'or click to choose a file, or paste with ⌘V / Ctrl+V' }));
  file.addEventListener('change', () => { if (file.files[0]) handle(file.files[0]); });
  return h('div', { class: 'stack' }, zone, file, err,
    h('p', { class: 'muted small', text: 'Works with screenshots and photos. Google Authenticator export codes are fine too: each QR holds up to 7 accounts.' }));
}

function linkTab() {
  const ta = h('textarea', { placeholder: 'otpauth://totp/…  or  otpauth-migration://offline?data=…  or a setup key' });
  const err = h('div', { class: 'error' });
  return h('div', { class: 'stack' },
    h('p', { class: 'muted', text: 'Paste one or more setup links, a Google Authenticator transfer link, or a plain secret key.' }),
    ta,
    h('button', { class: 'btn primary block', type: 'button', text: 'Import', onClick: async () => {
      if (!ta.value.trim()) { err.textContent = 'Paste something to import.'; return; }
      done(await importText(ta.value));
    } }), err);
}

function manualTab() {
  const issuer = h('input', { type: 'text', placeholder: 'Service, e.g. GitHub' });
  const name = h('input', { type: 'text', placeholder: 'Account, e.g. you@example.com' });
  const secret = h('input', { type: 'text', placeholder: 'Setup key, e.g. JBSW Y3DP EHPK 3PXP', autocomplete: 'off', spellcheck: 'false' });
  const alg = h('select', {}, ['SHA1', 'SHA256', 'SHA512'].map((x) => h('option', { value: x, text: x })));
  const digits = h('select', {}, [6, 7, 8].map((x) => h('option', { value: x, text: `${x} digits` })));
  const period = h('input', { type: 'text', value: '30', inputmode: 'numeric' });
  const err = h('div', { class: 'error' });
  return h('div', {},
    h('label', {}, h('span', { text: 'Service' }), issuer),
    h('label', {}, h('span', { text: 'Account' }), name),
    h('label', {}, h('span', { text: 'Setup key' }), secret),
    h('details', { class: 'muted small', style: 'margin-bottom:10px' }, h('summary', { text: 'Advanced' }),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('label', {}, h('span', { text: 'Algorithm' }), alg), h('label', {}, h('span', { text: 'Digits' }), digits), h('label', {}, h('span', { text: 'Period (s)' }), period))),
    h('button', { class: 'btn primary block', type: 'button', text: 'Add account', onClick: async () => {
      try {
        const a = makeAccount({ issuer: issuer.value, name: name.value || 'Account', secret: secret.value, algorithm: alg.value, digits: +digits.value, period: parseInt(period.value, 10) || 30 });
        const { dupes } = await addAccounts([a]);
        if (dupes) { err.textContent = 'You already have this account.'; return; }
        toast('Account added'); listView();
      } catch (e) { err.textContent = e.message; }
    } }), err);
}

/* ---------- export ---------- */
function drawQr(canvas, text) {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const qr = qrcode(0, 'L'); qr.addData(text, 'Byte'); qr.make();
  const n = qr.getModuleCount(), quiet = 4, cells = n + quiet * 2;
  const scale = Math.max(2, Math.floor(520 / cells));
  canvas.width = canvas.height = cells * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
}

function qrScreen({ title, urls, warnings = [], hint }) {
  state.view = 'qr';
  let i = 0, left = 60;
  const canvas = h('canvas', { 'aria-label': 'QR code' });
  const label = h('span', { class: 'muted' });
  const timer = h('p', { class: 'muted small' });
  const render = () => {
    try { drawQr(canvas, urls[i]); } catch { toast('That QR code is too large to draw.', true); exportView(); return; }
    label.textContent = urls.length > 1 ? `Batch ${i + 1} of ${urls.length}` : '';
    prev.disabled = i === 0; next.disabled = i === urls.length - 1;
  };
  const prev = h('button', { class: 'btn', type: 'button', text: 'Previous', onClick: () => { i--; render(); } });
  const next = h('button', { class: 'btn', type: 'button', text: 'Next batch', onClick: () => { i++; render(); } });
  show(header(title, { back: exportView }), h('div', { class: 'body' },
    warnings.map((w) => h('div', { class: 'notice', text: w })),
    urls.length > 1 && h('div', { class: 'pager' }, prev, label, next),
    h('div', { class: 'qrbox' }, canvas),
    h('p', { class: 'muted small', text: hint }),
    timer,
    h('button', { class: 'btn block', type: 'button', text: 'Done', onClick: exportView })));
  render();
  const tickTimer = () => { timer.textContent = `For your security, this QR code hides in ${left}s.`; };
  tickTimer();
  state.qrTimer = setInterval(() => { left--; if (left <= 0) { exportView(); } else tickTimer(); }, 1000);
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportView() {
  state.view = 'export';
  const selected = new Set(state.accounts.map((a) => a.id));
  const go = h('button', { class: 'btn primary block', type: 'button' });
  const refresh = () => { go.textContent = `Show transfer QR code${selected.size === 1 ? '' : 's'} (${selected.size})`; go.disabled = !selected.size; };
  go.addEventListener('click', () => askPassword({
    title: 'Confirm your password',
    text: 'The QR codes contain your secret keys. Anyone who can see them can generate your codes.',
    confirmLabel: 'Show QR codes',
    run: () => {
      const { urls, warnings } = buildMigrationUrls(state.accounts.filter((a) => selected.has(a.id)));
      if (!urls.length) { toast('None of the selected accounts can be transferred to Google Authenticator.', true); return; }
      qrScreen({ title: 'Transfer to Google', urls, warnings, hint: 'On your phone: Google Authenticator → menu → Transfer accounts → Import accounts → scan this code.' });
    },
  }));
  const picks = state.accounts.map((a) => h('div', { class: 'pick' },
    h('input', { type: 'checkbox', checked: true, 'aria-label': `Include ${labelOf(a)}`, onChange: (e) => { e.target.checked ? selected.add(a.id) : selected.delete(a.id); refresh(); } }),
    h('span', { class: 't', text: labelOf(a) }),
    h('button', { class: 'btn', type: 'button', text: 'QR', title: 'Single-account QR code for any authenticator app', onClick: () => askPassword({
      title: 'Confirm your password',
      text: 'This QR code contains the secret key for this account.',
      confirmLabel: 'Show QR code',
      run: () => qrScreen({ title: 'Account QR code', urls: [buildOtpauthUrl(a)], hint: 'Standard setup QR code. Works with Google Authenticator (Add a code → Scan a QR code) and most other apps.' }),
    }) })));
  const restore = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  restore.addEventListener('change', async () => {
    const f = restore.files[0]; if (!f) return;
    const text = await f.text();
    const pw = h('input', { type: 'password', placeholder: 'Backup password' });
    const err = h('div', { class: 'error' });
    modal({ title: 'Restore backup', body: h('div', {}, pw, err), actions: [{ label: 'Cancel' }, { label: 'Restore', kind: 'primary', run: async () => {
      try {
        const accounts = await vault.importBackup(text, pw.value);
        const { added, dupes } = await addAccounts(accounts);
        toast(`Restored ${added} account${added === 1 ? '' : 's'}${dupes ? `, ${dupes} already saved` : ''}`);
        listView();
      } catch (e) { err.textContent = e.message; return false; }
    } }] });
  });
  const backup = () => {
    const p1 = h('input', { type: 'password', placeholder: 'Backup password (8+ characters)', autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', placeholder: 'Repeat password', autocomplete: 'new-password' });
    const err = h('div', { class: 'error' });
    modal({ title: 'Download encrypted backup', body: h('div', { class: 'stack' }, h('p', { class: 'muted small', text: 'The file is encrypted with this password. You’ll need it to restore.' }), p1, p2, err),
      actions: [{ label: 'Cancel' }, { label: 'Download', kind: 'primary', run: async () => {
        if (p1.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return false; }
        if (p1.value !== p2.value) { err.textContent = "The passwords don't match."; return false; }
        download(`nexus-authenticator-backup-${new Date().toISOString().slice(0, 10)}.json`, await vault.exportBackup(state.accounts, p1.value));
      } }] });
  };
  show(header('Export', { back: listView }), h('div', { class: 'body' },
    h('h3', { text: 'Transfer to Google Authenticator', style: 'margin-top:0' }),
    h('p', { class: 'muted small', text: 'Choose accounts, then scan the QR codes with Google Authenticator on your phone. Each code holds up to 7 accounts.' }),
    state.accounts.length ? picks : h('p', { class: 'muted', text: 'No accounts to export yet.' }),
    state.accounts.length ? go : null,
    h('h3', { text: 'Backup' }),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', text: 'Download backup', disabled: !state.accounts.length, onClick: backup }),
      h('button', { class: 'btn', type: 'button', text: 'Restore backup', onClick: () => restore.click() })),
    restore));
  refresh();
}

/* ---------- settings ---------- */
function settingsView() {
  state.view = 'settings';
  const lockSel = h('select', { 'aria-label': 'Auto-lock' }, [[0, 'When I close this popup'], [1, 'After 1 minute'], [5, 'After 5 minutes'], [15, 'After 15 minutes'], [60, 'After 1 hour']]
    .map(([v, t]) => h('option', { value: String(v), text: t, selected: v === state.settings.autoLockMinutes })));
  lockSel.addEventListener('change', async () => {
    state.settings.autoLockMinutes = +lockSel.value;
    await vault.saveSettings(state.settings);
    await vault.storeSession(state.key, state.settings.autoLockMinutes);
    toast('Auto-lock updated');
  });
  const cur = h('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
  const n1 = h('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
  const n2 = h('input', { type: 'password', placeholder: 'Repeat new password', autocomplete: 'new-password' });
  const err = h('div', { class: 'error' });
  const change = async () => {
    err.textContent = '';
    if (n1.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    if (n1.value !== n2.value) { err.textContent = "The new passwords don't match."; return; }
    try { await vault.verifyPassword(cur.value); } catch (e) { err.textContent = e.message; return; }
    state.key = await vault.changePassword(state.accounts, n1.value);
    await vault.storeSession(state.key, state.settings.autoLockMinutes);
    cur.value = n1.value = n2.value = '';
    toast('Password changed');
  };
  show(header('Settings', { back: listView }), h('div', { class: 'body' },
    h('label', {}, h('span', { text: 'Lock the vault' }), lockSel),
    h('h3', { text: 'Change master password' }),
    h('div', { class: 'stack' }, cur, n1, n2, err, h('button', { class: 'btn block', type: 'button', text: 'Change password', onClick: change })),
    h('h3', { text: 'Vault' }),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', text: 'Lock now', onClick: lockNow }),
      h('button', { class: 'btn danger', type: 'button', text: 'Wipe vault', onClick: () => modal({
        title: 'Wipe the vault?',
        body: h('p', { class: 'muted', text: 'This deletes every saved account from this browser. Export a backup first if you might need them.' }),
        actions: [{ label: 'Cancel' }, { label: 'Wipe vault', kind: 'danger', run: async () => { await vault.resetVault(); state.accounts = []; setupView(); } }],
      }) })),
    h('p', { class: 'muted small', style: 'margin-top:16px', text: `Nexus Authenticator ${chrome.runtime.getManifest().version}. Codes are generated on this device and nothing is sent anywhere.` })));
}

/* ---------- paste support on the Add screen ---------- */
document.addEventListener('paste', async (e) => {
  if (state.view !== 'add' || !state.key) return;
  if (e.target.matches?.('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    const text = await decodeImageBlob(item.getAsFile());
    if (!text) { toast('No QR code found in the pasted image.', true); return; }
    done(await importText(text));
    return;
  }
  const text = e.clipboardData?.getData('text/plain');
  if (text && /otpauth/i.test(text)) { e.preventDefault(); done(await importText(text)); }
});

/* ---------- start ---------- */
(async function init() {
  try {
    state.settings = await vault.getSettings();
    if (!(await vault.hasVault())) return setupView();
    const key = await vault.loadSession();
    if (key) {
      try { return await afterUnlock(key, await vault.unlockWithKey(key)); } catch { /* fall through to lock screen */ }
    }
    lockedView();
  } catch (e) {
    show(h('div', { class: 'body center' }, h('h2', { text: 'Something went wrong' }), h('p', { class: 'muted', text: String(e.message || e) })));
  }
})();
