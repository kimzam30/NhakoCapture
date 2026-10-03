/* Render the Chrome Web Store graphics.
 *
 *   node tools/store-shots.mjs     (first: real product shots -> docs/store/raw)
 *   node tools/render-store.mjs    docs/store/src/*.html -> docs/store/*.png
 *
 * Every file comes out at exactly the size the store accepts -- it rejects
 * anything else -- and is flattened to RGB, because screenshots with an alpha
 * channel are refused too.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'docs/store/src');
const out = join(root, 'docs/store');

const JOBS = [
  ['1-hero', 1280, 800, 'screenshot-1-hero'],
  ['2-markup', 1280, 800, 'screenshot-2-markup'],
  ['3-blur', 1280, 800, 'screenshot-3-blur'],
  ['4-fullpage', 1280, 800, 'screenshot-4-whole-page'],
  ['5-private', 1280, 800, 'screenshot-5-private'],
  ['promo-small', 440, 280, 'promo-small-440x280'],
  ['promo-marquee', 1400, 560, 'promo-marquee-1400x560'],
];

const browser = ['google-chrome', 'chromium', 'chromium-browser', 'brave-browser']
  .find((b) => { try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!browser) throw new Error('render-store: needs a Chromium-based browser on PATH');

for (const [name, w, h, file] of JOBS) {
  const target = join(out, `${file}.png`);
  const profile = mkdtempSync(join(tmpdir(), 'nc-store-'));
  try {
    execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--allow-file-access-from-files', '--force-device-scale-factor=1',
      '--virtual-time-budget=3000', `--user-data-dir=${profile}`,
      `--window-size=${w},${h}`, `--screenshot=${target}`,
      `file://${join(src, `${name}.html`)}`,
    ], { stdio: 'ignore' });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  if (!existsSync(target)) throw new Error(`render-store: ${name} was not written`);

  /* Flatten and verify. The store says "24-bit PNG, no alpha" and means it. */
  const check = execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(target)})
if im.mode != 'RGB': im.convert('RGB').save(${JSON.stringify(target)})
im = Image.open(${JSON.stringify(target)})
print(im.size[0], im.size[1], im.mode)`]).toString().trim();
  if (check !== `${w} ${h} RGB`) throw new Error(`render-store: ${file} came out ${check}, wanted ${w} ${h} RGB`);
  console.log(`wrote docs/store/${file}.png (${check})`);
}
