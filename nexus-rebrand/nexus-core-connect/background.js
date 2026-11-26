// Nexus Browser Control — service worker.
//
// Speaks the Nexus Connect protocol (nexus_connect/agents/PROTOCOL.md) as a
// device agent with platform "browser":
//   1. pair_request  { pairing_code }          -> pair_approved { device, device_secret }
//   2. authenticate  { device_id, device_secret } -> device_online + capabilities
//   3. execute       { action, parameters }    -> result { success, data | error }
//   4. chat_message  { source: "browser", ... } -> result { success }   ("Send to Nexus")
// The device id + secret are stored, so after the first pairing the browser
// reconnects on its own (browser start, Nexus Core restart, network drop).
//
// Safety model (see README): Nexus works in its own "Nexus" tab group, a site
// block/allow list is enforced on every action, risky clicks and scripts need the
// user's OK in an extension-owned window, everything is logged, and the user can
// pause everything at once (popup switch or Alt+Shift+P).

import { getSettings, saveSettings, siteBlockReason, hostOf } from "./settings.js";
import { logActivity, getActivity, clearActivity } from "./activity.js";
import { requestConfirmation, getConfirmDetails, answerConfirm, denyAllConfirmations } from "./confirmation.js";
import * as cdp from "./cdp.js";

const AGENT_VERSION = chrome.runtime.getManifest().version;
const DEFAULT_HOST = "127.0.0.1:8765";
const PING_MS = 20000;
const WATCHDOG_ALARM = "nexus-watchdog";
const NEXUS_GROUP = "Nexus";
const MAX_CHAT_CHARS = 12000;
const CAPABILITIES = [
  "browser", "tabs", "navigate", "page_read", "page_interact", "screenshot", "script_eval", "file_upload",
  // generic Nexus Connect actions this browser also understands (open_url, capture_screen, get_device_info)
  "launch_app", "screen_capture", "device_info",
];

// ---------------------------------------------------------------- state
const rt = {
  ws: null,
  status: "unpaired", // unpaired | connecting | connected | disconnected | paused
  detail: "",
  pingTimer: null,
  retryTimer: null,
  retryMs: 1000,
  wantConnected: false,
  authRequestId: null,
  pendingPair: null,
  busy: 0,
  loaded: false,
  cfg: { host: DEFAULT_HOST, deviceId: "", deviceSecret: "", deviceName: "", paused: false },
};
const acks = new Map(); // request_id -> { resolve, timer }   (replies to chat_message)

async function loadCfg() {
  if (rt.loaded) return rt.cfg;
  const stored = (await chrome.storage.local.get("nexus")).nexus || {};
  rt.cfg = { ...rt.cfg, ...stored };
  rt.loaded = true;
  return rt.cfg;
}
async function saveCfg(patch) {
  rt.cfg = { ...rt.cfg, ...patch };
  await chrome.storage.local.set({ nexus: rt.cfg });
}
const isPaired = () => Boolean(rt.cfg.deviceId && rt.cfg.deviceSecret);

// ---------------------------------------------------------------- status / badge
function publicStatus() {
  return {
    status: rt.status,
    detail: rt.detail,
    host: rt.cfg.host,
    deviceId: rt.cfg.deviceId,
    deviceName: rt.cfg.deviceName,
    paired: isPaired(),
    paused: rt.cfg.paused,
  };
}
function setStatus(status, detail = "") {
  rt.status = status;
  rt.detail = detail;
  const shown = rt.cfg.paused && isPaired() ? "paused" : status;
  const badge = {
    connected: ["ON", "#16a34a"],
    connecting: ["…", "#d97706"],
    disconnected: ["!", "#d97706"],
    paused: ["II", "#6b7280"],
    unpaired: ["", "#000000"],
  }[shown] || ["", "#000000"];
  chrome.action.setBadgeText({ text: badge[0] }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: badge[1] }).catch(() => {});
  chrome.runtime.sendMessage({ event: "status", ...publicStatus() }).catch(() => {});
}
function refreshStatus() {
  if (!isPaired() && !rt.pendingPair) return setStatus("unpaired", rt.detail);
  if (rt.ws && rt.status === "connected" && rt.cfg.paused) return setStatus("paused", "Control is paused.");
  if (rt.status === "paused" && !rt.cfg.paused) return setStatus("connected", "");
}
function flashBadge(ok) {
  chrome.action.setBadgeText({ text: ok ? "✓" : "✗" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: ok ? "#16a34a" : "#dc2626" }).catch(() => {});
  setTimeout(() => setStatus(rt.status, rt.detail), 2000);
}

async function setPaused(paused) {
  await loadCfg();
  await saveCfg({ paused: !!paused });
  if (paused) {
    denyAllConfirmations();
    await cdp.detachAll();
  }
  if (rt.status === "connected" || rt.status === "paused") {
    setStatus(paused ? "paused" : "connected", paused ? "Control is paused." : "");
  } else {
    setStatus(rt.status, rt.detail);
  }
  if (rt.ws) send(rt.ws, "event", { event: paused ? "paused" : "resumed", source: "user" });
  logActivity({ kind: "control", summary: paused ? "Control paused" : "Control resumed" });
}
const assertNotPaused = () => {
  if (rt.cfg.paused) throw fail("PAUSED", "Browser control was paused by the user.");
};

// If the user presses Cancel on Chrome's "debugging this browser" bar, treat it as "stop".
cdp.onUserCancel(() => {
  loadCfg().then(() => setPaused(true));
  logActivity({ kind: "control", summary: "Debugging bar cancelled, control paused", outcome: "blocked" });
});

