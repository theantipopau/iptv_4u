const STORAGE_KEY = 'iptv4u_session_v1';

const state = {
  m3uText: '',
  xmlText: '',
  m3uChannels: [],
  xmlSummary: null,
  discoveredSources: [],
  links: new Map(), // channel index -> link object
  contexts: new Map(), // channel index -> search context (24/7, country hint, ...)
  errors: new Map(), // channel index -> last error message
  selected: new Set(), // channel indexes currently checked in the table
  sort: { key: null, direction: 'asc' }
};

const el = {
  m3uFile: document.getElementById('m3uFile'),
  xmlFile: document.getElementById('xmlFile'),
  loadFilesBtn: document.getElementById('loadFilesBtn'),
  summary: document.getElementById('summary'),
  discoverBtn: document.getElementById('discoverBtn'),
  sourceStatus: document.getElementById('sourceStatus'),
  tmdbStatus: document.getElementById('tmdbStatus'),
  maxSources: document.getElementById('maxSources'),
  customGuideUrl: document.getElementById('customGuideUrl'),
  channelsTableBody: document.querySelector('#channelsTable tbody'),
  autoMatchBtn: document.getElementById('autoMatchBtn'),
  matchProgress: document.getElementById('matchProgress'),
  exportM3UBtn: document.getElementById('exportM3UBtn'),
  exportXMLBtn: document.getElementById('exportXMLBtn'),
  mergeStatus: document.getElementById('mergeStatus'),
  matchDialog: document.getElementById('matchDialog'),
  dialogChannelName: document.getElementById('dialogChannelName'),
  dialogContext: document.getElementById('dialogContext'),
  matchList: document.getElementById('matchList'),
  resumeBanner: document.getElementById('resumeBanner'),
  resumeBtn: document.getElementById('resumeBtn'),
  discardBtn: document.getElementById('discardBtn'),
  saveProjectBtn: document.getElementById('saveProjectBtn'),
  exportBacklogBtn: document.getElementById('exportBacklogBtn'),
  loadProjectFile: document.getElementById('loadProjectFile'),
  themeToggle: document.getElementById('themeToggle'),
  channelFilter: document.getElementById('channelFilter'),
  tableCount: document.getElementById('tableCount'),
  progressTrack: document.getElementById('progressTrack'),
  progressFill: document.getElementById('progressFill'),
  toastStack: document.getElementById('toastStack'),
  publishSlug: document.getElementById('publishSlug'),
  publishBtn: document.getElementById('publishBtn'),
  publishStatus: document.getElementById('publishStatus'),
  publishResult: document.getElementById('publishResult'),
  publishM3uUrl: document.getElementById('publishM3uUrl'),
  publishXmlUrl: document.getElementById('publishXmlUrl'),
  copyM3uUrlBtn: document.getElementById('copyM3uUrlBtn'),
  copyXmlUrlBtn: document.getElementById('copyXmlUrlBtn'),
  watchLiveLink: document.getElementById('watchLiveLink'),
  statsBar: document.getElementById('statsBar'),
  statTotal: document.getElementById('statTotal'),
  statGuide: document.getElementById('statGuide'),
  statLogo: document.getElementById('statLogo'),
  statNone: document.getElementById('statNone'),
  selectAllCheckbox: document.getElementById('selectAllCheckbox'),
  bulkToolbar: document.getElementById('bulkToolbar'),
  bulkCount: document.getElementById('bulkCount'),
  bulkMatchBtn: document.getElementById('bulkMatchBtn'),
  bulkClearBtn: document.getElementById('bulkClearBtn'),
  bulkDeselectBtn: document.getElementById('bulkDeselectBtn'),
  autoRefreshM3uUrl: document.getElementById('autoRefreshM3uUrl'),
  autoRefreshInterval: document.getElementById('autoRefreshInterval'),
  saveAutoRefreshBtn: document.getElementById('saveAutoRefreshBtn'),
  refreshNowBtn: document.getElementById('refreshNowBtn'),
  autoRefreshStatus: document.getElementById('autoRefreshStatus')
};

// ---- toasts ----------------------------------------------------------

function toast(message, kind = 'info') {
  const el2 = document.createElement('div');
  el2.className = `toast${kind === 'error' ? ' toast--error' : ''}${kind === 'success' ? ' toast--success' : ''}`;
  el2.textContent = message;
  el.toastStack.appendChild(el2);
  setTimeout(() => el2.remove(), kind === 'error' ? 7000 : 4000);
}

// ---- theme -------------------------------------------------------------

const THEME_KEY = 'iptv4u_theme';

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function initTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) applyTheme(saved);
  } catch {
    // ignore
  }
}

el.themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // ignore
  }
});

initTheme();

async function readFileText(file) {
  return file.text();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const json = await response.json();
  if (!response.ok || !json.ok) {
    throw new Error(json.error || `Request failed: ${response.status}`);
  }
  return json;
}

