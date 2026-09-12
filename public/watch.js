import {
  parseM3U,
  channelKey,
  parseGuideForNowNext,
  getNowNext,
  formatTime,
  pushRecent as pushRecentKey,
  pruneStaleKeys,
  isMixedContentCandidate,
  buildHttpsUpgradeUrl,
  redactUrl,
  redactHost,
  classifyStreamType,
  classifyPlaybackError,
  ERROR_MESSAGES
} from './watch-core.js';

const THEME_KEY = 'iptv4u_theme_v1';

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // ignore
  }
  if (saved === 'dark' || saved === 'light') {
    document.documentElement.setAttribute('data-theme', saved);
  }
}

document.getElementById('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // ignore
  }
});

initTheme();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}

function updateOfflineBanner() {
  const banner = document.getElementById('offlineBanner');
  if (banner) banner.hidden = navigator.onLine;
}
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);
updateOfflineBanner();

const el = {
  slugInput: document.getElementById('slugInput'),
  loadSlugBtn: document.getElementById('loadSlugBtn'),
  slugStatus: document.getElementById('slugStatus'),
  watchArea: document.getElementById('watchArea'),
  channelCountPill: document.getElementById('channelCountPill'),
  channelCount: document.getElementById('channelCount'),
  channelSearch: document.getElementById('channelSearch'),
  groupFilter: document.getElementById('groupFilter'),
  favFilterBtn: document.getElementById('favFilterBtn'),
  recentRow: document.getElementById('recentRow'),
  channelList: document.getElementById('channelList'),
  player: document.getElementById('player'),
  playerOverlay: document.getElementById('playerOverlay'),
  goLiveBtn: document.getElementById('goLiveBtn'),
  favBtn: document.getElementById('favBtn'),
  sleepTimer: document.getElementById('sleepTimer'),
  nowPlayingLogo: document.getElementById('nowPlayingLogo'),
  nowPlayingName: document.getElementById('nowPlayingName'),
  nowPlayingGroup: document.getElementById('nowPlayingGroup'),
  nowPlayingGuide: document.getElementById('nowPlayingGuide'),
  nowPlayingCurrentTitle: document.getElementById('nowPlayingCurrentTitle'),
  nowPlayingCurrentTime: document.getElementById('nowPlayingCurrentTime'),
  nowPlayingProgress: document.getElementById('nowPlayingProgress'),
  nowPlayingNextTitle: document.getElementById('nowPlayingNextTitle'),
  nowPlayingNextTime: document.getElementById('nowPlayingNextTime'),
  diagnosticsList: document.getElementById('diagnosticsList'),
  copyDiagnosticBtn: document.getElementById('copyDiagnosticBtn'),
  copyDiagnosticStatus: document.getElementById('copyDiagnosticStatus')
};

