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
  healthCheckBtn: document.getElementById('healthCheckBtn'),
  compareIdsBtn: document.getElementById('compareIdsBtn'),
  healthSummary: document.getElementById('healthSummary'),
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
  autoRefreshStatus: document.getElementById('autoRefreshStatus'),
  allGuidesBtn: document.getElementById('allGuidesBtn'),
  allGuidesStatus: document.getElementById('allGuidesStatus'),
  guidesTable: document.getElementById('guidesTable'),
  enableAutoRefreshBtn: document.getElementById('enableAutoRefreshBtn'),
  publishSummary: document.getElementById('publishSummary'),
  attentionBanner: document.getElementById('attentionBanner'),
  autoRefreshAtHour: document.getElementById('autoRefreshAtHour'),
  autoRefreshAtHourLabel: document.getElementById('autoRefreshAtHourLabel'),
  autoRefreshTimeZone: document.getElementById('autoRefreshTimeZone'),
  autoRefreshTimeZoneLabel: document.getElementById('autoRefreshTimeZoneLabel')
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

  let json = null;
  try {
    json = await response.json();
  } catch {
    throw new Error(`The server returned a non-JSON response (HTTP ${response.status}).`);
  }
  if (!response.ok || !json.ok) {
    // Carry the stage-specific code/details through, so callers can explain
    // exactly which stage failed instead of showing a generic message.
    const error = new Error(json.error || `Request failed: ${response.status}`);
    error.code = json.code || null;
    error.details = json.details || null;
    error.status = response.status;
    throw error;
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
    customGuideUrl: el.customGuideUrl.value.trim(),
    publishSlug: el.publishSlug.value.trim()
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

  const slug = (data.publishSlug || '').trim();
  el.publishSlug.value = slug;
  // The remembered slug only means the URLs are *known*, not that the
  // currently-loaded state has actually been published under it yet (or
  // still matches whatever was published last) — publishStatus is left
  // blank rather than claiming "Published" outright.
  if (slug) {
    showPublishedUrls(slug);
  } else {
    el.publishResult.hidden = true;
  }
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

// A deliberate "no EPG at all" option — distinct from just closing the
// dialog without picking anything. Needed because auto-match (especially
// for 24/7 channels) sometimes confidently picks the *wrong* thing, and
// until now there was no way to say "none of these are right" short of
// closing the dialog and using the bulk toolbar's "Clear Links" instead.
function buildNoneCard(channel) {
  const card = document.createElement('div');
  card.className = 'match-item match-item--none';
  card.innerHTML = `
    <h4>None</h4>
    <p class="small">Remove any EPG/logo match for this channel — it'll show as "Not linked" until you search or set one manually again.</p>
    <div class="match-actions">
      <button class="btn" type="button">Set No EPG (Clear Link)</button>
    </div>
  `;

  card.querySelector('button').addEventListener('click', (event) => {
    event.preventDefault();
    state.links.delete(channel.index);
    state.contexts.delete(channel.index);
    state.errors.delete(channel.index);
    renderTable();
    autosave();
    toast('Cleared — no EPG assigned to this channel.', 'success');
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
    const empty = document.createElement('p');
    empty.className = 'small';
    empty.textContent = 'No strong matches found. Try lowering source limits or editing channel names.';
    el.matchList.appendChild(empty);
    el.matchList.appendChild(buildNoneCard(channel));
    renderTable();
    return;
  }

  result.matches.forEach((match) => {
    el.matchList.appendChild(buildMatchCard(match, channel));
  });
  el.matchList.appendChild(buildNoneCard(channel));
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

// The hosted URLs are entirely deterministic from the slug — no server
// round-trip needed to know them. Used both right after a real publish
// and when resuming a session that remembers a slug it was already
// published under, so the URLs/Watch Live link show up immediately
// instead of needing a "publish again" just to redisplay them.
function showPublishedUrls(slug) {
  el.publishResult.hidden = false;
  el.publishM3uUrl.value = `${location.origin}/iptv/${slug}.m3u`;
  el.publishXmlUrl.value = `${location.origin}/epg/${slug}.xml`;
  el.watchLiveLink.href = `${location.origin}/watch?slug=${encodeURIComponent(slug)}`;
}

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

    // Every currently-manual link becomes a protected override for this
    // slug — auto-refresh (if configured) will use these as-is instead of
    // re-matching from scratch, so a manual fix doesn't get silently
    // undone on the next scheduled run. Keyed by the channel's raw M3U
    // name since that's the only stable identifier available before a
    // channel has been matched at all.
    const overrides = {};
    for (const link of state.links.values()) {
      if (!link.manual) continue;
      const channel = state.m3uChannels.find((c) => c.index === link.channelIndex);
      if (!channel) continue;
      overrides[channel.name] = {
        channelId: link.channelId,
        channelName: link.channelName,
        source: link.source,
        logoUrl: link.logoUrl,
        guideUrl: link.guideUrl,
        canMergeGuide: link.canMergeGuide,
        tmdb: link.tmdb || null,
        synthesize: !!link.synthesize,
        score: link.score,
        manual: true
      };
    }

    // Every channel's match (or deliberate lack of one), so scheduled
    // refreshes can renew the schedule from the same sources without
    // re-searching the whole lineup.
    const plan = {};
    for (const channel of state.m3uChannels) {
      const link = state.links.get(channel.index);
      plan[channel.name] = link
        ? {
          channelId: link.channelId,
          channelName: link.channelName,
          source: link.source,
          logoUrl: link.logoUrl,
          guideUrl: link.guideUrl,
          canMergeGuide: link.canMergeGuide,
          tmdb: link.tmdb || null,
          synthesize: !!link.synthesize,
          score: link.score,
          manual: !!link.manual
        }
        : { channelId: null };
    }

    const result = await api('/api/publish', {
      method: 'POST',
      body: JSON.stringify({ slug, m3uContent: m3u, xmlContent: xml, overrides, plan })
    });

    showPublishedUrls(result.slug);
    const metrics = result.metrics || {};
    el.publishStatus.textContent = `Published — ${metrics.playlistChannels ?? '?'} channels, ${metrics.epgPrograms ?? 0} programmes (${metrics.epgCurrentOrFuturePrograms ?? 0} current or upcoming). Point your IPTV app at these URLs:`;
    autosave();
    toast('Published.', 'success');
    // Verify what was actually stored, immediately — the point is to find out
    // here rather than in TiViMate — and then say what happens next: whether
    // anything will renew it, and when the schedule it just published runs out.
    const health = await checkPublishedHealth({ quiet: true });
    renderPublishSummary({ slug: result.slug, health, warnings: result.warnings || [] });
    checkAllGuides({ quiet: true });
  } catch (error) {
    renderPublishSummary({ slug, error });
    if (error.code === 'PUBLISH_VALIDATION_FAILED' && error.details?.errors) {
      const reasons = error.details.errors.map((e) => e.message).join(' ');
      el.publishStatus.textContent = `Nothing was published — the previous version is still live. ${reasons}`;
      toast('Publication blocked: see the Publish panel for why.', 'error');
    } else if (error.code === 'PUBLISH_READBACK_FAILED' || error.code === 'PUBLISH_STORAGE_WRITE_FAILED') {
      el.publishStatus.textContent = `Nothing was published — the stored files could not be verified (${error.code}). The previous version is still live.`;
      toast('Publication failed during storage. Nothing was changed.', 'error');
    } else {
      el.publishStatus.textContent = '';
      toast(error.message, 'error');
    }
  } finally {
    el.publishBtn.disabled = false;
  }
}

function copyToClipboard(value) {
  navigator.clipboard?.writeText(value)
    .then(() => toast('Copied to clipboard.', 'success'))
    .catch(() => toast('Could not copy — select and copy manually.', 'error'));
}

// ---- published EPG health -------------------------------------------------
//
// The panel that would have caught the production incident in one click:
// TiViMate showing no guide for any channel is a *server-side* condition
// (an expired or disconnected guide), not something to fix by resetting the
// player app — so the checks live here, next to the publish button, and are
// ordered so the guide is verified before anyone is told to refresh it.

const HEALTH_LABELS = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  stale: 'Stale — the guide has run out',
  invalid: 'Invalid',
  missing: 'Nothing published'
};

