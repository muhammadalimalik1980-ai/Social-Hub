const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
let ElectronBlocker = null;
try { ({ ElectronBlocker } = require('@ghostery/adblocker-electron')); } catch {} // app still runs without it

const TOP = 56, SIDE = 210, GAP = 6, MAX = 16;
const SITES = {
  youtube:   { name: 'YouTube',   url: 'https://www.youtube.com' },
  instagram: { name: 'Instagram', url: 'https://www.instagram.com' },
  tiktok:    { name: 'TikTok',    url: 'https://www.tiktok.com' },
  x:         { name: 'X',         url: 'https://x.com' },
  facebook:  { name: 'Facebook',  url: 'https://www.facebook.com' },
  reddit:    { name: 'Reddit',    url: 'https://www.reddit.com' },
  linkedin:  { name: 'LinkedIn',  url: 'https://www.linkedin.com' },
  telegram:  { name: 'Telegram',  url: 'https://web.telegram.org' },
  whatsapp:  { name: 'WhatsApp',  url: 'https://web.whatsapp.com' },
};

let win, mode = 'rect', active = null, fit = true, scale = 1, selected = null;
let adblock = true, blocker = null;
const TARGET = 1000; // CSS width every site is laid out at, so nothing is cut off
const open = new Map(); // id -> { id, name, view }

// Extra YouTube layer: ads come from YouTube's own servers, so skip them in the player too.
const YT_SKIP = `(() => { if (window.__hubSkip) return; let muted = null;
  window.__hubSkip = setInterval(() => {
    if (window.__hubAdblock === false) return;
    const p = document.querySelector('.html5-video-player.ad-showing');
    const v = document.querySelector('video');
    if (p && v) {
      if (muted === null) muted = v.muted;
      v.muted = true;
      if (isFinite(v.duration) && v.duration > 0) { v.playbackRate = 16; v.currentTime = v.duration; }
    } else if (muted !== null && v) { v.muted = muted; v.playbackRate = 1; muted = null; }
    document.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-overlay-close-button').forEach(b => b.click());
  }, 250); })();`;

// Pops the playing (else biggest visible) video into Picture-in-Picture; a second press closes it.
const PIP = `(async () => {
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return 'closed'; }
    const vids = [...document.querySelectorAll('video')].filter(v => v.readyState > 0);
    if (!vids.length) return 'none';
    const area = v => { const r = v.getBoundingClientRect();
      return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)); };
    vids.sort((a, b) => ((b.paused === false) - (a.paused === false)) || area(b) - area(a));
    const v = vids[0];
    v.removeAttribute('disablePictureInPicture'); v.disablePictureInPicture = false;
    await v.requestPictureInPicture();
    return 'ok';
  } catch (e) { return 'error'; }
})()`;

function injectYT(wc) {
  if (wc.isDestroyed() || !/youtube\.com/.test(wc.getURL())) return;
  wc.executeJavaScript(`window.__hubAdblock=${adblock};` + YT_SKIP).catch(() => {});
}

function syncBlocking() {
  for (const o of open.values()) {
    const wc = o.view.webContents;
    if (wc.isDestroyed()) continue;
    try {
      if (blocker) adblock ? blocker.enableBlockingInSession(wc.session) : blocker.disableBlockingInSession(wc.session);
    } catch (e) { report('Ad block unavailable', e); }
    if (/youtube\.com/.test(wc.getURL())) wc.executeJavaScript(`window.__hubAdblock=${adblock}`).catch(() => {});
  }
}

function report(label, e) {
  console.log(label, e);
  if (win && !win.isDestroyed()) win.webContents.send('toast', label + ': ' + ((e && e.message) || e));
}

function push() {
  if (!win) return;
  win.webContents.send('state', {
    mode, active, fit, scale, adblock,
    sel: open.has(selected) ? { id: selected, name: open.get(selected).name, scale: open.get(selected).scale } : null,
    sites: Object.entries(SITES).map(([id, s]) => ({ id, name: s.name, open: open.has(id) })),
    tabs: [...open.values()].map(o => ({ id: o.id, name: o.name })),
  });
}

function openSite(id, name, url) {
  const view = new WebContentsView({ webPreferences: { partition: 'persist:' + id, sandbox: true } });
  const wc = view.webContents;
  wc.setUserAgent(app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(/ [\w-]+\/\d[\w.]* (?=Chrome)/, ' '));
  wc.setWindowOpenHandler(() => ({ action: 'allow' })); // keeps login popups working
  wc.on('dom-ready', () => { autoFit(); injectYT(wc); });
  wc.on('did-navigate', autoFit);
  wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
    if (isMain && code !== -3) report('Page failed to load', { message: desc + ' (' + code + ')' });
  });
  wc.loadURL(url).catch(() => {});
  win.contentView.addChildView(view);
  open.set(id, { id, name, view, scale: 1 });
  selected = id;
  syncBlocking();
  wc.on('focus', () => { if (selected !== id) { selected = id; push(); } });
  active = id;
}

function closeSite(id) {
  const o = open.get(id);
  if (!o) return;
  win.contentView.removeChildView(o.view);
  o.view.webContents.close();
  open.delete(id);
  if (selected === id) selected = open.keys().next().value || null;
  if (active === id) active = open.keys().next().value || null;
}