const state = {
  slug: '',
  channels: [],
  activeIndex: null,
  hls: null,
  mpegts: null,
  watchdogTimer: null,
  attemptId: 0, // monotonically increasing — guards every async callback below
  status: 'idle', // idle | loading | playing | buffering | reconnecting | paused | ended | failed
  diagnostics: null,
  guide: new Map(), // channel id (tvg-id) -> sorted programme list
  favorites: new Set(),
  recents: [],
  favoritesOnly: false,
  sleepTimerHandle: null,
  nowNextInterval: null
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setOverlay(message) {
  if (!message) {
    el.playerOverlay.hidden = true;
    el.playerOverlay.textContent = '';
    return;
  }
  el.playerOverlay.hidden = false;
  el.playerOverlay.textContent = message;
}

function clearWatchdog() {
  if (state.watchdogTimer) {
    clearTimeout(state.watchdogTimer);
    state.watchdogTimer = null;
  }
}

// Tears down whichever player is active and bumps the attempt id, so any
// event a soon-to-be-destroyed hls.js/mpegts.js instance fires afterward
// (its own destroy() is not guaranteed instantaneous for every in-flight
// callback) is recognized as stale and ignored rather than mutating the
// UI for a channel the viewer already navigated away from.
function destroyPlayer() {
  state.attemptId += 1;
  clearWatchdog();
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  if (state.mpegts) {
    try {
      state.mpegts.destroy();
    } catch {
      // ignore — already torn down
    }
    state.mpegts = null;
  }
  el.player.removeAttribute('src');
  el.player.oncanplay = null;
  el.player.onerror = null;
  el.player.onwaiting = null;
  el.player.onplaying = null;
  el.player.onpause = null;
  el.player.onended = null;
  el.player.load();
}

function renderDiagnostics() {
  const d = state.diagnostics;
  if (!d) {
    el.diagnosticsList.innerHTML = '<dt>Status</dt><dd>No channel selected yet.</dd>';
    return;
  }
  const rows = [
    ['Channel', d.channelName || ''],
    ['Host', d.host || ''],
    ['Scheme', d.scheme || ''],
    ['Delivery', d.delivery || ''],
    ['Content-Type', d.contentType || '(unverified — blocked from browser inspection)'],
    ['Playback strategy', d.strategy || ''],
    ['HTTPS upgrade attempted', d.httpsUpgradeAttempted ? 'yes' : 'no'],
    ['HTTPS upgrade succeeded', d.httpsUpgradeAttempted ? (d.httpsUpgradeSucceeded ? 'yes' : 'no') : 'n/a'],
    ['Status', d.status || ''],
    ['Failure category', d.failureCategory || 'none'],
    ['Detail (redacted)', d.detail || 'none'],
    ['Timestamp', d.timestamp || '']
  ];
  el.diagnosticsList.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

function setStatus(status, { category = null, detail = null } = {}) {
  state.status = status;
  if (state.diagnostics) {
    state.diagnostics.status = status;
    state.diagnostics.failureCategory = category;
    state.diagnostics.detail = detail ? redactUrl(String(detail)) || String(detail).slice(0, 200) : null;
    state.diagnostics.timestamp = new Date().toISOString();
  }
  renderDiagnostics();
}

el.copyDiagnosticBtn.addEventListener('click', async () => {
  const d = state.diagnostics;
  const lines = d
    ? [
        `channel: ${d.channelName || ''}`,
        `host: ${d.host || ''}`,
        `scheme: ${d.scheme || ''}`,
        `delivery: ${d.delivery || ''}`,
        `contentType: ${d.contentType || 'unverified'}`,
        `strategy: ${d.strategy || ''}`,
        `httpsUpgradeAttempted: ${d.httpsUpgradeAttempted}`,
        `httpsUpgradeSucceeded: ${d.httpsUpgradeAttempted ? d.httpsUpgradeSucceeded : 'n/a'}`,
        `status: ${d.status || ''}`,
        `failureCategory: ${d.failureCategory || 'none'}`,
        `detail: ${d.detail || 'none'}`,
        `timestamp: ${d.timestamp || ''}`
      ]
    : ['No channel selected yet.'];
  // Deliberately excludes: full stream URL, query string, any header,
  // cookie, token, username or password — only a redacted host+path (see
  // watch-core.js's redactUrl) ever appears above.
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    el.copyDiagnosticStatus.textContent = 'Copied.';
  } catch {
    el.copyDiagnosticStatus.textContent = text;
  }
  setTimeout(() => {
    el.copyDiagnosticStatus.textContent = '';
  }, 4000);
});

const WATCHDOG_MS = 15000;

function attemptPlayback(url, { isUpgradeAttempt = false, originalUrl = url, channelName = '' } = {}) {
  destroyPlayer();
  const myAttempt = state.attemptId;
  const isStale = () => myAttempt !== state.attemptId;

  state.diagnostics = {
    channelName,
    host: redactHost(originalUrl),
    scheme: (originalUrl.match(/^([a-z]+):/i) || [])[1] || '',
    delivery: null,
    contentType: null,
    strategy: null,
    httpsUpgradeAttempted: isUpgradeAttempt,
    httpsUpgradeSucceeded: null,
    status: 'loading',
    failureCategory: null,
    detail: null,
    timestamp: new Date().toISOString()
  };

  setStatus('loading');
  setOverlay(isUpgradeAttempt ? 'Loading… (trying a secure version of this stream)' : 'Loading…');

  const fail = (category, detail) => {
    if (isStale()) return;
    clearWatchdog();
    if (isUpgradeAttempt) {
      state.diagnostics.httpsUpgradeSucceeded = false;
      setStatus('failed', { category: 'HTTPS_UPGRADE_FAILED', detail });
      setOverlay(ERROR_MESSAGES.HTTPS_UPGRADE_FAILED);
      return;
    }
    setStatus('failed', { category, detail });
    setOverlay(ERROR_MESSAGES[category] || ERROR_MESSAGES.UNKNOWN);
  };

  const succeed = () => {
    if (isStale()) return;
    clearWatchdog();
    if (isUpgradeAttempt) state.diagnostics.httpsUpgradeSucceeded = true;
    setStatus('playing');
    setOverlay(null);
  };

  state.watchdogTimer = setTimeout(() => {
    if (isStale()) return;
    const { category } = classifyPlaybackError({ source: 'watchdog' });
    fail(category, 'watchdog-timeout');
  }, WATCHDOG_MS);

  const playSafely = () => {
    el.player.play().catch((error) => {
      if (isStale()) return;
      if (error && error.name === 'NotAllowedError') {
        clearWatchdog();
        setStatus('paused', { category: 'AUTOPLAY_BLOCKED' });
        setOverlay(ERROR_MESSAGES.AUTOPLAY_BLOCKED);
      }
      // Other rejection reasons (e.g. aborted by a fast channel switch)
      // are expected and not worth surfacing as a failure.
    });
  };

  el.player.onwaiting = () => {
    if (isStale() || state.status === 'failed') return;
    setStatus('buffering');
  };
  el.player.onplaying = () => {
    if (isStale()) return;
    setStatus('playing');
  };
  el.player.onended = () => {
    if (isStale()) return;
    setStatus('ended');
  };

  const isHls = /\.m3u8?(\?|$)/i.test(url);
  state.diagnostics.delivery = classifyStreamType(url, '');

  if (isHls && window.Hls && window.Hls.isSupported()) {
    state.diagnostics.strategy = 'hls.js';
    const hls = new window.Hls({ enableWorker: true });
    state.hls = hls;

    // hls.js already retries recoverable network/media errors internally
    // with its own bounded backoff — only a `fatal` error means it gave
    // up, which is the only case that should reach the viewer.
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (isStale() || !data.fatal) return;
      const { category } = classifyPlaybackError({ source: 'hls', detail: data.details, isUpgradeAttempt });
      fail(category, data.details);
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, (_evt, data) => {
      if (isStale()) return;
      state.diagnostics.contentType = 'application/vnd.apple.mpegurl (parsed)';
      if (Array.isArray(data?.levels)) {
        state.diagnostics.levelCount = data.levels.length;
      }
      succeed();
      playSafely();
    });
    hls.loadSource(url);
    hls.attachMedia(el.player);
  } else if (isHls) {
    // Native HLS (Safari/iOS) — no hls.js involved.
    state.diagnostics.strategy = 'native';
    el.player.src = url;
    el.player.oncanplay = () => succeed();
    el.player.onerror = () => {
      const code = el.player.error ? el.player.error.code : null;
      const { category } = classifyPlaybackError({ source: 'native', detail: code });
      fail(category, code);
    };
    playSafely();
  } else if (window.mpegts && window.mpegts.isSupported()) {
    // Most IPTV playlists serve a continuous raw MPEG-TS stream (no
    // .m3u8 manifest at all) rather than real HLS — browsers can't play
    // that container natively, so it needs mpegts.js's MSE remuxer.
    state.diagnostics.strategy = 'mpegts.js';
    state.diagnostics.delivery = 'mpegts';
    const player = window.mpegts.createPlayer({ type: 'mpegts', isLive: true, url });
    state.mpegts = player;
    player.on(window.mpegts.Events.ERROR, (_type, detail) => {
      if (isStale()) return;
      const { category } = classifyPlaybackError({ source: 'mpegts', detail });
      fail(category, detail);
    });
    player.attachMediaElement(el.player);
    player.load();
    player.play().then(() => succeed()).catch((error) => {
      if (isStale()) return;
      if (error && error.name === 'NotAllowedError') {
        clearWatchdog();
        setStatus('paused', { category: 'AUTOPLAY_BLOCKED' });
        setOverlay(ERROR_MESSAGES.AUTOPLAY_BLOCKED);
      }
    });
  } else {
    state.diagnostics.strategy = 'native-progressive';
    el.player.src = url;
    el.player.oncanplay = () => succeed();
    el.player.onerror = () => {
      const code = el.player.error ? el.player.error.code : null;
      const { category } = classifyPlaybackError({ source: 'native', detail: code });
      fail(category, code);
    };
    playSafely();
  }

  renderDiagnostics();

  // Best-effort, non-blocking content-type probe purely for diagnostics —
  // never gates playback, and a CORS failure is reported as "unverified",
  // not "unsupported" (the stream may still play fine via hls.js/mpegts.js,
  // which fetch it themselves rather than through this page's fetch()).
  const controller = new AbortController();
  const probeTimer = setTimeout(() => controller.abort(), 4000);
  fetch(url, { method: 'GET', mode: 'cors', headers: { Range: 'bytes=0-1023' }, signal: controller.signal })
    .then((res) => {
      clearTimeout(probeTimer);
      if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
      if (isStale()) return;
      const contentType = res.headers.get('content-type') || '';
      state.diagnostics.contentType = contentType || state.diagnostics.contentType;
      if (contentType) state.diagnostics.delivery = classifyStreamType(url, contentType);
      renderDiagnostics();
    })
    .catch(() => {
      clearTimeout(probeTimer);
      // Left as whatever classifyStreamType(url, '') already inferred —
      // "unverified", not overwritten with a false negative.
    });
}