function healthStatusNote(health) {
  if (health.status === 'missing') return 'Nothing is published under this slug yet — publish first.';
  if (health.status === 'invalid') return 'The published files are structurally broken. Republish this slug before touching any player app.';
  const freshness = health.epg?.freshness;
  if (freshness === 'expired') {
    return 'Every programme in the published guide has already ended, so players will show NO EPG for every channel even though the playlist still loads. Re-run the match with current guide sources and publish again.';
  }
  if (freshness === 'ending-soon') {
    return 'The guide still has programmes, but its schedule runs out shortly — republish (or enable auto-refresh) before then, or every channel will lose its EPG when it does.';
  }
  if (health.epg && !health.epg.programmes) {
    return 'No programmes are published for this guide yet — channels will show a logo but no schedule.';
  }
  if (health.mapping?.matchedIds === 0) {
    return 'No playlist id matches any guide channel id — players join the two by exact id, so the guide will appear empty for every channel.';
  }
  if (health.status === 'degraded') return 'Usable, with warnings worth reading below.';
  return 'The playlist and guide are connected and the guide contains current programmes.';
}

function renderHealth(health, { focusMapping = false } = {}) {
  const summary = el.healthSummary;
  summary.hidden = false;
  summary.replaceChildren();

  const head = document.createElement('div');
  head.className = 'health-summary__head';
  const status = document.createElement('span');
  status.className = `health-summary__status health-summary__status--${health.status}`;
  status.textContent = HEALTH_LABELS[health.status] || health.status;
  const slugLine = document.createElement('span');
  slugLine.className = 'small';
  slugLine.textContent = `/epg/${health.slug}.xml`;
  head.append(status, slugLine);
  summary.appendChild(head);

  const note = document.createElement('p');
  note.className = 'health-advice small';
  note.textContent = healthStatusNote(health);
  summary.appendChild(note);

  const rows = [];
  if (health.playlist) {
    rows.push(['Playlist channels', `${health.playlist.channels}`]);
    rows.push(['Channels with tvg-id', `${health.playlist.channelsWithTvgId} (blank ${health.playlist.channels - health.playlist.channelsWithTvgId}, duplicates ${health.playlist.duplicateIds})`]);
  }
  if (health.epg) {
    rows.push(['Guide channels', `${health.epg.channels}`]);
    rows.push(['Programmes', `${health.epg.programmes} (current/future ${health.epg.currentOrFutureProgrammes})`]);
    rows.push(['Programme range', health.epg.earliestStart || health.epg.latestStop
      ? `${new Date(health.epg.earliestStart).toLocaleString()} → ${new Date(health.epg.latestStop).toLocaleString()}`
      : 'no programmes']);
    rows.push(['Guide freshness', health.epg.freshness]);
  }
  if (health.mapping) {
    const coverage = health.playlist?.channelsWithTvgId
      ? `${Math.round((health.mapping.matchedIds / health.playlist.channelsWithTvgId) * 100)}%`
      : 'n/a';
    rows.push(['Matched ids', `${health.mapping.matchedIds} of ${health.playlist?.channelsWithTvgId ?? '?'} ids (${coverage})`]);
    rows.push(['Channels without EPG', `${health.mapping.playlistIdsWithoutEpg}`]);
    rows.push(['Programme refs without a channel', `${health.mapping.programmeReferencesWithoutChannel}`]);
  }
  if (health.storage) {
    rows.push(['Active version', health.storage.activeVersion || 'none']);
    rows.push(['Published at', health.storage.publishedAt ? new Date(health.storage.publishedAt).toLocaleString() : 'unknown']);
    if (health.storage.lastKnownGoodAvailable) rows.push(['Previous version kept', 'yes — available for rollback']);
  }

  const list = document.createElement('dl');
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  summary.appendChild(list);

  if (health.warnings?.length) {
    const heading = document.createElement('p');
    heading.className = 'small';
    heading.textContent = focusMapping ? 'Identifier comparison' : 'Warnings';
    const warnings = document.createElement('ul');
    for (const warning of health.warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      warnings.appendChild(item);
    }
    summary.append(heading, warnings);
  }
}

