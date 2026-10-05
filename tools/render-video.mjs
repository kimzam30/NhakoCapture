/* Render the launch film.
 *
 *   node tools/render-video.mjs                 -> docs/launch/nhakocapture-launch.mp4
 *   node tools/render-video.mjs --stills 1,5.2  -> PNG stills at those times, for checking
 *   node tools/render-video.mjs --fps 30
 *
 * docs/launch/video.html paints any moment with window.render(t). This steps
 * through it one frame at a time in headless Chromium over the DevTools
 * Protocol (Node 22's built-in WebSocket, no dependencies, like preview.mjs)
 * and pipes the frames into ffmpeg. Because nothing runs on a real clock,
 * every frame is exact however long a screenshot takes.
 *
 * If docs/launch/soundtrack.wav exists (python3 tools/make-soundtrack.py),
 * it is muxed in, and a silent cut is written alongside.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'docs/launch/video.html');
const OUT = join(ROOT, 'docs/launch/nhakocapture-launch.mp4');
const SILENT = join(ROOT, 'docs/launch/nhakocapture-launch-silent.mp4');
const AUDIO = join(ROOT, 'docs/launch/soundtrack.wav');
const W = 1080, H = 1920;

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const FPS = Number(opt('--fps', 60));
const STILLS = opt('--stills', null);
const STILL_DIR = opt('--out', join(ROOT, 'docs/launch/stills'));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = cdp.pending.get(m.id);
      if (!p) return;
      cdp.pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
    return r.result.value;
  }
}

const browser = ['google-chrome', 'chromium', 'chromium-browser', 'brave-browser']
  .find((b) => { try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!browser) throw new Error('render-video: needs a Chromium-based browser on PATH');

const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'nc-film-'));
const chrome = spawn(browser, [
  '--headless=new', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--allow-file-access-from-files', '--disable-background-networking', '--disable-extensions',
  '--font-render-hinting=none',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

async function pageWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('render-video: browser did not start');
}

let ff;
try {
  const cdp = await CDP.attach(await pageWs());
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `file://${PAGE}?capture` });
  for (let i = 0; i < 100 && !(await cdp.eval('!!window.ready').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100));
  await cdp.eval('window.ready');
  const duration = await cdp.eval('window.DURATION');

  const frame = async (t) => {
    await cdp.eval(`window.render(${t}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    return Buffer.from(data, 'base64');
  };

  if (STILLS) {
    mkdirSync(STILL_DIR, { recursive: true });
    for (const s of STILLS.split(',').map(Number)) {
      const f = join(STILL_DIR, `t${s.toFixed(2)}.png`);
      writeFileSync(f, await frame(s));
      console.log(f);
    }
  } else {
    const total = Math.round(duration * FPS);
    ff = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-profile:v', 'high', '-movflags', '+faststart', SILENT,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((res, rej) => ff.on('exit', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
    const started = Date.now();
    for (let i = 0; i < total; i++) {
      const buf = await frame(i / FPS);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % FPS === 0) process.stdout.write(`\r${i}/${total} frames, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end();
    await done;
    console.log(`\nwrote ${SILENT}`);
    if (existsSync(AUDIO)) {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', SILENT, '-i', AUDIO,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
      console.log(`wrote ${OUT}`);
    }
  }
  cdp.ws.close();
} finally {
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited;
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
