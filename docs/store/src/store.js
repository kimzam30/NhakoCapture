/* Fills in the browser bar of every .window[data-url]. Chrome by default;
   tools/render-store.mjs --firefox opens the pages with ?firefox, which
   swaps in a Firefox-style toolbar for the AMO screenshots. */
const firefox = new URLSearchParams(location.search).has('firefox');
const icon = '<span class="ext"><img src="../../brand/logo-512.png" alt=""></span>';

for (const win of document.querySelectorAll('.window[data-url]')) {
  const bar = document.createElement('div');
  bar.className = `bar ${firefox ? 'firefox' : 'chrome'}`;
  const dots = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  const nav = '<span class="nav"><span>←</span><span>→</span><span>↻</span></span>';
  const url = win.dataset.url;
  bar.innerHTML = firefox
    ? `${dots}${nav}<div class="url"><span class="shield"></span><span class="lock"></span>${url}<span class="star">☆</span></div>`
      + `<span class="tools">${icon}<span class="burger"></span></span>`
    : `${dots}${nav}<div class="url"><span class="lock"></span>${url}</div>`
      + `<span class="tools">${icon}<span class="avatar"></span></span>`;
  win.prepend(bar);
}
