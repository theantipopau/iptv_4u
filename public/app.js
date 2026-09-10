const STORAGE_KEY = 'iptv4u_session_v1';

const state = {
  m3uText: '',
  xmlText: '',
  m3uChannels: [],
  xmlSummary: null,
  discoveredSources: [],
  links: new Map(), // channel index -> link object
  contexts: new Map(), // channel index -> search context (24/7, country hint, ...)
  errors: new Map() // channel index -> last error message
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
  loadProjectFile: document.getElementById('loadProjectFile'),
  themeToggle: document.getElementById('themeToggle'),
  channelFilter: document.getElementById('channelFilter'),
  tableCount: document.getElementById('tableCount'),
  progressTrack: document.getElementById('progressTrack'),
  progressFill: document.getElementById('progressFill'),
  toastStack: document.getElementById('toastStack')
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

function buildLinkFromMatch(match, channel) {
  const isTmdb = match.sourceType === 'tmdb';
  const channelId = match.channelId ||
    (isTmdb ? `tmdb-${slugify(match.tmdb?.title || channel.name)}` : slugify(channel.name));

  return {
    channelIndex: channel.index,
    channelId,
    channelName: match.channelName || channel.name,
    source: match.source || '',
    logoUrl: match.logoUrl || null,
    guideUrl: match.guideUrl || null,
    canMergeGuide: !!match.canMergeGuide,
    tmdb: isTmdb ? match.tmdb : null,
    synthesize: isTmdb && !!match.canSynthesizeGuide
  };
}

function formatLink(link) {
  if (!link) return 'Not linked';
  if (link.tmdb) {
    return `TMDB: ${link.channelName} (logo${link.synthesize ? ' + placeholder guide' : ''})`;
  }
  if (link.canMergeGuide) {
    return `${link.channelId} @ ${link.source} (full guide)`;
  }
  return `${link.channelId} @ ${link.source || 'unknown'} (logo only)`;
}

// ---- persistence --------------------------------------------------------

function serializeState() {
  return {
    m3uText: state.m3uText,
    xmlText: state.xmlText,
    m3uChannels: state.m3uChannels,
    xmlSummary: state.xmlSummary,
    links: Array.from(state.links.entries()),
    contexts: Array.from(state.contexts.entries())
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

function renderTable() {
  el.channelsTableBody.innerHTML = '';
  state.m3uChannels.forEach((channel) => {
    const tr = document.createElement('tr');
    const linked = state.links.get(channel.index);
    const context = state.contexts.get(channel.index);
    const error = state.errors.get(channel.index);

    const logoSrc = (linked && linked.logoUrl) || channel.attrs?.['tvg-logo'] || '';
    const logoCell = logoSrc
      ? `<img class="logo-thumb" src="${escapeHtml(logoSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
      : '<div class="logo-thumb logo-thumb--empty"></div>';

    const badges = [];
    if (context?.isTwentyFourSeven) badges.push('<span class="badge badge--247">24/7</span>');
    if (linked?.tmdb) badges.push('<span class="badge badge--tmdb">TMDB</span>');
    if (error) badges.push(`<span class="badge badge--error" title="${escapeHtml(error)}">Search failed</span>`);

    tr.innerHTML = `
      <td>${channel.index + 1}</td>
      <td>${logoCell}</td>
      <td>
        <strong>${escapeHtml(channel.name)}</strong>
        ${badges.join(' ')}
        <div class="small">${escapeHtml(channel.url || '')}</div>
      </td>
      <td><code>${escapeHtml(channel.attrs?.['tvg-id'] || '')}</code></td>
      <td>
        <span>${escapeHtml(formatLink(linked))}</span>
      </td>
      <td>
        <button class="btn" data-action="search" data-index="${channel.index}">Search</button>
      </td>
    `;

    el.channelsTableBody.appendChild(tr);
  });

  applyChannelFilter();
}

// ---- filtering ----------------------------------------------------------

function applyChannelFilter() {
  const query = el.channelFilter.value.trim().toLowerCase();
  const rows = Array.from(el.channelsTableBody.querySelectorAll('tr'));
  let visible = 0;

  rows.forEach((row, i) => {
    const channel = state.m3uChannels[i];
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

  card.innerHTML = `
    ${thumb}
    <h4>${escapeHtml(match.channelName || match.channelId || 'Unknown')}</h4>
    <p class="small">ID: <code>${escapeHtml(match.channelId || '(generated)')}</code></p>
    <p class="small">Source: ${escapeHtml(match.source || '')} | Score: ${Number(match.score || 0).toFixed(2)} | ${capability}</p>
    ${guideLine}
    ${tmdbLine}
    <div class="match-actions">
      <button class="btn primary" data-select="${encodeURIComponent(JSON.stringify(match))}">Use This Match</button>
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
      maxSources: Number(el.maxSources.value || 120)
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

async function autoMatchAll() {
  if (!state.m3uChannels.length) {
    toast('Load files first.', 'error');
    return;
  }

  el.autoMatchBtn.disabled = true;
  el.progressTrack.hidden = false;
  el.progressFill.style.width = '0%';

  let processed = 0;
  let failed = 0;
  for (const channel of state.m3uChannels) {
    processed += 1;
    el.matchProgress.innerHTML = `<span class="spinner"></span>Auto matching ${processed}/${state.m3uChannels.length}: ${escapeHtml(channel.name)}`;
    el.progressFill.style.width = `${Math.round((processed / state.m3uChannels.length) * 100)}%`;
    try {
      const result = await api('/api/search-channel', {
        method: 'POST',
        body: JSON.stringify({
          channelName: channel.name,
          tvgId: channel.attrs?.['tvg-id'] || '',
          groupTitle: channel.attrs?.['group-title'] || '',
          maxSources: Number(el.maxSources.value || 120)
        })
      });

      state.contexts.set(channel.index, result.context);
      state.errors.delete(channel.index);
      updateTmdbStatus(result.context);

      const best = result.matches[0];
      if (best) {
        state.links.set(channel.index, buildLinkFromMatch(best, channel));
      }
    } catch (error) {
      failed += 1;
      state.errors.set(channel.index, error.message);
      console.error(error);
    }
  }

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

async function exportM3U() {
  if (!state.m3uChannels.length) {
    toast('Load files first.', 'error');
    return;
  }

  const links = Array.from(state.links.values());
  const result = await api('/api/export-m3u', {
    method: 'POST',
    body: JSON.stringify({
      channels: state.m3uChannels,
      links
    })
  });

  downloadFile('updated_playlist.m3u', result.m3u, 'audio/x-mpegurl');
  toast('Downloaded updated_playlist.m3u', 'success');
}

async function exportXML() {
  if (!state.xmlText) {
    toast('Load files first.', 'error');
    return;
  }

  el.exportXMLBtn.disabled = true;
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
  el.exportXMLBtn.disabled = false;
  autosave();
  downloadFile('updated_guide.xml', merged, 'application/xml');
  toast('Downloaded updated_guide.xml', 'success');
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

el.saveProjectBtn.addEventListener('click', () => {
  saveProjectFile();
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