async function checkPublishedHealth({ focusMapping = false, quiet = false } = {}) {
  const slug = el.publishSlug.value.trim();
  if (!slug) {
    if (!quiet) toast('Set a URL slug in the Publish section first.', 'error');
    return null;
  }

  el.healthCheckBtn.disabled = true;
  el.compareIdsBtn.disabled = true;
  el.healthSummary.hidden = false;
  el.healthSummary.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'small';
  loading.textContent = 'Checking the published files on the server…';
  el.healthSummary.appendChild(loading);

  let health = null;
  try {
    health = await api(`/api/health/epg/${encodeURIComponent(slug)}`);
    renderHealth(health, { focusMapping });
    if (quiet) { /* the caller renders the result; no toast */ }
    else if (health.status === 'healthy') toast('Published playlist and guide look healthy.', 'success');
    else if (health.status === 'missing') toast('Nothing published under that slug yet.', 'error');
    else toast(`Published EPG is ${health.status} — see the panel for details.`, 'error');
  } catch (error) {
    el.healthSummary.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'small';
    failed.textContent = `Could not check the published files: ${error.message}`;
    el.healthSummary.appendChild(failed);
    if (!quiet) toast(error.message, 'error');
  } finally {
    el.healthCheckBtn.disabled = false;
    el.compareIdsBtn.disabled = false;
  }
  // Returned so the publish summary can state the same facts the health panel
  // just rendered, rather than a second source of truth.
  return health;
}

