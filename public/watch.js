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
  hls: null
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

function destroyHls() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
}

function playChannel(channel) {
  state.activeIndex = channel.index;
  destroyHls();
  setOverlay('Loading…');

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
  const isHls = /\.m3u8?(\?|$)/i.test(url);

  const onError = () => {
    setOverlay('This channel failed to play — the stream may not support secure/cross-origin browser playback, or may be offline.');
  };

  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true });
    state.hls = hls;
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) onError();
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      setOverlay(null);
      el.player.play().catch(() => {});
    });
    hls.loadSource(url);
    hls.attachMedia(el.player);
  } else {
    // Native HLS (Safari/iOS) or a direct progressive stream.
    el.player.src = url;
    el.player.oncanplay = () => setOverlay(null);
    el.player.onerror = onError;
    el.player.play().catch(() => {});
  }

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
