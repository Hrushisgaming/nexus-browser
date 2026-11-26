// User-controlled safety settings. Stored separately from the pairing config so
// re-pairing or "Disconnect & forget" never resets what the user decided.

const KEY = "nexus_settings";

export const DEFAULT_SETTINGS = Object.freeze({
  // "agent_tabs": Nexus can only touch tabs in its own "Nexus" tab group.
  // "all_tabs":   Nexus can also use the tabs you already have open.
  scope: "agent_tabs",
  // Use Chrome's debugger API for clicks, typing and keys so they are real input events.
  realInput: true,
  // Ask before clicking/submitting things that pay, send, post or delete.
  confirmRisky: true,
  // Ask before Nexus runs its own JavaScript inside a page.
  confirmScripts: true,
  // "blocklist": Nexus may use any site except the listed ones.
  // "allowlist": Nexus may use only the listed sites.
  siteMode: "blocklist",
  blocklist: [
    // Banks, payments and crypto. Edit freely in the popup.
    "paypal.com", "venmo.com", "wise.com", "stripe.com", "coinbase.com", "binance.com",
    "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "capitalone.com", "americanexpress.com",
    "hdfcbank.com", "icicibank.com", "sbi.co.in", "onlinesbi.sbi", "axisbank.com", "kotak.com",
    "paytm.com", "phonepe.com",
  ],
  allowlist: [],
});

const MAX_LIST = 300;

export function normalizePattern(raw) {
  let p = String(raw || "").trim().toLowerCase();
  p = p.replace(/^[a-z][a-z0-9+.\-]*:\/\//, "").replace(/[\/?#].*$/, "").replace(/:\d+$/, "")
    .replace(/^\*\./, "").replace(/^\./, "");
  if (!/^[a-z0-9.\-]+$/.test(p)) return "";
  if (!p.includes(".") && p !== "localhost") return "";
  return p;
}

function cleanList(list) {
  const src = Array.isArray(list) ? list : String(list || "").split(/[\s,]+/);
  return [...new Set(src.map(normalizePattern).filter(Boolean))].slice(0, MAX_LIST);
}

function sanitize(s) {
  return {
    scope: s.scope === "all_tabs" ? "all_tabs" : "agent_tabs",
    realInput: s.realInput !== false,
    confirmRisky: s.confirmRisky !== false,
    confirmScripts: s.confirmScripts !== false,
    siteMode: s.siteMode === "allowlist" ? "allowlist" : "blocklist",
    blocklist: cleanList(s.blocklist),
    allowlist: cleanList(s.allowlist),
  };
}

export async function getSettings() {
  let stored = {};
  try { stored = (await chrome.storage.local.get(KEY))[KEY] || {}; } catch (_) { /* use defaults */ }
  return sanitize({ ...DEFAULT_SETTINGS, ...stored });
}

export async function saveSettings(patch) {
  const next = sanitize({ ...(await getSettings()), ...(patch || {}) });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function hostMatches(host, pattern) {
  return host === pattern || host.endsWith("." + pattern);
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
}

// Returns "" when the URL is fine to use, otherwise a sentence saying why not.
export function siteBlockReason(url, settings) {
  let u;
  try { u = new URL(url); } catch (_) { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const host = u.hostname.toLowerCase();
  if (settings.siteMode === "allowlist") {
    return settings.allowlist.some((p) => hostMatches(host, p)) ? "" : `${host} is not on your allowed sites list.`;
  }
  return settings.blocklist.some((p) => hostMatches(host, p)) ? `${host} is on your blocked sites list.` : "";
}