function updateNowPlayingGuide(channel) {
  const tvgId = channel.attrs['tvg-id'];
  const { current, next } = tvgId ? getNowNext(state.guide, tvgId) : { current: null, next: null };

  if (!current && !next) {
    el.nowPlayingGuide.hidden = true;
    return;
  }

  el.nowPlayingGuide.hidden = false;
  const placeholderTag = (p) => (p && p.isPlaceholder ? ' (estimated — no verified schedule)' : '');

  if (current) {
    el.nowPlayingCurrentTitle.textContent = (current.title || '(no title)') + placeholderTag(current);
    const startMs = current.start.getTime();
    const stopMs = current.stop ? current.stop.getTime() : null;
    if (stopMs) {
      el.nowPlayingCurrentTime.textContent = `${formatTime(current.start)} – ${formatTime(current.stop)}`;
      const pct = Math.min(100, Math.max(0, ((Date.now() - startMs) / (stopMs - startMs)) * 100));
      el.nowPlayingProgress.style.width = `${pct}%`;
    } else {
      el.nowPlayingCurrentTime.textContent = formatTime(current.start);
      el.nowPlayingProgress.style.width = '0%';
    }
  } else {
    el.nowPlayingCurrentTitle.textContent = 'No programme data right now';
    el.nowPlayingCurrentTime.textContent = '';
    el.nowPlayingProgress.style.width = '0%';
  }

  if (next) {
    el.nowPlayingNextTitle.textContent = (next.title || '(no title)') + placeholderTag(next);
    el.nowPlayingNextTime.textContent = formatTime(next.start);
  } else {
    el.nowPlayingNextTitle.textContent = '—';
    el.nowPlayingNextTime.textContent = '';
  }
}