// ---------------------------------------------------------------- protocol helpers
const newId = () => crypto.randomUUID().replace(/-/g, "");
const envelope = (type, payload = {}, requestId = newId()) => ({
  type, request_id: requestId, timestamp: new Date().toISOString(), payload,
});
function send(sock, type, payload, requestId) {
  if (!sock || sock.readyState !== WebSocket.OPEN) return false;
  sock.send(JSON.stringify(envelope(type, payload, requestId)));
  return true;
}
function normalizeHost(raw) {
  let h = String(raw || "").trim().replace(/^wss?:\/\//i, "").replace(/\/.*$/, "");
  if (!h) h = DEFAULT_HOST;
  if (!/^[\w.\-\[\]:]+$/.test(h)) throw new Error("That address doesn't look right. Use something like 127.0.0.1:8765.");
  if (!/:\d+$/.test(h)) h += ":8765";
  return h.replace(/^localhost(?=:)/i, "127.0.0.1");
}
function defaultDeviceName() {
  const plat = (navigator.userAgentData && navigator.userAgentData.platform) || "";
  return plat ? `Chrome (${plat})` : "Chrome";
}

// ---------------------------------------------------------------- connection
function clearTimers() {
  clearInterval(rt.pingTimer); rt.pingTimer = null;
  clearTimeout(rt.retryTimer); rt.retryTimer = null;
}
function closeSocket() {
  const sock = rt.ws;
  rt.ws = null;
  clearInterval(rt.pingTimer); rt.pingTimer = null;
  if (sock) { try { sock.close(1000, "closing"); } catch (_) { /* ignore */ } }
}

function openSocket({ onOpen }) {
  closeSocket();
  const sock = new WebSocket(`ws://${rt.cfg.host}/ws`);
  rt.ws = sock;
  sock.onopen = () => { if (sock === rt.ws) onOpen(sock); };
  sock.onmessage = (ev) => { if (sock === rt.ws) onFrame(sock, ev.data); };
  sock.onerror = () => { /* onclose follows with details */ };
  sock.onclose = () => {
    if (sock !== rt.ws) return;
    rt.ws = null;
    clearInterval(rt.pingTimer); rt.pingTimer = null;
    cdp.detachAll().catch(() => {});
    if (rt.pendingPair) {
      const p = rt.pendingPair; rt.pendingPair = null;
      p.reject(new Error(`Couldn't reach Nexus Core at ${rt.cfg.host}. Is it running?`));
    }
    if (rt.wantConnected && isPaired()) {
      setStatus("connecting", "Reconnecting to Nexus Core…");
      scheduleRetry();
    } else {
      refreshStatus();
    }
  };
}

function scheduleRetry() {
  clearTimeout(rt.retryTimer);
  const wait = rt.retryMs;
  rt.retryMs = Math.min(rt.retryMs * 2, 30000);
  rt.retryTimer = setTimeout(() => { connectWithSavedCredentials().catch(() => {}); }, wait);
}

async function connectWithSavedCredentials() {
  await loadCfg();
  if (!isPaired()) return setStatus("unpaired", rt.detail);
  if (rt.ws && (rt.ws.readyState === WebSocket.OPEN || rt.ws.readyState === WebSocket.CONNECTING)) return;
  rt.wantConnected = true;
  if (rt.status !== "connecting") setStatus("connecting", "Connecting to Nexus Core…");
  openSocket({
    onOpen: (sock) => {
      rt.authRequestId = newId();
      send(sock, "authenticate", {
        device_id: rt.cfg.deviceId,
        device_secret: rt.cfg.deviceSecret,
        capabilities: CAPABILITIES,
        agent_version: AGENT_VERSION,
      }, rt.authRequestId);
    },
  });
}

function startPing(sock) {
  clearInterval(rt.pingTimer);
  // Pings also keep the MV3 service worker alive while connected.
  rt.pingTimer = setInterval(() => send(sock, "ping", {}), PING_MS);
}

async function pair({ code, host, deviceName }) {
  await loadCfg();
  code = String(code || "").replace(/\D/g, "");
  if (code.length !== 6) throw new Error("Enter the 6-digit code from Nexus Core.");
  const normalizedHost = normalizeHost(host);
  const name = (deviceName || "").trim() || rt.cfg.deviceName || defaultDeviceName();
  const previousHost = rt.cfg.host;
  rt.wantConnected = false;
  clearTimers();
  rt.cfg = { ...rt.cfg, host: normalizedHost };
  setStatus("connecting", "Pairing…");

  const approved = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      rt.pendingPair = null; closeSocket();
      reject(new Error("Nexus Core didn't answer. Check that it's running and the address is right."));
    }, 10000);
    const done = (fn) => (v) => { clearTimeout(timeout); fn(v); };
    const requestId = newId();
    rt.pendingPair = { requestId, resolve: done(resolve), reject: done(reject) };
    openSocket({
      onOpen: (sock) => {
        send(sock, "pair_request", {
          pairing_code: code,
          device_name: name,
          platform: "browser",
          os_version: navigator.userAgent.slice(0, 120),
          agent_version: AGENT_VERSION,
          capabilities: CAPABILITIES,
          permissions: ["tabs", "scripting", "debugger"],
          metadata: { browser: "chrome", extension: "nexus-browser-control" },
        }, requestId);
      },
    });
  }).catch((err) => {
    if (isPaired()) {
      // Keep the existing pairing working if a re-pair attempt fails.
      rt.cfg = { ...rt.cfg, host: previousHost };
      connectWithSavedCredentials().catch(() => {});
    } else {
      setStatus("unpaired", "");
    }
    throw err;
  });

  await saveCfg({
    host: normalizedHost,
    deviceId: approved.device.device_id,
    deviceSecret: approved.device_secret,
    deviceName: approved.device.name || name,
  });
  // pair_approved does not log this socket in; authenticate on it right away.
  rt.wantConnected = true;
  rt.retryMs = 1000;
  const sock = rt.ws;
  if (sock && sock.readyState === WebSocket.OPEN) {
    rt.authRequestId = newId();
    send(sock, "authenticate", {
      device_id: rt.cfg.deviceId, device_secret: rt.cfg.deviceSecret,
      capabilities: CAPABILITIES, agent_version: AGENT_VERSION,
    }, rt.authRequestId);
  } else {
    await connectWithSavedCredentials();
  }
  return publicStatus();
}

async function unpair() {
  await loadCfg();
  rt.wantConnected = false;
  clearTimers();
  const sock = rt.ws;
  if (sock) send(sock, "device_offline", {});
  closeSocket();
  denyAllConfirmations();
  await cdp.detachAll();
  await saveCfg({ deviceId: "", deviceSecret: "", deviceName: "", paused: false });
  setStatus("unpaired", "");
  return publicStatus();
}

// ---------------------------------------------------------------- incoming frames
function onFrame(sock, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  const type = String(msg.type || "").toLowerCase();
  const payload = msg.payload || {};

  if (type === "pair_approved") {
    if (rt.pendingPair && msg.request_id === rt.pendingPair.requestId) {
      const p = rt.pendingPair; rt.pendingPair = null;
      if (payload.device && payload.device_secret) p.resolve(payload);
      else p.reject(new Error("Nexus Core approved the pairing but sent no credentials."));
    }
    return;
  }
  if (type === "device_online") {
    if (rt.authRequestId && msg.request_id === rt.authRequestId) {
      rt.retryMs = 1000;
      startPing(sock);
      setStatus(rt.cfg.paused ? "paused" : "connected", rt.cfg.paused ? "Control is paused." : "");
    }
    return;
  }
  if (type === "result") {
    const waiting = acks.get(msg.request_id);
    if (waiting) { acks.delete(msg.request_id); clearTimeout(waiting.timer); waiting.resolve(payload); }
    return;
  }
  if (type === "error") {
    const text = String(payload.error || "Unknown error");
    const waiting = acks.get(msg.request_id);
    if (waiting) { acks.delete(msg.request_id); clearTimeout(waiting.timer); waiting.resolve({ success: false, error: text }); return; }
    if (rt.pendingPair && msg.request_id === rt.pendingPair.requestId) {
      const p = rt.pendingPair; rt.pendingPair = null;
      p.reject(new Error(/invalid or expired/i.test(text)
        ? "That code is invalid or has expired. Ask Nexus Core for a new one."
        : text));
      return;
    }
    if (rt.authRequestId && msg.request_id === rt.authRequestId) {
      // Credentials were revoked or the device was forgotten in Nexus Core.
      rt.wantConnected = false;
      clearTimers();
      closeSocket();
      saveCfg({ deviceId: "", deviceSecret: "", deviceName: "" }).then(() =>
        setStatus("unpaired", "Nexus Core no longer recognises this browser. Pair again with a new code."));
    }
    return;
  }
  if (type === "execute") {
    handleExecute(sock, msg);
    return;
  }
  // pong, capabilities, notification, ...: nothing to do
}

// ---------------------------------------------------------------- execute
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
const BLOCKED_CODES = new Set(["SITE_BLOCKED", "TAB_NOT_SHARED", "NO_AGENT_TAB", "PAUSED"]);
const DENIED_CODES = new Set(["USER_DENIED", "USER_NO_RESPONSE"]);

async function handleExecute(sock, msg) {
  const requestId = msg.request_id;
  const payload = msg.payload || {};
  const name = String(payload.action || "").trim().toLowerCase();
  const params = payload.parameters || {};
  const reply = (body) => send(sock, "result", body, requestId);

  if (rt.cfg.paused) {
    logActivity({ action: name, summary: name, outcome: "blocked", detail: "Ignored while paused" });
    return reply({ success: false, error: "Browser control is paused by the user.", error_code: "PAUSED" });
  }
  const resolvedName = ALIASES[name] || name;
  const fn = ACTIONS[resolvedName];
  if (!fn) {
    return reply({
      success: false, error_code: "UNSUPPORTED_ACTION",
      error: `Browser doesn't support "${name}". Supported: ${Object.keys(ACTIONS).join(", ")}.`,
    });
  }
  const ctx = { host: "", summary: "" };
  let outcome = "ok", detail = "";
  rt.busy += 1;
  chrome.action.setBadgeText({ text: "▶" }).catch(() => {});
  try {
    const data = await fn(params, ctx);
    reply({ success: true, data });
  } catch (err) {
    const code = (err && err.code) || "ACTION_FAILED";
    outcome = DENIED_CODES.has(code) ? "denied" : BLOCKED_CODES.has(code) ? "blocked" : "error";
    detail = String((err && err.message) || err);
    reply({ success: false, error: detail, error_code: code });
  } finally {
    rt.busy -= 1;
    if (rt.busy === 0) setStatus(rt.status, rt.detail);
    logActivity({ action: resolvedName, host: ctx.host, summary: ctx.summary || resolvedName, outcome, detail });
  }
}

