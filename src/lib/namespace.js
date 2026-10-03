/* NhakoCapture — module namespace
 *
 * chrome.scripting.executeScript({files}) does not run content scripts as ES
 * modules, so there is no import/export available and no bundler in this
 * project by design (the README's "no bloated libraries" claim is meant
 * literally). Instead every overlay file is an IIFE that attaches itself to one
 * namespace on the isolated world's globalThis, and the files are injected in a
 * fixed order by background.js.
 *
 * This file must be first in that order, and must be safe to run repeatedly:
 * pressing Ctrl+Shift+5 twice re-injects every file.
 *
 * Every injection builds the namespace FROM SCRATCH. It used to keep the
 * resident modules whenever the version string matched, which is exactly
 * wrong after the extension is reloaded or updated: the isolated world
 * survives the reload, so the old modules stayed, still holding the OLD
 * chrome.runtime -- an invalidated one. Their message listener could never
 * hear the new service worker again, the handoff failed, and every capture on
 * that tab silently fell back to the editor window until the tab was
 * reloaded. Re-evaluating a dozen small IIFEs costs nothing by comparison.
 */
(() => {
  'use strict';

  /* Read from the manifest rather than repeated here, so a release bumps one
   * file and the two can never disagree. */
  const VERSION = globalThis.chrome?.runtime?.getManifest?.().version ?? 'dev';
  const existing = globalThis.NhakoCapture;

  if (existing) {
    /* Take down whatever the previous build left running -- its overlay, and
     * its runtime listener -- before replacing it, or they outlive it. */
    try {
      existing.destroy?.();
    } catch (err) {
      console.warn('[NhakoCapture] previous overlay failed to tear down:', err);
    }
    try {
      existing.detach?.();
    } catch {
      /* An orphaned runtime throws here; its listener is already dead. */
    }
  }

  const modules = Object.create(null);

  globalThis.NhakoCapture = {
    version: VERSION,
    modules,

    define(name, value) {
      modules[name] = value;
      return value;
    },

    require(name) {
      const mod = modules[name];
      if (!mod) {
        throw new Error(
          `[NhakoCapture] module "${name}" was required before it loaded. ` +
          `Check the injection order in background.js.`
        );
      }
      return mod;
    },

    // Set by inject.js once an overlay is mounted; null when nothing is up.
    destroy: null,
    // Set by inject.js: removes its runtime message listener.
    detach: null,
  };
})();
