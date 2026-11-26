// Real input events through Chrome's debugger API (Chrome DevTools Protocol).
// While a tab is attached Chrome shows its "is debugging this browser" bar; we
// attach lazily and let go again once the tab has been idle for a while.

const CDP_VERSION = "1.3";
const IDLE_MS = 20000;

const sessions = new Map(); // tabId -> { lastUse }
let cancelHandler = () => {};
let idleTimer = null;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function onUserCancel(fn) { cancelHandler = fn; }
export function attachedTabs() { return [...sessions.keys()]; }

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  const had = sessions.delete(source.tabId);
  if (had && reason === "canceled_by_user") cancelHandler(source.tabId);
});

function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function scheduleIdleCheck() {
  clearTimeout(idleTimer);
  if (!sessions.size) return;
  idleTimer = setTimeout(() => { detachIdle(IDLE_MS).catch(() => {}); }, IDLE_MS + 500);
}

export async function ensureAttached(tabId) {
  const s = sessions.get(tabId);
  if (s) { s.lastUse = Date.now(); scheduleIdleCheck(); return; }
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (e) {
    // After a service-worker restart we may still be attached from before.
    try {
      await send(tabId, "Runtime.evaluate", { expression: "1" });
    } catch (_) {
      throw err("DEBUGGER_UNAVAILABLE", `Couldn't attach to the tab for real input: ${(e && e.message) || e}`);
    }
  }
  sessions.set(tabId, { lastUse: Date.now() });
  // Pages behave as if focused even when the window is in the background.
  await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  scheduleIdleCheck();
}

async function cmd(tabId, method, params) {
  await ensureAttached(tabId);
  const s = sessions.get(tabId);
  if (s) s.lastUse = Date.now();
  try {
    return await send(tabId, method, params);
  } catch (e) {
    throw err("INPUT_FAILED", `Chrome rejected the input event (${method}): ${(e && e.message) || e}`);
  }
}

export async function detach(tabId) {
  if (!sessions.delete(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) { /* already gone */ }
}
export async function detachAll() {
  clearTimeout(idleTimer);
  await Promise.all([...sessions.keys()].map(detach));
}
export async function detachIdle(maxMs = IDLE_MS) {
  const now = Date.now();
  for (const [id, s] of [...sessions]) if (now - s.lastUse >= maxMs) await detach(id);
  scheduleIdleCheck();
}
// Called at start-up: a previous service worker may have left sessions attached.
export async function releaseLeftovers() {
  try {
    for (const t of await chrome.debugger.getTargets()) {
      if (t.attached && t.tabId != null && !sessions.has(t.tabId)) {
        try { await chrome.debugger.detach({ tabId: t.tabId }); } catch (_) { /* not ours */ }
      }
    }
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------- mouse
export async function click(tabId, x, y, { double = false } = {}) {
  await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse" });
  for (let n = 1; n <= (double ? 2 : 1); n++) {
    const base = { x, y, button: "left", pointerType: "mouse", clickCount: n };
    await cmd(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 });
    await cmd(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 });
  }
}

// Press at the first point, move through the rest with the button held, release at the last.
export async function drag(tabId, points, { stepMs = 8 } = {}) {
  const [first, ...rest] = points;
  await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: first.x, y: first.y, pointerType: "mouse" });
  await cmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: first.x, y: first.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  let last = first;
  try {
    for (const q of rest) {
      await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: q.x, y: q.y, button: "left", buttons: 1, pointerType: "mouse" });
      last = q;
      if (stepMs > 0) await new Promise((r) => setTimeout(r, stepMs));
    }
  } finally {
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" }).catch(() => {});
  }
}

export async function wheel(tabId, x, y, deltaX, deltaY) {
  await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
}

// ---------------------------------------------------------------- keyboard
const NAMED = {};
function named(key, code, vk, text) {
  const entry = { key, code, vk, text };
  NAMED[key.toLowerCase()] = entry;
  return entry;
}
named("Enter", "Enter", 13, "\r");
named("Tab", "Tab", 9);
named("Escape", "Escape", 27); NAMED.esc = NAMED.escape;
named("Backspace", "Backspace", 8);
named("Delete", "Delete", 46);
named("Insert", "Insert", 45);
named("ArrowLeft", "ArrowLeft", 37);
named("ArrowUp", "ArrowUp", 38);
named("ArrowRight", "ArrowRight", 39);
named("ArrowDown", "ArrowDown", 40);
named("Home", "Home", 36);
named("End", "End", 35);
named("PageUp", "PageUp", 33);
named("PageDown", "PageDown", 34);
named(" ", "Space", 32, " "); NAMED.space = NAMED[" "];
for (let i = 1; i <= 12; i++) named("F" + i, "F" + i, 111 + i);

