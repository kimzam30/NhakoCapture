/* Capture the product shots the Chrome Web Store graphics are built from.
 *
 *   node tools/store-shots.mjs        -> docs/store/raw/*.png
 *   node tools/render-store.mjs       -> docs/store/*.png (the upload set)
 *
 * The same approach as tools/preview.mjs: a real headless Chromium, the real
 * overlay modules injected in the order background.js uses, and the frame and
 * marks drawn with real dispatched input. Nothing in the store graphics is a
 * mockup -- every overlay pixel is drawn by the extension's own code.
 *
 * The pages are fictional fixtures defined below. Rendered at 2x, so the
 * shots stay sharp when the store graphics scale them into a window frame.
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/store/raw');
const W = 1280, H = 720;

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const BG = read('src/background.js');
const MODULES = [...BG.matchAll(/'(src\/(?:lib|engine|overlay)\/[^']+\.js)'/g)]
  .map((m) => m[1]).filter((f, i, a) => a.indexOf(f) === i);
const STYLES = [...BG.matchAll(/'(src\/overlay\/[^']+\.css)'/g)]
  .map((m) => m[1]).filter((f, i, a) => a.indexOf(f) === i);
const CSS = STYLES.map(read).join('\n');

/* --- fixtures -------------------------------------------------------------- */

const page = (body, extra = '') => `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html><meta charset="utf-8">
<style>
 *{box-sizing:border-box;margin:0}
 body{font:16px/1.5 Inter,system-ui,sans-serif;color:#16202c;background:#fff}
 header{background:#12263f;color:#fff;padding:18px 36px;display:flex;gap:30px;align-items:center}
 header b{font-size:19px;letter-spacing:-.01em} nav a{color:#b9cbe4;text-decoration:none;font-size:14px;margin-right:22px}
 ${extra}
</style>${body}`)}`;

/* A product landing page: the hero shot. */
const LANDING = page(`
<header><b>Meridian</b><nav><a>Product</a><a>Docs</a><a>Pricing</a><a>Blog</a></nav></header>
<div class="hero">
  <div><h1>Ship the thing you keep putting off.</h1>
  <p>A calm place to plan, build and hand over work, without another dashboard to check every morning.</p>
  <span class="cta">Start free</span></div>
  <div class="art"><i></i><i></i><i></i></div>
</div>
<div class="cards">
  <div class="card"><h3>Plan</h3><p>Break a brief into slices you can actually finish in one sitting.</p></div>
  <div class="card"><h3>Build</h3><p>Every change reviewed against the brief, not just the diff.</p></div>
  <div class="card"><h3>Hand over</h3><p>State that survives the gap between one session and the next.</p></div>