function slugify(name) {
  return String(name || 'channel')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'channel';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildLinkFromMatch(match, channel, { keepLogoUrl } = {}) {
  const isTmdb = match.sourceType === 'tmdb';
  const channelId = match.channelId ||
    (isTmdb ? `tmdb-${slugify(match.tmdb?.title || channel.name)}` : slugify(channel.name));

  return {
    channelIndex: channel.index,
    channelId,
    channelName: match.channelName || channel.name,
    source: match.source || '',
    logoUrl: keepLogoUrl !== undefined ? keepLogoUrl : (match.logoUrl || null),
    guideUrl: match.guideUrl || null,
    canMergeGuide: !!match.canMergeGuide,
    tmdb: isTmdb ? match.tmdb : null,
    synthesize: isTmdb && !!match.canSynthesizeGuide,
    score: typeof match.score === 'number' ? match.score : null
  };
}

// A schedule-bearing match and the best-looking logo don't always come
// from the same source — a custom/worker EPG's own icon is often a
// generic placeholder even when its programme data is exactly right. So
// identity/schedule and logo are picked independently instead of both
// being forced to come from whichever single match scores highest.

const CONFIDENT_MATCH_SCORE = 0.6;

function pickIdentityMatch(matches) {
  if (!matches.length) return null;
  const top = matches[0]; // matches arrive sorted by score, descending
  if (top.canMergeGuide) return top;
  // The top-scoring match has no real schedule — if a still-confident
  // match further down the list does, prefer that one so the channel
  // doesn't lose real programme data just because a logo/metadata-only
  // match happened to edge it out on name similarity.
  return matches.find((m) => m.canMergeGuide && m.score >= CONFIDENT_MATCH_SCORE) || top;
}

function pickLogoUrl(matches, identityMatch) {
  const confident = matches.filter((m) => m.logoUrl && m.score >= Math.min(CONFIDENT_MATCH_SCORE, identityMatch.score ?? 0));
  if (!confident.length) return identityMatch.logoUrl || null;
  // Prefer a curated public-catalog logo over a scraped custom/worker
  // EPG's own icon, which is frequently just a generic placeholder.
  const catalogMatch = confident.find((m) => m.sourceType === 'iptv-org-api');
  return (catalogMatch || confident[0]).logoUrl;
}

function manualLink(channel, { channelId, logoUrl }) {
  const existing = state.links.get(channel.index);
  return {
    channelIndex: channel.index,
    channelId: channelId !== undefined ? channelId : (existing?.channelId || slugify(channel.name)),
    channelName: existing?.channelName || channel.name,
    source: 'manual',
    logoUrl: logoUrl !== undefined ? (logoUrl || null) : (existing?.logoUrl || null),
    guideUrl: existing?.guideUrl || null,
    canMergeGuide: !!existing?.canMergeGuide,
    tmdb: existing?.tmdb || null,
    synthesize: !!existing?.synthesize,
    score: existing?.score ?? null,
    manual: true
  };
}

function formatLink(link) {
  if (!link) return 'Not linked';
  if (link.manual) return `${link.channelId} (manual)`;
  if (link.tmdb) {
    return `TMDB: ${link.channelName} (logo${link.synthesize ? ' + placeholder guide' : ''})`;
  }
  if (link.canMergeGuide) {
    return `${link.channelId} @ ${link.source} (full guide)`;
  }
  return `${link.channelId} @ ${link.source || 'unknown'} (logo only)`;
}

// Green = this channel's EPG will actually populate a schedule on export.
// Orange = it only has a logo/identity (or a TMDB placeholder guide) — the
// channels worth clicking into if you want real programme data for them.
function linkStatusClass(link) {
  if (!link || link.manual) return '';
  if (link.canMergeGuide) return 'badge--guide';
  return 'badge--logo-only';
}

// 3 = full guide, 2 = logo only / tmdb, 1 = manual, 0 = not linked
function statusRank(link) {
  if (!link) return 0;
  if (link.manual) return 1;
  if (link.canMergeGuide) return 3;
  return 2;
}

// ---- persistence --------------------------------------------------------

function serializeState() {
  return {
    m3uText: state.m3uText,
    xmlText: state.xmlText,
    m3uChannels: state.m3uChannels,
    xmlSummary: state.xmlSummary,
    links: Array.from(state.links.entries()),
    contexts: Array.from(state.contexts.entries()),
    customGuideUrl: el.customGuideUrl.value.trim()
  };
}

function restoreState(data) {
  state.m3uText = data.m3uText || '';
  state.xmlText = data.xmlText || '';
  state.m3uChannels = data.m3uChannels || [];
  state.xmlSummary = data.xmlSummary || null;
  state.links = new Map(data.links || []);
  state.contexts = new Map(data.contexts || []);
  state.errors = new Map();
  el.customGuideUrl.value = data.customGuideUrl || '';
}

function autosave() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState()));
  } catch (error) {
    console.warn('Autosave failed', error);
  }
}

function loadAutosave() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearAutosave() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function applyLoadedState() {
  const channelCount = state.xmlSummary?.channelCount ?? 0;
  const programmeCount = state.xmlSummary?.programmeCount ?? 0;
  el.summary.textContent = `Loaded ${state.m3uChannels.length} M3U channels, ${channelCount} XMLTV channels, ${programmeCount} programmes.`;
  renderTable();
}