function saveRecents(slug, recents) {
  try {
    localStorage.setItem(`iptv4u_watch_recents_${slug}`, JSON.stringify(recents.slice(0, 12)));
  } catch {
    // ignore
  }
}

function pushRecent(channel) {
  state.recents = pushRecentKey(state.recents, channelKey(channel), 12);
  saveRecents(state.slug, state.recents);
  renderRecentRow();
}

function playChannel(channel) {
  state.activeIndex = channel.index;

  el.nowPlayingName.textContent = channel.name;
  el.nowPlayingGroup.textContent = channel.attrs['group-title'] || '';
  const logo = channel.attrs['tvg-logo'];
  if (logo) {
    el.nowPlayingLogo.src = logo;
    el.nowPlayingLogo.hidden = false;
  } else {
    el.nowPlayingLogo.hidden = true;
  }

  el.favBtn.classList.toggle('active', state.favorites.has(channelKey(channel)));
  el.favBtn.textContent = state.favorites.has(channelKey(channel)) ? '★ Favourite' : '☆ Favourite';
  updateNowPlayingGuide(channel);

  const url = channel.url;
  // Runs at most once per playback attempt (this call), never mutates
  // channel.url itself, and only ever fires for an http:// stream loaded
  // from this https-deployed page — never the reverse, and never twice.
  const needsHttpsAttempt = isMixedContentCandidate(location.protocol, url);
  const upgraded = needsHttpsAttempt ? buildHttpsUpgradeUrl(url) : null;
  attemptPlayback(upgraded || url, {
    isUpgradeAttempt: !!upgraded,
    originalUrl: url,
    channelName: channel.name
  });

  renderChannelList();
  pushRecent(channel);
  try {
    localStorage.setItem(`iptv4u_watch_last_${state.slug}`, String(channel.index));
  } catch {
    // ignore
  }
}