// ---------------------------------------------------------------- tab policy
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tabIdOf = (p) => (p.tab_id ?? p.tabId ?? null);
const trunc = (s, n = 60) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function describeTab(t) {
  return { tab_id: t.id, window_id: t.windowId, title: t.title || "", url: t.url || t.pendingUrl || "", active: !!t.active, status: t.status };
}

async function isAgentTab(tab) {
  if (!tab || tab.groupId == null || tab.groupId < 0) return false;
  try { return (await chrome.tabGroups.get(tab.groupId)).title === NEXUS_GROUP; } catch (_) { return false; }
}
async function agentTabs() {
  const groups = await chrome.tabGroups.query({ title: NEXUS_GROUP });
  const lists = await Promise.all(groups.map((g) => chrome.tabs.query({ groupId: g.id })));
  return lists.flat();
}
async function pickNormalWindowId() {
  const wins = (await chrome.windows.getAll()).filter((w) => w.type === "normal");
  if (!wins.length) return (await chrome.windows.create({})).id;
  return (wins.find((w) => w.focused) || wins[0]).id;
}
// Puts a tab into the "Nexus" tab group of its window (creating the group if needed).
async function shareTab(tab) {
  if (tab.pinned) throw fail("CANNOT_SHARE", "Pinned tabs can't be added to a tab group. Unpin it first.");
  const [existing] = await chrome.tabGroups.query({ title: NEXUS_GROUP, windowId: tab.windowId });
  if (existing) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: NEXUS_GROUP, color: "purple" });
  }
}
async function rememberAgentTab(id) {
  try { await chrome.storage.session.set({ lastAgentTab: id }); } catch (_) { /* optional */ }
}
async function defaultAgentTab() {
  let last = null;
  try { last = (await chrome.storage.session.get("lastAgentTab")).lastAgentTab; } catch (_) { /* optional */ }
  if (last != null) {
    try {
      const t = await chrome.tabs.get(last);
      if (await isAgentTab(t)) return t;
    } catch (_) { /* closed */ }
  }
  const tabs = await agentTabs();
  return tabs.find((t) => t.active) || tabs[tabs.length - 1] || null;
}

async function assertUrlAllowed(url, settings, ctx) {
  if (ctx) ctx.host = hostOf(url);
  const reason = siteBlockReason(url, settings);
  if (reason) throw fail("SITE_BLOCKED", `${reason} Nexus can't open or use it. (The user can change this in the extension popup.)`);
}
async function assertTabAllowed(tab, settings, ctx) {
  if (settings.scope === "agent_tabs" && !(await isAgentTab(tab))) {
    throw fail("TAB_NOT_SHARED",
      `Tab ${tab.id} isn't one of Nexus's tabs. Nexus can only use tabs in its own "${NEXUS_GROUP}" tab group. ` +
      "Open a page with browser_open_url, or ask the user to share this tab from the extension popup.");
  }
  await assertUrlAllowed(tab.url || tab.pendingUrl || "", settings, ctx);
}

// opts.allowBlockedPage: for actions that never read the page (navigate away, close), so a
// tab stuck on a blocked site can still be moved on or closed.
async function resolveTab(p, ctx, opts = {}) {
  const settings = await getSettings();
  const id = tabIdOf(p);
  let tab;
  if (id !== null && id !== undefined && id !== "") {
    try { tab = await chrome.tabs.get(Number(id)); } catch (_) { throw fail("TAB_NOT_FOUND", `No tab with id ${id}.`); }
  } else if (settings.scope === "all_tabs") {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) [tab] = await chrome.tabs.query({ active: true });
    if (!tab) throw fail("NO_TAB", "There is no open tab.");
  } else {
    tab = await defaultAgentTab();
    if (!tab) throw fail("NO_AGENT_TAB", `Nexus has no tab of its own yet. Open one with browser_open_url (it goes into the "${NEXUS_GROUP}" tab group), or ask the user to share a tab.`);
  }
  await assertTabAllowed(tab, opts.allowBlockedPage ? { ...settings, siteMode: "blocklist", blocklist: [] } : settings, ctx);
  if (settings.scope === "agent_tabs" || (await isAgentTab(tab))) rememberAgentTab(tab.id);
  return tab;
}

function cleanUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) throw fail("MISSING_PARAMETERS", "A url is required.");
  if (!/^[a-z][a-z0-9+.\-]*:/i.test(u)) u = "https://" + u;
  let parsed;
  try { parsed = new URL(u); } catch (_) { throw fail("BAD_URL", `Not a valid URL: ${raw}`); }
  if (u === "about:blank") return u;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw fail("BAD_URL", `Only http and https links can be opened (got ${parsed.protocol}).`);
  }
  return parsed.href;
}
// A page may redirect to a site on the block list. Reset the tab and report it.
async function checkLanded(tabId, settings) {
  const tab = await chrome.tabs.get(tabId);
  const reason = siteBlockReason(tab.url || "", settings);
  if (reason) {
    await chrome.tabs.update(tabId, { url: "about:blank" }).catch(() => {});
    throw fail("SITE_BLOCKED", `The page ended up on a blocked site (${reason}) so the tab was reset. Nothing from it was read.`);
  }
  return tab;
}

async function waitUntilComplete(tabId, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  await sleep(150);
  while (Date.now() < end) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") return true;
    } catch (_) { return false; }
    await sleep(150);
  }
  return false;
}
function navigateAndWait(tabId, trigger, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let sawLoading = false, finished = false;
    const finish = (ok, err) => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (err) reject(err); else resolve(ok);
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
    Promise.resolve().then(trigger).then(
      () => setTimeout(() => { if (!sawLoading) finish(true); }, 800), // same-document or cached
      (err) => finish(false, err),
    );
  });
}
// Back/forward through the page's own history. chrome.tabs.goBack() refuses
// entries on pages the user never interacted with, which is every page an agent drives.
async function historyMove(tab, direction) {
  const before = tab.url;
  try {
    assertScriptable(tab);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, args: [direction],
      func: (d) => { if (d < 0) history.back(); else history.forward(); },
    });
  } catch (_) {
    try { await (direction < 0 ? chrome.tabs.goBack(tab.id) : chrome.tabs.goForward(tab.id)); }
    catch (e) { throw fail("NO_HISTORY", direction < 0 ? "There is no earlier page in this tab." : "There is no later page in this tab."); }
  }
  const end = Date.now() + 3000;
  let after = await chrome.tabs.get(tab.id);
  while (after.url === before && Date.now() < end) {
    await sleep(100);
    after = await chrome.tabs.get(tab.id);
  }
  if (after.url === before) {
    throw fail("NO_HISTORY", direction < 0 ? "There is no earlier page in this tab." : "There is no later page in this tab.");
  }
  await waitUntilComplete(tab.id, 15000);
  return chrome.tabs.get(tab.id);
}
const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search|chrome-untrusted):/i;
function assertScriptable(tab) {
  const url = tab.url || "";
  if (RESTRICTED.test(url) || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) {
    throw fail("RESTRICTED_PAGE", `Chrome doesn't allow extensions to read or control this page (${url.slice(0, 60)}). Navigate to a normal website first.`);
  }
}

