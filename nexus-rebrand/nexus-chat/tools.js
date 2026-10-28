// Tools the model can call (search, clock, calculator, files, ...). Each tool: name, label (shown as "Model called <label>"),
// desc (what the model reads), params (JSON schema) and run(args, ctx) -> string. ctx comes from the panel:
// { getPage(), addFile({name, mime, text|base64}) }.
// Everything a tool returns is untrusted data for the model: web pages can contain instructions aimed at it.

const MAX_OUT = 12000;
const cap = (s, n = MAX_OUT) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n…(cut, ${s.length - n} more characters)` : s; };
const obj = (properties, required = []) => ({ type: 'object', properties, required });

// ---------- calculator (no eval) ----------
const CONST = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
const FN = { sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max, pow: Math.pow };
export function calc(src) {
  const text = String(src).toLowerCase().replace(/×/g, '*').replace(/÷/g, '/').replace(/,(?=\d{3}\b)/g, '');
  const toks = text.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z_][a-z0-9_]*|\*\*|[-+*/%^(),]/g) || [];
  if (!toks.length || toks.join('') !== text.replace(/\s+/g, '')) throw new Error('Cannot read that expression');
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') { const o = next(), r = term(); v = o === '+' ? v + r : v - r; } return v; };
  const term = () => { let v = unary(); while (peek() === '*' || peek() === '/' || peek() === '%') { const o = next(), r = unary(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; };
  const unary = () => { if (peek() === '-') { next(); return -unary(); } if (peek() === '+') { next(); return unary(); } return power(); };
  const power = () => { const b = atom(); if (peek() === '^' || peek() === '**') { next(); return b ** unary(); } return b; };
  const atom = () => {
    const t = next();
    if (t === undefined) throw new Error('Expression ends too early');
    if (t === '(') { const v = expr(); if (next() !== ')') throw new Error('Missing )'); return v; }
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (t in CONST) return CONST[t];
    if (t in FN) {
      if (next() !== '(') throw new Error(t + ' needs ( )');
      const a = []; if (peek() !== ')') { a.push(expr()); while (peek() === ',') { next(); a.push(expr()); } }
      if (next() !== ')') throw new Error('Missing )');
      return FN[t](...a);
    }
    throw new Error('Unknown word: ' + t);
  };
  const v = expr();
  if (i < toks.length) throw new Error('Unexpected ' + toks[i]);
  if (!Number.isFinite(v)) throw new Error('Result is not a finite number');
  return v;
}

// ---------- helpers ----------
const WMO = { 0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail' };
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?fe80|\[?fc|\[?fd)/i;
const getJSON = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`); return r.json(); };
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function pageText(html, limit) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,form,header').forEach((n) => n.remove());
  const root = doc.querySelector('main,article,[role=main]') || doc.body;
  const title = (doc.title || '').trim();
  return (title ? title + '\n\n' : '') + (root?.textContent || '').replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