function matchesFilters(channel, query, group) {
  if (state.favoritesOnly && !state.favorites.has(channelKey(channel))) return false;
  if (group && (channel.attrs['group-title'] || '') !== group) return false;
  if (!query) return true;
  const haystack = `${channel.name} ${channel.attrs['group-title'] || ''}`.toLowerCase();
  return haystack.includes(query);
}

function nowNextRowHtml(channel) {
  const tvgId = channel.attrs['tvg-id'];
  if (!tvgId) return '';
  const { current } = getNowNext(state.guide, tvgId);
  if (!current) return '';
  return escapeHtml(current.title || '') + (current.isPlaceholder ? ' (est.)' : '');
}

function renderChannelList() {
  const query = el.channelSearch.value.trim().toLowerCase();
  const group = el.groupFilter.value;
  const filtered = state.channels.filter((c) => matchesFilters(c, query, group));

  if (!filtered.length) {
    el.channelList.innerHTML = '<li class="channel-list-empty">No channels match.</li>';
    return;
  }

  el.channelList.innerHTML = filtered.map((channel) => {
    const logo = channel.attrs['tvg-logo'];
    const logoHtml = logo
      ? `<img class="logo-thumb" src="${escapeHtml(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
      : '<div class="logo-thumb--empty"></div>';
    const activeClass = channel.index === state.activeIndex ? ' active' : '';
    const chno = channel.attrs['tvg-chno'];
    const isFav = state.favorites.has(channelKey(channel));
    const nowText = nowNextRowHtml(channel);
    return `
      <li class="channel-row${activeClass}" data-index="${channel.index}" tabindex="0" role="button" aria-label="Play ${escapeHtml(channel.name)}">
        ${chno ? `<span class="channel-row-number">${escapeHtml(chno)}</span>` : ''}
        ${logoHtml}
        <div class="channel-row-info">
          <div class="channel-row-name">${escapeHtml(channel.name)}</div>
          <div class="channel-row-group">${escapeHtml(channel.attrs['group-title'] || '')}</div>
          ${nowText ? `<div class="channel-row-nownext" data-nownext="${channel.index}">▸ ${nowText}</div>` : ''}
        </div>
        <button class="channel-row-fav${isFav ? ' active' : ''}" data-fav-index="${channel.index}" title="Toggle favourite" aria-label="Toggle favourite for ${escapeHtml(channel.name)}">${isFav ? '★' : '☆'}</button>
      </li>
    `;
  }).join('');

  el.channelList.querySelectorAll('.channel-row').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('.channel-row-fav')) return;
      const idx = Number(row.dataset.index);
      const channel = state.channels.find((c) => c.index === idx);
      if (channel) playChannel(channel);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const idx = Number(row.dataset.index);
      const channel = state.channels.find((c) => c.index === idx);
      if (channel) playChannel(channel);
    });
  });

  el.channelList.querySelectorAll('.channel-row-fav').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const idx = Number(btn.dataset.favIndex);
      const channel = state.channels.find((c) => c.index === idx);
      if (channel) toggleFavorite(channel);
    });
  });
}

function renderRecentRow() {
  const channels = state.recents
    .map((key) => state.channels.find((c) => channelKey(c) === key))
    .filter(Boolean);

  if (!channels.length) {
    el.recentRow.hidden = true;
    el.recentRow.innerHTML = '';
    return;
  }

  el.recentRow.hidden = false;
  el.recentRow.innerHTML = channels.map((channel) => {
    const logo = channel.attrs['tvg-logo'];
    const logoHtml = logo
      ? `<img class="logo-thumb" src="${escapeHtml(logo)}" alt="${escapeHtml(channel.name)}" title="${escapeHtml(channel.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
      : `<div class="logo-thumb--empty" title="${escapeHtml(channel.name)}"></div>`;
    return `<span data-index="${channel.index}" tabindex="0" role="button" aria-label="Play ${escapeHtml(channel.name)}">${logoHtml}</span>`;
  }).join('');

  el.recentRow.querySelectorAll('[data-index]').forEach((wrap) => {
    wrap.addEventListener('click', () => {
      const idx = Number(wrap.dataset.index);
      const channel = state.channels.find((c) => c.index === idx);
      if (channel) playChannel(channel);
    });
    wrap.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const idx = Number(wrap.dataset.index);
      const channel = state.channels.find((c) => c.index === idx);
      if (channel) playChannel(channel);
    });
  });
}

