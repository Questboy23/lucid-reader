/**
 * Options page. Deliberately thin: it only exposes the handful of settings that
 * belong outside a document (takeover, default mode, position memory) plus a
 * global reset. Everything else is adjusted in the reader, next to the text it
 * affects.
 */

import * as store from '../reader/lib/settings.js';

const $ = id => document.getElementById(id);

let note = 0;
function saved(text = 'Saved') {
  $('saved').textContent = text;
  clearTimeout(note);
  note = setTimeout(() => { $('saved').textContent = ''; }, 1600);
}

function bindSwitch(key) {
  const btn = $(key);
  btn.addEventListener('click', async () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(next));
    await store.save({ [key]: next });
    saved();
  });
}

function paint(s) {
  for (const key of ['takeover', 'rememberPosition']) {
    $(key).setAttribute('aria-checked', String(!!s[key]));
  }
  $('defaultMode').value = s.defaultMode;
}

async function main() {
  paint(await store.load());

  bindSwitch('takeover');
  bindSwitch('rememberPosition');

  $('defaultMode').addEventListener('change', async e => {
    await store.save({ defaultMode: e.target.value });
    saved();
  });

  $('reset').addEventListener('click', async () => {
    await store.reset();
    paint(store.get());
    saved('Reset to defaults');
  });

  $('open').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('reader/reader.html') });
  });

  // chrome:// URLs can't be linked to directly from a page.
  for (const [id, url] of [
    ['ext-link', `chrome://extensions/?id=${chrome.runtime.id}`],
    ['sc-link', 'chrome://extensions/shortcuts'],
  ]) {
    const a = $(id);
    if (!a) continue;
    a.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url });
    });
  }

  if (new URLSearchParams(location.search).has('welcome')) {
    $('welcome-card').hidden = false;
  }

  store.subscribe(paint);
}

main();