function arrange() {
  if (!win) return;
  const [W, H] = win.getContentSize();
  const items = [...open.values()];
  items.forEach(i => i.view.setVisible(false));
  if (!items.length) return;

  if (mode === 'vertical') {
    const a = open.get(active) || items[0];
    a.view.setBounds({ x: SIDE, y: TOP, width: W - SIDE, height: H - TOP });
    a.view.setVisible(true);
    return;
  }

  const list = items.slice(0, MAX), n = list.length;

  if (mode === 'focus') { // one big view on the left, the rest stacked on the right
    const a = open.get(active) || list[0];
    const rest = list.filter(i => i !== a);
    const h = H - TOP, mw = rest.length ? Math.round((W - SIDE) * 0.7) : W - SIDE;
    a.view.setBounds({ x: SIDE + GAP, y: TOP + GAP, width: mw - GAP * 2, height: h - GAP * 2 });
    a.view.setVisible(true);
    const th = (h - GAP * (rest.length + 1)) / (rest.length || 1);
    rest.forEach((it, i) => {
      it.view.setBounds({
        x: SIDE + mw, y: Math.round(TOP + GAP + i * (th + GAP)),
        width: W - SIDE - mw - GAP, height: Math.round(th),
      });
      it.view.setVisible(true);
    });
    return;
  }

  let rows = n <= 3 ? 1 : n <= 8 ? 2 : n <= 12 ? 3 : 4;
  if (mode === 'columns') rows = 1;
  if (mode === 'rows') rows = n;
  const cols = Math.ceil(n / rows);
  const w = W, h = H - TOP;
  let cw = (w - GAP * (cols + 1)) / cols, ch = (h - GAP * (rows + 1)) / rows;
  let ox = GAP, oy = TOP + GAP;

  if (mode === 'square') {
    const s = Math.max(100, Math.min(cw, ch));
    cw = ch = s;
    ox = (w - (s * cols + GAP * (cols - 1))) / 2;
    oy = TOP + (h - (s * rows + GAP * (rows - 1))) / 2;
  }

  list.forEach((it, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    it.view.setBounds({
      x: Math.round(ox + c * (cw + GAP)), y: Math.round(oy + r * (ch + GAP)),
      width: Math.round(cw), height: Math.round(ch),
    });
    it.view.setVisible(true);
  });
}

// Zoom each visible site so its page is laid out at TARGET width: text and video fit the tile.
function autoFit() {
  for (const it of open.values()) {
    const wc = it.view.webContents;
    if (wc.isDestroyed()) continue;
    const w = it.view.getBounds().width;
    const base = fit && w > 0 ? Math.min(1, Math.max(0.4, w / TARGET)) : 1;
    wc.setZoomFactor(Math.min(3, Math.max(0.25, base * scale * (it.scale || 1)))); // slider multiplies auto-fit
  }
}

function layout() { arrange(); autoFit(); }
function refresh() { layout(); push(); }

// Runs last and can never break the app: any ad block failure is only logged.
async function initAdblock() {
  if (!ElectronBlocker) return;
  try {
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: path.join(app.getPath('userData'), 'adblock-engine.bin'),
      read: fs.promises.readFile, write: fs.promises.writeFile,
    });
    syncBlocking();
  } catch (e) { console.log('Ad block failed to start:', e && e.message); }
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1400, height: 860, backgroundColor: '#12151c', title: 'Social Hub',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  win.webContents.on('did-finish-load', refresh);
  win.on('resize', layout);

  const safe = (label, fn) => (...a) => {
    try { fn(...a); } catch (e) { report(label, e); }
    refresh();
  };
  ipcMain.on('toggle', safe('Could not open site', (_, id) => {
    open.has(id) ? closeSite(id) : openSite(id, SITES[id].name, SITES[id].url);
  }));
  ipcMain.on('add', safe('Could not open address', (_, raw) => {
    let url = String(raw || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    openSite('c' + Date.now(), new URL(url).hostname.replace(/^www\./, ''), url);
  }));
  ipcMain.on('fit', () => { fit = !fit; refresh(); });
  ipcMain.on('scale', (_, v) => { scale = Math.min(2, Math.max(0.5, Number(v) || 1)); autoFit(); });
  ipcMain.on('itemScale', (_, v) => {
    const o = open.get(selected);
    if (o) { o.scale = Math.min(3, Math.max(0.3, Number(v) || 1)); autoFit(); }
  });
  ipcMain.on('adblock', () => { adblock = !adblock; syncBlocking(); refresh(); });
  ipcMain.on('pip', async () => {
    const order = [selected, ...open.keys()].filter((id, i, a) => open.has(id) && a.indexOf(id) === i);
    for (const id of order) {
      try {
        const r = await open.get(id).view.webContents.executeJavaScript(PIP, true);
        if (r === 'ok' || r === 'closed') return;
      } catch {}
    }
    win.webContents.send('toast', 'No video found for Picture-in-Picture');
  });
  ipcMain.on('mode', (_, m) => { mode = m; refresh(); });
  ipcMain.on('activate', safe('Switch failed', (_, id) => { active = id; }));
  ipcMain.on('close', safe('Close failed', (_, id) => { closeSite(id); }));

  initAdblock();
});

app.on('window-all-closed', () => app.quit());