const PUNCT = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188],
  ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192],
};
const EDIT_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

function charInfo(ch) {
  if (/^[a-z]$/i.test(ch)) return { code: "Key" + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(ch)) return { code: "Digit" + ch, vk: ch.charCodeAt(0) };
  if (ch === " ") return { code: "Space", vk: 32 };
  if (PUNCT[ch]) return { code: PUNCT[ch][0], vk: PUNCT[ch][1] };
  return { code: "", vk: 0 };
}

// "Ctrl+A", "Shift+Tab", "Enter" ... plus separate ctrl/shift/alt/meta flags.
export function parseKey(keyString, flags = {}) {
  const parts = String(keyString || "").split("+");
  let key = parts.pop();
  if (key === "" && parts.length) key = "+"; // "Ctrl++"
  let alt = !!flags.alt, ctrl = !!flags.ctrl, meta = !!flags.meta, shift = !!flags.shift;
  for (const part of parts) {
    switch (part.trim().toLowerCase()) {
      case "alt": case "option": alt = true; break;
      case "ctrl": case "control": ctrl = true; break;
      case "meta": case "cmd": case "command": case "win": meta = true; break;
      case "shift": shift = true; break;
      default: throw err("BAD_KEY", `Unknown modifier "${part}".`);
    }
  }
  if (!key) throw err("BAD_KEY", "key is required, e.g. Enter, Escape, Tab, ArrowDown.");
  return { key, alt, ctrl, meta, shift, mods: (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0) };
}

async function keystroke(tabId, ch) {
  const { code, vk } = charInfo(ch);
  await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, windowsVirtualKeyCode: vk, text: ch, unmodifiedText: ch });
  await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk });
}

export async function pressKey(tabId, keyString, flags = {}) {
  const parsed = parseKey(keyString, flags);
  let entry = NAMED[parsed.key.toLowerCase()];
  if (!entry) {
    if (Array.from(parsed.key).length !== 1) throw err("BAD_KEY", `Unknown key "${parsed.key}".`);
    let ch = parsed.key;
    if (parsed.shift && /^[a-z]$/.test(ch)) ch = ch.toUpperCase();
    const info = charInfo(ch);
    entry = { key: ch, code: info.code, vk: info.vk, text: ch };
  }
  const shortcut = parsed.ctrl || parsed.meta || parsed.alt;
  const base = { key: entry.key, code: entry.code, windowsVirtualKeyCode: entry.vk, modifiers: parsed.mods };
  if (shortcut || !entry.text) {
    const down = { ...base, type: "rawKeyDown" };
    const command = (parsed.ctrl || parsed.meta) ? EDIT_COMMANDS[entry.key.toLowerCase()] : null;
    if (command) down.commands = [command];
    await cmd(tabId, "Input.dispatchKeyEvent", down);
  } else {
    await cmd(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyDown", text: entry.text, unmodifiedText: entry.text });
  }
  await cmd(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

export async function typeText(tabId, text) {
  const chars = Array.from(String(text));
  if (chars.length > 400) { await cmd(tabId, "Input.insertText", { text: String(text) }); return; }
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (ch === "\n") await pressKey(tabId, "Enter");
    else if (ch === "\t") await pressKey(tabId, "Tab");
    else if (cp >= 32 && cp < 127) await keystroke(tabId, ch);
    else await cmd(tabId, "Input.insertText", { text: ch });
  }
}

// ---------------------------------------------------------------- file inputs
export async function setFiles(tabId, selector, files) {
  const { root } = await cmd(tabId, "DOM.getDocument", { depth: 0 });
  const { nodeId } = await cmd(tabId, "DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw err("PAGE_ERROR", "That file input is no longer on the page.");
  await cmd(tabId, "DOM.setFileInputFiles", { files, nodeId });
}
