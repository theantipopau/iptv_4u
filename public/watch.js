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
  nowPlayingNextTime: document.getElementById('nowPlayingNextTime')
};

const state = {
  slug: '',
  channels: [],
  activeIndex: null,
  hls: null,
  mpegts: null,
  watchdogTimer: null,
  guide: new Map(), // channel id (tvg-id) -> sorted programme list
  favorites: new Set(),
  recents: [],
  favoritesOnly: false,
  sleepTimerHandle: null,
  nowNextInterval: null
};

// A stable identity for favourites/recents that survives a re-publish
// changing the channel order — prefer the EPG id, fall back to the name.
function channelKey(channel) {
  return channel.attrs['tvg-id'] || channel.name;
}

// hls.js reports a stable `details` code on every error — translate the
// common fatal ones into a message a viewer (not an engineer) can act on,
// instead of one generic "failed to play" for every cause.
const HLS_ERROR_MESSAGES = {
  manifestLoadError: "Couldn't reach this channel — its stream may be offline, or its server may not allow browser playback.",
  manifestLoadTimeOut: 'Timed out waiting for this channel to respond.',
  manifestParsingError: "This channel's stream data could not be understood by this browser.",
  levelLoadError: "Couldn't load this channel's stream data.",
  levelLoadTimeOut: "Timed out loading this channel's stream data.",
  fragLoadError: 'Lost connection to the stream partway through.',
  fragLoadTimeOut: 'Timed out loading part of the stream.',
  bufferAddCodecError: "This channel's video or audio format isn't supported by this browser.",
  bufferIncompatibleCodecsError: "This channel's video or audio format isn't supported by this browser.",
  keyLoadError: 'This stream is encrypted and the decryption key could not be loaded.',
  keySystemNoKeys: "This stream uses DRM this browser can't decode."
};

const MPEGTS_ERROR_MESSAGES = {
  NetworkError: "Couldn't reach this channel — its stream may be offline, or its server may not allow browser playback.",
  MediaError: "This channel's video or audio format isn't supported by this browser."
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Mirrors shared/core.js's parseM3U closely enough for display/playback
// purposes — this page only ever reads an already-published playlist, it
// never needs to round-trip or re-serialize it.
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const match of line.matchAll(/([\w-]+)="([^"]*)"/g)) {
        attrs[match[1]] = match[2];
      }
      const commaIdx = line.indexOf(',');
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : `Channel ${channels.length + 1}`;
      pending = { index: channels.length, name, attrs, url: '' };
      continue;
    }

    if (pending && !line.startsWith('#')) {
      pending.url = line;
      channels.push(pending);
      pending = null;
    }
  }

  if (pending) channels.push(pending);
  return channels;
}

// XMLTV timestamps look like "20260912040000 +0700" — a fixed-width
// date/time plus an optional UTC offset (no offset means UTC).
function parseXmltvDate(str) {
  if (!str) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/.exec(str.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z'}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// A compact now/next index, keyed by XMLTV channel id — parses the
// published guide once at load time using the browser's built-in
// DOMParser (no bundling needed), not on every render.
function parseGuideForNowNext(xmlText) {
  const guide = new Map();
  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) return guide;
  } catch {
    return guide;
  }

  doc.querySelectorAll('programme').forEach((node) => {
    const channelId = node.getAttribute('channel');
    const start = parseXmltvDate(node.getAttribute('start'));
    if (!channelId || !start) return;
    const stop = parseXmltvDate(node.getAttribute('stop'));
    const titleNode = node.querySelector('title');
    const title = titleNode ? titleNode.textContent.trim() : '';
    if (!guide.has(channelId)) guide.set(channelId, []);
    guide.get(channelId).push({ start, stop, title });
  });

  for (const list of guide.values()) list.sort((a, b) => a.start - b.start);
  return guide;
}

// Missing stop times are handled the same way core.js's server-side
// guide merge does — the next programme's start becomes the effective
// stop, and only the last item in the list is genuinely open-ended.
function getNowNext(channelId, now = new Date()) {
  const list = state.guide.get(channelId);
  if (!list || !list.length) return { current: null, next: null };

  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    if (p.start > now) return { current: null, next: p };
    const effectiveStop = p.stop || (list[i + 1] ? list[i + 1].start : null);
    if (!effectiveStop || now < effectiveStop) {
      return { current: p, next: list[i + 1] || null };
    }
  }
  return { current: null, next: null };
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

function destroyPlayer() {
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
  el.player.load();
}

const WATCHDOG_MS = 15000;
const MIXED_CONTENT_MESSAGE = "This stream is HTTP-only, and browsers block insecure video on a secure (HTTPS) page like this one — that's a limitation of the provider, not this app. It may still work in TiviMate, or if you self-host this app locally over HTTP.";

