// Without the native build (Nexus made by build_nexus_dmg.sh) the browser has no page called nexus://convert,
// so when a tab lands on it we send the tab to the page inside this extension. The native build does this itself
// (nexus-internal-pages.patch) and this file is then never needed.
const CONVERT_URL = /^(nexus|helium|chrome):\/\/convert\/?([?#].*)?$/i;
const go = (tabId, url) => {
  if (url && CONVERT_URL.test(url)) chrome.tabs.update(tabId, { url: chrome.runtime.getURL('index.html') }).catch(() => {});
};
chrome.tabs.onUpdated.addListener((tabId, info, tab) => go(tabId, info.url || (info.status === 'loading' ? tab.url : '')));
chrome.tabs.onCreated.addListener((tab) => go(tab.id, tab.pendingUrl || tab.url));
