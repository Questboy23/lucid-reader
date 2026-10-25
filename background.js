/**
 * Service worker: decides when a PDF becomes a Lucid Reader tab.
 *
 * Takeover is done with dynamic declarativeNetRequest rules registered at
 * runtime rather than a static rule file, because the redirect target contains
 * the extension's own id (unknown at build time for unpacked installs) and
 * because the user can switch takeover off in settings.
 *
 * Only main_frame / sub_frame navigations are matched, so the reader's own
 * fetch() of the PDF bytes is never redirected into itself.
 */

const READER = chrome.runtime.getURL('reader/reader.html');

const RULE_URL_PDF = 1;      // ...something.pdf
const RULE_URL_PDF_FILE = 2; // file:///...pdf
const RULE_CTYPE = 3;        // Content-Type: application/pdf (Chrome 128+)

/** `?file=` must survive the redirect intact, so the original URL is escaped. */
function rules() {
  const target = `${READER}?file=\\0`;
  return [
    {
      id: RULE_URL_PDF,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: target } },
      condition: {
        regexFilter: '^https?://.+\\.pdf($|[?#])',
        resourceTypes: ['main_frame'],
        isUrlFilterCaseSensitive: false,
      },
    },
    {
      id: RULE_URL_PDF_FILE,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: target } },
      condition: {
        regexFilter: '^file://.+\\.pdf$',
        resourceTypes: ['main_frame'],
        isUrlFilterCaseSensitive: false,
      },
    },
  ];
}

/** Separate because response-header conditions need Chrome 128+. */
function ctypeRule() {
  return {
    id: RULE_CTYPE,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${READER}?file=\\0` } },
    condition: {
      regexFilter: '^https?://.+',
      resourceTypes: ['main_frame'],
      responseHeaders: [{ header: 'content-type', values: ['application/pdf', 'application/pdf;*'] }],
      excludedResponseHeaders: [
        // A PDF served for download should keep downloading.
        { header: 'content-disposition', values: ['attachment*'] },
      ],
    },
  };
}

async function setTakeover(on) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map(r => r.id);
  if (!on) {
    if (removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    }
    return;
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: rules(),
  });
  // Best effort: older Chrome rejects responseHeaders conditions outright.
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_CTYPE],
      addRules: [ctypeRule()],
    });
  } catch {
    /* extensionless PDFs simply won't auto-open; the toolbar button still works */
  }
}

async function syncFromSettings() {
  const { settings } = await chrome.storage.sync.get('settings').catch(() => ({}));
  const on = settings?.takeover !== false;
  await setTakeover(on);
}

chrome.runtime.onInstalled.addListener(async details => {
  await syncFromSettings();
  chrome.contextMenus.create({
    id: 'open-in-lucid',
    title: 'Open link in Lucid Reader',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', 'file:///*.pdf'],
  }, () => void chrome.runtime.lastError);
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(syncFromSettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) {
    const before = changes.settings.oldValue?.takeover;
    const after = changes.settings.newValue?.takeover;
    if (before !== after) setTakeover(after !== false);
  }
});

/** reader.html URL for an arbitrary PDF location. */
function readerUrlFor(pdfUrl) {
  return `${READER}?file=${encodeURIComponent(pdfUrl)}`;
}

function isReaderUrl(url) {
  return typeof url === 'string' && url.startsWith(READER);
}

async function openForTab(tab) {
  if (!tab) return;
  const url = tab.url || '';
  if (isReaderUrl(url)) {
    // Already in the reader — send it back to Chrome's own viewer.
    const raw = new URL(url).searchParams.get('file');
    if (raw) chrome.tabs.update(tab.id, { url: raw });
    return;
  }
  if (/^https?:|^file:/.test(url)) {
    chrome.tabs.update(tab.id, { url: readerUrlFor(url) });
    return;
  }
  chrome.tabs.create({ url: READER });
}

chrome.action.onClicked.addListener(openForTab);

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'open-reader') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  openForTab(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'open-in-lucid' || !info.linkUrl) return;
  chrome.tabs.create({ url: readerUrlFor(info.linkUrl), index: tab ? tab.index + 1 : undefined });
});

/** The reader asks for bytes when its own fetch is blocked by CORS. */
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type !== 'fetch-pdf' || typeof msg.url !== 'string') return false;
  fetch(msg.url, { credentials: 'include' })
    .then(async r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      // Structured clone of an ArrayBuffer over sendMessage is copied, not shared.
      respond({ ok: true, data: Array.from(new Uint8Array(buf)) });
    })
    .catch(e => respond({ ok: false, error: String(e && e.message || e) }));
  return true; // async
});
