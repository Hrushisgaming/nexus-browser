const $ = (id) => document.getElementById(id);
const LABELS = {
  unpaired: "Not paired",
  connecting: "Connecting…",
  connected: "Connected to Nexus Core",
  disconnected: "Disconnected",
  paused: "Paused",
};

function ask(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError?.message || "No response" })));
}
function showError(text) { $("error").textContent = text || ""; }

let currentTab = null;

// ---------------------------------------------------------------- status
function render(s) {
  $("dot").className = "dot " + s.status;
  $("statusText").textContent = LABELS[s.status] || s.status;
  $("detail").textContent = s.detail || "";
  $("pairView").hidden = s.paired;
  $("pairedView").hidden = !s.paired;
  if (s.paired) {
    $("devName").textContent = s.deviceName || s.deviceId;
    $("devHost").textContent = s.host;
    $("pause").checked = !!s.paused;
    $("sendPage").disabled = $("sendSel").disabled = !(s.status === "connected" || s.status === "paused");
  } else if (!$("host").value) {
    $("host").value = s.host || "";
  }
}

$("code").addEventListener("input", (e) => {
  const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
  e.target.value = digits.length > 3 ? digits.slice(0, 3) + " " + digits.slice(3) : digits;
});
$("code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("pairBtn").click(); });

$("pairBtn").addEventListener("click", async () => {
  showError("");
  $("pairBtn").disabled = true;
  $("pairBtn").textContent = "Connecting…";
  const r = await ask({ cmd: "pair", code: $("code").value, host: $("host").value, deviceName: $("name").value });
  $("pairBtn").disabled = false;
  $("pairBtn").textContent = "Connect";
  if (!r.ok) return showError(r.error);
  $("code").value = "";
  render(r);
  loadAll();
});
$("unpairBtn").addEventListener("click", async () => {
  const r = await ask({ cmd: "unpair" });
  if (r.ok) render(r);
});
$("reconnectBtn").addEventListener("click", async () => {
  showError("");
  const r = await ask({ cmd: "reconnect" });
  if (r.ok) render(r); else showError(r.error);
});
$("pause").addEventListener("change", async (e) => {
  const r = await ask({ cmd: "setPaused", paused: e.target.checked });
  if (r.ok) render(r);
});

// ---------------------------------------------------------------- this tab
async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  currentTab = tab || null;
  if (!tab) { $("tabNote").textContent = "No tab is open."; $("shareBtn").hidden = true; return; }
  const r = await ask({ cmd: "getTabState", tabId: tab.id });
  const t = r.ok && r.tab;
  if (!t) return;
  $("tabHost").textContent = t.host ? `· ${t.host}` : "";
  $("shareBtn").hidden = false;
  $("shareBtn").disabled = false;
  if (t.restricted) {
    $("tabNote").textContent = "Chrome doesn't let extensions control this kind of page.";
    $("shareBtn").hidden = true;
  } else if (t.blocked) {
    $("tabNote").textContent = `${t.blocked} Nexus can't use it.`;
    $("shareBtn").hidden = true;
  } else if (t.shared) {
    $("tabNote").textContent = "Nexus can use this tab (it's in the “Nexus” tab group).";
    $("shareBtn").textContent = "Stop sharing this tab";
    $("shareBtn").dataset.mode = "unshare";
  } else {
    $("tabNote").textContent = "Nexus can't see or touch this tab unless you share it.";
    $("shareBtn").textContent = "Let Nexus use this tab";
    $("shareBtn").dataset.mode = "share";
  }
}
$("shareBtn").addEventListener("click", async () => {
  if (!currentTab) return;
  showError("");
  const r = await ask({ cmd: $("shareBtn").dataset.mode === "unshare" ? "unshareTab" : "shareTab", tabId: currentTab.id });
  if (!r.ok) showError(r.error);
  loadTab(); loadActivity();
});

// ---------------------------------------------------------------- send to nexus
async function sendNow(kind) {
  if (!currentTab) return;
  $("sendMsg").textContent = "Sending…";
  const r = await ask({ cmd: "sendToNexus", kind, tabId: currentTab.id, note: $("note").value });
  if (r.ok) { $("sendMsg").textContent = `Sent ${kind === "selection" ? "your selection" : "this page"} to Nexus.`; $("note").value = ""; }
  else $("sendMsg").textContent = r.error || "Couldn't send that.";
  loadActivity();
}
$("sendPage").addEventListener("click", () => sendNow("page"));
$("sendSel").addEventListener("click", () => sendNow("selection"));