el.healthCheckBtn.addEventListener('click', () => checkPublishedHealth());
el.compareIdsBtn.addEventListener('click', () => checkPublishedHealth({ focusMapping: true }));

// ---- auto-refresh --------------------------------------------------------

// A short list rather than every IANA zone: the point is to pick the zone the
// user actually lives in, and typing through 400 options is worse than not
// offering them. The browser's own zone is added (and selected) when known.
const REFRESH_TIME_ZONES = [
  'UTC',
  'Australia/Sydney',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Perth',
  'Pacific/Auckland',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles'
];

function browserTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && REFRESH_TIME_ZONES.includes(zone) ? zone : (zone || 'UTC');
  } catch {
    return 'UTC';
  }
}

function initRefreshScheduleFields() {
  const zones = [...REFRESH_TIME_ZONES];
  const own = browserTimeZone();
  if (!zones.includes(own)) zones.unshift(own);
  for (const zone of zones) {
    const option = document.createElement('option');
    option.value = zone;
    option.textContent = zone === own ? `${zone} (your time zone)` : zone;
    el.autoRefreshTimeZone.appendChild(option);
  }
  el.autoRefreshTimeZone.value = own;

  for (let hour = 0; hour < 24; hour += 1) {
    const option = document.createElement('option');
    option.value = String(hour);
    option.textContent = `${String(hour).padStart(2, '0')}:00`;
    el.autoRefreshAtHour.appendChild(option);
  }
  el.autoRefreshAtHour.value = '3';

  el.autoRefreshInterval.addEventListener('change', syncRefreshScheduleFields);
  syncRefreshScheduleFields();
}

function syncRefreshScheduleFields() {
  const dailyAt = el.autoRefreshInterval.value === 'daily-at';
  el.autoRefreshAtHourLabel.hidden = !dailyAt;
  el.autoRefreshTimeZoneLabel.hidden = !dailyAt;
}

/**
 * The schedule as the form currently describes it — one source of truth for
 * both Save and the one-click Enable button, so the button can't silently
 * apply a different schedule from the one on screen.
 * @returns {{intervalKey: string|null, dailyAtHour: number|null, timeZone: string|null}}
 */
function readScheduleFromForm() {
  if (el.autoRefreshInterval.value === 'daily-at') {
    return {
      intervalKey: null,
      dailyAtHour: Number(el.autoRefreshAtHour.value),
      timeZone: el.autoRefreshTimeZone.value || 'UTC'
    };
  }
  return {
    intervalKey: el.autoRefreshInterval.value || null,
    dailyAtHour: null,
    timeZone: null
  };
}

/**
 * Human summary of a schedule, from either the form's shape or the server's
 * `refresh` block — one function so the status line, the dashboard and the
 * publish checklist can never phrase the same schedule differently.
 * @returns {string} e.g. 'daily at 03:00 (Australia/Sydney)', 'every 24 hours', or 'off'
 */
function scheduleLabel(schedule) {
  if (!schedule) return 'off';
  if (Number.isInteger(schedule.dailyAtHour)) {
    const hour = `${String(schedule.dailyAtHour).padStart(2, '0')}:00`;
    return `daily at ${hour} (${schedule.timeZone || 'UTC'})`;
  }
  if (schedule.intervalKey) return `every ${String(schedule.intervalKey).replace('h', ' hours')}`;
  return 'off';
}

