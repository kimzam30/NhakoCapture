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

/* The same site, made taller than the viewport. `Capture full page` is
 * disabled on the short fixture above -- correctly, there is nothing below the
 * fold -- so the enabled path needs a page that actually has one. */
const TALL_PAGE = PAGE + encodeURIComponent(
  '<div class="cards">' +
  '<div class="card"><h3>More</h3><p>Filler that pushes this page past the fold.</p></div>'.repeat(24) +
  '</div>'
);

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
  /* Tear down any overlay that is still up BEFORE screenshotting the page.
   * The real extension gets this for free -- background.js captures the
   * viewport before injecting anything, precisely so its own UI cannot end up
   * inside the capture. This harness screenshots from inside the page, so it
   * has to arrange the same thing by hand, or a remount bakes the previous
   * pill into the new backdrop and every shot after it is ghosted. */
  await cdp.eval(
    `(() => { try { globalThis.NhakoCapture?.modules?.overlay?.destroy?.(); } catch {} })()`
  );
  await sleep(60);
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
        sendMessage: async (msg) => { globalThis.__sent.push(msg);
          const r = globalThis.__reply;
          return (typeof r === 'function' ? r(msg) : r) ?? { ok: true }; },
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

    /* --- the pill's two capture extents ---------------------------------- */
    /* Scoped to the pill. The tool rail's Copy and Save share the .nc-btn
       class, so an unscoped query reaches them first -- and the rail is hidden
       until a frame exists, which makes its buttons unfocusable and any test
       that lands on one quietly meaningless. */
    const labels = JSON.parse(await cdp.eval(
      `JSON.stringify([...document.getElementById('nhako-capture-host').shadowRoot
        .querySelectorAll('.nc-pill .nc-btn')].map(b => b.getAttribute('aria-label')))`));
    check('the pill names the visible extent honestly',
      labels.includes('Capture visible page'), JSON.stringify(labels));
    check('and offers the full extent beside it',
      labels.includes('Capture full page'), JSON.stringify(labels));
    check('ordered by extent, visible before full',
      labels.indexOf('Capture visible page') < labels.indexOf('Capture full page'),
      JSON.stringify(labels));

    /* This fixture is shorter than the viewport, so full page has nothing to
       add and says so rather than producing a near-duplicate. */
    const disabled = JSON.parse(await cdp.eval(
      `(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot;
        const b = [...sr.querySelectorAll('.nc-pill .nc-btn')]
          .find(x => x.getAttribute('aria-label') === 'Capture full page');
        b.focus();
        return JSON.stringify({
          ariaDisabled: b.getAttribute('aria-disabled'),
          hasDisabledAttr: b.hasAttribute('disabled'),
          focusable: sr.activeElement === b,
          hintOnFocus: sr.querySelector('.nc-hint').textContent,
          colour: getComputedStyle(b).color,
          opacity: getComputedStyle(b).opacity,
        }); })()`));

    check('full page is disabled on a page with nothing below the fold',
      disabled.ariaDisabled === 'true', JSON.stringify(disabled));
    check('...via aria-disabled, not the attribute that removes it from tab order',
      disabled.hasDisabledAttr === false);
    check('...so a keyboard user can still reach it', disabled.focusable === true);
    check('...and hears why', disabled.hintOnFocus === 'Whole page already visible',
      disabled.hintOnFocus);
    check('...greyed by colour, not opacity',
      disabled.opacity === '1' && disabled.colour === 'rgb(154, 154, 154)',
      JSON.stringify(disabled));

    const afterBlur = await cdp.eval(
      `(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot;
        sr.querySelector('.nc-pill .nc-btn').focus();
        return sr.querySelector('.nc-hint').textContent; })()`);
    check('the reason does not outlive the focus that raised it',
      afterBlur === 'Drag to select an area', afterBlur);

    /* --- capture visible page -------------------------------------------- */
    await cdp.eval(`(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot;
      [...sr.querySelectorAll('.nc-pill .nc-btn')].find(b => /visible page/i.test(b.textContent)).click(); })()`);
    await sleep(200);
    const full = JSON.parse(await rectOf(cdp));
    check('capture visible page selects the whole viewport',
      full && full.x === 0 && full.y === 0 && full.w === W, JSON.stringify(full));
    await shoot(cdp, '03-visible-page');


    /* --- full page, on a page that actually has one ----------------------- */
    {
      await cdp.send('Page.navigate', { url: TALL_PAGE });
      await sleep(300);
      await mountOverlay(cdp);

      const state = JSON.parse(await cdp.eval(
        `(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot;
          const b = [...sr.querySelectorAll('.nc-pill .nc-btn')]
            .find(x => x.getAttribute('aria-label') === 'Capture full page');
          b.focus();
          return JSON.stringify({
            ariaDisabled: b.getAttribute('aria-disabled'),
            colour: getComputedStyle(b).color,
            hint: sr.querySelector('.nc-hint').textContent,
            docHeight: document.documentElement.scrollHeight,
            viewHeight: innerHeight,
          }); })()`));

      check('the tall fixture really is taller than the viewport',
        state.docHeight > state.viewHeight + 32, JSON.stringify(state));
      check('full page is enabled where there IS something below the fold',
        state.ariaDisabled === null, JSON.stringify(state));
      check('...and carries the live text colour, not the disabled one',
        state.colour !== 'rgb(154, 154, 154)', state.colour);
      check('...and announces no reason, because there is none',
        state.hint === 'Drag to select an area', state.hint);

      // Back to the short fixture for the rest of the run.
      await cdp.send('Page.navigate', { url: PAGE });
      await sleep(300);
      await mountOverlay(cdp);
      await cdp.eval(`(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot;
        [...sr.querySelectorAll('.nc-pill .nc-btn')].find(b => /visible page/i.test(b.textContent)).click(); })()`);
      await sleep(200);
    }

    /* --- T10: what happens when something tears down MID-capture ---------- */
    {
      await cdp.send('Page.navigate', { url: TALL_PAGE });
      await sleep(300);
      /* Remember the page's own overflow, before any overlay touches it. */
      const pageOverflow = await cdp.eval(`document.documentElement.style.overflow`);
      await mountOverlay(cdp);

      /* Answer capture-tile with a real (tiny) PNG so the loop runs end to end
         without an extension behind it. */
      await cdp.eval(`globalThis.__reply = (msg) =>
        msg.type === 'nc:capture-tile'
          ? { ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }
          : { ok: true };`);

      /* Deliberately NOT returning the promise. cdp.eval sets awaitPromise, so
         handing it back would block here until the whole capture finished --
         and every assertion below is about what is true WHILE it runs. */
      await cdp.eval(`(() => {
        globalThis.__scrollBefore = scrollY;
        globalThis.__capture = NhakoCapture.modules.overlay.session.captureFullPage();
        return 'started';
      })()`);
      await sleep(250);

      const capturing = await cdp.eval(
        `String(!!NhakoCapture.modules.overlay.session?.capturing)`);
      check('a capture is genuinely in flight', capturing === 'true', capturing);

      /* (1) A REAL size change, not a synthetic event. On a real page the
         capture lifts the scroll lock, the scrollbar returns and innerWidth
         drops -- a genuine resize by this guard's own measure, on essentially
         every scrollbarred page. This harness runs with --hide-scrollbars, so
         that particular trigger cannot happen here; the viewport is resized
         outright instead, which is the same event from the handler's point of
         view. Dispatching a bare Event('resize') would have proved nothing:
         with the dimensions unchanged the handler returns early regardless of
         the guard. */
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1180, height: H, deviceScaleFactor: 1, mobile: false });
      await sleep(120);
      const resized = JSON.parse(await cdp.eval(`JSON.stringify({
        host: !!document.getElementById('nhako-capture-host'),
        width: innerWidth,
        stillCapturing: !!NhakoCapture.modules.overlay.session?.capturing,
      })`));
      check('the viewport really did change size', resized.width === 1180,
        JSON.stringify(resized));
      check('...and the capture is still running', resized.stillCapturing === true,
        JSON.stringify(resized));
      check('a resize during a capture does not tear the overlay down',
        resized.host === true, JSON.stringify(resized));
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: W, height: H, deviceScaleFactor: 1, mobile: false });

      /* (2) Teardown mid-capture must be deferred, not raced. If it is not,
         the loop's restore lands after the overlay's and puts overflow:hidden
         back on a page with no overlay left -- permanently unscrollable. */
      await cdp.eval(`NhakoCapture.modules.overlay.destroy()`);
      const stillUp = await cdp.eval(
        `String(!!document.getElementById('nhako-capture-host'))`);
      check('teardown during a capture is deferred, not immediate',
        stillUp === 'true');

      /* Wait for the CAPTURE to settle, not for the host to vanish.
         Waiting on the host is what a first draft of this test did, and it
         made the assertions below meaningless: without the deferral the host
         disappears instantly, so the checks ran BEFORE the loop's finally had
         re-applied its recorded overflow. The damage this test exists to catch
         lands after that point, so the wait has to reach past it. */
      await cdp.eval(`globalThis.__capture.catch(() => {}).then(() => 'settled')`);
      await sleep(120);

      const after = JSON.parse(await cdp.eval(`JSON.stringify({
        host: !!document.getElementById('nhako-capture-host'),
        overflow: document.documentElement.style.overflow,
        scrollY, before: globalThis.__scrollBefore,
      })`));

      check('the deferred teardown does eventually complete', after.host === false,
        JSON.stringify(after));
      /* The assertion that discriminates. A scroll-based probe does NOT: this
         browser happily scrolls a documentElement with overflow:hidden, so a
         "can it still scroll" check passes identically whether or not the bug
         is present, and reads as reassurance while proving nothing. */
      check('the page is NOT left pinned by the loop\'s restore',
        after.overflow === pageOverflow, JSON.stringify(after));
      check('scroll position is where the user left it',
        after.scrollY === after.before, JSON.stringify(after));

      await cdp.eval(`globalThis.__reply = { ok: true };`);
      await cdp.send('Page.navigate', { url: PAGE });
      await sleep(300);
      await mountOverlay(cdp);
      await cdp.eval(`(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot;
        [...sr.querySelectorAll('.nc-pill .nc-btn')].find(b => /visible page/i.test(b.textContent)).click(); })()`);
      await sleep(200);
    }

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

    /* T12: and it must survive the narrow-window collapse. The hint is
       display:none below 640px, and the overlay tears itself down 1.6s after a
       degraded copy -- so a message that lives only in the hint is invisible
       on a narrow window, permanently, for the one outcome the user most needs
       to know about. */
    {
      const degraded = JSON.parse(await shadowEval(cdp, `
        const n = sr.querySelector('.nc-notice');
        return JSON.stringify({
          hidden: n.hidden, text: n.textContent, title: n.title,
          hintText: sr.querySelector('.nc-hint').textContent,
        });`));
      check('a degraded copy also raises the notice',
        degraded.hidden === false && /HTML/.test(degraded.text),
        JSON.stringify(degraded));
      check('the notice text is short enough for a narrow pill',
        degraded.text.length <= 20, degraded.text);
      check('the full sentence is still available in the hint',
        degraded.hintText === 'Pasted as HTML', degraded.hintText);
    }

    /* Same outcome, narrow window: the hint is gone, the notice is not. */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 480, height: 720, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    await mountOverlay(cdp);
    await drag(cdp, [60, 160], [420, 460]);
    await sleep(200);
    await cdp.eval(`globalThis.__reply = { ok: true, degraded: true, note: 'Pasted as HTML' };`);
    await shadowEval(cdp, `sr.querySelector('.nc-btn--primary').click();`);
    await sleep(300);
    {
      const narrow = JSON.parse(await shadowEval(cdp, `
        const n = sr.querySelector('.nc-notice');
        const pill = sr.querySelector('.nc-pill');
        return JSON.stringify({
          hintShown: getComputedStyle(sr.querySelector('.nc-hint')).display,
          noticeShown: getComputedStyle(n).display,
          noticeText: n.textContent,
          fits: pill.getBoundingClientRect().width <= innerWidth,
        });`));
      check('at 480px the hint really is hidden', narrow.hintShown === 'none',
        narrow.hintShown);
      check('...but the degraded-copy notice is NOT',
        narrow.noticeShown !== 'none' && /HTML/.test(narrow.noticeText),
        JSON.stringify(narrow));
      check('...and the pill still fits the window', narrow.fits === true,
        JSON.stringify(narrow));
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    await cdp.eval(`globalThis.__reply = { ok: true };`);

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
      /* Scoped to the pill. The rail's Copy and Save carry .nc-btn__label too,
         and they are deliberately exempt from this collapse -- an unscoped
         query finds one of those first and tests the opposite intent. */
      const l = sr.querySelector('.nc-pill .nc-btn__label');
      const done = sr.querySelector('.nc-group--done .nc-btn__label');
      const hint = sr.querySelector('.nc-hint');
      return { label: l && getComputedStyle(l).display,
               done: done && getComputedStyle(done).display,
               hint: hint && getComputedStyle(hint).display };
    })()`);
    check('pill button labels collapse below 640px', labelsHidden.label === 'none', JSON.stringify(labelsHidden));
    check('...but Copy and Save keep theirs — they are the point of the overlay',
      labelsHidden.done !== 'none', JSON.stringify(labelsHidden));
    check('hint text collapses below 640px', labelsHidden.hint === 'none');
    await shoot(cdp, '04-narrow');

    /* T9: with the labels gone, shape is the only thing left to tell the two
       capture extents apart. The eye test is a human judgement made against
       rendered candidates; what a machine can hold is that the two never
       silently become the same icon, and that both stay reachable by name. */
    {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 400, height: 720, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      await mountOverlay(cdp);

      const icons = JSON.parse(await cdp.eval(
        `(() => { const sr = document.getElementById('nhako-capture-host').shadowRoot;
          const btns = [...sr.querySelectorAll('.nc-pill .nc-btn')];
          const pill = sr.querySelector('.nc-pill');
          const of = (name) => {
            const b = btns.find(x => x.getAttribute('aria-label') === name);
            return b && b.querySelector('svg').innerHTML;
          };
          return JSON.stringify({
            visible: of('Capture visible page'),
            full: of('Capture full page'),
            pdf: of('Save page as PDF'),
            names: btns.map(b => b.getAttribute('aria-label')),
            labelShown: getComputedStyle(btns[0].querySelector('.nc-btn__label')).display,
            overflows: pill.scrollWidth > innerWidth,
          }); })()`));

      check('at 400px the labels really are gone', icons.labelShown === 'none');
      check('both capture extents are still offered',
        icons.visible && icons.full, JSON.stringify(icons.names));
      check('the two capture icons are not the same shape',
        icons.visible !== icons.full);
      check('nor is either the same as the PDF icon',
        icons.full !== icons.pdf && icons.visible !== icons.pdf);
      check('the two capture icons share a motif rather than being unrelated',
        icons.full.includes('M3 7V5a2 2 0 0 1 2-2h2'), icons.full);
      check('every control keeps a name once its label is hidden',
        icons.names.every(n => n && n.length > 0), JSON.stringify(icons.names));
      check('the pill still fits at 400px', icons.overflows === false);
      await shoot(cdp, '04b-narrow-400');

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 560, height: 720, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
    }

    /* --- T14: accessibility ------------------------------------------------ */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    {
      await cdp.send('Page.navigate', { url: TALL_PAGE });
      await sleep(300);
      await mountOverlay(cdp);

      /* The announcer must be OUTSIDE the shadow host, or it disappears from
         the accessibility tree the moment the overlay hides for a capture. */
      const ann = JSON.parse(await cdp.eval(`(() => {
        const el = [...document.documentElement.children]
          .find(n => n.getAttribute && n.getAttribute('role') === 'status');
        if (!el) return JSON.stringify({ found: false });
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return JSON.stringify({
          found: true,
          insideHost: !!document.getElementById('nhako-capture-host')?.contains(el),
          live: el.getAttribute('aria-live'),
          w: Math.round(r.width), h: Math.round(r.height),
          clip: cs.clipPath, overflow: cs.overflow,
        });
      })()`));

      check('there is a live region outside the overlay', ann.found === true,
        JSON.stringify(ann));
      check('...genuinely outside it, so hiding the overlay cannot mute it',
        ann.insideHost === false, JSON.stringify(ann));
      check('...announced politely', ann.live === 'polite', ann.live);
      /* Un-photographable: it must paint nothing, or it lands in the tiles. */
      check('...and paints nothing a capture could pick up',
        ann.w <= 1 && ann.h <= 1 && ann.clip !== 'none', JSON.stringify(ann));

      /* Endpoint 1. The pill's own hint cannot do this job: run() is
         synchronous up to its first await, so the hint is set and the host is
         hidden in the SAME task -- populated and removed from the a11y tree
         before anything could observe it. */
      await cdp.eval(`globalThis.__reply = (msg) =>
        msg.type === 'nc:capture-tile'
          ? { ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }
          : { ok: true };`);
      await cdp.eval(`(() => {
        globalThis.__capture = NhakoCapture.modules.overlay.session.captureFullPage();
        return 'started';
      })()`);
      await sleep(250);

      const during = JSON.parse(await cdp.eval(`(() => {
        const host = document.getElementById('nhako-capture-host');
        const el = [...document.documentElement.children]
          .find(n => n.getAttribute && n.getAttribute('role') === 'status');
        return JSON.stringify({
          hostHidden: getComputedStyle(host).display === 'none',
          announced: el.textContent,
          hintInShadow: host.shadowRoot.querySelector('.nc-hint').textContent,
        });
      })()`));

      check('the overlay really is hidden during a capture',
        during.hostHidden === true, JSON.stringify(during));
      check('the start of a capture is announced from outside it',
        /Capturing full page/.test(during.announced), JSON.stringify(during));
      check('...which the pill hint could not have done from inside a hidden host',
        during.hintInShadow === 'Capturing full page…', during.hintInShadow);

      /* Endpoint 2: arrival. */
      await cdp.eval(`globalThis.__capture.catch(() => {}).then(() => 'settled')`);
      await sleep(150);
      const ended = await cdp.eval(`(() => {
        const el = [...document.documentElement.children]
          .find(n => n.getAttribute && n.getAttribute('role') === 'status');
        return el ? el.textContent : '(announcer gone)';
      })()`);
      check('the end of a capture is announced too',
        /captured|failed|cancelled/i.test(ended), ended);

      await cdp.eval(`globalThis.__reply = { ok: true };`);
      await cdp.send('Page.navigate', { url: PAGE });
      await sleep(300);
      await mountOverlay(cdp);
    }

    /* the disabled control: reachable, ringed, and readable */
    {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await sleep(120);

      const a11y = JSON.parse(await cdp.eval(`(() => {
        const sr = document.getElementById('nhako-capture-host').shadowRoot;
        const b = [...sr.querySelectorAll('.nc-pill .nc-btn')]
          .find(x => x.getAttribute('aria-label') === 'Capture full page');
        b.focus();
        const cs = getComputedStyle(b);

        /* WCAG contrast, computed against the grounds this control actually
           sits on -- read from the live stylesheet, not from a design note. */
        const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        const lum = ([r, g, bl]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
        /* [0-9.] not [\d.]: this whole probe is inside a template literal, where
           a backslash escape collapses before the regex is ever compiled. */
        const parse = (s) => s.match(/[0-9.]+/g).slice(0, 3).map(Number);
        const ratio = (a, b2) => { const [x, y] = [lum(a), lum(b2)].sort((p, q) => q - p);
                                   return (x + 0.05) / (y + 0.05); };
        /* Resolved by the browser rather than parsed by hand: a probe element
           painted with the token, read back as rgb(). Hex-string surgery on
           getPropertyValue is what an earlier version of this did, and it
           returned empty for half the tokens. */
        const root = sr.querySelector('.nc-root');
        const tok = (n) => {
          const probe = document.createElement('div');
          probe.style.cssText = 'background:var(' + n + ')';
          root.appendChild(probe);
          const v = parse(getComputedStyle(probe).backgroundColor);
          probe.remove();
          return v;
        };
        const fg = parse(cs.color);
        const surface = tok('--nc-surface');
        const raised = tok('--nc-surface-raised');
        /* --nc-surface-glass is 0.92 alpha; worst case is a white page behind. */
        const glassOnWhite = surface.map(c => Math.round(0.92 * c + 0.08 * 255));

        return JSON.stringify({
          focused: sr.activeElement === b,
          ring: cs.boxShadow,
          colour: cs.color,
          opacity: cs.opacity,
          onSurface: +ratio(fg, surface).toFixed(2),
          onRaised: +ratio(fg, raised).toFixed(2),
          onGlass: +ratio(fg, glassOnWhite).toFixed(2),
        });
      })()`));

      check('the disabled control can hold focus', a11y.focused === true,
        JSON.stringify(a11y));
      check('...and shows a focus ring rather than suppressing it',
        a11y.ring && a11y.ring !== 'none', a11y.ring);
      check('...greyed by colour, never opacity', a11y.opacity === '1', a11y.opacity);
      check('disabled text clears 4.5:1 on the toolbar surface',
        a11y.onSurface >= 4.5, String(a11y.onSurface));
      check('...on the hover surface', a11y.onRaised >= 4.5, String(a11y.onRaised));
      check('...and on glass over a white page, the worst case',
        a11y.onGlass >= 4.5, String(a11y.onGlass));
    }

    /* forced-colors: hand the palette back to the OS */
    {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'forced-colors', value: 'active' }] });
      await sleep(200);
      await mountOverlay(cdp);
      const forced = JSON.parse(await cdp.eval(`(() => {
        const sr = document.getElementById('nhako-capture-host').shadowRoot;
        const root = sr.querySelector('.nc-root');
        const cs = getComputedStyle(root);
        return JSON.stringify({
          disabled: cs.getPropertyValue('--nc-text-disabled').trim(),
          accent: cs.getPropertyValue('--nc-accent-bright').trim(),
        });
      })()`));
      check('forced-colors hands disabled text to the OS palette',
        /GrayText/i.test(forced.disabled), JSON.stringify(forced));
      check('...and the accent too, rather than painting our own',
        /Highlight/i.test(forced.accent), JSON.stringify(forced));
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      await sleep(150);
      await mountOverlay(cdp);
    }

    /* --- T13: the pill at every breakpoint --------------------------------
     *
     * The pill now carries three labelled actions plus dismiss -- one more
     * than it has ever had. Each width is checked with a notice present as
     * well as without, because the notice is the widest thing that can appear
     * in there and it is exactly what a fit test done on an empty pill misses.
     */
    for (const width of [320, 400, 640, 1280]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: 720, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
      await mountOverlay(cdp);

      const measure = `
        const pill = sr.querySelector('.nc-pill');
        const btns = [...sr.querySelectorAll('.nc-pill .nc-btn')];
        const dismiss = btns[btns.length - 1];
        const p = pill.getBoundingClientRect();
        const d = dismiss.getBoundingClientRect();
        return JSON.stringify({
          left: Math.round(p.left), right: Math.round(p.right),
          width: Math.round(p.width), height: Math.round(p.height),
          /* scrollWidth > clientWidth means content is being clipped inside
             the pill -- the failure that looks fine from outside. */
          clipped: pill.scrollWidth > pill.clientWidth + 1,
          /* More than one row of controls means it wrapped. */
          wrapped: p.height > 60,
          dismissVisible: d.width > 0 && d.left >= p.left - 1 && d.right <= p.right + 1,
          dismissInView: d.left >= 0 && d.right <= innerWidth,
          labels: getComputedStyle(btns[0].querySelector('.nc-btn__label')).display,
          controls: btns.length,
        });`;

      const bare = JSON.parse(await shadowEval(cdp, measure));
      check(`${width}px: the pill fits the window`,
        bare.left >= 0 && bare.right <= width, JSON.stringify(bare));
      check(`${width}px: nothing is clipped inside it`, bare.clipped === false,
        JSON.stringify(bare));
      check(`${width}px: it has not wrapped to a second row`, bare.wrapped === false,
        JSON.stringify(bare));
      check(`${width}px: the dismiss control is reachable`,
        bare.dismissVisible && bare.dismissInView, JSON.stringify(bare));
      check(`${width}px: labels ${width <= 640 ? 'collapse' : 'show'}`,
        (bare.labels === 'none') === (width <= 640), bare.labels);

      /* Now the same width carrying the widest thing the pill can hold. */
      await shadowEval(cdp, `
        NhakoCapture.modules.overlay.session.toolbar.setNotice(
          'Full page capped at 16384px — page is longer');
        return 1;`);
      await sleep(80);
      const withNotice = JSON.parse(await shadowEval(cdp, measure));
      check(`${width}px: still fits with a notice in it`,
        withNotice.left >= 0 && withNotice.right <= width, JSON.stringify(withNotice));
      check(`${width}px: and the dismiss control survives it`,
        withNotice.dismissVisible && withNotice.dismissInView,
        JSON.stringify(withNotice));

      /* The notice shrinks and ellipsises rather than pushing the pill off
         screen -- which is why the fit checks above pass at 320px. That is
         only acceptable if what survives the truncation still carries the
         claim. "Full page capp…" is a notice; "Full…" is decoration. */
      const legible = JSON.parse(await shadowEval(cdp, `
        const n = sr.querySelector('.nc-notice');
        const cs = getComputedStyle(n);
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        return JSON.stringify({
          shown: Math.round(n.getBoundingClientRect().width),
          needed: Math.ceil(ctx.measureText('Full page capped').width),
          natural: n.scrollWidth,
          truncated: n.scrollWidth > n.clientWidth + 1,
        });`));
      check(`${width}px: the notice keeps the word that carries its meaning`,
        legible.shown >= legible.needed, JSON.stringify(legible));

      /* The rail carries far more controls than the pill -- six tools, seven
         inks, three weights, undo/redo and two actions. If anything overflows
         a narrow window it is this, and it is the surface the user is actually
         working in. */
      await drag(cdp, [Math.round(width * 0.15), 180],
                      [Math.round(width * 0.85), 420]);
      await sleep(200);
      const rail = JSON.parse(await shadowEval(cdp, `
        const r = sr.querySelector('.nc-rail');
        if (!r || r.hidden) return JSON.stringify({ hidden: true });
        const b = r.getBoundingClientRect();
        return JSON.stringify({
          hidden: false,
          left: Math.round(b.left), right: Math.round(b.right),
          clipped: r.scrollWidth > r.clientWidth + 1,
          controls: r.querySelectorAll('button').length,
        });`));
      check(`${width}px: the rail appears for a frame`, rail.hidden === false,
        JSON.stringify(rail));
      check(`${width}px: the rail fits the window`,
        rail.left >= 0 && rail.right <= width, JSON.stringify(rail));
      check(`${width}px: no rail control is clipped`, rail.clipped === false,
        JSON.stringify(rail));
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 560, height: 720, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    await mountOverlay(cdp);

    /* --- T18: edge cases ---------------------------------------------------- */
    await key(cdp, 'Escape'); await key(cdp, 'Escape');
    await mountOverlay(cdp);
    {
      const W0 = await cdp.eval('innerWidth'), H0 = await cdp.eval('innerHeight');
      const edges = {
        'top-left':     [[0, 0], [200, 150]],
        'top-right':    [[W0, 0], [W0 - 200, 150]],
        'bottom-left':  [[0, H0], [200, H0 - 150]],
        'bottom-right': [[W0, H0], [W0 - 200, H0 - 150]],
      };
      for (const [name, [from, to]] of Object.entries(edges)) {
        await drag(cdp, from, to);
        await sleep(150);
        const r = JSON.parse(await rectOf(cdp));
        check(`frame flush to the ${name} corner stays in bounds`,
          r && r.x >= 0 && r.y >= 0 && r.x + r.w <= W0 && r.y + r.h <= H0,
          JSON.stringify(r));
        const chrome = await cdp.eval(`(() => {
          const sr = document.getElementById('nhako-capture-host').shadowRoot;
          const rail = sr.querySelector('.nc-rail').getBoundingClientRect();
          const badge = sr.querySelector('.nc-badge').getBoundingClientRect();
          return { rail: rail.top >= 0 && rail.left >= 0 && rail.right <= innerWidth && rail.bottom <= innerHeight,
                   badge: badge.top >= 0 && badge.left >= 0 && badge.right <= innerWidth };
        })()`);
        check(`  ...and its rail and badge stay on screen (${name})`,
          chrome.rail && chrome.badge, JSON.stringify(chrome));
      }
    }

    /* --- T19: accessibility --------------------------------------------------- */
    await key(cdp, 'Escape'); await key(cdp, 'Escape');
    await mountOverlay(cdp);
    await drag(cdp, [300, 220], [820, 520]);
    await sleep(200);
    {
      const a11y = await cdp.eval(`(() => {
        const h = document.getElementById('nhako-capture-host');
        const sr = h.shadowRoot;
        const named = (sel) => [...sr.querySelectorAll(sel)]
          .every(b => (b.getAttribute('aria-label') || b.textContent || '').trim().length > 0);
        return {
          appRole: sr.querySelector('.nc-root').getAttribute('role'),
          appLabel: !!sr.querySelector('.nc-root').getAttribute('aria-label'),
          pillRole: sr.querySelector('.nc-pill').getAttribute('role'),
          railRole: sr.querySelector('.nc-rail').getAttribute('role'),
          hintLive: sr.querySelector('.nc-hint').getAttribute('aria-live'),
          badgeLive: sr.querySelector('.nc-badge').getAttribute('aria-live'),
          buttonsNamed: named('.nc-btn') && named('.nc-tool') && named('.nc-swatch') && named('.nc-weight'),
          focusInside: sr.contains(document.activeElement) || document.activeElement === h,
        };
      })()`);
      check('the overlay declares itself an application region', a11y.appRole === 'application' && a11y.appLabel);
      check('pill and rail are toolbars', a11y.pillRole === 'toolbar' && a11y.railRole === 'toolbar');
      check('the status hint is a live region', a11y.hintLive === 'polite');
      check('the dimension badge is a live region', a11y.badgeLive === 'polite');
      check('every control has an accessible name', a11y.buttonsNamed);
      check('focus starts inside the overlay', a11y.focusInside);

      /* focus trap: focusing something in the page must bounce back */
      const trapped = await cdp.eval(`(async () => {
        const link = document.createElement('button');
        link.textContent = 'page control';
        document.body.appendChild(link);
        link.focus();
        await new Promise(r => setTimeout(r, 120));
        const escaped = document.activeElement === link;
        link.remove();
        return !escaped;
      })()`);
      check('focus cannot escape into the page underneath', trapped);

      /* reduced motion collapses the durations */
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await sleep(200);
      const motion = await cdp.eval(`(() => {
        const sr = document.getElementById('nhako-capture-host').shadowRoot;
        const cs = getComputedStyle(sr.querySelector('.nc-btn'));
        return { dur: getComputedStyle(sr.host).getPropertyValue('--nc-duration-fast').trim(),
                 transition: cs.transitionDuration };
      })()`);
      check('prefers-reduced-motion collapses transitions',
        motion.dur === '0ms' && /^0s(, 0s)*$/.test(motion.transition), JSON.stringify(motion));
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      await sleep(150);

    }

    /* Focus restoration, tested end to end: it can only be checked with the
     * overlay down, because while it is up the trap (correctly) refuses to let
     * anything in the page take focus. */
    await key(cdp, 'Escape'); await key(cdp, 'Escape');
    await sleep(200);
    {
      const before = await cdp.eval(`(() => {
        const b = document.createElement('button');
        b.id = 'prev-focus';
        b.textContent = 'page control';
        document.body.appendChild(b);
        b.focus();
        return document.activeElement.id;
      })()`);
      check('a page control holds focus before launch', before === 'prev-focus', before);

      await mountOverlay(cdp);
      const during = await cdp.eval(`document.activeElement.id || document.activeElement.tagName`);
      check('launching moves focus into the overlay', during !== 'prev-focus', during);

      await key(cdp, 'Escape'); await key(cdp, 'Escape');
      await sleep(250);
      const after = await cdp.eval(`document.activeElement.id`);
      check('dismissing returns focus exactly where it was', after === 'prev-focus', after);
      await cdp.eval(`document.getElementById('prev-focus')?.remove()`);
    }

    /* --- fallback editor window -------------------------------------------
     * The brave:// path. Loaded from file:// with chrome.storage, runtime and
     * fetch shimmed, so the same modules can be exercised outside an installed
     * extension. Everything below the shim is the real editor.
     */
    {
      // The narrow-window test left a device-metrics override in place.
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(300);
      await cdp.send('Page.navigate', { url: PAGE });
      await sleep(1000);
      const capture = 'data:image/png;base64,' +
        (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
      const css = STYLES.map(read).join('\n');

      const stored = { capturedImage: capture };
      /* A factory, not a string-replace on a built shim: the replace has to
         match an interpolated JSON blob exactly, and when it silently does not
         the test still runs -- against the wrong fixture. */
      const makeShim = (st) => `
        globalThis.__sent = [];
        globalThis.chrome = {
          storage: { local: {
            get: async () => (${JSON.stringify(st)}),
            remove: async () => {},
          }},
          runtime: {
            getURL: (p) => 'nc-style:' + p,
            sendMessage: async (m) => { globalThis.__sent.push(m);
              const r = globalThis.__reply;
              return (typeof r === 'function' ? r(m) : r) ?? { ok: true }; },
          },
        };
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (u) => String(u).startsWith('nc-style:')
          ? { ok: true, text: async () => ${JSON.stringify(css)} }
          : realFetch(u);
      `;
      const shim = makeShim(stored);
      const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: shim });

      await cdp.send('Page.navigate', { url: `file://${join(ROOT, 'src/fallback/editor.html')}` });
      await sleep(900);

      const mounted = await cdp.eval(`(() => {
        const h = document.getElementById('nhako-capture-host');
        const sr = h && h.shadowRoot;
        const box = h && h.getBoundingClientRect();
        return {
          host: !!h,
          empty: getComputedStyle(document.getElementById('empty')).display,
          rail: !!(sr && sr.querySelector('.nc-rail')),
          tools: sr ? sr.querySelectorAll('.nc-tool').length : -1,
          box: box && { l: Math.round(box.left), t: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
          pillButtons: sr ? [...sr.querySelectorAll('.nc-pill .nc-btn')].map(b => b.getAttribute('aria-label')) : [],
        };
      })()`);

      check('fallback editor mounts the shared stage', mounted.host, JSON.stringify(mounted));
      check('the empty-state notice stays hidden', mounted.empty === 'none');
      check('it reuses the same tool rail', mounted.rail && mounted.tools === 8, String(mounted.tools));
      check('the capture is letterboxed inside the window',
        mounted.box && mounted.box.w > 0 && mounted.box.h > 0 &&
        mounted.box.l >= 0 && mounted.box.t >= 0, JSON.stringify(mounted.box));
      check('no "Capture visible page" here — the capture IS the frame',
        !mounted.pillButtons.includes('Capture visible page'), JSON.stringify(mounted.pillButtons));
      check('no "Capture full page" here — there is no live tab to scroll',
        !mounted.pillButtons.includes('Capture full page'), JSON.stringify(mounted.pillButtons));
      check('no "Save page as PDF" here — there is no live tab to print',
        !mounted.pillButtons.includes('Save page as PDF'));

      /* T11, the other half: a capture that was NOT capped must say nothing.
         A notice that appears either way is decoration, not information. */
      const uncapped = JSON.parse(await cdp.eval(`(() => {
        const sr = document.getElementById('nhako-capture-host').shadowRoot;
        const n = sr.querySelector('.nc-notice');
        return JSON.stringify({ present: !!n, hidden: n && n.hidden, text: n && n.textContent });
      })()`));
      check('an uncapped capture shows no notice',
        uncapped.hidden === true && !uncapped.text, JSON.stringify(uncapped));

      const framed = await cdp.eval(`JSON.stringify(NhakoCapture.require('selection') && (() => {
        const sr = document.getElementById('nhako-capture-host').shadowRoot;
        const m = sr.querySelector('.nc-marquee');
        return !m.hidden;
      })())`);
      check('the whole capture is framed on open', framed === 'true', framed);

      /* draw with the shared engine, in stage-local coordinates */
      const box = mounted.box;
      await shadowEval(cdp, `[...sr.querySelectorAll('.nc-tool')].find(b => b.getAttribute('aria-label') === 'Arrow').click();`);
      await sleep(150);
      await drag(cdp,
        [box.l + Math.round(box.w * 0.25), box.t + Math.round(box.h * 0.6)],
        [box.l + Math.round(box.w * 0.55), box.t + Math.round(box.h * 0.35)]);
      await sleep(250);
      const drawn = await cdp.eval(`(() => {
        const sr = document.getElementById('nhako-capture-host').shadowRoot;
        return sr.querySelector('.nc-annotate') && !sr.querySelector('.nc-annotate').hidden;
      })()`);
      check('annotation works in the fallback window', drawn);

      const chromeFits = await cdp.eval(`(() => {
        const sr = document.getElementById('nhako-capture-host').shadowRoot;
        const rail = sr.querySelector('.nc-rail');
        const pill = sr.querySelector('.nc-pill');
        const r = rail.getBoundingClientRect(), p = pill.getBoundingClientRect();
        return { overlaid: rail.classList.contains('is-overlaid'),
                 railInView: r.top >= 0 && r.bottom <= innerHeight,
                 collide: Math.min(p.bottom, r.bottom) - Math.max(p.top, r.top) > 0 };
      })()`);
      check('the rail sits at full opacity, not dimmed, in the fallback window',
        !chromeFits.overlaid, JSON.stringify(chromeFits));
      check('and stays inside the window without colliding with the pill',
        chromeFits.railInView && !chromeFits.collide, JSON.stringify(chromeFits));
      check('the pill is not dimmed — it sits in the margin, not over the capture',
        (await shadowEval(cdp, `return getComputedStyle(sr.querySelector('.nc-pill')).opacity;`)) === '1',
        await shadowEval(cdp, `return getComputedStyle(sr.querySelector('.nc-pill')).opacity;`));

      await shoot(cdp, '07-fallback-editor');

      await shadowEval(cdp, `sr.querySelector('.nc-btn--primary').click();`);
      await sleep(300);
      const sentFromFallback = await cdp.eval(`globalThis.__sent.map(m => m.type)`);

      check('Copy from the fallback window routes to the background',
        sentFromFallback.includes('nc:copy'), JSON.stringify(sentFromFallback));

      /* T12: the three copy outcomes must be as distinguishable here as they
         are in the overlay. This window is where restricted-page and full-page
         captures land, so an outcome that only reads correctly in the overlay
         is only half-reported. */
      {
        const outcome = async (reply) => {
          await cdp.eval(`globalThis.__reply = ${JSON.stringify(reply)};`);
          await shadowEval(cdp, `sr.querySelector('.nc-btn--primary').click();`);
          await sleep(250);
          return JSON.parse(await shadowEval(cdp, `
            const n = sr.querySelector('.nc-notice');
            return JSON.stringify({
              hint: sr.querySelector('.nc-hint').textContent,
              noticeHidden: n.hidden, notice: n.textContent,
            });`));
        };

        const clean = await outcome({ ok: true });
        check('editor: a clean copy says so', clean.hint === 'Copied!', clean.hint);
        check('editor: ...and raises no notice', clean.noticeHidden === true,
          JSON.stringify(clean));

        const degraded = await outcome({ ok: true, degraded: true, note: 'Pasted as HTML' });
        check('editor: a degraded copy does not claim a clean one',
          degraded.hint !== 'Copied!', degraded.hint);
        /* The notice, not the hint -- for symmetry with the overlay rather than
           for the narrow-window reason: this window has a 720px minimum, so it
           never reaches the collapse. Two surfaces reporting one outcome two
           different ways is its own kind of dishonesty. */
        check('editor: ...and raises the notice, as the overlay does',
          degraded.noticeHidden === false && /HTML/.test(degraded.notice),
          JSON.stringify(degraded));

        const failed = await outcome({ ok: false, error: 'clipboard unavailable' });
        check('editor: a refusal is reported as a failure',
          /failed/i.test(failed.hint), failed.hint);
        check('editor: ...and the window is still there to retry from',
          (await cdp.eval(`String(!!document.getElementById('nhako-capture-host'))`)) === 'true');

        await cdp.eval(`globalThis.__reply = { ok: true };`);
      }

      /* T11: the same window, told its capture was capped.
         The first shim is REMOVED rather than layered over. Two injected
         scripts share one global lexical scope, so a second copy declaring
         `const realFetch` throws a redeclaration SyntaxError, never reaches
         its assignment to globalThis.chrome, and leaves the page running on
         the first shim's fixture -- a green test measuring the wrong thing. */
      {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
        const cappedShim = makeShim({ ...stored, captureCapped: true });
        const { identifier: id2 } = await cdp.send(
          'Page.addScriptToEvaluateOnNewDocument', { source: cappedShim });
        await cdp.send('Page.navigate', { url: `file://${join(ROOT, 'src/fallback/editor.html')}` });
        await sleep(900);

        const capped = JSON.parse(await cdp.eval(`(() => {
          const sr = document.getElementById('nhako-capture-host').shadowRoot;
          const n = sr.querySelector('.nc-notice');
          return JSON.stringify({
            hidden: n && n.hidden,
            text: n && n.textContent,
            colour: n && getComputedStyle(n).color,
            live: n && n.getAttribute('aria-live'),
            beforeHint: n && (n.compareDocumentPosition(sr.querySelector('.nc-hint'))
                              & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
            /* From the shadow root. A document-level querySelector cannot see
               through the boundary and returns undefined, which made an earlier
               version of the height check below pass without testing anything. */
            imageHeight: sr.querySelector('img.nc-backdrop')?.naturalHeight ?? null,
          });
        })()`));

        check('a capped capture says so, in the pill', capped.hidden === false,
          JSON.stringify(capped));
        check('...naming a height rather than a vague warning',
          /^Full page capped at \d+px — page is longer$/.test(capped.text || ''),
          capped.text);
        check("...and the height quoted is this image's own",
          typeof capped.imageHeight === 'number' && capped.imageHeight > 0 &&
          capped.text.includes(String(capped.imageHeight)), JSON.stringify(capped));
        check('...in the notice colour, not the hint grey',
          capped.colour === 'rgb(255, 204, 0)', capped.colour);
        check('...announced politely rather than interrupting',
          capped.live === 'polite', capped.live);
        check('...and read before the hint, per the content hierarchy',
          capped.beforeHint === true, JSON.stringify(capped));

        await shoot(cdp, '08-capped-editor');

        /* The reason it is not a hint: a status message must not erase it. */
        const survived = JSON.parse(await cdp.eval(`(() => {
          const sr = document.getElementById('nhako-capture-host').shadowRoot;
          sr.querySelector('.nc-hint').textContent = 'Copying…';
          const n = sr.querySelector('.nc-notice');
          return JSON.stringify({ hidden: n.hidden, text: n.textContent });
        })()`));
        check('the notice outlives a status message that would erase a hint',
          survived.hidden === false && /capped/.test(survived.text),
          JSON.stringify(survived));

        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id2 });
      }
    }

    /* --- README hero -------------------------------------------------------
     * Opt-in, because it writes into the repo rather than the scratch dir. The
     * README shows the actual product, rendered by the actual code -- not a
     * mockup that quietly stops being true.
     */
    if (HERO) {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(300);
      /* The tall fixture, whose first viewport is identical to the short one
         but which actually has something below the fold -- so the README shows
         both capture modes live rather than one greyed out. Honest either way;
         this one is honest about the case that matters. */
      await cdp.send('Page.navigate', { url: TALL_PAGE });
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
    // Chromium can still be flushing its profile as we exit; a failure to tidy
    // a temp directory must not fail the run.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* leave it for the OS */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
