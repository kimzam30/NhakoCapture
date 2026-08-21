/* Render the overlay in a real Chromium engine and screenshot it.
 *
 *   node tools/preview.mjs [outdir]
 *
 * Drives the browser over the DevTools Protocol -- no dependencies, Node 22's
 * built-in WebSocket. This mirrors the production flow closely: the backdrop is
 * produced by a real Page.captureScreenshot of a real page, exactly as
 * captureVisibleTab would, and the frame is drawn with real dispatched input,
 * so the pointer path under test is the one users get.
 *
 * There is no way to click the toolbar action from here, so the background
 * worker is bypassed: the same overlay modules are evaluated in the same order
 * and start() is called directly. Everything downstream -- shadow root,
 * tokens.css, overlay.css, scrim geometry, handles, badge -- is the real thing.
 *
 * This is NOT a substitute for loading the extension in Brave.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const HERO = ARGS.includes('--hero');
const OUT = ARGS.find((a) => !a.startsWith('--')) || join(ROOT, 'preview');
const W = 1280, H = 800;

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/* Injection order and stylesheet list are parsed out of background.js rather
 * than duplicated here. A second copy silently drifts the moment a module is
 * added, and then this harness tests a build nobody ships. */
const BG = read('src/background.js');
const MODULES = [...BG.matchAll(/'(src\/(?:lib|engine|overlay)\/[^']+\.js)'/g)]
  .map((m) => m[1]).filter((f, i, a) => a.indexOf(f) === i);
const STYLES = [...BG.matchAll(/'(src\/overlay\/[^']+\.css)'/g)]
  .map((m) => m[1]).filter((f, i, a) => a.indexOf(f) === i);
if (!MODULES.length || !STYLES.length) throw new Error('could not parse module list from background.js');

/* A stand-in webpage: light, busy, and with a dark band, so the scrim and the
 * marquee can be judged against both extremes. */
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html><meta charset="utf-8">
<style>
 *{box-sizing:border-box;margin:0}
 body{font:16px/1.5 system-ui,sans-serif;color:#16202c;background:#fff}
 header{background:#12263f;color:#fff;padding:18px 32px;display:flex;gap:28px;align-items:center}
 header b{font-size:19px} nav a{color:#b9cbe4;text-decoration:none;font-size:14px}
 .hero{background:#eef2f7;padding:48px 32px;display:grid;grid-template-columns:1fr 380px;gap:40px;align-items:center}
 h1{font-size:38px;line-height:1.15;letter-spacing:-.02em}
 p{color:#5a6b80;margin-top:14px;max-width:52ch}
 .art{height:190px;border-radius:12px;background:linear-gradient(135deg,#ff6b4a,#ff2d78)}
 .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;padding:32px}
 .card{border:1px solid #dfe6ef;border-radius:12px;padding:20px;background:#fafcff}
 .card h3{font-size:16px;margin-bottom:10px}
 .card p{font-size:14px}
 footer{background:#0b1622;color:#8fa3bd;padding:22px 32px;font-size:13px}
</style>
<header><b>Meridian</b><nav><a>Product</a> <a>Docs</a> <a>Pricing</a> <a>Blog</a></nav></header>
<div class="hero">
  <div><h1>Ship the thing you keep putting off.</h1>
  <p>A calm place to plan, build and hand over work — without another dashboard to check every morning.</p></div>
  <div class="art"></div>
</div>
<div class="cards">
  <div class="card"><h3>Plan</h3><p>Break a brief into slices you can actually finish in one sitting.</p></div>
  <div class="card"><h3>Build</h3><p>Every change reviewed against the brief, not just the diff.</p></div>
  <div class="card"><h3>Hand over</h3><p>State that survives the gap between one session and the next.</p></div>
</div>
<footer>© Meridian — a fictional site used to preview a screenshot tool.</footer>
`)}`;

/* --- minimal CDP client --------------------------------------------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
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
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
    return r.result.value;
  }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(port, profile) {
  const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser']
    .find((b) => { try { return spawn('which', [b]) && true; } catch { return false; } }) || 'google-chrome';
  const child = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    `--window-size=${W},${H}`, 'about:blank',
  ], { stdio: 'ignore' });
  return child;
}

async function targetWs(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}

async function drag(cdp, from, to) {
  const base = { button: 'left', buttons: 1, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], ...base });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from[0] + ((to[0] - from[0]) * i) / steps),
      y: Math.round(from[1] + ((to[1] - from[1]) * i) / steps),
      ...base,
    });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], ...base });
}

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label + (detail ? ` — ${detail}` : '')); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

async function mountOverlay(cdp) {
  const backdrop = 'data:image/png;base64,' +
    (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  /* A real page already has a window.chrome (loadTimes, csi) but no runtime,
   * so the shim has to be merged in rather than defaulted. */
  /* A real page already has a window.chrome (loadTimes, csi) but no runtime,
   * so the shim has to be merged in rather than defaulted. sendMessage records
   * what the overlay hands to the background instead of answering it, so the
   * overlay half of copy/save can be asserted without the extension loaded. */
  await cdp.eval(`globalThis.__sent = [];
    globalThis.chrome = Object.assign({}, globalThis.chrome, {
      runtime: {
        onMessage: { addListener(){} },
        sendMessage: async (msg) => { globalThis.__sent.push(msg); return globalThis.__reply ?? { ok: true }; },
      },
    });`);
  for (const m of MODULES) await cdp.eval(read(m));
  const css = STYLES.map(read).join('\n');
  await cdp.eval(`globalThis.__css = ${JSON.stringify(css)}; globalThis.__page = ${JSON.stringify(backdrop)};`);
  await cdp.eval(`NhakoCapture.require('overlay').start({ dataUrl: __page, cssText: __css })`);
  await sleep(350);
  return backdrop;
}

const hostCount = (cdp) => cdp.eval(`document.querySelectorAll('#nhako-capture-host').length`);
const rectOf = (cdp) => cdp.eval(`JSON.stringify(NhakoCapture.require('overlay').session?.selection?.rect ?? null)`);

async function key(cdp, k) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 });
  }
  await sleep(150);
}


const shadowEval = (cdp, body) =>
  cdp.eval(`(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot; ${body} })()`);

const opCount = (cdp) => cdp.eval(`NhakoCapture.require('overlay').session.ops.length`);

async function pickTool(cdp, label) {
  await shadowEval(cdp, `[...sr.querySelectorAll('.nc-tool')].find(b => b.getAttribute('aria-label') === '${label}').click();`);
  await sleep(150);
}

async function keyCombo(cdp, key, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, key, code: `Key${key.toUpperCase()}`, modifiers,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    });
  }
  await sleep(180);
}

