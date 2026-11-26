const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("id") || "";

function ask(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false })));
}

let answered = false;
async function answer(allow) {
  if (answered) return;
  answered = true;
  $("allow").disabled = true; $("deny").disabled = true;
  await ask({ cmd: "answerConfirm", id, allow });
  window.close();
}

(async () => {
  const r = await ask({ cmd: "getConfirm", id });
  if (!r.ok || !r.details) {
    $("title").textContent = "This request has expired.";
    $("deny").textContent = "Close";
    $("deny").addEventListener("click", () => window.close());
    return;
  }
  const d = r.details;
  $("title").textContent = d.title || "Nexus is asking for permission";
  $("site").textContent = d.host ? `on ${d.host}` : "";
  for (const reason of d.reasons || []) {
    const span = document.createElement("span");
    span.className = "badge";
    span.textContent = reason;
    $("reasons").appendChild(span);
  }
  $("target").textContent = d.target || "";
  if (d.detail) { $("detail").hidden = false; $("detail").textContent = d.detail; }

  // Deny has focus, and Allow wakes up a moment later, so a stray Enter or Space
  // from whatever the user was typing can never approve anything.
  $("deny").focus();
  setTimeout(() => { $("allow").disabled = false; }, 800);
  $("deny").addEventListener("click", () => answer(false));
  $("allow").addEventListener("click", (e) => { if (e.isTrusted) answer(true); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") answer(false); });

  const tick = () => {
    const left = Math.max(0, Math.round((d.expires_at - Date.now()) / 1000));
    $("timer").textContent = `Nothing happens unless you allow it. Denies automatically in ${left}s.`;
  };
  tick();
  setInterval(tick, 1000);
})();