// ---------------------------------------------------------------- settings
let settings = null;
function renderSettings() {
  if (!settings) return;
  $("scope").checked = settings.scope === "all_tabs";
  $("realInput").checked = settings.realInput;
  $("confirmRisky").checked = settings.confirmRisky;
  $("confirmScripts").checked = settings.confirmScripts;
  $("siteMode").value = settings.siteMode;
  $("siteList").value = (settings.siteMode === "allowlist" ? settings.allowlist : settings.blocklist).join("\n");
}
async function loadSettings() {
  const r = await ask({ cmd: "getSettings" });
  if (r.ok) { settings = r.settings; renderSettings(); }
}
async function patchSettings(patch, message = "Saved.") {
  const r = await ask({ cmd: "saveSettings", patch });
  if (!r.ok) { $("settingsMsg").textContent = r.error; return; }
  settings = r.settings;
  renderSettings();
  $("settingsMsg").textContent = message;
  loadTab();
}
$("scope").addEventListener("change", (e) => patchSettings({ scope: e.target.checked ? "all_tabs" : "agent_tabs" }));
$("realInput").addEventListener("change", (e) => patchSettings({ realInput: e.target.checked }));
$("confirmRisky").addEventListener("change", (e) => patchSettings({ confirmRisky: e.target.checked }));
$("confirmScripts").addEventListener("change", (e) => patchSettings({ confirmScripts: e.target.checked }));
$("siteMode").addEventListener("change", (e) => {
  // Show the list for the chosen mode; it is saved with the button.
  const mode = e.target.value;
  $("siteList").value = (mode === "allowlist" ? settings.allowlist : settings.blocklist).join("\n");
  patchSettings({ siteMode: mode }, mode === "allowlist" ? "Nexus may now use only the listed sites." : "Nexus may now use every site except the listed ones.");
});
$("saveSites").addEventListener("click", () => {
  const list = $("siteList").value.split(/[\s,]+/).filter(Boolean);
  const key = $("siteMode").value === "allowlist" ? "allowlist" : "blocklist";
  patchSettings({ [key]: list, siteMode: $("siteMode").value }, "Site list saved.");
});

// ---------------------------------------------------------------- activity
const OUTCOME_ICON = { ok: "•", error: "!", denied: "✕", blocked: "⛔" };
async function loadActivity() {
  const r = await ask({ cmd: "getActivity" });
  if (!r.ok) return;
  const entries = r.entries.slice().reverse().slice(0, 60);
  $("activityCount").textContent = r.entries.length ? `(${r.entries.length})` : "";
  const list = $("activity");
  list.textContent = "";
  if (!entries.length) {
    const li = document.createElement("li"); li.className = "muted"; li.textContent = "Nothing yet."; list.appendChild(li); return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "act " + e.outcome;
    const when = new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const head = document.createElement("span");
    head.textContent = `${OUTCOME_ICON[e.outcome] || "•"} ${when}  ${e.summary}` + (e.host ? ` · ${e.host}` : "");
    li.appendChild(head);
    if (e.detail && e.outcome !== "ok") { const d = document.createElement("small"); d.textContent = e.detail; li.appendChild(d); }
    list.appendChild(li);
  }
}
$("clearActivity").addEventListener("click", async () => { await ask({ cmd: "clearActivity" }); loadActivity(); });

// ---------------------------------------------------------------- shortcut hint
async function loadShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === "toggle-pause");
    $("pauseKey").textContent = c && c.shortcut ? c.shortcut : "not set (chrome://extensions/shortcuts)";
  } catch (_) { /* leave default */ }
}

function loadAll() { loadTab(); loadSettings(); loadActivity(); loadShortcut(); }

chrome.runtime.onMessage.addListener((m) => {
  if (!m) return;
  if (m.event === "status") render(m);
  if (m.event === "activity") loadActivity();
  if (m.event === "toast" && m.error) $("sendMsg").textContent = m.error;
});
ask({ cmd: "getStatus" }).then((r) => { if (r.ok) { render(r); if (r.paired) loadAll(); } else showError(r.error); });