// ---- table rendering ------------------------------------------------------

function updateTmdbStatus(context) {
  if (!context) return;
  el.tmdbStatus.textContent = context.tmdbConfigured
    ? 'TMDB lookups enabled for 24/7 channel art.'
    : 'TMDB lookups disabled (no TMDB_API_KEY set on the server) — 24/7 channels are still flagged, just without automatic poster art. See .env.example.';
}

function sortedChannels() {
  const list = [...state.m3uChannels];
  const { key, direction } = state.sort;
  if (!key) return list;

  const dir = direction === 'desc' ? -1 : 1;
  const valueFor = (channel) => {
    const linked = state.links.get(channel.index);
    switch (key) {
      case 'name':
        return channel.name.toLowerCase();
      case 'tvgid':
        return (channel.attrs?.['tvg-id'] || '').toLowerCase();
      case 'status':
        return statusRank(linked);
      case 'score':
        return linked?.score ?? -1;
      default:
        return 0;
    }
  };

  list.sort((a, b) => {
    const va = valueFor(a);
    const vb = valueFor(b);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.index - b.index;
  });
  return list;
}

function updateSortHeaders() {
  document.querySelectorAll('th.sortable').forEach((th) => {
    const active = th.dataset.sort === state.sort.key;
    th.dataset.active = active ? 'true' : 'false';
    const arrow = active ? (state.sort.direction === 'desc' ? '▼' : '▲') : '↕';
    th.querySelector('.sort-arrow')?.remove();
    th.insertAdjacentHTML('beforeend', `<span class="sort-arrow">${arrow}</span>`);
  });
}

function updateStatsBar() {
  const total = state.m3uChannels.length;
  if (!total) {
    el.statsBar.hidden = true;
    return;
  }

  let guide = 0;
  let logo = 0;
  for (const link of state.links.values()) {
    if (link.canMergeGuide) guide += 1;
    else logo += 1;
  }
  const none = total - state.links.size;

  el.statsBar.hidden = false;
  el.statTotal.textContent = `${total} channel${total === 1 ? '' : 's'}`;
  el.statGuide.textContent = `${guide} guide`;
  el.statLogo.textContent = `${logo} logo`;
  el.statNone.textContent = `${none} unlinked`;
}

function updateBulkToolbar() {
  const count = state.selected.size;
  el.bulkToolbar.hidden = count === 0;
  el.bulkCount.textContent = `${count} selected`;
  el.selectAllCheckbox.checked = count > 0 && count === el.channelsTableBody.querySelectorAll('tr:not([hidden])').length;
}

function makeEditableCell(currentValue, onCommit) {
  const span = document.createElement('span');
  span.className = 'editable-cell';
  span.title = 'Click to edit';
  span.textContent = currentValue || '(none — click to set)';

  span.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentValue || '';
    span.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const value = input.value.trim();
      input.replaceWith(span);
      if (value !== (currentValue || '')) onCommit(value);
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') {
        input.value = currentValue || '';
        input.blur();
      }
    });
  });

  return span;
}