export const TOOLS = [
  { name: 'web_search', label: 'search', desc: 'Search the web (DuckDuckGo). Use it for news, facts that may have changed, prices, or anything you are not sure of. Returns titles, links and snippets; use read_url to open a result.',
    params: obj({ query: { type: 'string', description: 'The search query' }, max_results: { type: 'integer', description: 'How many results (1-10, default 6)' } }, ['query']),
    show: (a) => a.query,
    async run({ query, max_results }) {
      const r = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'q=' + encodeURIComponent(query) });
      if (!r.ok) throw new Error('Search engine answered ' + r.status);
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      const out = [], n = Math.min(10, Math.max(1, +max_results || 6));
      for (const el of doc.querySelectorAll('.result')) {
        if (el.classList.contains('result--ad')) continue;
        const a = el.querySelector('a.result__a'); if (!a) continue;
        let url = a.getAttribute('href') || '';
        try { const u = new URL(url, 'https://duckduckgo.com'); url = u.searchParams.get('uddg') || u.href; } catch { /* keep as is */ }
        out.push(`${out.length + 1}. ${a.textContent.trim()}\n   ${url}\n   ${(el.querySelector('.result__snippet')?.textContent || '').trim()}`);
        if (out.length >= n) break;
      }
      if (!out.length) throw new Error('No results (the search engine may be asking for a captcha). Try wikipedia or rephrase.');
      return out.join('\n');
    } },
  { name: 'read_url', label: 'page reader', desc: 'Download a web page (or a text/JSON file) and return its readable text. Use it after web_search to read a result.',
    params: obj({ url: { type: 'string', description: 'http(s) address' } }, ['url']),
    show: (a) => a.url,
    async run({ url }) {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https addresses');
      if (PRIVATE_HOST.test(u.hostname)) throw new Error('Pages on this computer or local network are not allowed');
      let r;
      try { r = await fetch(u.href, { redirect: 'follow' }); }
      catch { throw new Error('Could not fetch it. If Nexus is not yet allowed to read every site, turn on “Allow reading any page” in Settings > Tools.'); }
      if (!r.ok) throw new Error('The site answered ' + r.status);
      const type = r.headers.get('content-type') || '';
      const raw = await r.text();
      return cap(/html/i.test(type) ? pageText(raw, MAX_OUT) : raw);
    } },
  { name: 'get_time', label: 'clock', desc: 'Current date and time. Optionally for a named time zone such as "Asia/Kolkata" or "America/New_York".',
    params: obj({ timezone: { type: 'string', description: 'IANA time zone (default: the user\'s own)' } }),
    show: (a) => a.timezone || 'local',
    async run({ timezone }) {
      const now = new Date(), tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      let f; try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }); } catch { throw new Error('Unknown time zone: ' + tz); }
      return `${f.format(now)} (${tz})\nISO UTC: ${now.toISOString()}\nUnix seconds: ${Math.floor(now.getTime() / 1000)}`;
    } },
  { name: 'calculator', label: 'calculator', desc: 'Exact arithmetic. Supports + - * / % ^ ( ), pi, e and sqrt, abs, sin, cos, tan, ln, log, exp, floor, ceil, round, min, max. Use it instead of doing sums in your head.',
    params: obj({ expression: { type: 'string', description: 'e.g. (12.5*8)/3 + sqrt(2)' } }, ['expression']),
    show: (a) => a.expression,
    async run({ expression }) { return `${expression} = ${calc(expression)}`; } },
  { name: 'weather', label: 'weather', desc: 'Current weather and a 3-day forecast for a place (Open-Meteo).',
    params: obj({ location: { type: 'string', description: 'City or place name' } }, ['location']),
    show: (a) => a.location,
    async run({ location }) {
      const g = await getJSON('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(location));
      const p = g.results?.[0]; if (!p) throw new Error('Place not found: ' + location);
      const w = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&timezone=auto&forecast_days=3` +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code');
      const c = w.current, d = w.daily, u = w.current_units;
      const days = d.time.map((t, i) => `${t}: ${WMO[d.weather_code[i]] || 'n/a'}, ${d.temperature_2m_min[i]}–${d.temperature_2m_max[i]}${u.temperature_2m}, rain chance ${d.precipitation_probability_max[i]}%`).join('\n');
      return `${p.name}${p.admin1 ? ', ' + p.admin1 : ''}, ${p.country || ''}\nNow: ${WMO[c.weather_code] || 'n/a'}, ${c.temperature_2m}${u.temperature_2m} (feels ${c.apparent_temperature}${u.temperature_2m}), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} ${u.wind_speed_10m}\n${days}`;
    } },
  { name: 'wikipedia', label: 'wikipedia', desc: 'Look a topic up on Wikipedia and return the summary of the best matching article.',
    params: obj({ topic: { type: 'string' }, language: { type: 'string', description: 'Wikipedia language code, default en' } }, ['topic']),
    show: (a) => a.topic,
    async run({ topic, language }) {
      const lang = /^[a-z]{2,3}(-[a-z]+)?$/i.test(language || '') ? language : 'en';
      const s = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&origin=*&search=` + encodeURIComponent(topic));
      const title = s[1]?.[0]; if (!title) throw new Error('No Wikipedia article found for ' + topic);
      const j = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/` + encodeURIComponent(title));
      return `${j.title}${j.description ? ' (' + j.description + ')' : ''}\n${j.extract || ''}\n${j.content_urls?.desktop?.page || ''}`;
    } },
  { name: 'current_page', label: 'current page', desc: 'Read the web page the user is looking at right now: title, address, selected text and the page text.',
    params: obj({}),
    show: () => '',
    async run(_a, ctx) {
      const pg = await ctx.getPage();
      return cap(`Title: ${pg.title}\nURL: ${pg.url}\n` + (pg.sel ? `Selected text: ${pg.sel.slice(0, 4000)}\n` : '') + `Text:\n${pg.text.slice(0, 15000)}`);
    } },
  { name: 'list_tabs', label: 'tabs', desc: 'List the open browser tabs (title and address).',
    params: obj({}),
    show: () => '',
    async run() {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((t) => /^https?:/.test(t.url || '')).slice(0, 40).map((t) => `- ${t.title || '(no title)'} — ${t.url}${t.active ? ' [active]' : ''}`).join('\n') || 'No web tabs open.';
    } },
  { name: 'open_tab', label: 'open tab', desc: 'Open a web address in a new browser tab. The user is asked to confirm first.',
    params: obj({ url: { type: 'string' } }, ['url']),
    show: (a) => a.url,
    async run({ url }) {
      const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https addresses');
      if (!confirm('Nexus AI wants to open this in a new tab:\n\n' + u.href)) throw new Error('The user said no.');
      await chrome.tabs.create({ url: u.href, active: false }); return 'Opened in a background tab.';
    } },
  { name: 'create_file', label: 'file maker', desc: 'Create a file for the user to download (a document, CSV, JSON, code, HTML, SVG, markdown, plain text...). Put the full contents in "content". For binary data give "content_base64" instead.',
    params: obj({ filename: { type: 'string', description: 'e.g. report.md, data.csv, notes.txt' }, content: { type: 'string' }, content_base64: { type: 'string' }, mime: { type: 'string', description: 'Optional, e.g. text/csv' } }, ['filename']),
    show: (a) => a.filename,
    async run({ filename, content, content_base64, mime }, ctx) {
      const name = String(filename || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) || 'file.txt';
      if (content_base64) { const bytes = b64ToBytes(content_base64); ctx.addFile({ name, mime: mime || 'application/octet-stream', bytes }); return `File "${name}" (${bytes.length} bytes) is ready; the user sees a download button.`; }
      if (typeof content !== 'string') throw new Error('Give "content" (text) or "content_base64"');
      ctx.addFile({ name, mime: mime || 'text/plain', text: content }); return `File "${name}" (${content.length} characters) is ready; the user sees a download button.`;
    } },
  { name: 'remember', label: 'notes', desc: 'Save a short note that stays on this computer and can be read back later with recall (user preferences, facts they ask you to keep).',
    params: obj({ note: { type: 'string' } }, ['note']),
    show: (a) => a.note,
    async run({ note }) {
      const { notes = [] } = await chrome.storage.local.get('notes');
      notes.push({ t: Date.now(), note: String(note).slice(0, 500) });
      await chrome.storage.local.set({ notes: notes.slice(-100) }); return 'Saved.';
    } },
  { name: 'recall', label: 'notes', desc: 'Read back the notes saved with remember.',
    params: obj({}),
    show: () => '',
    async run() {
      const { notes = [] } = await chrome.storage.local.get('notes');
      return notes.length ? notes.map((n) => `- (${new Date(n.t).toISOString().slice(0, 10)}) ${n.note}`).join('\n') : 'No notes saved yet.';
    } },
  { name: 'random', label: 'dice', desc: 'Random number in a range, or a random pick from a list, or a UUID.',
    params: obj({ kind: { type: 'string', enum: ['number', 'pick', 'uuid'] }, min: { type: 'number' }, max: { type: 'number' }, items: { type: 'array', items: { type: 'string' } } }, ['kind']),
    show: (a) => a.kind,
    async run({ kind, min = 1, max = 100, items }) {
      const r = new Uint32Array(1); crypto.getRandomValues(r);
      if (kind === 'uuid') return crypto.randomUUID();
      if (kind === 'pick') { if (!items?.length) throw new Error('Give items'); return String(items[r[0] % items.length]); }
      const lo = Math.ceil(min), hi = Math.floor(max); if (hi < lo) throw new Error('max is below min');
      return String(lo + (r[0] % (hi - lo + 1)));
    } },
  { name: 'hash_text', label: 'hash', desc: 'SHA-256 (or SHA-1/384/512) hash of some text, as hex.',
    params: obj({ text: { type: 'string' }, algorithm: { type: 'string', enum: ['SHA-256', 'SHA-1', 'SHA-384', 'SHA-512'] } }, ['text']),
    show: () => '',
    async run({ text, algorithm = 'SHA-256' }) {
      const d = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } },
];

export const toolLabel = (name) => TOOLS.find((t) => t.name === name)?.label || name;
export const activeTools = (cfg) => (cfg && cfg.enabled === false ? [] : TOOLS.filter((t) => !(cfg?.off || []).includes(t.name)));

export async function runTool(name, args, ctx) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error('Unknown tool: ' + name);
  const out = await t.run(args && typeof args === 'object' ? args : {}, ctx);
  return { text: cap(out), summary: t.show ? String(t.show(args || {}) || '') : '' };
}

export const describeCall = (name, args) => { const x = TOOLS.find((y) => y.name === name); try { return x?.show ? String(x.show(args || {}) || '') : ''; } catch { return ''; } };