async function shoot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('wrote', file);
  return file;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), 'nc-preview-'));
  const child = launch(port, profile);

  let cdp;
  try {
    cdp = await CDP.attach(await targetWs(port));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: PAGE });
    await sleep(1200);
    await shoot(cdp, '00-page-before');

    /* --- mount ---------------------------------------------------------- */
    await mountOverlay(cdp);
    const mounted = await cdp.eval(`(() => {
      const h = document.getElementById('nhako-capture-host');
      const sr = h && h.shadowRoot;
      return { host: !!h, shadow: !!sr, sheets: sr ? sr.adoptedStyleSheets.length : -1,
               scrims: sr ? sr.querySelectorAll('.nc-scrim').length : -1,
               pill: !!(sr && sr.querySelector('.nc-pill')) };
    })()`);
    check('overlay mounts a shadow host', mounted.host && mounted.shadow);
    check('stylesheet adopted', mounted.sheets === 1);
    check('four scrim rects', mounted.scrims === 4, `got ${mounted.scrims}`);
    check('command pill rendered', mounted.pill);
    check('the pill offers Save page as PDF',
      await cdp.eval(`[...document.getElementById('nhako-capture-host').shadowRoot.querySelectorAll('.nc-btn')].some(b => /PDF/.test(b.textContent))`));
    await shoot(cdp, '01-idle');

    /* --- real drag through the real pointer path ------------------------- */
    await drag(cdp, [300, 250], [820, 580]);
    await sleep(250);
    check('drag produces the exact frame', await rectOf(cdp) === JSON.stringify({ x: 300, y: 250, w: 520, h: 330 }),
      await rectOf(cdp));
    check('badge reports device pixels',
      (await cdp.eval(`document.getElementById('nhako-capture-host').shadowRoot.querySelector('.nc-badge').textContent`)) === '520 × 330');
    await shoot(cdp, '02-selected');

    /* --- misclick is discarded ------------------------------------------- */
    await drag(cdp, [900, 120], [905, 125]);
    await sleep(200);
    check('a 5px drag is discarded as a misclick', await rectOf(cdp) === 'null', await rectOf(cdp));

    /* --- Escape steps back, then exits ----------------------------------- */
    await drag(cdp, [200, 200], [600, 500]);
    await sleep(200);
    check('frame drawn again', await rectOf(cdp) !== 'null');
    await key(cdp, 'Escape');
    check('Escape clears the frame first', await rectOf(cdp) === 'null');
    check('and the overlay is still up', await hostCount(cdp) === 1);
    await key(cdp, 'Escape');
    check('a second Escape tears the overlay down', await hostCount(cdp) === 0);
    check('scroll lock released',
      (await cdp.eval(`document.documentElement.style.overflow`)) !== 'hidden');

    /* --- re-injection must not stack overlays ---------------------------- */
    await mountOverlay(cdp);
    await mountOverlay(cdp);
    await mountOverlay(cdp);
    check('three launches leave exactly one host', await hostCount(cdp) === 1,
      `got ${await hostCount(cdp)}`);

    /* --- capture full screen --------------------------------------------- */
    await cdp.eval(`(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot;
      [...sr.querySelectorAll('.nc-btn')].find(b => /full screen/i.test(b.textContent)).click(); })()`);
    await sleep(200);
    const full = JSON.parse(await rectOf(cdp));
    check('capture full screen selects the whole viewport',
      full && full.x === 0 && full.y === 0 && full.w === W, JSON.stringify(full));
    await shoot(cdp, '03-full-screen');


    /* --- annotation engine ------------------------------------------------ */
    await key(cdp, 'Escape'); await key(cdp, 'Escape');
    await mountOverlay(cdp);
    await drag(cdp, [260, 200], [900, 560]);
    await sleep(200);

    check('tool rail appears once a frame is committed',
      await shadowEval(cdp, `return !sr.querySelector('.nc-rail').hidden;`));
    check('rail carries all six tools',
      (await shadowEval(cdp, `return sr.querySelectorAll('.nc-tool').length;`)) === 8, // 6 tools + undo/redo
      String(await shadowEval(cdp, `return sr.querySelectorAll('.nc-tool').length;`)));
    check('seven inks', (await shadowEval(cdp, `return sr.querySelectorAll('.nc-swatch').length;`)) === 7);
    check('exactly one ink reads as selected',
      (await shadowEval(cdp, `return [...sr.querySelectorAll('.nc-swatch')].filter(b => b.classList.contains('is-active')).length;`)) === 1,
      String(await shadowEval(cdp, `return [...sr.querySelectorAll('.nc-swatch')].filter(b => b.classList.contains('is-active')).length;`)));
    check('the selected ink is red by default',
      (await shadowEval(cdp, `return sr.querySelector('.nc-swatch.is-active')?.dataset.ink;`)) === 'red');
    check('exactly one stroke weight reads as selected',
      (await shadowEval(cdp, `return [...sr.querySelectorAll('.nc-weight')].filter(b => b.classList.contains('is-active')).length;`)) === 1);

    await pickTool(cdp, 'Pencil');
    check('pencil shows as active',
      await shadowEval(cdp, `return [...sr.querySelectorAll('.nc-tool')].some(b => b.classList.contains('is-active') && b.getAttribute('aria-label') === 'Pencil');`));

    const beforeStroke = await opCount(cdp);
    await drag(cdp, [360, 300], [700, 460]);
    await sleep(200);
    check('a stroke adds exactly one op', (await opCount(cdp)) - beforeStroke === 1,
      `${beforeStroke} -> ${await opCount(cdp)}`);
    check('drawing with a tool active does not reframe',
      (await rectOf(cdp)) === JSON.stringify({ x: 260, y: 200, w: 640, h: 360 }), await rectOf(cdp));

    /* undo / redo through the real keyboard path */
    await keyCombo(cdp, 'z', 2 /* Ctrl */);
    check('Ctrl+Z removes the stroke', await opCount(cdp) === beforeStroke);
    await keyCombo(cdp, 'z', 2 | 8 /* Ctrl+Shift */);
    check('Ctrl+Shift+Z puts it back', await opCount(cdp) === beforeStroke + 1);

    /* arrow + highlight + text, so the screenshot shows the real thing */
    await pickTool(cdp, 'Arrow');
    await drag(cdp, [420, 520], [640, 380]);
    await sleep(150);
    await pickTool(cdp, 'Highlight');
    await drag(cdp, [300, 250], [560, 250]);
    await sleep(150);
    check('four ops recorded', await opCount(cdp) === 3, String(await opCount(cdp)));

    /* Blur must actually redact. Measured differentially: local contrast in the
     * same region with the blur applied versus with it undone. An absolute
     * threshold would depend on whatever the page happens to show there. */
    await pickTool(cdp, 'Blur');
    // over the 'Build' card's body text: a region with real detail, so the
    // measurement can actually discriminate.
    await drag(cdp, [455, 405], [845, 490]);
    await sleep(250);
    check('blur is recorded as an op', await opCount(cdp) === 4, String(await opCount(cdp)));

    const contrast = `(() => {
      const s = NhakoCapture.require('overlay').session;
      const c = document.getElementById('nhako-capture-host').shadowRoot.querySelector('.nc-annotate');
      const g = c.getContext('2d');
      const geo = NhakoCapture.require('geometry');
      const m = NhakoCapture.require('overlay').metrics();
      const base = geo.toDevice(s.selection.rect, m);
      const dev = geo.toDevice({ x: 470, y: 440, w: 90, h: 34 }, m);
      const d = g.getImageData(dev.x - base.x, dev.y - base.y, dev.w, dev.h).data;
      let n = 0, sum = 0, sum2 = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        sum += v; sum2 += v * v; n++;
      }
      if (!n) return -1;
      return Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
    })()`;

    const sBlurred = await cdp.eval(contrast);
    await cdp.eval(`NhakoCapture.require('overlay').session.ops.undo()`);
    await sleep(200);
    const sSharp = await cdp.eval(contrast);
    await cdp.eval(`NhakoCapture.require('overlay').session.ops.redo()`);
    await sleep(200);

    check('the sample region was readable', sSharp > 0 && sBlurred >= 0,
      `sharp=${sSharp} blurred=${sBlurred}`);
    check('blur destroys local contrast (real redaction, not a grey box)',
      sBlurred < sSharp * 0.6,
      `stddev sharp=${Number(sSharp).toFixed(2)} blurred=${Number(sBlurred).toFixed(2)}`);

    await pickTool(cdp, 'Text');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 340, y: 500, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 340, y: 500, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(250);
    check('text tool opens an input',
      await shadowEval(cdp, `return !!sr.querySelector('.nc-textentry');`));
    await cdp.send('Input.insertText', { text: 'look here' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(250);
    check('text commits as an op', await opCount(cdp) === 5, String(await opCount(cdp)));
    check('the input is gone', !(await shadowEval(cdp, `return !!sr.querySelector('.nc-textentry');`)));

    await shoot(cdp, '05-annotated');

    /* the exported image is the device-pixel crop, not the CSS one */
    const exported = await cdp.eval(`(() => {
      const c = NhakoCapture.require('overlay').session.annotate.compose();
      return c.width + 'x' + c.height;
    })()`);
    check('export is the device-pixel crop', exported === '640x360', exported);

    /* --- copy / save handoff --------------------------------------------- */
    await cdp.eval(`globalThis.__sent = []; globalThis.__reply = { ok: true };`);
    await shadowEval(cdp, `sr.querySelector('.nc-btn--primary').click();`);
    await sleep(300);
    const sent = await cdp.eval(`globalThis.__sent.map(m => ({ type: m.type, len: m.dataUrl.length, head: m.dataUrl.slice(0, 22) }))`);
    check('Copy hands one message to the background', sent.length === 1, JSON.stringify(sent));
    check('addressed as nc:copy', sent[0]?.type === 'nc:copy', sent[0]?.type);
    check('carrying a PNG data URL', sent[0]?.head === 'data:image/png;base64,', sent[0]?.head);
    check('with the annotated image in it', sent[0]?.len > 5000, String(sent[0]?.len));
    check('and the overlay confirms', 
      (await shadowEval(cdp, `return sr.querySelector('.nc-hint').textContent;`)) === 'Copied!',
      await shadowEval(cdp, `return sr.querySelector('.nc-hint').textContent;`));

    /* a degraded clipboard result must say so rather than claim a clean copy */
    await mountOverlay(cdp);
    await drag(cdp, [260, 200], [900, 560]);
    await sleep(200);
    await cdp.eval(`globalThis.__sent = []; globalThis.__reply = { ok: true, degraded: true, note: 'Pasted as HTML' };`);
    await shadowEval(cdp, `sr.querySelector('.nc-btn--primary').click();`);
    await sleep(300);
    check('a degraded copy is reported honestly, not as "Copied!"',
      (await shadowEval(cdp, `return sr.querySelector('.nc-hint').textContent;`)) === 'Pasted as HTML',
      await shadowEval(cdp, `return sr.querySelector('.nc-hint').textContent;`));

    /* a failure must leave the capture on screen, not throw it away */
    await mountOverlay(cdp);
    await drag(cdp, [260, 200], [900, 560]);
    await sleep(200);
    await cdp.eval(`globalThis.__reply = { ok: false, error: 'clipboard unavailable' };`);
    await shadowEval(cdp, `sr.querySelector('.nc-btn--primary').click();`);
    await sleep(400);
    check('a failed copy leaves the overlay up', await hostCount(cdp) === 1);
    check('and says so', /failed/i.test(await shadowEval(cdp, `return sr.querySelector('.nc-hint').textContent;`)));
    await cdp.eval(`globalThis.__reply = { ok: true };`);

    /* --- restore a working frame for the remaining checks ----------------- */
    await mountOverlay(cdp);
    await drag(cdp, [260, 200], [900, 560]);
    await sleep(200);

    /* the rail must never collide with the command pill */
    await mountOverlay(cdp);
    await drag(cdp, [64, 96], [1216, 620]);   // tall frame: no room below
    await sleep(300);
    const overlap = await cdp.eval(`(() => {
      const sr = document.getElementById('nhako-capture-host').shadowRoot;
      const p = sr.querySelector('.nc-pill').getBoundingClientRect();
      const r = sr.querySelector('.nc-rail').getBoundingClientRect();
      const vertical = Math.min(p.bottom, r.bottom) - Math.max(p.top, r.top);
      const horizontal = Math.min(p.right, r.right) - Math.max(p.left, r.left);
      return { vertical, horizontal, railTop: r.top, pillBottom: p.bottom };
    })()`);
    check('a tall frame does not push the rail into the pill',
      overlap.vertical <= 0 || overlap.horizontal <= 0, JSON.stringify(overlap));
    check('the rail stays inside the viewport',
      await cdp.eval(`(() => { const r = document.getElementById('nhako-capture-host').shadowRoot.querySelector('.nc-rail').getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`));

    /* restore a normal frame */
    await mountOverlay(cdp);
    await drag(cdp, [260, 200], [900, 560]);
    await sleep(200);

    /* zoom loupe */
    await pickTool(cdp, 'Zoom');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 380 });
    await sleep(200);
    check('zoom shows a loupe',
      await shadowEval(cdp, `return !sr.querySelector('.nc-loupe').hidden;`));
    await shoot(cdp, '06-zoom');

    /* Escape releases the tool before clearing the frame */
    await key(cdp, 'Escape');
    check('Escape releases the tool first',
      (await cdp.eval(`NhakoCapture.require('overlay').session.annotate.tool`)) === null);
    check('and the frame survives', (await rectOf(cdp)) !== 'null');

    /* --- narrow window: pill collapses to icons -------------------------- */
    await key(cdp, 'Escape'); await key(cdp, 'Escape');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 560, height: 720, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    await mountOverlay(cdp);
    const labelsHidden = await cdp.eval(`(() => {
      const sr = document.getElementById('nhako-capture-host').shadowRoot;
      const l = sr.querySelector('.nc-btn__label');
      const hint = sr.querySelector('.nc-hint');
      return { label: l && getComputedStyle(l).display, hint: hint && getComputedStyle(hint).display };
    })()`);
    check('button labels collapse below 640px', labelsHidden.label === 'none', JSON.stringify(labelsHidden));
    check('hint text collapses below 640px', labelsHidden.hint === 'none');
    await shoot(cdp, '04-narrow');

    /* --- README hero -------------------------------------------------------
     * Opt-in, because it writes into the repo rather than the scratch dir. The
     * README shows the actual product, rendered by the actual code -- not a
     * mockup that quietly stops being true.
     */
    if (HERO) {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(300);
      await cdp.send('Page.navigate', { url: PAGE });
      await sleep(1200);
      await mountOverlay(cdp);
      // Sized to leave room for the rail below it at full opacity -- a dimmed
      // is-overlaid rail is correct behaviour but a poor product shot.
      await drag(cdp, [56, 128], [1224, 516]);
      await sleep(200);

      await pickTool(cdp, 'Highlight');
      await drag(cdp, [33, 176], [680, 176]);
      await sleep(120);
      await pickTool(cdp, 'Arrow');
      await drag(cdp, [980, 400], [1140, 300]);
      await sleep(120);
      await pickTool(cdp, 'Blur');
      await drag(cdp, [877, 438], [1216, 484]);
      await sleep(200);
      await pickTool(cdp, 'Text');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 880, y: 330, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 880, y: 330, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(250);
      await cdp.send('Input.insertText', { text: 'ship this' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(300);
      await pickTool(cdp, 'Pencil');

      mkdirSync(join(ROOT, 'docs'), { recursive: true });
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(ROOT, 'docs/screenshot.png'), Buffer.from(data, 'base64'));
      console.log('wrote docs/screenshot.png');
    }

    console.log(`\npreview: ${pass} checks passed, ${failures.length} failed`);
    if (failures.length) { for (const f of failures) console.error('  FAIL ' + f); process.exitCode = 1; }
  } finally {
    try { cdp?.close(); } catch {}
    child.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
