// Activity log: what Nexus did in this browser and when. Deliberately stores no
// typed text, page content or script source, only short descriptions.

const KEY = "nexus_activity";
const MAX = 200;
let chain = Promise.resolve();

export function logActivity(entry) {
  const row = {
    t: Date.now(),
    kind: entry.kind || "action",
    action: String(entry.action || ""),
    host: String(entry.host || ""),
    summary: String(entry.summary || entry.action || "").slice(0, 160),
    outcome: entry.outcome || "ok", // ok | error | denied | blocked
    detail: String(entry.detail || "").slice(0, 200),
  };
  chain = chain.then(async () => {
    try {
      const list = (await chrome.storage.local.get(KEY))[KEY] || [];
      list.push(row);
      await chrome.storage.local.set({ [KEY]: list.slice(-MAX) });
      chrome.runtime.sendMessage({ event: "activity" }).catch(() => {});
    } catch (_) { /* logging must never break an action */ }
  });
  return chain;
}

export async function getActivity() {
  try { return (await chrome.storage.local.get(KEY))[KEY] || []; } catch (_) { return []; }
}

export async function clearActivity() {
  chain = chain.then(() => chrome.storage.local.set({ [KEY]: [] }).catch(() => {}));
  return chain;
}
