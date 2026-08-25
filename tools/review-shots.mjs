/* Capture the design-review screenshot set.
 *
 *   node tools/review-shots.mjs
 *
 * Same engine and same mounting path as tools/preview.mjs -- a real Chromium
 * over the DevTools protocol, the real modules in the real injection order --
 * but it produces the review's named breakpoint set rather than the product
 * shots. Kept separate so the two cannot drift into one confused script.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.design/capture-modes/screenshots');
mkdirSync(OUT, { recursive: true });
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const BG = read('src/background.js');
const MODULES = [...BG.matchAll(/'(src\/(?:lib|engine|overlay)\/[^']+\.js)'/g)]
  .map((m) => m[1]).filter((f, i, a) => a.indexOf(f) === i);
const STYLES = [...BG.matchAll(/'(src\/overlay\/[^']+\.css)'/g)]
  .map((m) => m[1]).filter((f, i, a) => a.indexOf(f) === i);

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html><meta charset="utf-8">
<style>
 *{box-sizing:border-box;margin:0}
 body{font:16px/1.5 system-ui,sans-serif;color:#16202c;background:#fff}
 header{background:#12263f;color:#fff;padding:18px 24px;display:flex;gap:20px;align-items:center;flex-wrap:wrap}
 header b{font-size:19px} nav a{color:#b9cbe4;text-decoration:none;font-size:14px}
 .hero{background:#eef2f7;padding:40px 24px}
 h1{font-size:34px;line-height:1.15;letter-spacing:-.02em}
 p{color:#5a6b80;margin-top:12px;max-width:52ch}
 .art{height:170px;border-radius:12px;margin-top:24px;background:linear-gradient(135deg,#ff6b4a,#ff2d78)}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;padding:24px}
 .card{border:1px solid #dfe6ef;border-radius:12px;padding:18px;background:#fafcff}
 footer{background:#0b1622;color:#8fa3bd;padding:20px 24px;font-size:13px}
</style>
<header><b>Meridian</b><nav><a>Product</a> <a>Docs</a> <a>Pricing</a></nav></header>
<div class="hero"><h1>Ship the thing you keep putting off.</h1>
<p>A calm place to plan, build and hand over work.</p><div class="art"></div></div>
<div class="cards">
 <div class="card"><h3>Plan</h3><p>Break a brief into slices.</p></div>
 <div class="card"><h3>Build</h3><p>Reviewed against the brief.</p></div>
 <div class="card"><h3>Hand over</h3><p>State that survives the gap.</p></div>
</div>
<footer>© Meridian — a fictional site.</footer>
`)}`;
const TALL = PAGE + encodeURIComponent(
  '<div class="cards">' + '<div class="card"><h3>More</h3><p>Below the fold.</p></div>'.repeat(20) + '</div>');

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data); const p = c.pending.get(m.id);
      if (!p) return; c.pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), rej(new Error(method + ' timed out'))), 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
    return r.result.value;
  }
  close() { this.ws.close(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mount(cdp) {
  await cdp.eval(`(() => { try { globalThis.NhakoCapture?.modules?.overlay?.destroy?.(); } catch {} })()`);
  await sleep(80);
  const backdrop = 'data:image/png;base64,' + (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  await cdp.eval(`globalThis.__sent = [];
    globalThis.chrome = Object.assign({}, globalThis.chrome, {
      runtime: { onMessage: { addListener(){} },
        sendMessage: async (m) => { globalThis.__sent.push(m); return globalThis.__reply ?? { ok: true }; } } });`);
  for (const m of MODULES) await cdp.eval(read(m));
  await cdp.eval(`globalThis.__css = ${JSON.stringify(STYLES.map(read).join('\n'))};
                  globalThis.__page = ${JSON.stringify(backdrop)};`);
  await cdp.eval(`NhakoCapture.require('overlay').start({ dataUrl: __page, cssText: __css })`);
  await sleep(320);
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(data, 'base64'));
  console.log('  wrote', name + '.png');
}

async function resize(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(220);
}

async function drag(cdp, from, to) {
  const base = { button: 'left', buttons: 1, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], ...base });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
      x: Math.round(from[0] + ((to[0] - from[0]) * i) / 8),
      y: Math.round(from[1] + ((to[1] - from[1]) * i) / 8), ...base });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], ...base });
  await sleep(200);
}

const BREAKPOINTS = [
  { name: 'desktop-1280', w: 1280, h: 800 },
  { name: 'tablet-768', w: 768, h: 1024 },
  { name: 'mobile-375', w: 375, h: 812 },
];

async function main() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), 'nc-review-'));
  const child = spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--disable-extensions', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch { /* not up */ }
    if (!wsUrl) await sleep(250);
  }
  const cdp = await CDP.attach(wsUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  try {
    for (const bp of BREAKPOINTS) {
      await resize(cdp, bp.w, bp.h);
      await cdp.send('Page.navigate', { url: TALL });
      await sleep(500);
      await mount(cdp);
      await shot(cdp, `review-overlay-idle-${bp.name}`);

      await drag(cdp, [Math.round(bp.w * 0.12), Math.round(bp.h * 0.22)],
                      [Math.round(bp.w * 0.88), Math.round(bp.h * 0.62)]);
      await shot(cdp, `review-overlay-framed-${bp.name}`);
    }

    /* the disabled control, focused, on a page with nothing below the fold */
    await resize(cdp, 1280, 800);
    await cdp.send('Page.navigate', { url: PAGE });
    await sleep(500);
    await mount(cdp);
    await cdp.eval(`(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot;
      [...sr.querySelectorAll('.nc-pill .nc-btn')]
        .find(b => b.getAttribute('aria-label') === 'Capture full page').focus(); return 1; })()`);
    await sleep(150);
    await shot(cdp, 'review-fullpage-disabled-focused-desktop-1280');

    /* the cap notice */
    await cdp.send('Page.navigate', { url: TALL });
    await sleep(400);
    await mount(cdp);
    await cdp.eval(`(() => { NhakoCapture.modules.overlay.session.toolbar
      .setNotice('Full page capped at 16384px — page is longer'); return 1; })()`);
    await sleep(150);
    await shot(cdp, 'review-cap-notice-desktop-1280');

    /* degraded-copy notice at a narrow width -- the T12 case */
    await resize(cdp, 480, 720);
    await mount(cdp);
    await drag(cdp, [60, 160], [420, 460]);
    await cdp.eval(`globalThis.__reply = { ok: true, degraded: true, note: 'Pasted as HTML' };`);
    await cdp.eval(`(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot;
      sr.querySelector('.nc-btn--primary').click(); return 1; })()`);
    await sleep(300);
    await shot(cdp, 'review-degraded-copy-narrow-480');
    await cdp.eval(`globalThis.__reply = { ok: true };`);

    /* forced-colors */
    await resize(cdp, 1280, 800);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    await cdp.send('Page.navigate', { url: TALL });
    await sleep(400);
    await mount(cdp);
    await drag(cdp, [160, 200], [1120, 560]);
    await shot(cdp, 'review-forced-colors-desktop-1280');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  } finally {
    cdp.close();
    child.kill();
  }
  console.log('\nreview screenshots written to .design/capture-modes/screenshots/');
}

main().catch((e) => { console.error(e); process.exit(1); });