</div>
<footer>© Meridian. A fictional site.</footer>`, `
 .hero{background:#eef2f7;padding:56px 36px;display:grid;grid-template-columns:1fr 420px;gap:44px;align-items:center}
 h1{font-size:44px;line-height:1.1;letter-spacing:-.03em}
 p{color:#5a6b80;margin-top:16px;max-width:50ch}
 .cta{display:inline-block;margin-top:22px;background:#12263f;color:#fff;padding:10px 18px;border-radius:9px;font-weight:600;font-size:15px}
 .art{height:230px;border-radius:14px;background:linear-gradient(135deg,#ff6b4a,#ff2d78);position:relative;overflow:hidden}
 .art i{position:absolute;border-radius:50%;background:rgba(255,255,255,.18)}
 .art i:nth-child(1){width:180px;height:180px;right:-40px;top:-50px}
 .art i:nth-child(2){width:110px;height:110px;left:40px;bottom:-30px}
 .art i:nth-child(3){width:50px;height:50px;left:190px;top:40px}
 .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;padding:34px 36px}
 .card{border:1px solid #dfe6ef;border-radius:12px;padding:22px;background:#fafcff}
 .card h3{font-size:17px;margin-bottom:8px} .card p{font-size:14px;color:#5a6b80}
 footer{background:#0b1622;color:#8fa3bd;padding:22px 36px;font-size:13px}`);

/* A billing page with details worth hiding: the blur shot. All fictional. */
const BILLING = page(`
<header><b>Northwind</b><nav><a>Dashboard</a><a>Team</a><a>Billing</a><a>Settings</a></nav></header>
<main>
  <h1>Billing</h1>
  <div class="grid">
    <section class="panel">
      <h2>Account</h2>
      <dl>
        <dt>Name</dt><dd>Jordan Avery</dd>
        <dt>Email</dt><dd>jordan.avery@example.com</dd>
        <dt>Phone</dt><dd>+1 (555) 014 2298</dd>
        <dt>Card</dt><dd>Visa ending 4242, expires 08/29</dd>
        <dt>Address</dt><dd>12 Harbour Lane, Springfield</dd>
      </dl>
    </section>
    <section class="panel">
      <h2>Plan</h2>
      <div class="plan"><b>Team</b><span>$48 / month</span></div>
      <p class="note">Renews on 1 November. 6 of 10 seats used.</p>
      <div class="bar"><i></i></div>
      <button>Change plan</button>
    </section>
  </div>
  <section class="panel wide">
    <h2>Invoices</h2>
    <table>
      <tr><th>Date</th><th>Invoice</th><th>Amount</th><th>Status</th></tr>
      <tr><td>1 Oct 2026</td><td>NW-20931</td><td>$48.00</td><td><em>Paid</em></td></tr>
      <tr><td>1 Sep 2026</td><td>NW-19874</td><td>$48.00</td><td><em>Paid</em></td></tr>
      <tr><td>1 Aug 2026</td><td>NW-18802</td><td>$36.00</td><td><em>Paid</em></td></tr>
    </table>
  </section>
</main>`, `
 body{background:#f5f7fa}
 main{padding:30px 36px}
 h1{font-size:28px;letter-spacing:-.02em;margin-bottom:20px}
 .grid{display:grid;grid-template-columns:1.25fr 1fr;gap:22px}
 .panel{background:#fff;border:1px solid #e1e7ef;border-radius:12px;padding:22px 24px}
 .panel.wide{margin-top:22px}
 h2{font-size:15px;color:#5a6b80;font-weight:600;margin-bottom:14px;text-transform:uppercase;letter-spacing:.06em}
 dl{display:grid;grid-template-columns:100px 1fr;row-gap:12px;font-size:15px}
 dt{color:#7a8aa0} dd{font-weight:500}
 .plan{display:flex;justify-content:space-between;align-items:baseline;font-size:22px}
 .plan span{font-size:16px;color:#5a6b80}
 .note{color:#5a6b80;font-size:14px;margin:10px 0 12px}
 .bar{height:8px;background:#e8edf4;border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;width:60%;background:#3b82f6}
 button{margin-top:18px;border:0;background:#12263f;color:#fff;font:600 14px Inter,sans-serif;padding:10px 16px;border-radius:8px}
 table{width:100%;border-collapse:collapse;font-size:14px}
 th{text-align:left;color:#7a8aa0;font-weight:500;padding:6px 0;border-bottom:1px solid #e8edf4}
 td{padding:10px 0;border-bottom:1px solid #f0f3f7} em{font-style:normal;color:#16a34a;font-weight:600}`);

/* A long article: the whole-page shot. */
const ARTICLE = page(`
<header class="sticky"><b>Field Notes</b><nav><a>Latest</a><a>Guides</a><a>About</a></nav></header>
<article>
  <p class="kicker">Guide · 6 min read</p>
  <h1>How to write a bug report people actually fix</h1>
  <p class="lede">The best bug reports are short, specific, and come with a picture of the problem.</p>
  <div class="img a"></div>
  ${['Say what you expected', 'Show, don’t describe', 'Mark the exact spot', 'Hide what isn’t yours to share', 'Keep it to one problem']
    .map((h, i) => `<h2>${i + 1}. ${h}</h2><p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet. Cras mattis consectetur purus sit amet fermentum. '.repeat(2)}</p>${i % 2 ? '<div class="img b"></div>' : '<p>Nulla vitae elit libero, a pharetra augue. Maecenas sed diam eget risus varius blandit sit amet non magna.</p>'}`).join('')}
</article>
<footer>© Field Notes. A fictional site.</footer>`, `
 header.sticky{position:sticky;top:0;z-index:2}
 article{max-width:720px;margin:0 auto;padding:44px 24px}
 .kicker{color:#e0457b;font-weight:600;font-size:14px}
 h1{font-size:40px;line-height:1.12;letter-spacing:-.03em;margin:8px 0 14px}
 .lede{font-size:20px;color:#4b5b70}
 h2{font-size:24px;letter-spacing:-.02em;margin:34px 0 10px}
 p{color:#3a4a5e;margin-top:10px}
 .img{height:260px;border-radius:14px;margin:26px 0}
 .img.a{background:linear-gradient(135deg,#ffd6e8,#d9ccff)}
 .img.b{background:linear-gradient(135deg,#c7f0e3,#cfe0ff)}
 footer{background:#0b1622;color:#8fa3bd;padding:22px 36px;font-size:13px}`);

/* --- minimal CDP client (as in tools/preview.mjs) --------------------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  on(method, fn) { this.handlers.set(method, fn); }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method) { cdp.handlers.get(msg.method)?.(msg.params); return; }
      const p = cdp.pending.get(msg.id);
      if (!p) return;
      cdp.pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), rej(new Error(`${method} timed out`))), 30000);
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

function launch(port, profile) {
  return spawn('google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--hide-scrollbars', '--force-device-scale-factor=2',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    `--window-size=${W},${H}`, 'about:blank',
  ], { stdio: 'ignore' });
}

async function targetWs(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page');
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}

/* --- input ------------------------------------------------------------------ */
const mouse = (cdp, type, x, y) => cdp.send('Input.dispatchMouseEvent',
  { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });

async function drag(cdp, from, to, steps = 10) {
  await mouse(cdp, 'mousePressed', ...from);
  for (let i = 1; i <= steps; i++) {
    await mouse(cdp, 'mouseMoved',
      Math.round(from[0] + ((to[0] - from[0]) * i) / steps),
      Math.round(from[1] + ((to[1] - from[1]) * i) / steps));
  }
  await mouse(cdp, 'mouseReleased', ...to);
  await sleep(120);
}

/* A freehand stroke through several points: the pen should look drawn. */
async function stroke(cdp, pts) {
  await mouse(cdp, 'mousePressed', ...pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    for (let s = 1; s <= 6; s++) {
      await mouse(cdp, 'mouseMoved', Math.round(a[0] + ((b[0] - a[0]) * s) / 6), Math.round(a[1] + ((b[1] - a[1]) * s) / 6));
    }
  }
  await mouse(cdp, 'mouseReleased', ...pts.at(-1));
  await sleep(120);
}

/* Viewport centre-line of an element, so a mark lands on the text it means. */
async function box(cdp, selector, index = 0) {
  return cdp.eval(`(() => { const r = document.querySelectorAll(${JSON.stringify(selector)})[${index}].getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom),
             cy: Math.round(r.top + r.height / 2) }; })()`);
}

async function hover(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(150);
}

const shadowEval = (cdp, body) =>
  cdp.eval(`(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot; ${body} })()`);

async function pickTool(cdp, label) {
  await shadowEval(cdp, `[...sr.querySelectorAll('.nc-tool')].find(b => b.getAttribute('aria-label') === '${label}').click();`);
  await sleep(150);
}

async function pickInk(cdp, ink) {
  await shadowEval(cdp, `sr.querySelector('.nc-swatch[data-ink="${ink}"]').click();`);
  await sleep(100);
}

async function typeText(cdp, at, text) {
  await mouse(cdp, 'mousePressed', ...at);
  await mouse(cdp, 'mouseReleased', ...at);
  await sleep(250);
  await cdp.send('Input.insertText', { text });
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  await sleep(200);
}

/* Capture first, then mount -- the order background.js uses. */
async function mountOverlay(cdp) {
  await cdp.eval(`(() => { try { globalThis.NhakoCapture?.modules?.overlay?.destroy?.(); } catch {} })()`);
  await sleep(80);
  const backdrop = 'data:image/png;base64,' + (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  await cdp.eval(`globalThis.chrome = Object.assign({}, globalThis.chrome, {
    runtime: { onMessage: { addListener(){} }, sendMessage: async () => ({ ok: true }),
               getManifest: () => ({ version: 'store' }) } });`);
  for (const m of MODULES) await cdp.eval(read(m));
  await cdp.eval(`globalThis.__css = ${JSON.stringify(CSS)}; globalThis.__page = ${JSON.stringify(backdrop)};`);
  await cdp.eval(`NhakoCapture.require('overlay').start({ dataUrl: __page, cssText: __css })`);
  await sleep(450);
}

async function open(cdp, url) {
  await cdp.eval(`(() => { try { globalThis.NhakoCapture?.modules?.overlay?.destroy?.(); } catch {} })()`);
  await cdp.send('Page.navigate', { url });
  await sleep(1200);
}

async function shoot(cdp, name) {
  await sleep(250);   // let the springs settle
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`wrote docs/store/raw/${name}.png`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const port = 9100 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), 'nc-store-'));
  const child = launch(port, profile);
  let cdp;
  try {
    cdp = await CDP.attach(await targetWs(port));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: W, height: H, deviceScaleFactor: 2, mobile: false });

    /* 1. The moment after the shortcut: page frozen, pill up, nothing framed. */
    await open(cdp, LANDING);
    await mountOverlay(cdp);
    await hover(cdp, 640, 420);
    await shoot(cdp, 'idle');

    /* 2. The hero: framed and marked up. */
    await drag(cdp, [24, 104], [1256, 470]);
    await pickTool(cdp, 'Highlighter');
    await pickInk(cdp, 'amber');
    await drag(cdp, [42, 166], [560, 166]);
    await pickTool(cdp, 'Arrow');
    await pickInk(cdp, 'red');
    await drag(cdp, [700, 360], [835, 268]);
    await pickTool(cdp, 'Text');
    await typeText(cdp, [560, 370], 'make this pop');
    await pickTool(cdp, 'Pen');
    await pickInk(cdp, 'pink');
    await stroke(cdp, [[40, 316], [80, 300], [150, 298], [190, 312], [178, 334], [110, 342], [50, 336], [40, 316]]);
    await hover(cdp, 300, 700);
    await shoot(cdp, 'hero');

    /* 3. Markup: the rail in use, magnifier parked over the detail. */
    await open(cdp, LANDING);
    const lede = await box(cdp, '.hero p');
    const cta = await box(cdp, '.cta');
    await mountOverlay(cdp);
    await drag(cdp, [24, 104], [1256, 470]);
    await pickTool(cdp, 'Highlighter');
    await pickInk(cdp, 'green');
    await drag(cdp, [lede.x, lede.y + 13], [lede.x + 440, lede.y + 13]);
    await pickTool(cdp, 'Arrow');
    await pickInk(cdp, 'red');
    await drag(cdp, [cta.r + 150, cta.b + 40], [cta.r + 14, cta.cy + 4]);
    await pickTool(cdp, 'Text');
    await typeText(cdp, [cta.r + 110, cta.b + 46], 'new button colour?');
    await pickTool(cdp, 'Magnifier');
    await mouse(cdp, 'mousePressed', cta.x + 40, cta.cy);
    await mouse(cdp, 'mouseReleased', cta.x + 40, cta.cy);
    await sleep(200);
    await shoot(cdp, 'markup');

    /* 4. Blur: personal details destroyed, not dimmed. Measured before the
     * overlay goes up -- the backdrop is a still of this exact layout. */
    await open(cdp, BILLING);
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(await box(cdp, 'dd', i));
    const card = await box(cdp, '.panel');
    await mountOverlay(cdp);
    await drag(cdp, [card.x - 12, card.y - 12], [W - 24, card.b + 70]);
    await pickTool(cdp, 'Blur');
    for (const r of rows) await drag(cdp, [r.x - 6, r.y - 2], [r.x + 300, r.b + 2]);
    await pickTool(cdp, 'Arrow');
    await pickInk(cdp, 'pink');
    await drag(cdp, [rows[1].x + 470, rows[3].b + 40], [rows[1].x + 330, rows[2].cy]);
    await pickTool(cdp, 'Text');
    await typeText(cdp, [rows[1].x + 400, rows[3].b + 48], 'gone for good');
    await hover(cdp, 300, 700);
    await shoot(cdp, 'blur');

    /* 5. Whole page: a real scroll-and-stitch. The loop asks the service
     * worker for each tile; here that request is answered by a viewport
     * screenshot -- what captureVisibleTab returns -- so the scrolling,
     * sticky-header handling and stitching are all the extension's own. */
    await open(cdp, ARTICLE);
    await mountOverlay(cdp);
    await cdp.send('Runtime.addBinding', { name: '__ncTile' });
    cdp.on('Runtime.bindingCalled', async ({ name }) => {
      if (name !== '__ncTile') return;
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await cdp.eval(`globalThis.__tileResolve({ ok: true, dataUrl: 'data:image/png;base64,${data}' })`);
    });
    await cdp.eval(`(() => {
      globalThis.__done = null;
      chrome.runtime.sendMessage = async (msg) => {
        if (msg.type === 'nc:capture-tile') {
          return new Promise((res) => { globalThis.__tileResolve = res; __ncTile(''); });
        }
        if (msg.type === 'nc:full-page-done') { globalThis.__done = msg; }
        return { ok: true };
      };
      NhakoCapture.modules.overlay.session.captureFullPage();
    })()`);
    for (let i = 0; i < 120 && !(await cdp.eval('!!globalThis.__done')); i++) await sleep(500);
    const done = await cdp.eval('globalThis.__done && globalThis.__done.dataUrl');
    if (!done) throw new Error('the whole-page capture never finished');
    writeFileSync(join(OUT, 'fullpage.png'), Buffer.from(done.split(',')[1], 'base64'));
    console.log('wrote docs/store/raw/fullpage.png');
  } finally {
    try { cdp?.close(); } catch { /* closing anyway */ }
    child.kill('SIGKILL');
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
