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
 */
(() => {
  'use strict';

  const VERSION = '2.0.0';
  const existing = globalThis.NhakoCapture;

  if (existing) {
    if (existing.version === VERSION) {
      // Same build, already resident. Keep the modules, flag the re-entry so
      // inject.js knows to tear down the live overlay rather than stack a
      // second one on top of it.
      existing.reinjected = true;
      return;
    }
    // A different build is live -- almost certainly a reload during
    // development. Tear it down before replacing, or its listeners outlive it.
    try {
      existing.destroy?.();
    } catch (err) {
      console.warn('[NhakoCapture] previous build failed to tear down:', err);
    }
  }

  const modules = Object.create(null);

  globalThis.NhakoCapture = {
    version: VERSION,
    modules,
    reinjected: false,

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
  };
})();
