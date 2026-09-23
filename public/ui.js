// Presentation-only behaviour: Publish tabs, step-nav scroll-spy and step
// progress. app.js owns all data/state; this file only reads the DOM.
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  // ---- Publish tabs -------------------------------------------------------
  const tabs = $$('.tab');

  function showTab(name, { focus = false } = {}) {
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
      if (active && focus) tab.focus();
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      let next = null;
      if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
      else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === 'Home') next = tabs[0];
      else if (event.key === 'End') next = tabs[tabs.length - 1];
      if (next) {
        event.preventDefault();
        showTab(next.dataset.tab, { focus: true });
      }
    });
  }

  // "Enable auto-refresh" focuses the M3U source field when it's empty, and
  // that field lives on another tab. Capture phase, so the tab is already
  // visible by the time app.js's own click handler tries to focus the field.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const isEnable = button.id === 'enableAutoRefreshBtn'
      || (button.closest('#publishSummary') && /enable auto/i.test(button.textContent));
    if (isEnable && !$('#autoRefreshM3uUrl').value.trim()) showTab('refresh');
  }, true);

  $('#guideStatus')?.addEventListener('click', () => {
    showTab('health');
    document.getElementById('sec-publish')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---- Step nav: scroll-spy ----------------------------------------------
  const navLinks = $$('#stepNav a');
  const sections = navLinks.map((link) => document.getElementById(link.dataset.step)).filter(Boolean);

  function updateActiveStep() {
    const line = window.innerHeight * 0.35;
    let current = sections[0];
    let currentTop = -Infinity;
    for (const section of sections) {
      const top = section.getBoundingClientRect().top;
      // Strictly greater: side-by-side cards share a top, and the first wins.
      if (top <= line && top > currentTop) {
        current = section;
        currentTop = top;
      }
    }
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (atBottom) current = sections[sections.length - 1];
    for (const link of navLinks) {
      const active = current && link.dataset.step === current.id;
      if (active) link.setAttribute('aria-current', 'step');
      else link.removeAttribute('aria-current');
    }
  }

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      updateActiveStep();
    });
  }, { passive: true });
  window.addEventListener('resize', updateActiveStep);
  updateActiveStep();

  // ---- Step nav: progress ticks ------------------------------------------
  const stats = $('#statsBar');
  const count = (id) => Number(($(`#${id}`)?.textContent || '').match(/\d+/)?.[0] || 0);

  function updateProgress() {
    const loaded = !!stats && !stats.hidden && count('statTotal') > 0;
    document.body.classList.toggle('has-playlist', loaded);
    const linked = loaded && count('statGuide') + count('statLogo') > 0;
    const complete = loaded && count('statNone') === 0;
    const mark = (step, done) => $(`#stepNav a[data-step="${step}"]`)?.classList.toggle('is-done', done);
    mark('sec-load', loaded);
    mark('sec-link', complete || linked);
  }

  if (stats) {
    new MutationObserver(updateProgress).observe(stats, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true
    });
  }
  updateProgress();
})();
