/* Integrate fork-owned outlook into the downloaded console's quota page. */
(() => {
  'use strict';
  let authorization = '', frame = null, section = null, routeSince = 0, lastState = '', scheduled = false, retry = 0;
  let notes = new Map(), notesWanted = true, notesLoading = false;
  let fileIndex = new Map(), months = new Map(), monthsAt = 0, monthsLoading = false;
  // Console theme tokens mirrored into the outlook so it matches every console theme.
  const TOKENS = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--text-primary', '--text-secondary',
    '--text-tertiary', '--text-quaternary', '--border-color', '--border-primary', '--border-hover', '--primary-color',
    '--error-color', '--bg-error-light', '--warning-border', '--success-badge-bg', '--success-badge-text',
    '--success-badge-border', '--failure-badge-bg', '--failure-badge-text', '--failure-badge-border', '--count-badge-bg',
    '--floating-surface', '--floating-shadow', '--ease-out-strong'];
  // Provider tab order used by the console quota page; labels are translated, so match by position.
  const PROVIDER_TABS = ['all', 'claude', 'antigravity', 'codex', 'xai', 'kimi', 'devin', 'meta', 'plugin'];
  const isQuota = () => /^#\/quota\/?(?:\?|$)/.test(location.hash) &&
    new URLSearchParams(location.hash.split('?')[1] || '').get('view') !== 'model-usage';
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
      '.qo-named>[class*="QuotaCard-module__fileName"]:not(.qo-note),.qo-named>[class*="QuotaTimeline-module__laneName"]:not(.qo-note){display:none}' +
      '.qo-month>[class*="QuotaTimeline-module__window___"]:not(.qo-bar),.qo-month>[class*="QuotaTimeline-module__laneIdle"],' +
      '.qo-month-top>[class*="QuotaTimeline-module__lanePeriod"]:not(.qo-period){display:none}';
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
        fileIndex = new Map(data.files.map(file => [file.name, file.auth_index]));
        scheduleSync();
      })
      .catch(() => { /* Keep file names when notes cannot be loaded. */ })
      .finally(() => { notesLoading = false; });
  }
  // Latest monthly limit of each subscription that reports no weekly one (Kimi), from quota history.
  function loadMonths() {
    if (monthsLoading || !authorization || Date.now() - monthsAt < 120000) return;
    monthsLoading = true;
    monthsAt = Date.now();
    originalFetch('/v8/management/quota/history', {headers: {Authorization: authorization}, cache: 'no-store'})
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!Array.isArray(data?.samples)) return;
        const latest = new Map(), next = new Map();
        for (const sample of data.samples) {
          const at = Date.parse(sample.at), last = latest.get(sample.account);
          if (!last || at > last.at) latest.set(sample.account, {at, batch: [sample]});
          else if (at === last.at) last.batch.push(sample);
        }
        for (const [account, {batch}] of latest) {
          const month = batch.find(s => s.windowHours >= 600 && s.windowHours <= 800 && Date.parse(s.reset));
          if (!month || batch.some(s => s.windowHours >= 144 && s.windowHours <= 192)) continue;
          next.set(account, {reset: Date.parse(month.reset), remaining: Math.round(month.remaining)});
        }
        months = next;
        scheduleSync();
      })
      .catch(() => { monthsAt = 0; })
      .finally(() => { monthsLoading = false; });
  }
  // Hashed console class names, read from the console's inline styles.
  const classes = {};
  function moduleClass(name) {
    if (!classes[name]) {
      const pattern = new RegExp('QuotaTimeline-module__' + name + '___[\\w-]+');
      for (const style of document.querySelectorAll('style')) {
        const match = pattern.exec(style.textContent);
        if (match) { classes[name] = match[0]; break; }
      }
    }
    return classes[name] || '';
  }
  const pad = n => String(n).padStart(2, '0');
  const stamp = ms => { const d = new Date(ms); return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const laneFile = lane => { const name = lane.querySelector('[class*="QuotaTimeline-module__laneName"]:not(.qo-note)'); return name?.getAttribute('title') || name?.textContent || ''; };
  // The weekly view only draws windows up to two weeks long, so a subscription whose long limit is
  // monthly shows its 5-hour window there. Draw its monthly windows instead, styled like the console's.
  function monthLanes() {
    const weekly = document.querySelector('[class*="QuotaTimeline-module__modes"] button')?.getAttribute('aria-pressed') === 'true';
    const first = /^(\d\d)\/(\d\d)$/.exec(document.querySelector('[class*="QuotaTimeline-module__axisDate"]')?.textContent.trim() || '');
    let start = NaN;
    if (weekly && first) {
      // The axis shows no year; take the one nearest today.
      const now = Date.now();
      start = [-1, 0, 1].map(k => new Date(new Date().getFullYear() + k, first[1] - 1, first[2]).getTime())
        .reduce((best, at) => Math.abs(at - now) < Math.abs(best - now) ? at : best);
    }
    const end = new Date(start);
    end.setDate(end.getDate() + 14);
    for (const lane of document.querySelectorAll('[class*="QuotaTimeline-module__lane___"]')) {
      const track = lane.querySelector('[class*="QuotaTimeline-module__track___"]');
      const top = lane.querySelector('[class*="QuotaTimeline-module__laneTop"]');
      const month = Number.isFinite(start) ? months.get(fileIndex.get(laneFile(lane))) : null;
      if (!track || !top) continue;
      if (month) {
        drawMonths(lane, track, top, month, start, end.getTime());
        continue;
      }
      track.classList.remove('qo-month');
      top.classList.remove('qo-month-top');
      for (const node of lane.querySelectorAll('.qo-bar,.qo-period')) node.remove();
      track.qoMonths = '';
    }
  }
  function drawMonths(lane, track, top, month, start, end) {
    const now = Date.now(), percent = ms => (ms - start) / (end - start) * 100;
    const shift = (ms, n) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime(); };
    const bars = [];
    let n = 0;
    while (shift(month.reset, n - 1) > start && n > -24) n--;
    for (; shift(month.reset, n - 1) < end && n < 24; n++) {
      const from = shift(month.reset, n - 1), to = shift(month.reset, n);
      const left = Math.max(0, percent(from)), right = Math.min(100, percent(to));
      if (right <= left) continue;
      const state = to <= now ? 'Past' : from <= now ? 'Live' : 'Next';
      // Usage belongs to the reported month only, as in the console's own bars.
      bars.push({from, to, left, width: right - left, state, remaining: state === 'Live' && n === 0 ? month.remaining : null});
    }
    if (!track.classList.contains('qo-month')) track.classList.add('qo-month');
    if (!top.classList.contains('qo-month-top')) top.classList.add('qo-month-top');
    if (!top.querySelector(':scope>.qo-period')) {
      const period = document.createElement('span');
      period.className = moduleClass('lanePeriod') + ' qo-period';
      period.textContent = '1mo';
      top.append(period);
    }
    // Rebuild only when the bars change, so the observer settles.
    const signature = JSON.stringify(bars);
    if (track.qoMonths === signature) return;
    track.qoMonths = signature;
    for (const node of track.querySelectorAll(':scope>.qo-bar')) node.remove();
    for (const bar of bars) {
      const node = document.createElement('div');
      node.className = moduleClass('window') + ' ' + moduleClass('window' + bar.state) + ' qo-bar';
      node.style.left = bar.left + '%';
      node.style.width = bar.width + '%';
      node.title = laneFile(lane) + '\n' + stamp(bar.from) + ' → ' + stamp(bar.to) + (bar.remaining !== null ? '\n' + bar.remaining + '% remaining' : '');
      if (bar.remaining !== null) {
        const fill = document.createElement('span');
        fill.className = moduleClass('windowFill');
        fill.style.width = (100 - bar.remaining) + '%';
        node.append(fill);
      }
      if (bar.width > 9) {
        const label = document.createElement('span');
        label.className = moduleClass('windowLabel');
        label.textContent = (bar.remaining !== null ? bar.remaining + '% · ' : '') + stamp(bar.to);
        node.append(label);
      }
      track.append(node);
    }
  }
  // Kimi rows carry only a translation key, so their lane chips have no name; reuse the card's row names.
  function nameLimits() {
    const cards = new Map();
    for (const name of document.querySelectorAll('[class*="QuotaCard-module__fileName"]:not(.qo-note)')) {
      cards.set(name.getAttribute('title') || name.textContent, name.closest('[class*="QuotaCard-module__card___"]'));
    }
    for (const lane of document.querySelectorAll('[class*="QuotaTimeline-module__lane___"]')) {
      const chips = [...lane.querySelectorAll('[class*="QuotaTimeline-module__laneLimit___"]')];
      const rows = [...(cards.get(laneFile(lane))?.querySelectorAll('[class*="QuotaBody-module__quotaModel"]') || [])];
      chips.forEach((chip, index) => {
        let label = chip.querySelector(':scope>.qo-limit');
        const own = [...chip.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
        const text = !own && rows.length === chips.length ? rows[index].textContent.trim() : '';
        if (!text) { label?.remove(); return; }
        if (!label) {
          label = document.createElement('span');
          label.className = 'qo-limit';
          chip.prepend(label);
        }
        if (label.textContent !== text + ' ') label.textContent = text + ' ';
      });
    }
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
      loadMonths();
      nameCards();
      monthLanes();
      nameLimits();
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
        monthsAt = 0;
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
    monthsAt = 0;
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
