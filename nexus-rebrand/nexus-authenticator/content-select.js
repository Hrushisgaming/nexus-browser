// Injected on demand. Lets the user drag a rectangle around a QR code,
// then asks the background worker to capture and decode that region.
(() => {
  if (window.__nexusAuthSelecting) return;
  window.__nexusAuthSelecting = true;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .shade{position:fixed;inset:0;cursor:crosshair;background:rgba(6,9,20,.38);touch-action:none}
      .box{position:fixed;display:none;border:2px solid #5ee6d0;background:rgba(94,230,208,.10);
           box-shadow:0 0 0 1px rgba(6,9,20,.6);pointer-events:none}
      .hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:9px 14px;border-radius:10px;
            background:#12162a;color:#e8ecf8;font:13px/1.3 system-ui,-apple-system,sans-serif;
            box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap}
      kbd{background:#252b47;border-radius:4px;padding:1px 6px;font:inherit}
    </style>
    <div class="shade"></div>
    <div class="box"></div>
    <div class="hint">Drag around the QR code to scan it. <kbd>Esc</kbd> cancels.</div>`;
  document.documentElement.appendChild(host);

  const shade = root.querySelector('.shade');
  const box = root.querySelector('.box');
  let start = null;
  let rect = null;

  function cleanup() {
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    window.__nexusAuthSelecting = false;
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); }
  }
  window.addEventListener('keydown', onKey, true);

  shade.addEventListener('pointerdown', (e) => {
    shade.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
    box.style.display = 'block';
    update(e);
  });
  shade.addEventListener('pointermove', (e) => { if (start) update(e); });
  shade.addEventListener('pointerup', async (e) => {
    if (!start) return;
    update(e);
    const r = rect;
    cleanup();
    if (!r || r.w < 12 || r.h < 12) return;
    // let the page repaint without the overlay before the screenshot is taken
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 80))));
    chrome.runtime.sendMessage({
      type: 'region-selected', rect: r, vw: window.innerWidth, vh: window.innerHeight,
    });
  });

  function update(e) {
    const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
    const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
    rect = { x, y, w, h };
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box.style.width = w + 'px'; box.style.height = h + 'px';
  }
})();