// ---------------------------------------------------------------- page-side code
// Runs inside the page. Must be fully self-contained (it is serialised).
async function pageOp(op, a) {
  try {
    const SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
    };
    // Querying that also looks inside open shadow roots (custom elements hide their inputs there).
    const deepAll = (sel, root = document, out = []) => {
      for (const el of root.querySelectorAll(sel)) out.push(el);
      if (out.length > 4000) return out;
      for (const host of root.querySelectorAll("*")) if (host.shadowRoot) deepAll(sel, host.shadowRoot, out);
      return out;
    };
    const frameTag = window === window.top ? "" : (window.__nexusFrameTag = window.__nexusFrameTag || Math.random().toString(36).slice(2, 4));
    const label = (el) => String(el.innerText || el.value || el.getAttribute("aria-label") || el.title || el.alt || el.placeholder || "")
      .trim().replace(/\s+/g, " ").slice(0, 120);
    const find = () => {
      if (a.ref) {
        const el = deepAll('[data-nexus-ref="' + CSS.escape(String(a.ref)) + '"]')[0];
        if (!el) throw new Error('Unknown or stale ref "' + a.ref + '". Take a new snapshot first.');
        return el;
      }
      if (a.selector) {
        const el = document.querySelector(a.selector) || deepAll(a.selector)[0];
        if (!el) throw new Error("No element matches selector: " + a.selector);
        return el;
      }
      return null;
    };
    const fire = (el, Type, name, init) => el.dispatchEvent(new Type(name, Object.assign({ bubbles: true, cancelable: true, view: window }, init)));
    const describe = (el) => ({ tag: el.tagName.toLowerCase(), text: label(el) });
    const isEditable = (el) => el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable;

    const setText = (el, text, clear) => {
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el, clear ? text : el.value + text);
        fire(el, InputEvent, "input", { inputType: "insertText", data: text });
        fire(el, Event, "change", {});
      } else if (el.isContentEditable) {
        if (clear) { document.execCommand("selectAll", false); document.execCommand("delete", false); }
        document.execCommand("insertText", false, text);
      } else {
        throw new Error("That element can't take text input.");
      }
    };
    const pressEnter = (el) => {
      const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13 };
      const down = fire(el, KeyboardEvent, "keydown", init);
      fire(el, KeyboardEvent, "keypress", init);
      fire(el, KeyboardEvent, "keyup", init);
      if (down && el.form && el.tagName === "INPUT") {
        if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
      }
    };

    // ---- risk assessment: does acting on this element pay, send, post or delete?
    const PAY = /\b(pay|pay now|payment|buy|buy now|place (your |my )?order|purchase|checkout|check out|complete (your )?(order|purchase)|confirm (your )?(order|payment|purchase)|donate|subscribe|book now|authori[sz]e payment|transfer|withdraw|send money|wire)\b/i;
    const SEND = /^\s*(send|post|reply|publish|tweet|share|comment|send message|submit (post|comment|review|reply))\b/i;
    const DEL = /\b(delete|remove|erase|discard|deactivate|close account|cancel (my |your )?(subscription|account|order|membership)|unsubscribe|empty (the )?(trash|bin)|permanently)\b/i;
    const CARD = 'input[autocomplete^="cc-"],input[name*="card" i],input[name*="cvv" i],input[name*="cvc" i],input[id*="card" i],input[id*="cvv" i]';
    const clickable = (el) => el.closest('button,a[href],[role=button],input[type=submit],input[type=button],input[type=image],summary') || el;
    const isSubmit = (el) => (el.tagName === "BUTTON" && el.type === "submit") || (el.tagName === "INPUT" && (el.type === "submit" || el.type === "image"));
    const assess = (start, kind) => {
      const out = [];
      if (!start || !start.tagName) return out;
      if (kind === "type") {
        if (start.matches && start.matches(CARD)) out.push({ type: "payment", why: "typing into a card or payment field" });
        return out;
      }
      const controls = [];
      if (kind === "submit") {
        const form = start.form || (start.closest && start.closest("form"));
        const btn = form && form.querySelector("button[type=submit],input[type=submit],button:not([type])");
        if (btn) controls.push(btn);
        else if (form) controls.push(form);
      } else if (kind === "click") {
        controls.push(clickable(start));
      }
      for (const c of controls) {
        const text = c.tagName === "FORM" ? "" : label(c).slice(0, 80);
        const isLink = c.tagName === "A";
        if (text && !isLink && PAY.test(text)) out.push({ type: "payment", why: "the button says “" + text + "”" });
        else if (text && DEL.test(text)) out.push({ type: "delete", why: "the " + (isLink ? "link" : "button") + " says “" + text + "”" });
        else if (text && !isLink && SEND.test(text)) out.push({ type: "send", why: "the button says “" + text + "”" });
        const form = c.tagName === "FORM" ? c : (c.form || (c.closest && c.closest("form")));
        if ((kind === "submit" || isSubmit(c)) && form && form.querySelector(CARD) && !out.some((o) => o.type === "payment")) {
          out.push({ type: "payment", why: "this form asks for card details" });
        }
      }
      return out;
    };
    const selectAll = (el) => {
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        try { el.select(); } catch (_) { /* some input types */ }
        if (el.selectionStart === el.selectionEnd && el.value) { try { el.setSelectionRange(0, el.value.length); } catch (_) { /* ignore */ } }
      } else if (el.isContentEditable) {
        const range = document.createRange(); range.selectNodeContents(el);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      }
    };
    const caretToEnd = (el) => {
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) { /* some input types */ }
      } else if (el.isContentEditable) {
        const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      }
    };

    switch (op) {
      case "snapshot": {
        window.__nexusRefN = window.__nexusRefN || 0;
        const elements = [];
        let total = 0;
        for (const el of deepAll(SEL)) {
          if (!visible(el)) continue;
          total++;
          if (elements.length >= a.maxElements) continue;
          let ref = el.getAttribute("data-nexus-ref");
          if (!ref) { ref = frameTag + "n" + (++window.__nexusRefN); el.setAttribute("data-nexus-ref", ref); }
          const tag = el.tagName.toLowerCase();
          const r = el.getBoundingClientRect();
          const isField = tag === "input" || tag === "textarea" || tag === "select";
          elements.push({
            ref, tag,
            role: el.getAttribute("role") || undefined,
            type: el.type && tag === "input" ? el.type : undefined,
            text: label(el),
            href: tag === "a" ? el.href : undefined,
            value: isField && el.type !== "password" && el.type !== "file" ? String(el.value).slice(0, 120) : undefined,
            checked: (el.type === "checkbox" || el.type === "radio") ? el.checked : undefined,
            disabled: el.disabled || undefined,
            x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
          });
        }
        const text = (document.body ? document.body.innerText : "") || "";
        return {
          url: location.href, title: document.title, is_top: window === window.top,
          text: text.slice(0, a.maxText), text_truncated: text.length > a.maxText,
          elements, elements_total: total,
          scroll: { x: Math.round(scrollX), y: Math.round(scrollY), page_height: document.documentElement.scrollHeight, viewport_height: innerHeight },
        };
      }
      case "text": {
        const el = find() || document.body;
        const text = (el.innerText || el.textContent || "");
        return { url: location.href, title: document.title, text: text.slice(0, a.maxText), truncated: text.length > a.maxText };
      }
      // Look at the target without acting: where is it, what would acting on it do?
      case "prepare": {
        let el = find();
        let px = null, py = null;
        if (!el) {
          if (a.kind === "key" || a.kind === "submit") {
            el = document.activeElement || document.body;
          } else if (typeof a.x === "number" && typeof a.y === "number") {
            px = a.x; py = a.y; el = document.elementFromPoint(px, py);
            if (!el) throw new Error("There is no element at that point.");
          } else {
            throw new Error("This needs a ref, a selector, or x and y.");
          }
        }
        if (a.kind === "upload" && !(el.tagName === "INPUT" && el.type === "file")) {
          throw new Error("That element isn't a file input (<input type=file>). Take a snapshot and look for one.");
        }
        if (px === null) {
          if (a.kind === "click" || a.kind === "type" || a.kind === "upload") el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          px = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
          py = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
        }
        const hit = document.elementFromPoint(px, py);
        const obscured = !!(hit && hit !== el && !el.contains(hit) && !hit.contains(el));
        let reasons = assess(el, a.kind);
        if (obscured && a.kind === "click") reasons = reasons.concat(assess(hit, a.kind));
        return {
          tag: el.tagName.toLowerCase(), text: label(el), type: el.type || undefined,
          x: Math.round(px), y: Math.round(py), reasons,
          covered_by: obscured ? (label(hit) || hit.tagName.toLowerCase()) : undefined,
          is_select: el.tagName === "SELECT", editable: isEditable(el),
        };
      }
      case "focus": {
        const el = find();
        if (!el) throw new Error("A ref or selector is required.");
        if (!a.any && !isEditable(el)) throw new Error("That element can't take text input.");
        el.scrollIntoView({ block: "center", inline: "center" });
        if (document.activeElement !== el) el.focus({ preventScroll: true });
        // When only pressing a key (a.any) leave the caret and selection exactly as they are.
        if (isEditable(el) && !a.any) { if (a.clear) selectAll(el); else caretToEnd(el); }
        return { tag: el.tagName.toLowerCase(), focused: document.activeElement === el };
      }
      case "readback": {
        const el = find() || document.activeElement;
        if (!el) return {};
        if (el.tagName === "INPUT" && el.type === "file") return { files: Array.from(el.files || []).map((f) => f.name) };
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return { value_length: String(el.value).length };
        if (el.isContentEditable) return { value_length: (el.innerText || "").length };
        return {};
      }
      case "viewport":
        return { w: innerWidth, h: innerHeight };
      case "click": {
        let el = find();
        let cx, cy;
        if (el) {
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
        } else {
          if (typeof a.x !== "number" || typeof a.y !== "number") throw new Error("click needs a ref, a selector, or x and y.");
          cx = a.x; cy = a.y; el = document.elementFromPoint(cx, cy);
          if (!el) throw new Error("There is no element at that point.");
        }
        const m = { clientX: cx, clientY: cy, button: 0 };
        const times = a.double ? 2 : 1;
        for (let i = 0; i < times; i++) {
          fire(el, PointerEvent, "pointerdown", m); fire(el, MouseEvent, "mousedown", m);
          if (el.focus) el.focus({ preventScroll: true });
          fire(el, PointerEvent, "pointerup", m); fire(el, MouseEvent, "mouseup", m);
          el.click();
        }
        if (a.double) fire(el, MouseEvent, "dblclick", m);
        return { clicked: describe(el) };
      }
      case "type": {
        const el = find();
        if (!el) throw new Error("type needs a ref or a selector.");
        el.scrollIntoView({ block: "center" });
        el.focus();
        const text = String(a.text == null ? "" : a.text);
        if (el.tagName === "SELECT") {
          const opt = Array.from(el.options).find((o) => o.value === text || o.text.trim() === text.trim());
          if (!opt) throw new Error('The dropdown has no option "' + text + '".');
          el.value = opt.value; fire(el, Event, "input", {}); fire(el, Event, "change", {});
        } else {
          setText(el, text, a.clear !== false);
        }
        if (a.submit) pressEnter(el);
        return { typed_into: describe(el), submitted: !!a.submit };
      }
      case "key": {
        const el = find() || document.activeElement || document.body;
        if (el.focus) el.focus();
        const key = String(a.key || "");
        if (!key) throw new Error("key is required, e.g. Enter, Escape, Tab, ArrowDown.");
        if (key === "Enter") { pressEnter(el); return { pressed: key }; }
        const init = { key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, ctrlKey: !!a.ctrl, shiftKey: !!a.shift, altKey: !!a.alt, metaKey: !!a.meta };
        const notPrevented = fire(el, KeyboardEvent, "keydown", init);
        if (key.length === 1 && notPrevented && !a.ctrl && !a.meta && isEditable(el)) setText(el, key, false);
        fire(el, KeyboardEvent, "keyup", init);
        return { pressed: key };
      }
      case "scroll": {
        const el = find();
        if (el) { el.scrollIntoView({ block: "center" }); }
        else {
          const dir = a.direction || "down";
          const amt = Number(a.amount) || Math.round(innerHeight * 0.8);
          if (dir === "top") scrollTo({ top: 0, behavior: "instant" });
          else if (dir === "bottom") scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
          else scrollBy({ top: dir === "down" ? amt : dir === "up" ? -amt : 0, left: dir === "right" ? amt : dir === "left" ? -amt : 0, behavior: "instant" });
        }
        return { scroll_x: Math.round(scrollX), scroll_y: Math.round(scrollY), page_height: document.documentElement.scrollHeight, viewport_height: innerHeight };
      }
      case "wait_for": {
        const end = Date.now() + (Number(a.timeout) || 10000);
        while (Date.now() < end) {
          if (a.selector) { const el = document.querySelector(a.selector); if (el && visible(el)) return { found: "selector" }; }
          if (a.text && document.body && document.body.innerText.includes(a.text)) return { found: "text" };
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("Timed out waiting for " + (a.selector ? "selector " + a.selector : 'text "' + a.text + '"') + ".");
      }
      case "selection":
        return { selection: String(getSelection() || ""), text: document.body ? document.body.innerText : "", title: document.title, url: location.href };
      default:
        throw new Error("Unknown page operation " + op);
    }
  } catch (e) {
    return { __error: String((e && e.message) || e) };
  }
}

