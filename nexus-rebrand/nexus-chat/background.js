// Opens the sidebar, adds the right-click menu, and lets the embedded chat sites load inside the panel.
// Settings > "Turn on the AI side panel" switches all of it off (default: on).
import { getSettings, saveSettings, domainsFor, hostnameOf } from './store.js';

const hasPanel = !!chrome.sidePanel;

async function openChat(windowId) {
  if (hasPanel) { try { await chrome.sidePanel.open({ windowId }); return; } catch (_) { /* fall through */ } }
  await chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html?win=1'), type: 'popup', width: 440, height: 780 });
}

// Chat sites refuse to be shown inside other pages (X-Frame-Options / frame-ancestors).
// Only for frames opened by this extension, and only for the sites you enabled, we drop those headers.
async function syncRules(s) {
  const domains = [...new Set(s.sites.filter((x) => x.enabled && x.embed !== false).flatMap(domainsFor))];
  const dnr = chrome.declarativeNetRequest, on = s.panelEnabled && domains.length > 0, errs = [];
  const strip = { type: 'modifyHeaders', responseHeaders: ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only'].map((header) => ({ header, operation: 'remove' })) };
  // Each rule is installed on its own, so one that Chrome rejects cannot take the others down with it.
  const attempt = async (label, fn) => { try { await fn(); } catch (e) { errs.push(label + ': ' + String(e.message || e).slice(0, 160)); } };
  // 1. frames opened by this extension's pages
  await attempt('rule 1', () => dnr.updateDynamicRules({ removeRuleIds: [1], addRules: on ? [{ id: 1, priority: 1, action: strip,
    condition: { requestDomains: domains, resourceTypes: ['sub_frame'], initiatorDomains: [chrome.runtime.id] } }] : [] }));
  // 2. backup: the same thing for requests that belong to no browser tab at all (the side panel is one), in case rule 1 does not match there
  await attempt('rule 2', () => dnr.updateSessionRules({ removeRuleIds: [3], addRules: on ? [{ id: 3, priority: 1, action: strip,
    condition: { requestDomains: domains, resourceTypes: ['sub_frame'], tabIds: [chrome.tabs.TAB_ID_NONE] } }] : [] }));
  // 3. local model servers (Ollama and similar) often reject requests from browser extensions; send them a plain request
  await attempt('rule 3', () => dnr.updateDynamicRules({ removeRuleIds: [2], addRules: s.panelEnabled ? [{ id: 2, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: { requestDomains: ['localhost', '127.0.0.1'], resourceTypes: ['xmlhttprequest'], initiatorDomains: [chrome.runtime.id] } }] : [] }));
  try { await chrome.storage.session.set({ ruleErrors: errs }); } catch (_) {}
}

// ---- Sign-in bridge (opt-in) ----
// Pages shown inside another page only receive a site's cookies if those are marked SameSite=None. Most sign-in
// cookies are not, so a sign-in done in a normal window looks "signed out" inside the panel. When the bridge is on,
// we re-save the cookies of the enabled sites with SameSite=None; Secure. Google's own cookies are never touched.
const SKIP = /(^|\.)(google\.com|gstatic\.com|googleapis\.com)$/;
const bridge = { on: false, hosts: [] };
const cookieHost = (c) => c.domain.replace(/^\./, '');
const bridged = (c) => bridge.hosts.some((h) => h === cookieHost(c) || cookieHost(c).endsWith('.' + h) || h.endsWith('.' + cookieHost(c)));
async function fixCookie(c) {
  if (!bridge.on || c.sameSite === 'no_restriction' || c.partitionKey || !bridged(c)) return;
  const d = { url: 'https://' + cookieHost(c) + c.path, name: c.name, value: c.value, path: c.path, secure: true,
    httpOnly: c.httpOnly, sameSite: 'no_restriction', storeId: c.storeId };
  if (!c.hostOnly) d.domain = c.domain;
  if (!c.session) d.expirationDate = c.expirationDate;
  try { await chrome.cookies.set(d); } catch (_) { /* leave the cookie as it was */ }
}
async function syncBridge(s) {
  bridge.on = !!s.signinBridge && s.panelEnabled !== false;
  bridge.hosts = [...new Set(s.sites.filter((x) => x.enabled && x.embed !== false).map((x) => hostnameOf(x.url).replace(/^www\./, '')))].filter((h) => h && !SKIP.test(h));
  if (!bridge.on) return;
  for (const h of bridge.hosts) { try { for (const c of await chrome.cookies.getAll({ domain: h })) await fixCookie(c); } catch (_) {} }
}
chrome.cookies.onChanged.addListener(async ({ removed, cookie }) => {
  if (removed || !bridge.on) return;
  await getSettings().then(syncHosts);          // keep the host list fresh when the worker has just woken up
  fixCookie(cookie);
});
const syncHosts = (s) => { if (!bridge.hosts.length) syncBridge(s); };

function menus(on, L) {
  chrome.contextMenus.removeAll(() => {
    if (!on) return;
    chrome.contextMenus.create({ id: 'ask-selection', title: 'Ask Nexus about “%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'ask-page', title: 'Chat with Nexus about this page', contexts: ['page'] });
    // Right-click the Chat with Nexus toolbar icon: switch the page pill on/off and pick its style.
    chrome.contextMenus.create({ id: 'pill-show', type: 'checkbox', checked: !!L.enabled, title: 'Show the “Ask Nexus” pill on pages', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'pill-docked', type: 'radio', checked: L.mode !== 'floating', title: 'Pill: docked to the page edge', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'pill-floating', type: 'radio', checked: L.mode === 'floating', title: 'Pill: floating button', contexts: ['action'] });
  });
}

// Bring everything in line with the saved settings. Safe to call as often as we like.
async function apply() {
  const s = await getSettings();
  // One-time switch: the page pill is off by default now, including on profiles that saved the old default (on).
  if (s.pillDefault !== 2) { s.pillDefault = 2; s.launcher.enabled = false; await saveSettings(s); return; }
  const on = s.panelEnabled !== false;
  if (hasPanel) {
    try { await chrome.sidePanel.setOptions({ enabled: on }); } catch (_) {}
    try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: on }); } catch (_) {}
  }
  chrome.action.setTitle({ title: on ? 'Chat with Nexus' : 'Chat with Nexus (turned off: click to change)' });
  menus(on, s.launcher);
  await syncRules(s);
  await syncBridge(s);
}

