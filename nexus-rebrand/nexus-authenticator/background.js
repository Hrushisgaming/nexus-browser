// Service worker: injects the region selector, captures the tab, decodes the QR code,
// and hands the result to the popup through memory-only session storage.
importScripts('vendor/jsQR.js');

const CANT_SCAN = "Browser pages (settings, the new tab page, the web store) can't be scanned. Open the QR code in a normal tab, or use Image / QR instead.";

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'auto-lock') chrome.storage.session.remove('session');
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'scan-screen') return;
  try { await startRegionScan(tab); } catch (e) { await setResult({ error: e.message }); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    try {
      if (msg.type === 'start-region-scan') {
        await startRegionScan(await activeTab());
      } else if (msg.type === 'scan-visible') {
        const tab = await activeTab();
        await scanRegion(tab, null);
      } else if (msg.type === 'region-selected' && sender.tab) {
        await scanRegion(sender.tab, msg);
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab;
}

async function startRegionScan(tab) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-select.js'] });
  } catch {
    throw new Error(CANT_SCAN);
  }
}

async function scanRegion(tab, sel) {
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch {
    throw new Error(CANT_SCAN);
  }
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (sel) {
    const kx = bmp.width / sel.vw, ky = bmp.height / sel.vh;
    sx = Math.max(0, Math.floor(sel.rect.x * kx));
    sy = Math.max(0, Math.floor(sel.rect.y * ky));
    sw = Math.min(bmp.width - sx, Math.ceil(sel.rect.w * kx));
    sh = Math.min(bmp.height - sy, Math.ceil(sel.rect.h * ky));
  }
  const text = decodeRegion(bmp, sx, sy, sw, sh);
  if (!text) {
    await setResult({ error: sel ? 'No QR code found in that area. Try selecting a little more around it.' : 'No QR code found on the visible page.' });
    return;
  }
  await setResult({ text });
}

function decodeRegion(bmp, sx, sy, sw, sh) {
  const attempts = [
    { scale: 1, pad: 24 }, { scale: 2, pad: 48 }, { scale: 1, pad: 0 }, { scale: 0.5, pad: 12 },
  ];
  for (const { scale, pad } of attempts) {
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    if (w < 21 || h < 21 || w + 2 * pad > 4000 || h + 2 * pad > 4000) continue;
    const canvas = new OffscreenCanvas(w + 2 * pad, h + 2 * pad);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, sx, sy, sw, sh, pad, pad, w, h);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (code && code.data) return code.data;
  }
  return null;
}

async function setResult(result) {
  await chrome.storage.session.set({
    pendingScan: { ...result, at: Date.now() },
  });
  await chrome.action.setBadgeBackgroundColor({ color: result.error ? '#e5484d' : '#2fbf9f' });
  await chrome.action.setBadgeText({ text: result.error ? '!' : '1' });
  try { await chrome.action.openPopup(); } catch { /* needs a focused window; the badge tells the user */ }
}