// Runs in the page's own JS world so it can see page variables.
async function pageEval(code) {
  try {
    const value = await (0, eval)(code);
    let out;
    try { out = value === undefined ? null : JSON.parse(JSON.stringify(value)); } catch (_) { out = String(value); }
    return { value: out };
  } catch (e) {
    return { __error: String((e && e.message) || e) };
  }
}

async function runInPage(tab, op, args) {
  assertScriptable(tab);
  // Snapshots and ref-based actions look in every frame: refs from an iframe's elements are
  // prefixed per frame, so only the frame that owns a ref answers.
  const allFrames = op === "snapshot" || !!(args && args.ref);
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames }, func: pageOp, args: [op, args] });
  } catch (e) {
    throw fail("SCRIPT_FAILED", `Couldn't run on that page: ${e.message}`);
  }
  results = (results || []).filter((r) => r && r.result !== undefined && r.result !== null);
  if (!results.length) return undefined;
  const top = results.find((r) => r.frameId === 0) || results[0];
  if (op === "snapshot") {
    if (top.result.__error) throw fail("PAGE_ERROR", top.result.__error);
    const out = top.result;
    const max = (args && args.maxElements) || 150;
    for (const r of results) {
      if (r === top || !r.result || r.result.__error || !r.result.elements) continue;
      for (const el of r.result.elements) {
        if (out.elements.length >= max) break;
        out.elements.push({ ...el, in_frame: r.result.url });
      }
      out.elements_total += r.result.elements_total;
      if (r.result.text && out.text.length < (args.maxText || 5000)) {
        out.text += "\n[frame " + r.result.url + "]\n" + r.result.text.slice(0, 1500);
      }
    }
    return out;
  }
  if (!allFrames) {
    if (top.result.__error) throw fail("PAGE_ERROR", top.result.__error);
    return top.result;
  }
  const answered = results.find((r) => !(r.result && r.result.__error));
  if (!answered) {
    const err = (results.find((r) => r.frameId === 0) || results[0]).result;
    throw fail("PAGE_ERROR", err.__error);
  }
  const out = answered.result;
  if (out && typeof out === "object" && answered.frameId !== 0) out.in_frame = true;
  return out;
}

// ---------------------------------------------------------------- asking the user
const REASON_LABELS = { payment: "Payment", send: "Sends something", delete: "Deletes something", script: "Runs a script", file: "Uploads files" };

// reasons: [{ type, why }]. Throws unless the user allows it.
async function askUser({ title, host, url, reasons, detail }) {
  chrome.action.setBadgeText({ text: "?" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#d97706" }).catch(() => {});
  const answer = await requestConfirmation({
    title, host, url,
    reasons: [...new Set(reasons.map((r) => REASON_LABELS[r.type] || r.type))],
    target: reasons.map((r) => r.why).join("; "),
    detail: detail || "",
  });
  chrome.action.setBadgeText({ text: "▶" }).catch(() => {});
  if (answer === "allow") { assertNotPaused(); return; }
  if (answer === "timeout") throw fail("USER_NO_RESPONSE", "The user didn't respond to the confirmation, so nothing was done.");
  throw fail("USER_DENIED", "The user declined this action, so nothing was done.");
}
async function confirmIfRisky(prep, tab, title) {
  const settings = await getSettings();
  if (!prep.reasons.length || !settings.confirmRisky) return;
  await askUser({ title, host: hostOf(tab.url), url: tab.url, reasons: prep.reasons });
}

// ---------------------------------------------------------------- actions
const ALIASES = {
  open_url: "browser_open_url",
  capture_screen: "browser_screenshot",
  get_device_info: "browser_info",
};

const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const pick = (p, ...keys) => Object.fromEntries(keys.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
const wantsRealInput = async (p) => (await getSettings()).realInput && p.real !== false;
// Runs a real-input step; if Chrome won't let us attach, the caller falls back to synthetic events.
async function tryReal(step) {
  assertNotPaused();
  try { await step(); return true; } catch (e) {
    if (e && e.code === "DEBUGGER_UNAVAILABLE") return false;
    throw e;
  }
}

// Downscale a PNG data URL to a JPEG no wider than maxWidth. Returns { base64, width, height }.
async function shrinkImage(dataUrl, maxWidth, quality) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, maxWidth / bmp.width);
  const width = Math.max(1, Math.round(bmp.width * scale)), height = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(bmp, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: Math.min(Math.max(quality, 0.2), 0.95) });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), width, height };
}

