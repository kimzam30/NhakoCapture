/* Render the launch poster.
 *
 *   node tools/render-poster.mjs
 *
 * docs/launch/poster.html -> docs/launch/poster.png, at 2x (2400 x 3280).
 * Headless Chromium draws it, so the poster uses the same engine the
 * extension runs in, and no dependency is added to render it. Re-run after
 * `node tools/preview.mjs out/ --hero` so the window shows the current UI.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = join(root, 'docs/launch/poster.html');
const out = join(root, 'docs/launch/poster.png');

const browser = ['google-chrome', 'chromium', 'chromium-browser', 'brave-browser']
  .find((b) => { try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; } });
if (!browser) throw new Error('render-poster: needs a Chromium-based browser on PATH');

const profile = mkdtempSync(join(tmpdir(), 'nc-poster-'));
try {
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--force-device-scale-factor=2',
    '--virtual-time-budget=3000',
    `--user-data-dir=${profile}`,
    '--window-size=1200,1640',
    `--screenshot=${out}`,
    `file://${page}`,
  ], { stdio: 'ignore' });
} finally {
  rmSync(profile, { recursive: true, force: true });
}
if (!existsSync(out)) throw new Error('render-poster: no image was written');
console.log('wrote docs/launch/poster.png');
