/* Integrate fork-owned outlook into the downloaded console's quota page. */
(() => {
  'use strict';
  let authorization = '', frame = null, section = null, routeSince = 0, lastState = '', scheduled = false, retry = 0;
  let notes = new Map(), notesWanted = true, notesLoading = false;
  // Console theme tokens mirrored into the outlook so it matches every console theme.
  const TOKENS = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--text-primary', '--text-secondary',
    '--text-tertiary', '--text-quaternary', '--border-color', '--border-primary', '--border-hover', '--primary-color',
    '--error-color', '--bg-error-light', '--warning-border', '--success-badge-bg', '--success-badge-text',
    '--success-badge-border', '--failure-badge-bg', '--failure-badge-text', '--failure-badge-border', '--count-badge-bg',
    '--floating-surface', '--floating-shadow', '--ease-out-strong'];
  // Provider tab order used by the console quota page; labels are translated, so match by position.
  const PROVIDER_TABS = ['all', 'claude', 'antigravity', 'codex', 'xai', 'kimi', 'devin', 'meta', 'plugin'];
  const isQuota = () => /^#\/quota\/?(?:\?|$)/.test(location.hash);
  const tabsRow = () => document.querySelector('[class*="QuotaPage-module__tabsRow"]');
  function activeProvider() {
    const tabs = [...(tabsRow()?.querySelectorAll('button[aria-pressed]') || [])];
    const index = tabs.findIndex(tab => tab.getAttribute('aria-pressed') === 'true');
    if (index < 0) return null;
    if (tabs.length === PROVIDER_TABS.length) return PROVIDER_TABS[index];
    const label = tabs[index].querySelector('[class*="tabLabel"]')?.textContent || '';
    return index === 0 ? 'all' : label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
  }
  function state() {
    const root = getComputedStyle(document.documentElement), vars = {};
    for (const name of TOKENS) {
      const value = root.getPropertyValue(name).trim();
      if (value) vars[name] = value;
    }
    vars['--font'] = getComputedStyle(document.body).fontFamily;
    const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    return {type: 'quota-outlook-session', authorization, theme, vars, provider: activeProvider()};
  }
  const sendSession = force => {
    if (!frame?.contentWindow) return;
    const next = state(), serialized = JSON.stringify(next);
    if (!force && serialized === lastState) return;
    lastState = serialized;
    // Matching color schemes keeps the frame transparent over the console background.
    frame.style.colorScheme = next.theme;
    frame.contentWindow.postMessage(next, location.origin);
  };
  // React owns the console markup, so its text is hidden by a class and our nodes are appended beside it.
  function addStyle() {
    if (document.getElementById('quota-outlook-split-style')) return;
    const style = document.createElement('style');
    style.id = 'quota-outlook-split-style';
    style.textContent = '.qo-split>[class*="QuotaTimeline-module__windowLabel"]{display:none}' +
      '.qo-used,.qo-left{position:relative;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}' +
      '.qo-used{font-weight:600}.qo-left{margin-left:auto;padding-left:8px}' +
      '.qo-named>[class*="QuotaCard-module__fileName"]:not(.qo-note),.qo-named>[class*="QuotaTimeline-module__laneName"]:not(.qo-note){display:none}';
    document.head.append(style);
  }
  // Credential notes from the auth file editor, keyed by file name.
  function loadNotes() {
    if (!notesWanted || notesLoading || !authorization) return;
    notesWanted = false;
    notesLoading = true;
    originalFetch('/v8/management/credentials', {headers: {Authorization: authorization}, cache: 'no-store'})
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!Array.isArray(data?.files)) return;
        notes = new Map(data.files.filter(file => typeof file.note === 'string' && file.note.trim()).map(file => [file.name, file.note.trim()]));
        scheduleSync();
      })
      .catch(() => { /* Keep file names when notes cannot be loaded. */ })
      .finally(() => { notesLoading = false; });
  }
  // Quota cards and quota window lanes show the credential note instead of the file name;
  // hovering still shows the file name.
  function nameCards() {
    for (const name of document.querySelectorAll('[class*="QuotaCard-module__fileName"]:not(.qo-note),[class*="QuotaTimeline-module__laneName"]:not(.qo-note)')) {
      const head = name.parentElement, file = name.getAttribute('title') || name.textContent;
      const note = notes.get(file);
      let label = head.querySelector(':scope>.qo-note');
      if (!note) {
        head.classList.remove('qo-named');
        label?.remove();
        continue;
      }
      if (!label) {
        label = document.createElement('span');
        name.after(label);
      }
      const cls = name.className + ' qo-note';
      if (label.className !== cls) label.className = cls;
      if (label.textContent !== note) label.textContent = note;
      if (label.title !== file) label.title = file;
      if (!head.classList.contains('qo-named')) head.classList.add('qo-named');
    }
  }
  // Quota window bars read "used" on the left, over the used fill, and "left" on the right.
  const measure = document.createElement('canvas').getContext('2d');
  function splitWindows() {
    for (const bar of document.querySelectorAll('[class*="QuotaTimeline-module__window___"]')) {
      const fill = bar.querySelector('[class*="QuotaTimeline-module__windowFill"]');
      const title = bar.getAttribute('title') || '';
      const match = /([\d.]+)% remaining/.exec(title);
      const remaining = match ? Number(match[1]) : fill ? 100 - parseFloat(fill.style.width) : NaN;
      let used = bar.querySelector(':scope>.qo-used'), left = bar.querySelector(':scope>.qo-left');
      if (!fill || !Number.isFinite(remaining)) {
        bar.classList.remove('qo-split');
        used?.remove();
        left?.remove();
        continue;
      }
      if (!used) {
        used = document.createElement('span');
        used.className = 'qo-used';
        left = document.createElement('span');
        left.className = 'qo-left';
        bar.append(used, left);
      }
      const label = bar.querySelector('[class*="QuotaTimeline-module__windowLabel"]')?.textContent || '';
      const reset = label.includes('· ') ? label.slice(label.lastIndexOf('· ') + 2) : (/→ (.+)/.exec(title)?.[1] || '');
      const round = n => String(Math.round(n * 10) / 10);
      const usedText = round(100 - remaining) + '% used', leftText = round(remaining) + '% left';
      const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
      const show = (node, visible) => { if (node.hidden === visible) node.hidden = !visible; };
      if (!bar.classList.contains('qo-split')) bar.classList.add('qo-split');
      // Drop the reset time, then the used label, when the bar is too narrow for both.
      // Text is measured off-screen so every pass writes the same result and mutations settle.
      measure.font = getComputedStyle(bar).font;
      const width = text => measure.measureText(text).width, room = bar.clientWidth - 24;
      const full = reset ? leftText + ' · ' + reset : leftText;
      const fits = text => width(text) + width(usedText) * 1.08 <= room;
      set(used, usedText);
      set(left, fits(full) ? full : leftText);
      show(used, fits(left.textContent));
    }
  }
  const scheduleSync = () => {
    if (scheduled) return;
    scheduled = true;
    // A timer, unlike animation frames, still runs while the console tab is in the background.
    setTimeout(() => {
      scheduled = false;
      sendSession(false);
      if (!isQuota()) return;
      addStyle();
      loadNotes();
      nameCards();
      splitWindows();
    }, 50);
  };
  // Reuse the console's current session in memory. Never read or write browser storage.
  function capture(url, value) {
    try {
      const target = new URL(url, location.href);
      if (target.origin !== location.origin || !/^\/v(?:8|0)\/management\//.test(target.pathname)) return;
      if (typeof value === 'string' && /^Bearer\s+\S+/i.test(value) && authorization !== value) {
        authorization = value;
        notesWanted = true;
        scheduleSync();
      }
    } catch { /* Ignore non-URL requests. */ }
  }
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    capture(input instanceof Request ? input.url : input, headers.get('Authorization'));
    return originalFetch.apply(this, arguments);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url) {
    urls.set(this, url);
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (name.toLowerCase() === 'authorization') capture(urls.get(this), value);
    return originalSetHeader.apply(this, arguments);
  };
  function mount() {
    const main = document.querySelector('main.main-content');
    if (!isQuota() || !main) {
      section?.remove();
      section = frame = null;
      routeSince = 0;
      lastState = '';
      if (/^#\/login(?:\?|$)/.test(location.hash)) authorization = '';
      return;
    }
    if (section?.isConnected) {
      scheduleSync();
      return;
    }
    routeSince ||= Date.now();
    const anchor = tabsRow();
    // The quota page renders after the shell; wait briefly for the provider tabs before falling back.
    if (!anchor && Date.now() - routeSince < 1500) {
      retry ||= setTimeout(() => { retry = 0; mount(); }, 1600);
      return;
    }
    // Notes may have been edited on the auth files page since the last visit.
    notesWanted = true;
    section = document.createElement('section');
    section.id = 'quota-outlook-section';
    section.setAttribute('aria-label', 'Quota outlook');
    section.style.cssText = 'width:100%;min-width:0;' + (anchor ? '' : 'margin-top:24px;');
    frame = document.createElement('iframe');
    frame.title = 'Quota outlook';
    frame.src = '/quota-outlook/?embedded=1';
    frame.style.cssText = 'display:block;width:100%;height:0;border:0;background:transparent;';
    frame.addEventListener('load', () => sendSession(true));
    section.append(frame);
    lastState = '';
    if (anchor) anchor.after(section);
    else main.append(section);
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
    if (event.data?.type === 'quota-outlook-ready') sendSession(true);
    if (event.data?.type === 'quota-outlook-height' && Number.isFinite(event.data.height)) {
      const height = Math.max(0, Math.min(30000, event.data.height));
      if (frame.style.height !== height + 'px') frame.style.height = height + 'px';
    }
  });
  window.addEventListener('hashchange', mount);
  window.addEventListener('popstate', mount);
  // React Router can change the hash through history without a hashchange event.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function() {
      const result = original.apply(this, arguments);
      mount();
      return result;
    };
  }
  // Mutations cover route renders, provider tab changes, theme switches and quota window updates.
  new MutationObserver(mount).observe(document.documentElement, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-theme', 'aria-pressed', 'title']});
  window.addEventListener('resize', scheduleSync);
  mount();
})();