const ACTIONS = {
  async browser_info(_p, ctx) {
    ctx.summary = "Read browser info";
    const [tabs, windows] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]);
    const settings = await getSettings();
    return {
      browser: "chrome", user_agent: navigator.userAgent, extension_version: AGENT_VERSION,
      tab_count: tabs.length, window_count: windows.length,
      tab_scope: settings.scope, real_input: settings.realInput,
      message: `Chrome with ${tabs.length} tab(s) in ${windows.length} window(s).`,
    };
  },

  async browser_list_tabs(_p, ctx) {
    ctx.summary = "Listed tabs";
    const settings = await getSettings();
    const all = await chrome.tabs.query({});
    let shown = all;
    if (settings.scope === "agent_tabs") {
      const ids = new Set((await agentTabs()).map((t) => t.id));
      shown = all.filter((t) => ids.has(t.id));
    }
    const tabs = shown.map((t) => (siteBlockReason(t.url || "", settings)
      ? { tab_id: t.id, window_id: t.windowId, blocked: true, title: "[blocked site]", url: "" }
      : describeTab(t)));
    const hidden = all.length - shown.length;
    return {
      tabs, count: tabs.length, scope: settings.scope,
      other_tabs_not_shared: settings.scope === "agent_tabs" ? hidden : undefined,
      message: `${tabs.length} tab(s) available to Nexus` + (hidden ? ` (${hidden} other tab(s) are not shared).` : "."),
    };
  },

  async browser_open_url(p, ctx) {
    const settings = await getSettings();
    const url = cleanUrl(p.url);
    await assertUrlAllowed(url, settings, ctx);
    ctx.summary = `Opened ${ctx.host || "a page"}`;
    const wantActive = p.active !== false;
    let tab;
    if (p.new_tab === false) {
      tab = await resolveTab(p, ctx);
      await navigateAndWait(tab.id, () => chrome.tabs.update(tab.id, { url, active: wantActive }));
    } else {
      tab = await chrome.tabs.create({ url, active: wantActive, windowId: await pickNormalWindowId() });
      try { await shareTab(tab); } catch (e) {
        await chrome.tabs.remove(tab.id).catch(() => {});
        throw fail("CANNOT_SHARE", `Couldn't put the new tab into the "${NEXUS_GROUP}" group: ${e.message}`);
      }
      rememberAgentTab(tab.id);
      if (p.wait !== false) await waitUntilComplete(tab.id);
    }
    tab = await checkLanded(tab.id, settings);
    return { ...describeTab(tab), message: `Opened ${tab.url || url} (tab ${tab.id}).` };
  },

  async browser_navigate(p, ctx) {
    const settings = await getSettings();
    const url = cleanUrl(p.url);
    await assertUrlAllowed(url, settings, ctx);
    const tab = await resolveTab(p, ctx, { allowBlockedPage: true });
    ctx.summary = `Navigated to ${hostOf(url)}`;
    const loaded = await navigateAndWait(tab.id, () => chrome.tabs.update(tab.id, { url }));
    const t = await checkLanded(tab.id, settings);
    return { ...describeTab(t), loaded, message: `Navigated tab ${t.id} to ${t.url || url}.` };
  },

  async browser_back(p, ctx) {
    const tab = await resolveTab(p, ctx);
    ctx.summary = "Went back";
    const moved = await historyMove(tab, -1);
    return describeTab(await checkLanded(moved.id, await getSettings()));
  },

  async browser_forward(p, ctx) {
    const tab = await resolveTab(p, ctx);
    ctx.summary = "Went forward";
    const moved = await historyMove(tab, 1);
    return describeTab(await checkLanded(moved.id, await getSettings()));
  },

  async browser_reload(p, ctx) {
    const tab = await resolveTab(p, ctx);
    ctx.summary = "Reloaded the page";
    await navigateAndWait(tab.id, () => chrome.tabs.reload(tab.id));
    return describeTab(await chrome.tabs.get(tab.id));
  },

  async browser_activate_tab(p, ctx) {
    const tab = await resolveTab(p, ctx);
    ctx.summary = "Switched tab";
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { ...describeTab(await chrome.tabs.get(tab.id)), message: `Switched to tab ${tab.id}.` };
  },

  async browser_close_tab(p, ctx) {
    if (tabIdOf(p) === null && !p.current) throw fail("MISSING_PARAMETERS", "tab_id is required (or pass current: true to close the active tab).");
    const tab = await resolveTab(p, ctx, { allowBlockedPage: true });
    ctx.summary = "Closed a tab";
    await chrome.tabs.remove(tab.id);
    return { closed_tab_id: tab.id, message: `Closed tab ${tab.id}.` };
  },

  async browser_snapshot(p, ctx) {
    const tab = await resolveTab(p, ctx);
    ctx.summary = "Read the page";
    const snap = await runInPage(tab, "snapshot", { maxElements: num(p.max_elements, 150), maxText: num(p.max_text, 5000) });
    return { tab_id: tab.id, ...snap, message: `Snapshot of "${snap.title}" with ${snap.elements.length} interactive element(s).` };
  },

  async browser_get_text(p, ctx) {
    const tab = await resolveTab(p, ctx);
    ctx.summary = "Read page text";
    const out = await runInPage(tab, "text", { ...pick(p, "selector", "ref"), maxText: num(p.max_text, 20000) });
    return { tab_id: tab.id, ...out };
  },

  async browser_click(p, ctx) {
    const tab = await resolveTab(p, ctx);
    const target = pick(p, "ref", "selector", "x", "y");
    const prep = await runInPage(tab, "prepare", { ...target, kind: "click" });
    ctx.summary = `Clicked ${prep.tag} “${trunc(prep.text)}”`;
    await confirmIfRisky(prep, tab, "Nexus wants to click a button");
    let input = "synthetic";
    if (!prep.in_frame && await wantsRealInput(p)) {
      if (await tryReal(() => cdp.click(tab.id, prep.x, prep.y, { double: !!p.double }))) input = "real";
    }
    if (input === "synthetic") { assertNotPaused(); await runInPage(tab, "click", { ...pick(p, "ref", "selector", "x", "y", "double") }); }
    await sleep(num(p.settle_ms, 300));
    return {
      tab_id: tab.id, clicked: { tag: prep.tag, text: prep.text }, input, covered_by: prep.covered_by,
      message: `Clicked ${prep.tag} "${prep.text}"` + (prep.covered_by ? ` (something else was on top: "${prep.covered_by}")` : "") + ".",
    };
  },

  async browser_type(p, ctx) {
    const tab = await resolveTab(p, ctx);
    const target = pick(p, "ref", "selector");
    if (!target.ref && !target.selector) throw fail("MISSING_PARAMETERS", "type needs a ref or a selector.");
    const text = String(p.text == null ? "" : p.text);
    const prep = await runInPage(tab, "prepare", { ...target, kind: "type" });
    if (p.submit) {
      const submitting = await runInPage(tab, "prepare", { ...target, kind: "submit" });
      prep.reasons = prep.reasons.concat(submitting.reasons);
    }
    // Never log what was typed: only how much.
    ctx.summary = `Typed ${text.length} character(s) into ${prep.tag}` + (p.submit ? " and submitted" : "");
    await confirmIfRisky(prep, tab, p.submit ? "Nexus wants to fill in and submit a form" : "Nexus wants to type into a field");
    let input = "synthetic", info = {};
    if (!prep.is_select && !prep.in_frame && await wantsRealInput(p)) {
      const ok = await tryReal(async () => {
        await runInPage(tab, "focus", { ...target, clear: p.clear !== false });
        if (text === "" && p.clear !== false) await cdp.pressKey(tab.id, "Backspace");
        else await cdp.typeText(tab.id, text);
      });
      if (ok) {
        input = "real";
        info = await runInPage(tab, "readback", target);
        if (p.submit) { assertNotPaused(); await cdp.pressKey(tab.id, "Enter"); }
      }
    }
    if (input === "synthetic") {
      assertNotPaused();
      await runInPage(tab, "type", pick(p, "ref", "selector", "text", "clear", "submit"));
    }
    if (p.submit) await sleep(num(p.settle_ms, 500));
    return {
      tab_id: tab.id, typed_into: { tag: prep.tag, text: prep.text }, submitted: !!p.submit, input, ...info,
      message: `Typed into ${prep.tag}${p.submit ? " and submitted" : ""}.`,
    };
  },

  async browser_press_key(p, ctx) {
    const tab = await resolveTab(p, ctx);
    const key = String(p.key || "");
    const combo = cdp.parseKey(key, p);
    const target = pick(p, "ref", "selector");
    const isEnter = combo.key.toLowerCase() === "enter" && !combo.ctrl && !combo.alt && !combo.meta;
    const prep = await runInPage(tab, "prepare", { ...target, kind: isEnter ? "submit" : "key" });
    ctx.summary = `Pressed ${key}`;
    await confirmIfRisky(prep, tab, "Nexus wants to press Enter in a form");
    let input = "synthetic";
    if (await wantsRealInput(p)) {
      const ok = await tryReal(async () => {
        if (target.ref || target.selector) await runInPage(tab, "focus", { ...target, any: true, clear: false });
        await cdp.pressKey(tab.id, key, p);
      });
      if (ok) input = "real";
    }
    if (input === "synthetic") { assertNotPaused(); await runInPage(tab, "key", pick(p, "key", "ref", "selector", "ctrl", "shift", "alt", "meta")); }
    return { tab_id: tab.id, pressed: key, input, message: `Pressed ${key}.` };
  },

  async browser_scroll(p, ctx) {
    const tab = await resolveTab(p, ctx);
    ctx.summary = "Scrolled the page";
    const dir = p.direction || "down";
    const target = pick(p, "ref", "selector");
    if (!target.ref && !target.selector && ["up", "down", "left", "right"].includes(dir) && await wantsRealInput(p)) {
      const view = await runInPage(tab, "viewport", {});
      const amount = num(p.amount, Math.round(view.h * 0.8));
      const dx = dir === "right" ? amount : dir === "left" ? -amount : 0;
      const dy = dir === "down" ? amount : dir === "up" ? -amount : 0;
      if (await tryReal(() => cdp.wheel(tab.id, Math.round(view.w / 2), Math.round(view.h / 2), dx, dy))) {
        // Wheel scrolling is animated: wait until the page has actually moved (or give up).
        const start = await runInPage(tab, "scroll", { direction: "none" });
        let pos = start;
        for (let i = 0; i < 12; i++) {
          await sleep(100);
          pos = await runInPage(tab, "scroll", { direction: "none" });
          if (pos.scroll_x !== start.scroll_x || pos.scroll_y !== start.scroll_y) { await sleep(150); pos = await runInPage(tab, "scroll", { direction: "none" }); break; }
        }
        return { tab_id: tab.id, input: "real", ...pos };
      }
    }
    assertNotPaused();
    const out = await runInPage(tab, "scroll", pick(p, "direction", "amount", "ref", "selector"));
    return { tab_id: tab.id, input: "synthetic", ...out };
  },

  async browser_wait_for(p, ctx) {
    if (!p.selector && !p.text) throw fail("MISSING_PARAMETERS", "Pass a selector or text to wait for.");
    const tab = await resolveTab(p, ctx);
    ctx.summary = "Waited for the page";
    const out = await runInPage(tab, "wait_for", pick(p, "selector", "text", "timeout"));
    return { tab_id: tab.id, ...out };
  },

  async browser_screenshot(p, ctx) {
    const tab = await resolveTab(p, ctx);
    ctx.summary = "Took a screenshot";
    if (!tab.active || p.activate !== false) {
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(250);
    }
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    } catch (e) {
      throw fail("SCREENSHOT_FAILED", `Couldn't capture the tab: ${e.message}`);
    }
    // Models are billed per pixel: send a modest JPEG, not a full-resolution PNG.
    const small = await shrinkImage(dataUrl, num(p.max_width, 1024), num(p.quality, 0.6));
    let viewport = null;
    try { viewport = await runInPage(tab, "viewport", {}); } catch (_) { /* restricted page */ }
    return {
      tab_id: tab.id, mime: "image/jpeg", image_base64: small.base64,
      image_width: small.width, image_height: small.height,
      viewport_width: viewport && viewport.w, viewport_height: viewport && viewport.h,
      message: `Captured a screenshot of tab ${tab.id} (${small.width}x${small.height}).`,
    };
  },

  // Press, move along a path, release: draws on canvases, drags sliders and sortable items.
  async browser_drag(p, ctx) {
    const tab = await resolveTab(p, ctx);
    const raw = Array.isArray(p.path) && p.path.length >= 2 ? p.path
      : [[p.from_x, p.from_y], [p.to_x, p.to_y]];
    const pts = raw.map((q) => ({ x: Number(Array.isArray(q) ? q[0] : q && q.x), y: Number(Array.isArray(q) ? q[1] : q && q.y) }));
    if (pts.length < 2 || pts.length > 400 || pts.some((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y))) {
      throw fail("MISSING_PARAMETERS", "Drag needs from_x, from_y, to_x, to_y, or a path of 2 to 400 [x, y] points.");
    }
    if (!(await wantsRealInput(p))) throw fail("REAL_INPUT_REQUIRED", "Dragging needs real input, which is turned off in the extension's settings.");
    const prep = await runInPage(tab, "prepare", { x: pts[0].x, y: pts[0].y, kind: "click" });
    ctx.summary = `Dragged across ${pts.length} point(s)`;
    await confirmIfRisky(prep, tab, "Nexus wants to drag on the page");
    if (!(await tryReal(() => cdp.drag(tab.id, pts, { stepMs: num(p.step_ms, 8) })))) {
      throw fail("DEBUGGER_UNAVAILABLE", "Chrome wouldn't let Nexus use real mouse input on this tab.");
    }
    await sleep(num(p.settle_ms, 200));
    return { tab_id: tab.id, input: "real", points: pts.length, message: `Dragged across ${pts.length} point(s).` };
  },

  async browser_eval(p, ctx) {
    const code = String(p.code || p.script || "");
    if (!code.trim()) throw fail("MISSING_PARAMETERS", "code is required.");
    const tab = await resolveTab(p, ctx);
    assertScriptable(tab);
    ctx.summary = `Ran a script (${code.length} characters)`;
    const settings = await getSettings();
    if (settings.confirmScripts) {
      await askUser({
        title: "Nexus wants to run a script in this page", host: hostOf(tab.url), url: tab.url,
        reasons: [{ type: "script", why: "scripts can read or change anything on the page" }],
        detail: code.length > 600 ? code.slice(0, 600) + "…" : code,
      });
    }
    let res;
    try {
      [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: pageEval, args: [code] });
    } catch (e) {
      throw fail("SCRIPT_FAILED", `Couldn't run script: ${e.message}`);
    }
    const out = res && res.result;
    if (out && out.__error) throw fail("EVAL_ERROR", `${out.__error} (pages with a strict Content-Security-Policy block eval)`);
    return { tab_id: tab.id, value: out ? out.value : null };
  },

  // Attach local files to an <input type=file>. Always needs the user's OK.
  async browser_upload_file(p, ctx) {
    const files = (Array.isArray(p.files) ? p.files : [p.file || p.path]).filter((f) => typeof f === "string" && f.trim());
    if (!files.length || files.length > 10) throw fail("MISSING_PARAMETERS", "files must list 1 to 10 absolute file paths.");
    if (!p.ref && !p.selector) throw fail("MISSING_PARAMETERS", "upload needs the ref or selector of an <input type=file>.");
    if (p.ref && !/^n\d+$/.test(String(p.ref))) throw fail("MISSING_PARAMETERS", `Bad ref "${p.ref}".`);
    const settings = await getSettings();
    if (!settings.realInput) throw fail("REAL_INPUT_OFF", "File upload needs “Use real mouse and keyboard input” turned on in the extension popup.");
    const tab = await resolveTab(p, ctx);
    const target = pick(p, "ref", "selector");
    await runInPage(tab, "prepare", { ...target, kind: "upload" }); // throws unless it is a file input
    ctx.summary = `Upload of ${files.length} file(s)`;
    await askUser({
      title: "Nexus wants to upload files", host: hostOf(tab.url), url: tab.url,
      reasons: [{ type: "file", why: `sends files from this computer to ${hostOf(tab.url) || "this site"}` }],
      detail: files.join("\n"),
    });
    const selector = p.ref ? `[data-nexus-ref="${p.ref}"]` : String(p.selector);
    assertNotPaused();
    try {
      await cdp.setFiles(tab.id, selector, files);
    } catch (e) {
      if (e && e.code) throw e;
      throw fail("UPLOAD_FAILED", `Chrome couldn't attach the files: ${(e && e.message) || e}`);
    }
    const info = await runInPage(tab, "readback", target);
    return { tab_id: tab.id, ...info, message: `Attached ${files.length} file(s).` };
  },
};