function renderTable() {
  el.channelsTableBody.innerHTML = '';
  sortedChannels().forEach((channel) => {
    const tr = document.createElement('tr');
    tr.dataset.index = String(channel.index);
    const linked = state.links.get(channel.index);
    const context = state.contexts.get(channel.index);
    const error = state.errors.get(channel.index);

    if (state.selected.has(channel.index)) tr.classList.add('row-selected');

    const logoSrc = (linked && linked.logoUrl) || channel.attrs?.['tvg-logo'] || '';
    const logoCell = logoSrc
      ? `<img class="logo-thumb" src="${escapeHtml(logoSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
      : '<div class="logo-thumb logo-thumb--empty"></div>';

    const badges = [];
    if (context?.isTwentyFourSeven) badges.push('<span class="badge badge--247">24/7</span>');
    if (linked?.tmdb) badges.push('<span class="badge badge--tmdb">TMDB</span>');
    if (linked?.manual) badges.push('<span class="badge">Manual</span>');
    if (error) badges.push(`<span class="badge badge--error" title="${escapeHtml(error)}">Search failed</span>`);

    const scoreText = typeof linked?.score === 'number' ? linked.score.toFixed(2) : '—';

    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-checkbox" data-index="${channel.index}" ${state.selected.has(channel.index) ? 'checked' : ''} /></td>
      <td class="logo-cell"></td>
      <td>
        <strong>${escapeHtml(channel.name)}</strong>
        ${badges.join(' ')}
        <div class="small">${escapeHtml(channel.url || '')}</div>
      </td>
      <td class="tvgid-cell"></td>
      <td>
        <span class="link-status ${linkStatusClass(linked)}">${escapeHtml(formatLink(linked))}</span>
      </td>
      <td>${scoreText}</td>
      <td>
        <button class="btn" data-action="search" data-index="${channel.index}">Search</button>
      </td>
    `;

    const logoWrap = document.createElement('div');
    logoWrap.className = 'logo-wrap';
    logoWrap.innerHTML = logoCell;
    const editLogoBtn = document.createElement('button');
    editLogoBtn.type = 'button';
    editLogoBtn.className = 'logo-edit-btn';
    editLogoBtn.title = 'Set a custom logo';
    editLogoBtn.textContent = '✎';
    editLogoBtn.addEventListener('click', () => {
      const editor = document.createElement('div');
      editor.className = 'logo-editor';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'logo-url-input';
      input.value = logoSrc || '';
      input.placeholder = 'https://…/logo.png';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
      fileInput.className = 'logo-file-input';
      fileInput.title = 'Upload your own image (2MB max)';

      const status = document.createElement('div');
      status.className = 'logo-editor-status';

      editor.append(input, fileInput, status);
      logoWrap.replaceChildren(editor);
      input.focus();
      input.select();

      const commit = (value) => {
        state.links.set(channel.index, manualLink(channel, { logoUrl: value || null }));
        renderTable();
        autosave();
      };

      input.addEventListener('blur', () => {
        // A file upload in progress already commits on its own; don't
        // stomp its result with the (possibly stale) text field on blur.
        if (fileInput.dataset.uploading === '1') return;
        commit(input.value.trim());
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') input.blur();
        if (event.key === 'Escape') {
          input.value = logoSrc || '';
          renderTable();
        }
      });

      fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
          status.textContent = 'Too large — 2MB max.';
          return;
        }
        fileInput.dataset.uploading = '1';
        status.textContent = 'Uploading…';
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          const imageBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
          const result = await api('/api/upload-logo', {
            method: 'POST',
            body: JSON.stringify({ imageBase64, contentType: file.type })
          });
          input.value = result.url;
          commit(result.url);
        } catch (error) {
          status.textContent = error.message || 'Upload failed.';
        } finally {
          fileInput.dataset.uploading = '0';
        }
      });
    });
    logoWrap.appendChild(editLogoBtn);
    tr.querySelector('.logo-cell').appendChild(logoWrap);

    const currentTvgId = linked?.channelId || channel.attrs?.['tvg-id'] || '';
    tr.querySelector('.tvgid-cell').appendChild(
      makeEditableCell(currentTvgId, (value) => {
        state.links.set(channel.index, manualLink(channel, { channelId: value || undefined }));
        renderTable();
        autosave();
      })
    );

    el.channelsTableBody.appendChild(tr);
  });

  updateSortHeaders();
  updateStatsBar();
  updateBulkToolbar();
  applyChannelFilter();
}

// ---- filtering ----------------------------------------------------------

function applyChannelFilter() {
  const query = el.channelFilter.value.trim().toLowerCase();
  const rows = Array.from(el.channelsTableBody.querySelectorAll('tr'));
  let visible = 0;

  rows.forEach((row) => {
    const index = Number(row.dataset.index);
    const channel = state.m3uChannels.find((c) => c.index === index);
    if (!channel) return;
    const linked = state.links.get(channel.index);
    const haystack = [
      channel.name,
      channel.attrs?.['group-title'],
      channel.attrs?.['tvg-id'],
      linked?.channelId,
      linked?.channelName,
      formatLink(linked)
    ].filter(Boolean).join(' ').toLowerCase();

    const match = !query || haystack.includes(query);
    row.hidden = !match;
    if (match) visible += 1;
  });

  el.tableCount.textContent = state.m3uChannels.length
    ? `${visible} / ${state.m3uChannels.length} channels`
    : '';
}

el.channelFilter.addEventListener('input', applyChannelFilter);

// ---- file loading ---------------------------------------------------------

async function parseFiles() {
  const m3u = el.m3uFile.files[0];
  const xml = el.xmlFile.files[0];
  if (!m3u) {
    toast('Please choose an M3U file.', 'error');
    return;
  }

  const m3uText = await readFileText(m3u);
  const xmlText = xml ? await readFileText(xml) : '';

  el.summary.innerHTML = '<span class="spinner"></span>Parsing files…';
  const result = await api('/api/parse-files', {
    method: 'POST',
    body: JSON.stringify({
      m3uContent: m3uText,
      xmlContent: xmlText
    })
  });

  state.m3uText = m3uText;
  state.xmlText = result.xmlContent;
  state.m3uChannels = result.m3uChannels;
  state.xmlSummary = result.xmlSummary;
  state.links.clear();
  state.contexts.clear();
  state.errors.clear();

  applyLoadedState();
  autosave();
  toast(`Loaded ${state.m3uChannels.length} channels.`, 'success');
}

async function discoverSources() {
  el.sourceStatus.innerHTML = '<span class="spinner"></span>Discovering sources… this can take a bit.';
  const result = await api('/api/discover-sources');
  state.discoveredSources = result.sources;
  el.sourceStatus.textContent = `Discovered ${result.count} online sources.`;
}

// ---- matching ---------------------------------------------------------