// A plain-http stream on an https page is blocked outright by the
// browser's mixed-content policy — but some providers happen to also
// serve the identical stream over https on the same host (never updated
// in the M3U itself), so it's worth a free, no-server-involved attempt
// before giving up with an explanation.
function attemptPlayback(url, { isUpgradeAttempt = false } = {}) {
  destroyPlayer();
  setOverlay(isUpgradeAttempt ? 'Loading… (trying a secure version of this stream)' : 'Loading…');

  const settle = (message) => {
    clearWatchdog();
    if (message) {
      setOverlay(isUpgradeAttempt ? MIXED_CONTENT_MESSAGE : message);
    } else {
      setOverlay(null);
    }
  };

  state.watchdogTimer = setTimeout(() => {
    settle('Timed out waiting for this channel to respond.');
  }, WATCHDOG_MS);

  const isHls = /\.m3u8?(\?|$)/i.test(url);

  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true });
    state.hls = hls;
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) settle(HLS_ERROR_MESSAGES[data.details] || "This channel failed to play — the stream may be offline, or its server may not allow browser playback.");
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      settle(null);
      el.player.play().catch(() => {});
    });
    hls.loadSource(url);
    hls.attachMedia(el.player);
  } else if (isHls) {
    // Native HLS (Safari/iOS) — no hls.js involved.
    el.player.src = url;
    el.player.oncanplay = () => settle(null);
    el.player.onerror = () => settle("This channel failed to play — the stream may be offline, or its server may not allow browser playback.");
    el.player.play().catch(() => {});
  } else if (window.mpegts && window.mpegts.isSupported()) {
    // Most IPTV playlists serve a continuous raw MPEG-TS stream (no
    // .m3u8 manifest at all) rather than real HLS — browsers can't play
    // that container natively, so it needs mpegts.js's MSE remuxer.
    const player = window.mpegts.createPlayer({ type: 'mpegts', isLive: true, url });
    state.mpegts = player;
    player.on(window.mpegts.Events.ERROR, (_type, detail) => {
      settle(MPEGTS_ERROR_MESSAGES[detail] || "This channel failed to play — the stream may be offline, or its server may not allow browser playback.");
    });
    player.attachMediaElement(el.player);
    player.load();
    player.play().then(() => settle(null)).catch(() => {});
  } else {
    el.player.src = url;
    el.player.oncanplay = () => settle(null);
    el.player.onerror = () => settle("This channel failed to play — the stream may be offline, or its server may not allow browser playback.");
    el.player.play().catch(() => {});
  }
}

function updateNowPlayingGuide(channel) {
  const tvgId = channel.attrs['tvg-id'];
  const { current, next } = tvgId ? getNowNext(tvgId) : { current: null, next: null };

  if (!current && !next) {
    el.nowPlayingGuide.hidden = true;
    return;
  }

  el.nowPlayingGuide.hidden = false;

  if (current) {
    el.nowPlayingCurrentTitle.textContent = current.title || '(no title)';
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
    el.nowPlayingNextTitle.textContent = next.title || '(no title)';
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
  const key = channelKey(channel);
  state.recents = [key, ...state.recents.filter((k) => k !== key)].slice(0, 12);
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
  const needsHttpsAttempt = location.protocol === 'https:' && url.startsWith('http://');
  attemptPlayback(needsHttpsAttempt ? url.replace(/^http:\/\//, 'https://') : url, {
    isUpgradeAttempt: needsHttpsAttempt
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
  const { current } = getNowNext(tvgId);
  return current ? escapeHtml(current.title || '') : '';
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
      <li class="channel-row${activeClass}" data-index="${channel.index}">
        ${chno ? `<span class="channel-row-number">${escapeHtml(chno)}</span>` : ''}
        ${logoHtml}
        <div class="channel-row-info">
          <div class="channel-row-name">${escapeHtml(channel.name)}</div>
          <div class="channel-row-group">${escapeHtml(channel.attrs['group-title'] || '')}</div>
          ${nowText ? `<div class="channel-row-nownext" data-nownext="${channel.index}">▸ ${nowText}</div>` : ''}
        </div>
        <button class="channel-row-fav${isFav ? ' active' : ''}" data-fav-index="${channel.index}" title="Toggle favourite" aria-label="Toggle favourite">${isFav ? '★' : '☆'}</button>
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
    return `<span data-index="${channel.index}">${logoHtml}</span>`;
  }).join('');

  el.recentRow.querySelectorAll('[data-index]').forEach((wrap) => {
    wrap.addEventListener('click', () => {
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
  state.favorites = loadFavorites(slug);
  state.favoritesOnly = false;
  el.favFilterBtn.classList.remove('active');
  try {
    const savedRecents = localStorage.getItem(`iptv4u_watch_recents_${slug}`);
    state.recents = savedRecents ? JSON.parse(savedRecents) : [];
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
    document.querySelectorAll('[data-nownext]').forEach((el2) => {
      const idx = Number(el2.dataset.nownext);
      const channel = state.channels.find((c) => c.index === idx);
      if (channel) el2.textContent = `▸ ${nowNextRowHtml(channel)}`;
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

el.sleepTimer.addEventListener('change', () => {
  if (state.sleepTimerHandle) {
    clearTimeout(state.sleepTimerHandle);
    state.sleepTimerHandle = null;
  }
  const minutes = Number(el.sleepTimer.value);
  if (!minutes) return;
  state.sleepTimerHandle = setTimeout(() => {
    destroyPlayer();
    setOverlay(`Sleep timer ended playback after ${minutes} minutes.`);
    el.sleepTimer.value = '0';
  }, minutes * 60000);
});

const initialSlug = new URLSearchParams(location.search).get('slug');
if (initialSlug) {
  el.slugInput.value = initialSlug;
  loadSlug(initialSlug).catch((error) => {
    el.slugStatus.textContent = error.message;
  });
}