// ---------------------------------------------------------------- Send to Nexus
async function readFromTab(tab) {
  assertScriptable(tab);
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageOp, args: ["selection", {}] });
  const out = res && res.result;
  if (!out || out.__error) throw new Error((out && out.__error) || "Couldn't read that page.");
  return out;
}

// kind: "selection" | "page" | "link". Throws a user-readable Error on failure.
async function sendToNexus({ kind, tab, selectionText, linkUrl, note }) {
  await loadCfg();
  if (!isPaired()) throw new Error("This browser isn't paired with Nexus Core yet.");
  const sock = rt.ws;
  if (!sock || sock.readyState !== WebSocket.OPEN || (rt.status !== "connected" && rt.status !== "paused")) {
    throw new Error("Not connected to Nexus Core right now.");
  }
  const settings = await getSettings();
  let url = "", title = "", text = "";
  if (kind === "link") {
    url = String(linkUrl || "");
    text = url;
  } else {
    if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error("There is no open tab.");
    const reason = siteBlockReason(tab.url || "", settings);
    if (reason) throw new Error(`${reason} Remove it from the list in this popup if you want to send it.`);
    const page = await readFromTab(tab);
    url = page.url; title = page.title;
    text = kind === "selection" ? (selectionText || page.selection) : page.text;
  }
  text = String(text || "").trim();
  if (!text) throw new Error(kind === "selection" ? "Nothing is selected." : "That page has no readable text.");
  const truncated = text.length > MAX_CHAT_CHARS;
  if (truncated) text = text.slice(0, MAX_CHAT_CHARS);

  const requestId = newId();
  const reply = new Promise((resolve) => {
    const timer = setTimeout(() => {
      acks.delete(requestId);
      resolve({ success: false, error: "Nexus Core didn't confirm it got the message." });
    }, 8000);
    acks.set(requestId, { resolve, timer });
  });
  send(sock, "chat_message", {
    source: "browser", kind, url, title, text, truncated,
    instruction: String(note || "").trim().slice(0, 1000),
    device_name: rt.cfg.deviceName,
  }, requestId);
  const result = await reply;
  const ok = !!(result && result.success);
  logActivity({
    kind: "send", summary: `Sent ${kind === "link" ? "a link" : kind === "page" ? "a page" : "a selection"} to Nexus`,
    host: hostOf(url), outcome: ok ? "ok" : "error", detail: ok ? "" : (result && result.error) || "",
  });
  if (!ok) throw new Error((result && result.error) || "Nexus Core couldn't take that.");
  return { sent: kind, truncated };
}