function describeRefreshConfig(config) {
  if (!config) return '';
  const parts = [];
  const label = scheduleLabel(config);
  parts.push(label === 'off' ? 'Auto-refresh: off' : `Auto-refresh: ${label}`);

  if (config.lastRunAt) {
    const when = new Date(config.lastRunAt).toLocaleString();
    if (config.lastRunStatus === 'ok') {
      const overrideNote = config.lastRunOverrideCount ? `, ${config.lastRunOverrideCount} manual override${config.lastRunOverrideCount === 1 ? '' : 's'} preserved` : '';
      const programNote = config.lastRunProgramCount != null
        ? `, ${config.lastRunProgramCount} programmes (${config.lastRunCurrentOrFutureCount ?? 0} current/upcoming)`
        : '';
      parts.push(`last ran ${when} (${config.lastRunChannelCount ?? '?'} channels, ${config.lastRunGuideCount ?? 0} guide / ${config.lastRunLogoCount ?? 0} logo${programNote}${overrideNote})`);
    } else {
      // A blocked publication is reported with its stage-specific reason, and
      // explicitly states that the previous guide is untouched.
      parts.push(`last run failed ${when}: ${config.lastRunError || 'unknown error'}`);
      if (config.lastRunErrorCode === 'PUBLISH_VALIDATION_FAILED') {
        parts.push('nothing was published — the previous version is still live');
      }
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
        ...readScheduleFromForm()
      })
    });
    el.autoRefreshStatus.textContent = describeRefreshConfig(result.config);
    const saved = scheduleLabel(result.config);
    if (saved !== 'off') {
      toast(`Auto-refresh saved — ${saved}.`, 'success');
    } else {
      // Saying "saved" for a config that is never due is how someone ends up
      // believing their guide is on a schedule when nothing will ever run.
      toast('Saved, but with no interval set — this slug will NOT be refreshed automatically, and its guide will still expire.', 'error');
    }
    // The whole point of enabling this is that the guide stays current, so
    // report the new state rather than assuming the user trusts the toast.
    if (saved !== 'off') checkAllGuides({ quiet: true });
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

// ---- published guides & freshness dashboard -----------------------------
//
// One row per published slug. The two questions that matter are separate: how
// much schedule the guide has left, and whether anything will renew it. A
// guide that is fresh but has no auto-refresh is still a guide that is going
// to break on its own, and until now nothing in the UI ever said so.

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'unknown';
  const past = ms < 0;
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60000);
  const text = minutes < 60
    ? `${minutes} min`
    : minutes < 60 * 48
      ? `${Math.round(minutes / 60)} h`
      : `${Math.round(minutes / (60 * 24))} d`;
  return past ? `${text} ago` : `${text}`;
}

/**
 * "Guide expires in 3.2 days" / "Guide expired 17 hours ago" — the countdown
 * that makes an expiry legible while there is still time to act on it.
 * @param {{inMs: number|null, expired: boolean, at: string|null}|null|undefined} expiry
 */
function formatExpiry(expiry) {
  if (!expiry || expiry.inMs == null || !Number.isFinite(expiry.inMs)) return { kind: 'unknown', text: 'Guide expiry: unknown' };
  const abs = Math.abs(expiry.inMs);
  const days = abs / 86400000;
  const value = days >= 1
    ? `${days.toFixed(1)} days`
    : `${Math.max(1, Math.round(abs / 3600000))} hours`;
  if (expiry.expired) return { kind: 'expired', text: `Guide expired: ${value} ago` };
  return { kind: days < 1 ? 'urgent' : 'ok', text: `Guide expires in: ${value}` };
}

/**
 * The checklist shown immediately after a Publish. A guide that was written
 * successfully but has nothing scheduled to renew it is the single most
 * likely way to end up with a dead EPG, so it is stated as loudly as the
 * successes are, in the one place the user is already looking.
 * @param {{slug: string, health: Object|null, warnings: Array, error: Error|null}} input
 */
