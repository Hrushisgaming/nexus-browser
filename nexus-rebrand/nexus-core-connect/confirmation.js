// Confirmation prompts. They are shown in a window that belongs to the extension,
// so a web page can neither draw a fake one nor click Allow on the user's behalf.

const TIMEOUT_MS = 60000;
const pending = new Map(); // id -> { details, resolve, windowId, timer }

const newId = () => crypto.randomUUID().replace(/-/g, "");

function settle(id, answer) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  if (p.windowId != null) chrome.windows.remove(p.windowId).catch(() => {});
  p.resolve(answer);
  return true;
}

// Resolves "allow" | "deny" | "timeout".
export function requestConfirmation(details) {
  return new Promise((resolve) => {
    const id = newId();
    const entry = { details: { ...details, expires_at: Date.now() + TIMEOUT_MS }, resolve, windowId: null, timer: null };
    entry.timer = setTimeout(() => settle(id, "timeout"), TIMEOUT_MS);
    pending.set(id, entry);
    chrome.windows.create({
      url: chrome.runtime.getURL(`confirm.html?id=${id}`),
      type: "popup", width: 460, height: 430, focused: true,
    }).then((win) => {
      if (!pending.has(id)) { chrome.windows.remove(win.id).catch(() => {}); return; }
      entry.windowId = win.id;
    }).catch(() => settle(id, "deny"));
  });
}

export function getConfirmDetails(id) {
  const p = pending.get(id);
  return p ? p.details : null;
}

export function answerConfirm(id, allow) {
  return settle(id, allow ? "allow" : "deny");
}

export function denyAllConfirmations() {
  for (const id of [...pending.keys()]) settle(id, "deny");
}

// Closing the window with the X counts as Deny.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, p] of pending) if (p.windowId === windowId) { settle(id, "deny"); break; }
});