function loadFavorites(slug) {
  try {
    const saved = localStorage.getItem(`iptv4u_watch_favs_${slug}`);
    return new Set(saved ? JSON.parse(saved) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites(slug, favorites) {
  try {
    localStorage.setItem(`iptv4u_watch_favs_${slug}`, JSON.stringify(Array.from(favorites)));
  } catch {
    // ignore
  }
}

function toggleFavorite(channel) {
  const key = channelKey(channel);
  if (state.favorites.has(key)) {
    state.favorites.delete(key);
  } else {
    state.favorites.add(key);
  }
  saveFavorites(state.slug, state.favorites);
  if (state.activeIndex === channel.index) {
    el.favBtn.classList.toggle('active', state.favorites.has(key));
    el.favBtn.textContent = state.favorites.has(key) ? '★ Favourite' : '☆ Favourite';
  }
  renderChannelList();
}

function populateGroupFilter() {
  const groups = Array.from(new Set(
    state.channels.map((c) => c.attrs['group-title']).filter(Boolean)
  )).sort();
  el.groupFilter.innerHTML = '<option value="">All groups</option>' +
    groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
}

async function loadSlug(slug) {
  el.slugStatus.innerHTML = '<span class="spinner"></span>Loading playlist…';
  el.watchArea.hidden = true;

  const response = await fetch(`/iptv/${encodeURIComponent(slug)}.m3u`);
  if (!response.ok) {
    throw new Error(response.status === 404
      ? `No playlist published under "${slug}" yet.`
      : `Failed to load playlist (HTTP ${response.status}).`);
  }
  const text = await response.text();
  const channels = parseM3U(text);
  if (!channels.length) {
    throw new Error('That playlist has no channels.');
  }

  state.slug = slug;
  state.channels = channels;
  state.activeIndex = null;

  const validKeys = new Set(channels.map((c) => channelKey(c)));
  state.favorites = new Set(pruneStaleKeys(Array.from(loadFavorites(slug)), validKeys));
  saveFavorites(slug, state.favorites);
  state.favoritesOnly = false;
  el.favFilterBtn.classList.remove('active');
  try {
    const savedRecents = localStorage.getItem(`iptv4u_watch_recents_${slug}`);
    const parsed = savedRecents ? JSON.parse(savedRecents) : [];
    state.recents = pruneStaleKeys(parsed, validKeys);
  } catch {
    state.recents = [];
  }

  // The EPG guide is optional enrichment (now/next, progress bar) — a
  // slug published without one, or a fetch hiccup, shouldn't block the
  // channel list or playback from working.
  state.guide = new Map();
  fetch(`/epg/${encodeURIComponent(slug)}.xml`)
    .then((res) => (res.ok ? res.text() : null))
    .then((xml) => {
      if (!xml) return;
      state.guide = parseGuideForNowNext(xml);
      renderChannelList();
      const active = state.channels.find((c) => c.index === state.activeIndex);
      if (active) updateNowPlayingGuide(active);
    })
    .catch(() => {});

  el.channelCountPill.hidden = false;
  el.channelCount.textContent = `${channels.length} channels`;
  populateGroupFilter();
  renderChannelList();
  renderRecentRow();
  el.watchArea.hidden = false;
  el.slugStatus.textContent = '';

  if (state.nowNextInterval) clearInterval(state.nowNextInterval);
  state.nowNextInterval = setInterval(() => {
    // Patch just the now/next text in place rather than re-rendering the
    // whole list, so scrolling and search state aren't disturbed by a
    // periodic refresh.
    document.querySelectorAll('[data-nownext]').forEach((elx) => {
      const idx = Number(elx.dataset.nownext);
      const channel = state.channels.find((c) => c.index === idx);
      if (channel) elx.textContent = `▸ ${nowNextRowHtml(channel)}`;
    });
    const active = state.channels.find((c) => c.index === state.activeIndex);
    if (active) updateNowPlayingGuide(active);
  }, 60000);

  try {
    history.replaceState(null, '', `${location.pathname}?slug=${encodeURIComponent(slug)}`);
  } catch {
    // ignore
  }

  let resumeIndex = null;
  try {
    const saved = localStorage.getItem(`iptv4u_watch_last_${slug}`);
    if (saved !== null) resumeIndex = Number(saved);
  } catch {
    // ignore
  }
  const resumeChannel = channels.find((c) => c.index === resumeIndex);
  if (resumeChannel) playChannel(resumeChannel);
}

el.loadSlugBtn.addEventListener('click', () => {
  const slug = el.slugInput.value.trim();
  if (!slug) return;
  loadSlug(slug).catch((error) => {
    el.slugStatus.textContent = error.message;
  });
});

el.slugInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el.loadSlugBtn.click();
});

el.channelSearch.addEventListener('input', renderChannelList);
el.groupFilter.addEventListener('change', renderChannelList);

el.favFilterBtn.addEventListener('click', () => {
  state.favoritesOnly = !state.favoritesOnly;
  el.favFilterBtn.classList.toggle('active', state.favoritesOnly);
  renderChannelList();
});

el.favBtn.addEventListener('click', () => {
  const channel = state.channels.find((c) => c.index === state.activeIndex);
  if (channel) toggleFavorite(channel);
});

el.goLiveBtn.addEventListener('click', () => {
  const seekable = el.player.seekable;
  if (seekable && seekable.length) {
    el.player.currentTime = seekable.end(seekable.length - 1);
  }
  el.player.play().catch(() => {});
});

function clearSleepTimer() {
  if (state.sleepTimerHandle) {
    clearTimeout(state.sleepTimerHandle);
    state.sleepTimerHandle = null;
  }
}

function fireSleepTimer(label) {
  destroyPlayer();
  setStatus('paused');
  setOverlay(`Sleep timer ended playback (${label}).`);
  el.sleepTimer.value = '0';
}

el.sleepTimer.addEventListener('change', () => {
  clearSleepTimer();
  const value = el.sleepTimer.value;
  if (value === '0') return;

  if (value === 'end-of-programme') {
    const channel = state.channels.find((c) => c.index === state.activeIndex);
    const tvgId = channel?.attrs['tvg-id'];
    const { current } = tvgId ? getNowNext(state.guide, tvgId) : { current: null };
    if (!current || !current.stop) {
      el.copyDiagnosticStatus.textContent = '';
      setOverlay('No programme end time is known for this channel yet — pick a fixed duration instead.');
      setTimeout(() => setOverlay(null), 4000);
      el.sleepTimer.value = '0';
      return;
    }
    const ms = current.stop.getTime() - Date.now();
    state.sleepTimerHandle = setTimeout(() => fireSleepTimer('end of programme'), Math.max(0, ms));
    return;
  }

  const minutes = Number(value);
  if (!minutes) return;
  state.sleepTimerHandle = setTimeout(() => fireSleepTimer(`${minutes} minutes`), minutes * 60000);
});

const initialSlug = new URLSearchParams(location.search).get('slug');
if (initialSlug) {
  el.slugInput.value = initialSlug;
  loadSlug(initialSlug).catch((error) => {
    el.slugStatus.textContent = error.message;
  });
}
