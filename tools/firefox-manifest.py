#!/usr/bin/env python3
"""Print the Firefox manifest, derived from the Chrome manifest.json.

    python3 tools/firefox-manifest.py > path/to/manifest.json

What changes, and why:
  * background: Firefox MV3 has no service workers for extensions; it runs an
    event page from `scripts`. offscreen.js is loaded first so its jobs
    (clipboard, blob URLs) are plain functions background.js can call --
    Firefox has no chrome.offscreen, and does not need it, because an event
    page has a DOM.
  * permissions: `offscreen` does not exist in Firefox (it warns on unknown
    permissions); `clipboardWrite` lets the background page write images.
  * browser_specific_settings.gecko: the add-on ID AMO signs against, the
    minimum version, and the data-collection declaration every new AMO
    listing must carry. NhakoCapture collects nothing.
"""
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

GECKO_ID = 'nhakocapture@kimzam30.github.io'
# 140 is the first desktop release (and the current ESR) that understands
# data_collection_permissions; older ones would install without the consent
# screen AMO now requires.
MIN_FIREFOX = '140.0'


def firefox_manifest():
    with open(os.path.join(ROOT, 'manifest.json')) as f:
        m = json.load(f)

    m.pop('minimum_chrome_version', None)
    m['background'] = {'scripts': ['src/offscreen.js', m['background']['service_worker']]}
    perms = [p for p in m['permissions'] if p != 'offscreen']
    if 'clipboardWrite' not in perms:
        perms.append('clipboardWrite')
    m['permissions'] = perms
    m['browser_specific_settings'] = {
        'gecko': {
            'id': GECKO_ID,
            'strict_min_version': MIN_FIREFOX,
            'data_collection_permissions': {'required': ['none']},
        }
    }
    return m


if __name__ == '__main__':
    json.dump(firefox_manifest(), sys.stdout, indent=2)
    sys.stdout.write('\n')