function renderPublishSummary({ slug, health, warnings = [], error = null }) {
  const summary = el.publishSummary;
  summary.hidden = false;
  summary.replaceChildren();

  const line = (symbol, text, kind = 'ok') => {
    const row = document.createElement('p');
    row.className = `publish-summary__row publish-summary__row--${kind}`;
    row.textContent = `${symbol} ${text}`;
    return row;
  };

  if (error) {
    summary.appendChild(line('⚠', `Not published: ${error.message}`, 'bad'));
    return;
  }

  summary.appendChild(line('✅', 'Published', 'ok'));
  if (health?.playlist) summary.appendChild(line('✅', `Playlist healthy — ${health.playlist.channels} channels`, 'ok'));
  if (health?.epg) {
    summary.appendChild(line('✅', `Guide healthy — ${health.epg.channels} channels, ${health.epg.programmes} programmes (${health.epg.currentOrFutureProgrammes} current or upcoming)`, 'ok'));
  }

  const expiry = formatExpiry(health?.expiry);
  if (health?.expiry?.inMs != null) {
    summary.appendChild(line(expiry.kind === 'expired' ? '⚠' : '•', expiry.text, expiry.kind === 'expired' ? 'bad' : expiry.kind === 'urgent' ? 'warn' : 'ok'));
  }

  const refresh = health?.refresh;
  if (refresh?.enabled) {
    summary.appendChild(line('✅', `Auto-refresh enabled — ${scheduleLabel(refresh)}`, 'ok'));
    summary.appendChild(line('•', refresh.nextRunAt
      ? `Next refresh: ${new Date(refresh.nextRunAt).toLocaleString()}`
      : refresh.lastRunAt
        ? `Last refresh: ${new Date(refresh.lastRunAt).toLocaleString()}`
        : 'Next refresh: due now (the scheduler checks hourly)', 'ok'));
  } else if (refresh?.paused) {
    summary.appendChild(line('⚠', 'No auto-refresh will run — a config is saved with its interval set to Off', 'bad'));
  } else {
    // Mark it, say how long it has, and put the fix one click away.
    summary.appendChild(line('⚠', `No auto-refresh configured — this slug is marked WILL EXPIRE`, 'bad'));
    const enable = document.createElement('button');
    enable.type = 'button';
    enable.className = 'btn primary';
    enable.textContent = 'Enable Auto Refresh Now';
    enable.addEventListener('click', () => enableAutoRefresh().catch((err) => toast(err.message, 'error')));
    summary.appendChild(enable);
  }

  for (const warning of warnings) {
    if (warning.code === 'GUIDE_WILL_EXPIRE_WITHOUT_REFRESH') continue; // already stated above
    summary.appendChild(line('⚠', warning.message, 'warn'));
  }
  if (warnings.some((warning) => warning.code === 'GUIDE_WILL_EXPIRE_WITHOUT_REFRESH')) {
    summary.appendChild(line('⚠', 'This guide appears healthy but will eventually expire unless auto-refresh is enabled.', 'bad'));
  }
}

/**
 * One-click enrol: uses the M3U source URL from the auto-refresh panel if it's
 * already filled in, otherwise sends the user straight to that field rather
 * than to another screen or to the documentation.
 */
async function enableAutoRefresh() {
  const slug = el.publishSlug.value.trim();
  if (!slug) {
    toast('Set a URL slug in the Publish section first.', 'error');
    return;
  }
  const m3uUrl = el.autoRefreshM3uUrl.value.trim();
  if (!m3uUrl) {
    el.autoRefreshM3uUrl.focus();
    el.autoRefreshM3uUrl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast('Paste your provider\u2019s M3U URL here, then press Enable Auto Refresh again — that\u2019s the source the scheduled refresh re-reads.', 'error');
    return;
  }

  // Whatever the schedule panel currently says — including a fixed time of
  // day — so this button can't apply something different from what's on screen.
  const schedule = readScheduleFromForm();
  const effective = schedule.dailyAtHour !== null || schedule.intervalKey ? schedule : { intervalKey: '24h', dailyAtHour: null, timeZone: null };

  el.enableAutoRefreshBtn.disabled = true;
  try {
    await api('/api/refresh-config', {
      method: 'POST',
      body: JSON.stringify({ slug, m3uUrl, customGuideUrl: el.customGuideUrl.value.trim(), ...effective })
    });
    toast(`Auto-refresh enabled for ${slug} (${scheduleLabel(effective)}).`, 'success');
    // Re-render the checklist with what the server now says, so the warning
    // that prompted the click is visibly gone rather than left on screen.
    const health = await checkPublishedHealth({ quiet: true });
    if (health?.published) renderPublishSummary({ slug, health, warnings: [] });
    await checkAllGuides({ quiet: true });
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    el.enableAutoRefreshBtn.disabled = false;
  }
}

