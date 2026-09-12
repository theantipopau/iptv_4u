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
  channelList: document.getElementById('channelList'),
  player: document.getElementById('player'),
  playerOverlay: document.getElementById('playerOverlay'),
  nowPlayingLogo: document.getElementById('nowPlayingLogo'),
  nowPlayingName: document.getElementById('nowPlayingName'),
  nowPlayingGroup: document.getElementById('nowPlayingGroup')
};

const state = {
  slug: '',
  channels: [],
  activeIndex: null,
  hls: null,
  mpegts: null,
  watchdogTimer: null
};

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

  const url = channel.url;
  const needsHttpsAttempt = location.protocol === 'https:' && url.startsWith('http://');
  attemptPlayback(needsHttpsAttempt ? url.replace(/^http:\/\//, 'https://') : url, {
    isUpgradeAttempt: needsHttpsAttempt
  });

  renderChannelList();
  try {
    localStorage.setItem(`iptv4u_watch_last_${state.slug}`, String(channel.index));
  } catch {
    // ignore
  }
}

function matchesFilters(channel, query, group) {
  if (group && (channel.attrs['group-title'] || '') !== group) return false;
  if (!query) return true;
  const haystack = `${channel.name} ${channel.attrs['group-title'] || ''}`.toLowerCase();
  return haystack.includes(query);
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
    return `
      <li class="channel-row${activeClass}" data-index="${channel.index}">
        ${logoHtml}
        <div class="channel-row-info">
          <div class="channel-row-name">${escapeHtml(channel.name)}</div>
          <div class="channel-row-group">${escapeHtml(channel.attrs['group-title'] || '')}</div>
        </div>
      </li>
    `;
  }).join('');

  el.channelList.querySelectorAll('.channel-row').forEach((row) => {
    row.addEventListener('click', () => {
      const idx = Number(row.dataset.index);
      const channel = state.channels.find((c) => c.index === idx);
      if (channel) playChannel(channel);
    });
  });
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

  el.channelCountPill.hidden = false;
  el.channelCount.textContent = `${channels.length} channels`;
  populateGroupFilter();
  renderChannelList();
  el.watchArea.hidden = false;
  el.slugStatus.textContent = '';

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

const initialSlug = new URLSearchParams(location.search).get('slug');
if (initialSlug) {
  el.slugInput.value = initialSlug;
  loadSlug(initialSlug).catch((error) => {
    el.slugStatus.textContent = error.message;
  });
}