async function sendAndFlash(args) {
  try { await sendToNexus(args); flashBadge(true); } catch (e) {
    flashBadge(false);
    chrome.runtime.sendMessage({ event: "toast", error: String((e && e.message) || e) }).catch(() => {});
  }
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "send_selection", title: "Send selection to Nexus", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "send_page", title: "Send this page to Nexus", contexts: ["page"] });
    chrome.contextMenus.create({ id: "send_link", title: "Send link to Nexus", contexts: ["link"] });
    chrome.contextMenus.create({ id: "share_tab", title: "Let Nexus use this tab", contexts: ["page"] });
    chrome.contextMenus.create({ id: "unshare_tab", title: "Stop Nexus using this tab", contexts: ["page"] });
  });
}
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await loadCfg();
  switch (info.menuItemId) {
    case "send_selection": return sendAndFlash({ kind: "selection", tab, selectionText: info.selectionText });
    case "send_page": return sendAndFlash({ kind: "page", tab });
    case "send_link": return sendAndFlash({ kind: "link", tab, linkUrl: info.linkUrl });
    case "share_tab": if (tab) { await shareTab(tab).catch(() => flashBadge(false)); logActivity({ kind: "control", summary: "You shared a tab with Nexus", host: hostOf(tab.url) }); } return;
    case "unshare_tab": if (tab) { await chrome.tabs.ungroup(tab.id).catch(() => {}); logActivity({ kind: "control", summary: "You stopped sharing a tab", host: hostOf(tab.url) }); } return;
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  await loadCfg();
  if (command === "toggle-pause") { if (isPaired()) await setPaused(!rt.cfg.paused); return; }
  if (command === "send-selection") return sendAndFlash({ kind: "selection", tab });
});

// ---------------------------------------------------------------- popup messaging
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.cmd) return false;
  (async () => {
    await loadCfg();
    switch (msg.cmd) {
      case "getStatus": return publicStatus();
      case "pair": return await pair(msg);
      case "unpair": return await unpair();
      case "reconnect": rt.retryMs = 1000; await connectWithSavedCredentials(); return publicStatus();
      case "setPaused": await setPaused(!!msg.paused); return publicStatus();
      case "getSettings": return { settings: await getSettings() };
      case "saveSettings": {
        const settings = await saveSettings(msg.patch);
        if (!settings.realInput) await cdp.detachAll();
        return { settings };
      }
      case "getActivity": return { entries: await getActivity() };
      case "clearActivity": await clearActivity(); return {};
      case "getTabState": {
        const tab = await chrome.tabs.get(Number(msg.tabId)).catch(() => null);
        if (!tab) return { tab: null };
        const settings = await getSettings();
        return {
          tab: { id: tab.id, host: hostOf(tab.url), shared: await isAgentTab(tab),
            blocked: siteBlockReason(tab.url || "", settings), restricted: RESTRICTED.test(tab.url || "") },
        };
      }
      case "shareTab": {
        const tab = await chrome.tabs.get(Number(msg.tabId));
        await shareTab(tab);
        logActivity({ kind: "control", summary: "You shared a tab with Nexus", host: hostOf(tab.url) });
        return {};
      }
      case "unshareTab": {
        const tab = await chrome.tabs.get(Number(msg.tabId));
        await chrome.tabs.ungroup(tab.id);
        logActivity({ kind: "control", summary: "You stopped sharing a tab", host: hostOf(tab.url) });
        return {};
      }
      case "sendToNexus": {
        const tab = await chrome.tabs.get(Number(msg.tabId)).catch(() => null);
        const r = await sendToNexus({ kind: msg.kind === "selection" ? "selection" : "page", tab, note: msg.note });
        flashBadge(true);
        return r;
      }
      case "getConfirm": { const details = getConfirmDetails(String(msg.id || "")); return { details }; }
      case "answerConfirm": return { answered: answerConfirm(String(msg.id || ""), !!msg.allow) };
      default: throw new Error("Unknown command");
    }
  })().then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

// ---------------------------------------------------------------- lifecycle
async function boot() {
  await loadCfg();
  cdp.releaseLeftovers();
  if (isPaired()) await connectWithSavedCredentials();
  else setStatus("unpaired", "");
}
chrome.runtime.onStartup.addListener(() => { boot(); });
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  createMenus();
  boot();
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  await loadCfg();
  cdp.detachIdle().catch(() => {});
  if (isPaired() && (!rt.ws || rt.ws.readyState === WebSocket.CLOSED)) connectWithSavedCredentials();
});
chrome.alarms.get(WATCHDOG_ALARM).then((a) => { if (!a) chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 }); });
boot();