function buildMatchCard(match, channel) {
  const card = document.createElement('div');
  card.className = 'match-item';

  const isTmdb = match.sourceType === 'tmdb';
  const thumb = match.logoUrl
    ? `<img class="match-thumb" src="${escapeHtml(match.logoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
    : '';

  const guideLine = match.guideUrl ? `<div class="small">Guide: ${escapeHtml(match.guideUrl)}</div>` : '';
  const tmdbLine = isTmdb
    ? `<div class="small">${match.tmdb.year ? `(${escapeHtml(match.tmdb.year)}) ` : ''}${escapeHtml((match.tmdb.overview || '').slice(0, 200))}</div>`
    : '';
  const capability = isTmdb
    ? 'Identified via TMDB — logo + placeholder guide only, no real schedule'
    : (match.canMergeGuide ? 'Yes, full guide merge' : 'No, logo/metadata only');

  const existingLogo = state.links.get(channel.index)?.logoUrl;
  // A schedule-bearing match's own logo is sometimes worse than whatever
  // is already linked — offer to take just the guide/identity here and
  // leave the current logo alone, instead of forcing both to come from
  // this one match.
  const keepLogoBtn = (match.canMergeGuide && existingLogo && existingLogo !== match.logoUrl)
    ? `<button class="btn" data-select-keep-logo="${encodeURIComponent(JSON.stringify(match))}">Use Guide, Keep Current Logo</button>`
    : '';

  card.innerHTML = `
    ${thumb}
    <h4>${escapeHtml(match.channelName || match.channelId || 'Unknown')}</h4>
    <p class="small">ID: <code>${escapeHtml(match.channelId || '(generated)')}</code></p>
    <p class="small">Source: ${escapeHtml(match.source || '')} | Score: ${Number(match.score || 0).toFixed(2)} | ${capability}</p>
    ${guideLine}
    ${tmdbLine}
    <div class="match-actions">
      <button class="btn primary" data-select="${encodeURIComponent(JSON.stringify(match))}">Use This Match</button>
      ${keepLogoBtn}
    </div>
  `;

  const selectBtn = card.querySelector('button[data-select]');
  selectBtn.addEventListener('click', (event) => {
    event.preventDefault();
    const raw = decodeURIComponent(selectBtn.dataset.select);
    const selected = JSON.parse(raw);

    state.links.set(channel.index, buildLinkFromMatch(selected, channel));
    renderTable();
    autosave();
    el.matchDialog.close();
  });

  const keepLogoSelectBtn = card.querySelector('button[data-select-keep-logo]');
  keepLogoSelectBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    const raw = decodeURIComponent(keepLogoSelectBtn.dataset.selectKeepLogo);
    const selected = JSON.parse(raw);

    state.links.set(channel.index, buildLinkFromMatch(selected, channel, { keepLogoUrl: existingLogo }));
    renderTable();
    autosave();
    el.matchDialog.close();
  });

  return card;
}

async function searchForChannel(channel) {
  el.dialogChannelName.textContent = `Searching matches for: ${channel.name}`;
  el.dialogContext.textContent = '';
  el.matchList.innerHTML = '<p class="small">Searching online catalogs...</p>';
  if (!el.matchDialog.open) {
    el.matchDialog.showModal();
  }

  const result = await api('/api/search-channel', {
    method: 'POST',
    body: JSON.stringify({
      channelName: channel.name,
      tvgId: channel.attrs?.['tvg-id'] || '',
      groupTitle: channel.attrs?.['group-title'] || '',
      maxSources: Number(el.maxSources.value || 120),
      customGuideUrl: el.customGuideUrl.value.trim()
    })
  });

  state.contexts.set(channel.index, result.context);
  state.errors.delete(channel.index);
  updateTmdbStatus(result.context);

  const contextBits = [];
  if (result.context.isTwentyFourSeven) contextBits.push('24/7 channel detected');
  if (result.context.countryHint) contextBits.push(`Country hint: ${result.context.countryHint}`);
  if (result.context.isTwentyFourSeven && !result.context.tmdbConfigured) {
    contextBits.push('Set TMDB_API_KEY on the server to auto-fetch poster art for this channel.');
  }
  el.dialogContext.textContent = contextBits.join(' · ');

  el.matchList.innerHTML = '';
  if (!result.matches.length) {
    el.matchList.innerHTML = '<p class="small">No strong matches found. Try lowering source limits or editing channel names.</p>';
    renderTable();
    return;
  }

  result.matches.forEach((match) => {
    el.matchList.appendChild(buildMatchCard(match, channel));
  });
  renderTable();
}

async function matchOneChannel(channel) {
  const result = await api('/api/search-channel', {
    method: 'POST',
    body: JSON.stringify({
      channelName: channel.name,
      tvgId: channel.attrs?.['tvg-id'] || '',
      groupTitle: channel.attrs?.['group-title'] || '',
      maxSources: Number(el.maxSources.value || 120),
      customGuideUrl: el.customGuideUrl.value.trim()
    })
  });

  state.contexts.set(channel.index, result.context);
  state.errors.delete(channel.index);
  updateTmdbStatus(result.context);

  const identityMatch = pickIdentityMatch(result.matches);
  if (identityMatch) {
    const logoUrl = pickLogoUrl(result.matches, identityMatch);
    state.links.set(channel.index, buildLinkFromMatch(identityMatch, channel, { keepLogoUrl: logoUrl }));
  }
}

async function matchChannelList(channels, { onProgress } = {}) {
  let processed = 0;
  let failed = 0;
  for (const channel of channels) {
    processed += 1;
    onProgress?.(processed, channels.length, channel);
    try {
      await matchOneChannel(channel);
    } catch (error) {
      failed += 1;
      state.errors.set(channel.index, error.message);
      console.error(error);
    }
  }
  return { processed, failed };
}

async function autoMatchAll() {
  if (!state.m3uChannels.length) {
    toast('Load files first.', 'error');
    return;
  }

  el.autoMatchBtn.disabled = true;
  el.progressTrack.hidden = false;
  el.progressFill.style.width = '0%';

  const { processed, failed } = await matchChannelList(state.m3uChannels, {
    onProgress: (i, total, channel) => {
      el.matchProgress.innerHTML = `<span class="spinner"></span>Auto matching ${i}/${total}: ${escapeHtml(channel.name)}`;
      el.progressFill.style.width = `${Math.round((i / total) * 100)}%`;
    }
  });

  el.matchProgress.textContent = `Auto match complete: ${processed - failed}/${processed} succeeded${failed ? `, ${failed} failed` : ''}.`;
  el.autoMatchBtn.disabled = false;
  el.progressTrack.hidden = true;
  renderTable();
  autosave();
  toast(
    failed ? `Auto-match finished with ${failed} failure(s).` : 'Auto-match complete.',
    failed ? 'error' : 'success'
  );
}

// ---- export -----------------------------------------------------------

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function buildFinalM3U() {
  const links = Array.from(state.links.values());
  const result = await api('/api/export-m3u', {
    method: 'POST',
    body: JSON.stringify({
      channels: state.m3uChannels,
      links
    })
  });
  return result.m3u;
}

async function exportM3U() {
  if (!state.m3uChannels.length) {
    toast('Load files first.', 'error');
    return;
  }

  const m3u = await buildFinalM3U();
  downloadFile('updated_playlist.m3u', m3u, 'audio/x-mpegurl');
  toast('Downloaded updated_playlist.m3u', 'success');
}

async function buildFinalXML() {
  let merged = state.xmlText;
  let mergedCount = 0;
  let errorCount = 0;

  for (const link of state.links.values()) {
    try {
      let result;
      if (link.canMergeGuide && link.guideUrl && link.channelId) {
        result = await api('/api/merge-guide', {
          method: 'POST',
          body: JSON.stringify({
            baseXml: merged,
            guideUrl: link.guideUrl,
            channelId: link.channelId,
            preferredName: link.channelName,
            logoUrl: link.logoUrl
          })
        });
      } else if (link.logoUrl || link.tmdb) {
        result = await api('/api/apply-identity', {
          method: 'POST',
          body: JSON.stringify({
            baseXml: merged,
            channelId: link.channelId,
            channelName: link.channelName,
            logoUrl: link.logoUrl || (link.tmdb ? link.tmdb.posterUrl : null),
            synthesize: !!link.synthesize,
            title: link.tmdb ? link.tmdb.title : undefined,
            overview: link.tmdb ? link.tmdb.overview : undefined,
            days: 3
          })
        });
      } else {
        continue;
      }

      merged = result.mergedXml;
      mergedCount += 1;
      el.mergeStatus.innerHTML = `<span class="spinner"></span>Applied ${mergedCount} channel(s)…`;
    } catch (error) {
      errorCount += 1;
      console.error(error);
    }
  }

  state.xmlText = merged;
  el.mergeStatus.textContent = `XML update complete. Applied ${mergedCount} linked channel(s)${errorCount ? `, ${errorCount} failed` : ''}.`;
  autosave();
  return merged;
}

async function exportXML() {
  if (!state.xmlText) {
    toast('Load files first.', 'error');
    return;
  }

  el.exportXMLBtn.disabled = true;
  const merged = await buildFinalXML();
  el.exportXMLBtn.disabled = false;

  downloadFile('updated_guide.xml', merged, 'application/xml');
  toast('Downloaded updated_guide.xml', 'success');
}

// ---- publish (hosted M3U/XML for IPTV player apps) -----------------------

async function publishHosted() {
  if (!state.m3uChannels.length) {
    toast('Load files first.', 'error');
    return;
  }

  const slug = el.publishSlug.value.trim();
  if (!slug) {
    toast('Enter a URL slug (e.g. "matt") first.', 'error');
    return;
  }

  el.publishBtn.disabled = true;
  el.publishStatus.innerHTML = '<span class="spinner"></span>Building and publishing…';

  try {
    const [m3u, xml] = await Promise.all([buildFinalM3U(), buildFinalXML()]);
    const result = await api('/api/publish', {
      method: 'POST',
      body: JSON.stringify({ slug, m3uContent: m3u, xmlContent: xml })
    });

    const m3uUrl = `${location.origin}/iptv/${result.slug}.m3u`;
    const xmlUrl = `${location.origin}/epg/${result.slug}.xml`;

    el.publishResult.hidden = false;
    el.publishM3uUrl.value = m3uUrl;
    el.publishXmlUrl.value = xmlUrl;
    el.watchLiveLink.href = `${location.origin}/watch?slug=${encodeURIComponent(result.slug)}`;
    el.publishStatus.textContent = 'Published. Point your IPTV app at these URLs:';
    autosave();
    toast('Published.', 'success');
  } catch (error) {
    el.publishStatus.textContent = '';
    toast(error.message, 'error');
  } finally {
    el.publishBtn.disabled = false;
  }
}

function copyToClipboard(value) {
  navigator.clipboard?.writeText(value)
    .then(() => toast('Copied to clipboard.', 'success'))
    .catch(() => toast('Could not copy — select and copy manually.', 'error'));
}

// ---- auto-refresh --------------------------------------------------------

function describeRefreshConfig(config) {
  if (!config) return '';
  const parts = [];
  if (config.intervalKey) parts.push(`Auto-refresh: every ${config.intervalKey.replace('h', ' hours')}`);
  else parts.push('Auto-refresh: off');

  if (config.lastRunAt) {
    const when = new Date(config.lastRunAt).toLocaleString();
    if (config.lastRunStatus === 'ok') {
      parts.push(`last ran ${when} (${config.lastRunChannelCount ?? '?'} channels, ${config.lastRunGuideCount ?? 0} guide / ${config.lastRunLogoCount ?? 0} logo)`);
    } else {
      parts.push(`last run failed ${when}: ${config.lastRunError || 'unknown error'}`);
    }
  } else {
    parts.push('never run yet');
  }
  return parts.join(' — ');
}

async function saveAutoRefreshConfig() {
  const slug = el.publishSlug.value.trim();
  if (!slug) {
    toast('Set a URL slug in the Publish section first.', 'error');
    return;
  }
  const m3uUrl = el.autoRefreshM3uUrl.value.trim();
  if (!m3uUrl) {
    toast('Enter an M3U source URL.', 'error');
    return;
  }

  el.saveAutoRefreshBtn.disabled = true;
  try {
    const result = await api('/api/refresh-config', {
      method: 'POST',
      body: JSON.stringify({
        slug,
        m3uUrl,
        customGuideUrl: el.customGuideUrl.value.trim(),
        intervalKey: el.autoRefreshInterval.value || null
      })
    });
    el.autoRefreshStatus.textContent = describeRefreshConfig(result.config);
    toast('Auto-refresh config saved.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    el.saveAutoRefreshBtn.disabled = false;
  }
}

async function refreshNow() {
  const slug = el.publishSlug.value.trim();
  if (!slug) {
    toast('Set a URL slug in the Publish section first.', 'error');
    return;
  }

  el.refreshNowBtn.disabled = true;
  el.autoRefreshStatus.innerHTML = '<span class="spinner"></span>Refreshing — this fetches the M3U, re-matches every channel, and re-publishes…';
  try {
    const result = await api('/api/refresh-now', {
      method: 'POST',
      body: JSON.stringify({ slug })
    });
    el.autoRefreshStatus.textContent = describeRefreshConfig(result.config);
    toast('Refresh complete.', 'success');
  } catch (error) {
    el.autoRefreshStatus.textContent = '';
    toast(error.message, 'error');
  } finally {
    el.refreshNowBtn.disabled = false;
  }
}

// ---- channel backlog (your own manual fixes, reusable as a guide URL) ----
//
// Every channel you've manually corrected (inline-edited tvg-id or logo)
// gets exported here as a channel-only XMLTV file — no programmes, just
// id/name/icon. Commit it to your own repo and add its raw URL to the
// "Your own EPG/guide URL(s)" field: future re-imports of the same
// provider lineup resolve these automatically instead of needing the
// same manual fix again, and it isn't at the mercy of what the public
// iptv-org catalog happens to track (e.g. Fox Sports channel numbers it
// doesn't have entries for at all).

function buildBacklogXml() {
  const manualLinks = Array.from(state.links.values()).filter((link) => link.manual);
  const channelXml = manualLinks.map((link) => {
    const icon = link.logoUrl ? `\n    <icon src="${escapeHtml(link.logoUrl)}"/>` : '';
    return `  <channel id="${escapeHtml(link.channelId)}">\n    <display-name>${escapeHtml(link.channelName)}</display-name>${icon}\n  </channel>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="iptv-4u backlog">\n${channelXml}\n</tv>\n`;
}

function exportBacklog() {
  const manualCount = Array.from(state.links.values()).filter((link) => link.manual).length;
  if (!manualCount) {
    toast('No manually-fixed channels yet — inline-edit a tvg-id or logo first.', 'error');
    return;
  }
  downloadFile('iptv4u_backlog.xml', buildBacklogXml(), 'application/xml');
  toast(`Downloaded backlog with ${manualCount} channel(s).`, 'success');
}

// ---- project save/load --------------------------------------------------

function saveProjectFile() {
  if (!state.m3uChannels.length) {
    toast('Nothing to save yet — load a playlist first.', 'error');
    return;
  }
  downloadFile('iptv4u_project.json', JSON.stringify(serializeState(), null, 2), 'application/json');
  toast('Downloaded iptv4u_project.json', 'success');
}

async function loadProjectFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  restoreState(data);
  applyLoadedState();
  autosave();
  toast('Project loaded.', 'success');
}

// ---- init / events --------------------------------------------------------

function initResumeBanner() {
  const saved = loadAutosave();
  if (saved && Array.isArray(saved.m3uChannels) && saved.m3uChannels.length) {
    el.resumeBanner.hidden = false;
  }
}

el.resumeBtn.addEventListener('click', () => {
  const saved = loadAutosave();
  if (saved) {
    restoreState(saved);
    applyLoadedState();
  }
  el.resumeBanner.hidden = true;
});

el.discardBtn.addEventListener('click', () => {
  clearAutosave();
  el.resumeBanner.hidden = true;
});

el.loadFilesBtn.addEventListener('click', () => {
  parseFiles().catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
});

el.discoverBtn.addEventListener('click', () => {
  discoverSources().catch((error) => {
    console.error(error);
    el.sourceStatus.textContent = `Discovery failed: ${error.message}`;
  });
});

el.channelsTableBody.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  if (target.dataset.action !== 'search') return;

  const index = Number(target.dataset.index);
  const channel = state.m3uChannels.find((c) => c.index === index);
  if (!channel) return;

  searchForChannel(channel).catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
});

el.channelsTableBody.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains('row-checkbox')) return;

  const index = Number(target.dataset.index);
  if (target.checked) state.selected.add(index);
  else state.selected.delete(index);

  target.closest('tr')?.classList.toggle('row-selected', target.checked);
  updateBulkToolbar();
});

el.selectAllCheckbox.addEventListener('change', () => {
  const checked = el.selectAllCheckbox.checked;
  const visibleRows = Array.from(el.channelsTableBody.querySelectorAll('tr:not([hidden])'));
  visibleRows.forEach((row) => {
    const index = Number(row.dataset.index);
    if (checked) state.selected.add(index);
    else state.selected.delete(index);
  });
  renderTable();
});

document.querySelectorAll('th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sort.key === key) {
      state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      state.sort = { key, direction: 'asc' };
    }
    renderTable();
  });
});

el.bulkDeselectBtn.addEventListener('click', () => {
  state.selected.clear();
  renderTable();
});

el.bulkClearBtn.addEventListener('click', () => {
  for (const index of state.selected) {
    state.links.delete(index);
    state.contexts.delete(index);
    state.errors.delete(index);
  }
  renderTable();
  autosave();
  toast('Cleared links for selected channels.', 'success');
});

el.bulkMatchBtn.addEventListener('click', () => {
  const channels = state.m3uChannels.filter((c) => state.selected.has(c.index));
  if (!channels.length) return;

  el.bulkMatchBtn.disabled = true;
  matchChannelList(channels, {
    onProgress: (i, total, channel) => {
      el.matchProgress.innerHTML = `<span class="spinner"></span>Re-matching ${i}/${total}: ${escapeHtml(channel.name)}`;
    }
  })
    .then(({ processed, failed }) => {
      el.matchProgress.textContent = `Re-match complete: ${processed - failed}/${processed} succeeded${failed ? `, ${failed} failed` : ''}.`;
      renderTable();
      autosave();
      toast(failed ? `Finished with ${failed} failure(s).` : 'Re-match complete.', failed ? 'error' : 'success');
    })
    .catch((error) => {
      console.error(error);
      toast(error.message, 'error');
    })
    .finally(() => {
      el.bulkMatchBtn.disabled = false;
    });
});

el.autoMatchBtn.addEventListener('click', () => {
  autoMatchAll().catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
});

el.exportM3UBtn.addEventListener('click', () => {
  exportM3U().catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
});

el.exportXMLBtn.addEventListener('click', () => {
  exportXML().catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
});

el.publishBtn.addEventListener('click', () => {
  publishHosted().catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
});

el.copyM3uUrlBtn.addEventListener('click', () => copyToClipboard(el.publishM3uUrl.value));
el.copyXmlUrlBtn.addEventListener('click', () => copyToClipboard(el.publishXmlUrl.value));

el.saveAutoRefreshBtn.addEventListener('click', () => {
  saveAutoRefreshConfig().catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
});

el.refreshNowBtn.addEventListener('click', () => {
  refreshNow().catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
});

el.saveProjectBtn.addEventListener('click', () => {
  saveProjectFile();
});

el.exportBacklogBtn.addEventListener('click', () => {
  exportBacklog();
});

el.loadProjectFile.addEventListener('change', () => {
  const file = el.loadProjectFile.files[0];
  if (!file) return;
  loadProjectFile(file)
    .catch((error) => {
      console.error(error);
      toast(error.message, 'error');
    })
    .finally(() => {
      el.loadProjectFile.value = '';
    });
});

initResumeBanner();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}