// Column order matters: the countdown and the renewal state come before the
// historical detail, because those are the two things that decide whether the
// guide still works tomorrow.
const GUIDE_COLUMNS = ['Slug', 'Guide age', 'Expiry countdown', 'Current/future', 'Auto-refresh', 'Last refresh', 'Next refresh', 'Status'];

function renderGuidesTable(report) {
  const table = el.guidesTable;
  table.hidden = false;
  table.replaceChildren();

  if (!report.slugs?.length) {
    const empty = document.createElement('p');
    empty.className = 'small';
    empty.textContent = 'Nothing has been published yet — publish a slug and it will appear here.';
    table.appendChild(empty);
    renderAttentionBanner(report);
    return;
  }

  const element = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of GUIDE_COLUMNS) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  element.appendChild(head);

  const body = document.createElement('tbody');
  for (const row of report.slugs) {
    const tr = document.createElement('tr');

    const slug = document.createElement('th');
    slug.scope = 'row';
    slug.textContent = row.slug;
    tr.appendChild(slug);

    const age = document.createElement('td');
    // Three different situations, three different words: there is no guide
    // (nothing dated to show), the guide's age isn't recoverable, or an actual
    // number.
    age.textContent = row.published && row.hasGuide === false
      ? 'no guide'
      : row.guideAgeMs == null ? 'not recorded' : formatDuration(row.guideAgeMs);
    tr.appendChild(age);

    const expiryCell = document.createElement('td');
    const expiry = formatExpiry(row.expiry);
    expiryCell.className = `guides-table__expiry guides-table__expiry--${expiry.kind}`;
    expiryCell.textContent = expiry.kind === 'unknown' ? 'unknown' : expiry.text.replace(/^Guide /, '');
    tr.appendChild(expiryCell);

    const current = document.createElement('td');
    current.textContent = row.published && row.hasGuide === false
      ? 'no guide'
      : row.currentOrFutureProgrammes == null
        ? 'unknown'
        : `${row.currentOrFutureProgrammes} of ${row.programmes ?? '?'}`;
    tr.appendChild(current);

    const refresh = document.createElement('td');
    // The label is the point of the column: "enabled" and "will expire" must
    // be impossible to confuse with each other.
    if (row.renewal === 'auto') refresh.textContent = `Yes — ${scheduleLabel(row.refresh)}`;
    else if (row.renewal === 'overdue') refresh.textContent = 'Enabled — but not running';
    else if (row.renewal === 'paused') refresh.textContent = 'Saved but Off — will expire';
    else if (row.renewal === 'unpublished') refresh.textContent = 'Configured — nothing published';
    else refresh.textContent = 'No — will expire';
    tr.appendChild(refresh);

    const last = document.createElement('td');
    last.textContent = row.refresh?.lastRunAt
      ? `${new Date(row.refresh.lastRunAt).toLocaleString()}${row.refresh.lastRunStatus === 'error' ? ' (failed)' : ''}`
      : 'never';
    tr.appendChild(last);

    const next = document.createElement('td');
    next.textContent = row.refresh?.nextRunAt ? new Date(row.refresh.nextRunAt).toLocaleString() : (row.refresh?.due && row.refresh?.enabled ? 'due now' : '—');
    tr.appendChild(next);

    const status = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `health-summary__status health-summary__status--${row.status}`;
    badge.textContent = HEALTH_LABELS[row.status] || row.status;
    status.appendChild(badge);
    // Status is never conveyed by colour alone: the first warning for the row
    // is printed next to it.
    if (row.warnings?.length) {
      const note = document.createElement('span');
      note.className = 'small';
      note.textContent = ` ${row.warnings[0].message}`;
      status.appendChild(note);
    }
    tr.appendChild(status);
    body.appendChild(tr);
  }
  element.appendChild(body);
  table.appendChild(element);

  // Warnings for other slugs than the one currently selected in the Publish
  // box would otherwise be invisible — this is the "your other guide died"
  // alarm.
  const others = (report.warnings || []).filter((warning) => warning.slug && warning.slug !== el.publishSlug.value.trim());
  if (others.length) {
    const list = document.createElement('ul');
    list.className = 'guides-table__warnings';
    for (const warning of others) {
      const item = document.createElement('li');
      item.textContent = `${warning.slug}: ${warning.message}`;
      list.appendChild(item);
    }
    // Each row's Status column already says this; the full list is one click away.
    const details = document.createElement('details');
    details.className = 'help';
    const summary = document.createElement('summary');
    summary.textContent = `All ${others.length} warning${others.length === 1 ? '' : 's'} in detail`;
    details.append(summary, list);
    table.appendChild(details);
  }

  renderSchedulerNote(report.scheduler);
  renderAttentionBanner(report);
}