chrome.runtime.onInstalled.addListener(apply);
chrome.runtime.onStartup.addListener(apply);
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.settings) apply(); });
apply();                                    // the worker may have just woken up

// Toolbar icon. While the side panel is on, Chrome opens it by itself; this only fires when it is off (or unsupported).
chrome.action.onClicked.addListener(async (tab) => {
  const s = await getSettings();
  if (s.panelEnabled === false) chrome.runtime.openOptionsPage();
  else await openChat(tab?.windowId);
});

// The floating button on web pages asks us to open the panel. Do not await anything before open():
// it has to run while the click still counts as a user action.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'open-panel' && sender.tab) {
    if (hasPanel) chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => openChat(sender.tab.windowId));
    else openChat(sender.tab.windowId);
  } else if (msg?.type === 'open-options') {
    chrome.runtime.openOptionsPage();
  }
  return false;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (String(info.menuItemId).startsWith('pill-')) {              // toolbar-icon menu: change the pill, nothing else
    const s = await getSettings();
    if (info.menuItemId === 'pill-show') s.launcher.enabled = !!info.checked;
    else s.launcher.mode = info.menuItemId === 'pill-floating' ? 'floating' : 'docked';
    await saveSettings(s);
    return;
  }
  const inbox = info.menuItemId === 'ask-selection'
    ? { mode: 'selection', text: info.selectionText || '', ts: Date.now() }
    : { mode: 'page', text: '', ts: Date.now() };
  await chrome.storage.session.set({ inbox });
  await openChat(tab?.windowId);
});