/**
 * Scheduler-level status, the one thing no individual slug can report: a
 * missing Cloudflare Cron Trigger leaves every config looking correctly
 * "enabled" while nothing executes it.
 * @param {Object|undefined} scheduler
 */
function renderSchedulerNote(scheduler) {
  if (!scheduler || scheduler.observed === null || scheduler.observed === undefined) return;
  const note = document.createElement('p');
  note.className = `small guides-table__scheduler guides-table__scheduler--${scheduler.observed ? 'running' : 'missing'}`;
  // "Never run" and "not running when due" are different faults with the same
  // cause, so name the one that actually applies.
  const reason = scheduler.overdue?.length
    ? `enabled but not run when due: ${scheduler.overdue.join(', ')}`
    : `never run: ${scheduler.neverRun.join(', ')}`;
  note.textContent = scheduler.observed
    ? `Auto-refresh scheduler: running — ${scheduler.enabledConfigs} enabled config(s), last run ${scheduler.lastRunAt ? new Date(scheduler.lastRunAt).toLocaleString() : 'n/a'}.`
    : `Auto-refresh scheduler: NOT OBSERVED — ${reason}. On Cloudflare, check Settings → Trigger events for the 0 * * * * Cron Trigger; locally, check IPTV4U_NO_SCHEDULER is not set.`;
  el.guidesTable.appendChild(note);
}

/**
 * A standing warning above the Publish panel for anything already broken, so
 * existing slugs are surfaced the moment the app loads rather than only when
 * someone thinks to click the dashboard button.
 * @param {Object} report
 */
function renderAttentionBanner(report) {
  const banner = el.attentionBanner;
  const attention = report?.attention || {};
  const problems = [];
  if (attention.expired) problems.push(`${attention.expired} guide(s) have already expired — players will show no EPG for every channel`);
  if (attention.expiringSoon) problems.push(`${attention.expiringSoon} guide(s) run out within 12 hours`);
  if (attention.noRefresh) problems.push(`${attention.noRefresh} published slug(s) have no auto-refresh and will expire on their own`);
  if (attention.overdue) problems.push(`${attention.overdue} slug(s) have auto-refresh enabled but nothing is running it`);

  if (!problems.length) {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  banner.hidden = false;
  banner.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = 'Needs attention:';
  const list = document.createElement('ul');
  for (const problem of problems) {
    const item = document.createElement('li');
    item.textContent = problem;
    list.appendChild(item);
  }
  banner.append(heading, list);
}

async function checkAllGuides({ quiet = false } = {}) {
  el.allGuidesBtn.disabled = true;
  if (!quiet) el.allGuidesStatus.textContent = 'Checking every published slug…';
  try {
    const report = await api('/api/health/epg');
    renderGuidesTable(report);
    el.allGuidesStatus.textContent = `${report.count} published slug(s) — overall ${HEALTH_LABELS[report.status] || report.status}.`;
    if (!quiet) {
      if (report.status === 'healthy') toast('Every published guide is fresh and has current programmes.', 'success');
      else if (report.status === 'stale') toast('At least one published guide has expired — see the table below.', 'error');
      else toast('Some published guides need attention — see the table below.', 'error');
    }
    return report;
  } catch (error) {
    el.allGuidesStatus.textContent = '';
    if (!quiet) toast(error.message, 'error');
    return null;
  } finally {
    el.allGuidesBtn.disabled = false;
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

// Persist the slug as soon as it's set, not only after a successful
// publish — otherwise a session saved before ever clicking Publish (or
// before this field existed) never carries a slug to restore.
el.publishSlug.addEventListener('blur', () => autosave());

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

el.allGuidesBtn.addEventListener('click', () => {
  checkAllGuides().catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
});

el.enableAutoRefreshBtn.addEventListener('click', () => {
  enableAutoRefresh().catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
});

initRefreshScheduleFields();

// Audit every published slug as soon as the app loads, so an already-expired or
// unrenewed guide is announced instead of waiting to be asked about. Quiet: a
// first-time visitor with nothing published should see no error at all.
checkAllGuides({ quiet: true }).catch(() => {});

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
