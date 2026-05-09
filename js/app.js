// EtwWatcher frontend controller.
// Wires the snapshot picker, browse view, and diff view together.

import { loadManifest, loadSnapshot, loadSnapshotFromFile, getCachedSnapshot } from './parse.js';
import { diffSnapshots } from './diff.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let manifest = null;
const localSnapshots = []; // [{ key, label, osVersion, sourceName }]

const state = {
  browse: {
    snapshot: null,
    filters: { provider: '', description: '', keyword: '', template: '', schemaSource: 'all' },
    expanded: new Set(),
  },
  diff: {
    result: null,
    filters: { provider: '', description: '', keyword: '', template: '', schemaSource: 'all' },
    expanded: new Set(),
  },
};

// ---------- Bootstrap ----------

window.addEventListener('DOMContentLoaded', async () => {
  bindTabs();
  bindBrowseControls();
  bindDiffControls();
  bindUploadControls();

  try {
    manifest = await loadManifest();
    populateSnapshotPickers();
    await applyUrlState();
  } catch (err) {
    showError($('#manifest-error'), `Could not load snapshots/manifest.json: ${err.message}`);
  }
});

function bindTabs() {
  $$('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  $$('[data-tab]').forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('border-sky-400', active);
    btn.classList.toggle('text-slate-400', !active);
    btn.classList.toggle('border-transparent', !active);
  });
  $$('section[data-view]').forEach((sec) => {
    sec.hidden = sec.dataset.view !== name;
  });
  updateUrl();
}

function activeTab() {
  for (const sec of $$('section[data-view]')) {
    if (!sec.hidden) return sec.dataset.view;
  }
  return 'browse';
}

// ---------- URL state ----------

let _restoringFromUrl = false;

function updateUrl() {
  if (_restoringFromUrl) return;
  const view = activeTab();
  const params = new URLSearchParams();
  params.set('view', view);
  if (view === 'browse') {
    const snap = $('#browse-snapshot')?.value;
    if (snap) params.set('snap', snap);
    const f = state.browse.filters;
    if (f.provider) params.set('p', f.provider);
    if (f.description) params.set('d', f.description);
    if (f.keyword) params.set('k', f.keyword);
    if (f.template) params.set('t', f.template);
    if (f.schemaSource && f.schemaSource !== 'all') params.set('s', f.schemaSource);
  } else if (view === 'diff') {
    const a = $('#diff-a')?.value;
    const b = $('#diff-b')?.value;
    if (a) params.set('a', a);
    if (b) params.set('b', b);
    const f = state.diff.filters;
    if (f.provider) params.set('p', f.provider);
    if (f.description) params.set('d', f.description);
    if (f.keyword) params.set('k', f.keyword);
    if (f.template) params.set('t', f.template);
    if (f.schemaSource && f.schemaSource !== 'all') params.set('s', f.schemaSource);
  }
  const next = '#' + params.toString();
  if (window.location.hash !== next) {
    history.replaceState(null, '', next);
  }
}

async function applyUrlState() {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return;
  const params = new URLSearchParams(raw);
  const view = params.get('view');
  if (!view) return;

  _restoringFromUrl = true;
  try {
    switchTab(view);

    if (view === 'browse') {
      const filters = state.browse.filters;
      filters.provider = params.get('p') ?? '';
      filters.description = params.get('d') ?? '';
      filters.keyword = params.get('k') ?? '';
      filters.template = params.get('t') ?? '';
      const sParam = (params.get('s') ?? 'all').toLowerCase();
      filters.schemaSource = ['manifest', 'mof', 'tracelogging', 'all'].includes(sParam) ? sParam : 'all';
      $('#filter-provider').value = filters.provider;
      $('#filter-description').value = filters.description;
      $('#filter-keyword').value = filters.keyword;
      $('#filter-template').value = filters.template;
      paintSchemaToggle('browse', filters.schemaSource);

      const snap = params.get('snap');
      if (snap && snap !== 'local:' && optionExists('#browse-snapshot', snap)) {
        $('#browse-snapshot').value = snap;
        await loadBrowseSnapshot();
      } else {
        renderBrowseList();
      }
    } else if (view === 'diff') {
      const filters = state.diff.filters;
      filters.provider = params.get('p') ?? '';
      filters.description = params.get('d') ?? '';
      filters.keyword = params.get('k') ?? '';
      filters.template = params.get('t') ?? '';
      const sParam = (params.get('s') ?? 'all').toLowerCase();
      filters.schemaSource = ['manifest', 'mof', 'tracelogging', 'all'].includes(sParam) ? sParam : 'all';
      $('#diff-filter-provider').value = filters.provider;
      $('#diff-filter-description').value = filters.description;
      $('#diff-filter-keyword').value = filters.keyword;
      $('#diff-filter-template').value = filters.template;
      paintSchemaToggle('diff', filters.schemaSource);

      const a = params.get('a');
      const b = params.get('b');
      if (a && optionExists('#diff-a', a)) $('#diff-a').value = a;
      if (b && optionExists('#diff-b', b)) $('#diff-b').value = b;
      // Auto-run if both A and B are valid bundled snapshots and differ
      const aOk = a && !a.startsWith('local:') && optionExists('#diff-a', a);
      const bOk = b && !b.startsWith('local:') && optionExists('#diff-b', b);
      if (aOk && bOk && a !== b) {
        await runDiff();
      }
    }
  } finally {
    _restoringFromUrl = false;
  }
}

function optionExists(selectSel, value) {
  const sel = $(selectSel);
  if (!sel) return false;
  return [...sel.options].some((o) => o.value === value);
}

function populateSnapshotPickers() {
  const bundled = (manifest?.snapshots ?? []).map(
    (s) => `<option value="${escapeAttr(s.file)}">${escapeHtml(decoratedLabel(s.label, s.osVersion))}</option>`,
  );
  const local = localSnapshots.map(
    (s) => `<option value="${escapeAttr(s.key)}">${escapeHtml(`[Local] ${decoratedLabel(s.sourceName, s.osVersion)}`)}</option>`,
  );
  const optsHtml = [...bundled, ...local].join('');

  for (const id of ['#browse-snapshot', '#diff-a', '#diff-b']) {
    const sel = $(id);
    const prevValue = sel.value;
    sel.innerHTML = optsHtml;
    if (prevValue && [...sel.options].some((o) => o.value === prevValue)) {
      sel.value = prevValue;
    }
  }

  // Default diff B to a different option than A
  if (!$('#diff-b').value || $('#diff-a').value === $('#diff-b').value) {
    const total = $('#diff-b').options.length;
    if (total >= 2) $('#diff-b').selectedIndex = 1;
  }
}

// ---------- Upload (BYO snapshots) ----------

function bindUploadControls() {
  const zone = $('#upload-zone');
  const input = $('#upload-input');

  input.addEventListener('change', (e) => handleFiles(e.target.files));

  // Drag & drop
  ['dragenter', 'dragover'].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add('border-sky-500', 'bg-slate-900/50');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('border-sky-500', 'bg-slate-900/50');
    });
  });
  zone.addEventListener('drop', (e) => {
    handleFiles(e.dataTransfer?.files);
  });
}

async function handleFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const status = $('#upload-status');
  for (const file of fileList) {
    status.classList.remove('text-red-400');
    status.textContent = `Parsing ${file.name}...`;
    try {
      const snap = await loadSnapshotFromFile(file, (p) => {
        if (p.done) return;
        const pct = p.total > 0 ? ` ${((p.bytesRead / p.total) * 100).toFixed(0)}%` : '';
        status.textContent = `Parsing ${file.name}...${pct} (${p.providers} providers)`;
      });

      // Replace any existing entry under the same key, otherwise append
      const idx = localSnapshots.findIndex((s) => s.key === snap.file);
      const entry = {
        key: snap.file,
        sourceName: snap.sourceName,
        osVersion: snap.osVersion,
        label: snap.sourceName,
      };
      if (idx >= 0) localSnapshots[idx] = entry;
      else localSnapshots.push(entry);

      status.textContent = `Loaded ${file.name} (${snap.providers.length} providers, OS ${snap.osVersion})`;
      populateSnapshotPickers();
      renderUploadList();
    } catch (err) {
      showError(status, `${file.name}: ${err.message}`);
      return;
    }
  }
}

function renderUploadList() {
  const list = $('#upload-list');
  if (localSnapshots.length === 0) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = localSnapshots
    .map(
      (s) => `
        <span class="inline-flex items-center gap-2 bg-slate-900 border border-slate-700 rounded px-2 py-1">
          <span class="text-slate-300 font-mono">${escapeHtml(s.sourceName)}</span>
          <span class="text-slate-500">${escapeHtml(s.osVersion)}</span>
          <button data-remove-local="${escapeAttr(s.key)}" class="text-slate-500 hover:text-rose-400 ml-1">&times;</button>
        </span>`,
    )
    .join('');
  list.querySelectorAll('[data-remove-local]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.removeLocal;
      const idx = localSnapshots.findIndex((s) => s.key === key);
      if (idx >= 0) localSnapshots.splice(idx, 1);
      populateSnapshotPickers();
      renderUploadList();
    });
  });
}

// ---------- Browse view ----------

function bindBrowseControls() {
  $('#browse-snapshot').addEventListener('change', loadBrowseSnapshot);
  $('#browse-load').addEventListener('click', loadBrowseSnapshot);

  for (const [id, key] of [
    ['#filter-provider', 'provider'],
    ['#filter-description', 'description'],
    ['#filter-keyword', 'keyword'],
    ['#filter-template', 'template'],
  ]) {
    $(id).addEventListener('input', (e) => {
      state.browse.filters[key] = e.target.value;
      renderBrowseList();
      updateUrl();
    });
  }

  $('#filter-clear').addEventListener('click', () => {
    state.browse.filters = { provider: '', description: '', keyword: '', template: '', schemaSource: 'all' };
    for (const id of ['#filter-provider', '#filter-description', '#filter-keyword', '#filter-template']) {
      $(id).value = '';
    }
    paintSchemaToggle('browse', 'all');
    renderBrowseList();
    updateUrl();
  });

  $$('[data-schema-browse]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.browse.filters.schemaSource = btn.dataset.schemaBrowse;
      paintSchemaToggle('browse', btn.dataset.schemaBrowse);
      renderBrowseList();
      updateUrl();
    });
  });
  paintSchemaToggle('browse', state.browse.filters.schemaSource);
}

// Resolves a snapshot picker value to a snapshot object. Bundled keys are
// fetched via loadSnapshot; local keys (`local:<filename>`) come from the
// parser cache (uploaded earlier).
async function resolveSnapshot(key, onProgress) {
  if (key.startsWith('local:')) {
    const cached = getCachedSnapshot(key);
    if (!cached) {
      throw new Error('That local snapshot is no longer in memory. Re-upload it.');
    }
    onProgress?.({ done: true, fromCache: true });
    return cached;
  }
  return loadSnapshot(key, onProgress);
}

async function loadBrowseSnapshot() {
  const key = $('#browse-snapshot').value;
  if (!key) return;
  const progress = $('#browse-progress');
  showProgress(progress, 0, 'Loading...');
  try {
    const snap = await resolveSnapshot(key, (p) => {
      if (p.done) {
        showProgress(progress, 100, p.fromCache ? 'Loaded (cached)' : 'Loaded');
      } else if (p.total > 0) {
        showProgress(progress, (p.bytesRead / p.total) * 100, `${formatBytes(p.bytesRead)} / ${formatBytes(p.total)} - ${p.providers} providers`);
      } else {
        showProgress(progress, 0, `${formatBytes(p.bytesRead)} - ${p.providers} providers`);
      }
    });
    state.browse.snapshot = snap;
    state.browse.expanded.clear();
    $('#browse-meta').textContent = snapshotSummaryLine(snap);
    renderBrowseList();
    updateUrl();
  } catch (err) {
    showProgress(progress, 0, `Error: ${err.message}`);
  }
}

function renderBrowseList() {
  const snap = state.browse.snapshot;
  const out = $('#browse-results');
  if (!snap) {
    out.innerHTML = '';
    return;
  }

  const f = normalizeFilters(state.browse.filters);
  const matches = anyFilterActive(f)
    ? snap.providers.filter((p) => providerMatchesFilters(p, f))
    : snap.providers;

  $('#browse-count').textContent = `${matches.length} / ${snap.providers.length}`;

  const rows = matches.slice(0, 500).map((p, i) => providerRowHtml(p, i, state.browse.expanded, f));
  out.innerHTML = rows.join('');
  if (matches.length > 500) {
    out.insertAdjacentHTML('beforeend', `<p class="text-slate-500 text-sm mt-2">Showing first 500 of ${matches.length}. Refine the filter to narrow results.</p>`);
  }

  out.querySelectorAll('[data-toggle-provider]').forEach((row) => {
    row.addEventListener('click', () => {
      const guid = row.dataset.toggleProvider;
      if (state.browse.expanded.has(guid)) state.browse.expanded.delete(guid);
      else state.browse.expanded.add(guid);
      renderBrowseList();
    });
  });
}

function normalizeFilters(filters) {
  return {
    provider: filters.provider.trim().toLowerCase(),
    description: filters.description.trim().toLowerCase(),
    keyword: filters.keyword.trim().toLowerCase(),
    template: filters.template.trim().toLowerCase(),
    schemaSource: (filters.schemaSource ?? 'all').toLowerCase(),
  };
}

function anyFilterActive(f) {
  return !!(f.provider || f.description || f.keyword || f.template
    || (f.schemaSource && f.schemaSource !== 'all'));
}

// All non-empty filters must match (AND). Within a single filter input,
// the substring is OR'd across the relevant fields. The provider filter
// applies to the provider record; description/keyword/template are
// event-level filters and require at least one event to match.
function providerMatchesFilters(p, f) {
  if (f.schemaSource && f.schemaSource !== 'all') {
    if ((p.SchemaSource ?? '').toLowerCase() !== f.schemaSource) return false;
  }
  if (f.provider && !matchesProvider(p, f.provider)) return false;
  if (anyEventFilterActive(f) && !matchesAnyEvent(p, (e) => eventMatchesFilters(e, f))) {
    return false;
  }
  return true;
}

function matchesProvider(p, needle) {
  return includes(p.ProviderName, needle)
      || includes(p.ProviderGuid, needle)
      || includes(p.ResourceFilePath, needle);
}

// Event-level filters: each must independently match this event.
function eventMatchesFilters(e, f) {
  if (f.description && !includes(e.Description, f.description)) return false;
  if (f.keyword && !eventHasKeyword(e, f.keyword)) return false;
  if (f.template && !includes(e.Template, f.template)) return false;
  return true;
}

function eventHasKeyword(e, needle) {
  for (const kn of e.KeywordNames ?? []) {
    if (includes(kn, needle)) return true;
  }
  return false;
}

function anyEventFilterActive(f) {
  return !!(f.description || f.keyword || f.template);
}

function matchesAnyEvent(p, predicate) {
  for (const e of p.Events ?? []) if (predicate(e)) return true;
  return false;
}

function includes(haystack, needleLower) {
  if (!haystack) return false;
  return String(haystack).toLowerCase().includes(needleLower);
}

// Diff-specific filtering helpers. Added/Removed providers are full
// ProviderSnapshot objects (uppercase keys), so providerMatchesFilters
// works directly. Changed providers are ProviderDiff objects with their
// own field shape and split event lists.
function providerSnapshotMatchesDiff(p, f) {
  return providerMatchesFilters(p, f);
}

function providerDiffMatches(pd, f) {
  if (f.schemaSource && f.schemaSource !== 'all') {
    if ((pd.schemaSource ?? '').toLowerCase() !== f.schemaSource) return false;
  }
  if (f.provider) {
    if (!includes(pd.providerName, f.provider)
        && !includes(pd.providerGuid, f.provider)
        && !includes(pd.resourceFilePath, f.provider)) return false;
  }
  if (anyEventFilterActive(f)) {
    const someAdded = (pd.eventsAdded ?? []).some((e) => eventMatchesFilters(e, f));
    const someRemoved = (pd.eventsRemoved ?? []).some((e) => eventMatchesFilters(e, f));
    const someChanged = (pd.eventsChanged ?? []).some((ed) =>
      eventMatchesFilters(ed.a ?? {}, f) || eventMatchesFilters(ed.b ?? {}, f)
    );
    if (!someAdded && !someRemoved && !someChanged) return false;
  }
  return true;
}

function filterEventList(events, f) {
  if (!anyEventFilterActive(f)) return events ?? [];
  return (events ?? []).filter((e) => eventMatchesFilters(e, f));
}

function filterChangedEventList(eds, f) {
  if (!anyEventFilterActive(f)) return eds ?? [];
  return (eds ?? []).filter((ed) =>
    eventMatchesFilters(ed.a ?? {}, f) || eventMatchesFilters(ed.b ?? {}, f)
  );
}

function providerRowHtml(p, i, expandedSet, filters) {
  const guid = p.ProviderGuid;
  const expanded = expandedSet.has(guid);
  const totalEvents = (p.Events ?? []).length;
  const kwCount = (p.Keywords ?? []).length;

  const filteringEvents = filters && anyEventFilterActive(filters);
  const visibleEvents = filteringEvents
    ? (p.Events ?? []).filter((e) => eventMatchesFilters(e, filters))
    : (p.Events ?? []);

  const eventCountLabel = filteringEvents
    ? `${visibleEvents.length} / ${totalEvents} events`
    : `${totalEvents} events`;

  const head = `
    <div data-toggle-provider="${guid}" class="cursor-pointer px-4 py-3.5 hover:bg-slate-800/40 border-b border-slate-800 flex items-baseline gap-3 transition-colors">
      <span class="text-slate-600 w-4 text-center">${expanded ? '▾' : '▸'}</span>
      <div class="flex-1 min-w-0">
        <div class="text-base text-slate-100 truncate">${escapeHtml(p.ProviderName ?? '(no name)')}${copyBtn(p.ProviderName ?? '', 'provider name')}</div>
        <div class="text-sm text-slate-500 truncate mt-1"><span class="font-mono text-xs">${escapeHtml(guid)}</span>${copyBtn(guid, 'GUID')} <span class="text-slate-700">·</span> ${escapeHtml(p.SchemaSource ?? '')} <span class="text-slate-700">·</span> ${eventCountLabel} <span class="text-slate-700">·</span> ${kwCount} keywords</div>
      </div>
    </div>`;
  if (!expanded) return head;

  const path = providerSourcesHtml(p);
  const keywords = (p.Keywords ?? []).length === 0 ? '' : `
    <details class="mb-3">
      <summary class="text-xs text-slate-400 cursor-pointer hover:text-slate-200">${(p.Keywords ?? []).length} provider keyword(s) defined</summary>
      <table class="text-xs font-mono mt-2 w-full">
        ${(p.Keywords ?? []).map((k) => `<tr><td class="pr-4 text-slate-300">${escapeHtml(k.Name ?? '')}</td><td class="text-slate-500">0x${formatKeywordsHex(k.Value)}</td></tr>`).join('')}
      </table>
    </details>`;

  let events;
  if (visibleEvents.length === 0) {
    events = filteringEvents
      ? '<p class="text-slate-500 text-sm">No events match the active filter(s).</p>'
      : '<p class="text-slate-500 text-sm">No events.</p>';
  } else {
    const filterNote = filteringEvents
      ? `<div class="text-xs text-slate-500 mb-2">Showing ${visibleEvents.length} of ${totalEvents} event(s) matching active filters.</div>`
      : '';
    events = filterNote + `
      <table class="w-full text-sm">
        <thead class="text-xs text-slate-500 uppercase">
          <tr><th class="text-left py-1 pr-3 w-12">Id</th><th class="text-left pr-3 w-12">v</th><th class="text-left pr-3 w-16">Level</th><th class="text-left">Description</th></tr>
        </thead>
        <tbody>
          ${visibleEvents.map((e, j) => eventRowHtml(p, e, j)).join('')}
        </tbody>
      </table>`;
  }

  return head + `<div class="px-6 py-3 bg-slate-900/40 border-b border-slate-800">${path}${keywords}${events}</div>`;
}

function eventRowHtml(p, e, idx) {
  const desc = e.Description ?? '';
  const truncDesc = desc.length > 120 ? desc.slice(0, 117) + '…' : desc;
  return `
    <tr class="border-t border-slate-800/50">
      <td class="py-1 pr-3 font-mono text-slate-300 align-top">${e.Id}</td>
      <td class="pr-3 font-mono text-slate-500 align-top">${e.Version}</td>
      <td class="pr-3 font-mono text-slate-500 align-top">${e.Level}</td>
      <td class="text-slate-200 py-1">
        <details>
          <summary class="cursor-pointer hover:text-white">${escapeHtml(truncDesc) || '<span class="text-slate-600 italic">no description</span>'}</summary>
          ${eventDetailHtml(e)}
        </details>
      </td>
    </tr>`;
}

// Shared details block used by both the browse view's expanded event row
// and the diff view's added/removed event entries.
function eventDetailHtml(e) {
  const desc = e.Description ?? '';
  const keywordChips = (e.KeywordNames ?? []).map(
    (k) => `<span class="inline-block bg-slate-800 text-slate-300 text-xs px-1.5 py-0.5 rounded mr-1">${escapeHtml(k)}</span>`,
  ).join('');
  const template = e.Template
    ? `<details class="mt-2"><summary class="text-xs text-slate-400 cursor-pointer hover:text-slate-200">Template XML</summary><pre class="text-xs whitespace-pre-wrap text-slate-400 mt-1 font-mono">${escapeHtml(e.Template)}</pre></details>`
    : '';
  return `
    <div class="text-xs text-slate-400 mt-1 space-y-1">
      ${desc.length > 120 ? `<div class="whitespace-pre-wrap">${escapeHtml(desc)}</div>` : ''}
      <div><span class="text-slate-500">Opcode:</span> ${e.Opcode} <span class="text-slate-500 ml-3">Task:</span> ${e.Task} <span class="text-slate-500 ml-3">Keywords:</span> 0x${formatEventKeywordsHex(e.Keywords)}</div>
      ${keywordChips ? `<div>${keywordChips}</div>` : ''}
      ${template}
    </div>`;
}

// ---------- Diff view ----------

function bindDiffControls() {
  $('#diff-run').addEventListener('click', runDiff);

  for (const [id, key] of [
    ['#diff-filter-provider', 'provider'],
    ['#diff-filter-description', 'description'],
    ['#diff-filter-keyword', 'keyword'],
    ['#diff-filter-template', 'template'],
  ]) {
    $(id).addEventListener('input', (e) => {
      state.diff.filters[key] = e.target.value;
      if (state.diff.result) renderDiff();
      updateUrl();
    });
  }

  $('#diff-filter-clear').addEventListener('click', () => {
    state.diff.filters = { provider: '', description: '', keyword: '', template: '', schemaSource: 'all' };
    for (const id of ['#diff-filter-provider', '#diff-filter-description', '#diff-filter-keyword', '#diff-filter-template']) {
      $(id).value = '';
    }
    paintSchemaToggle('diff', 'all');
    if (state.diff.result) renderDiff();
    updateUrl();
  });

  $$('[data-schema-diff]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.diff.filters.schemaSource = btn.dataset.schemaDiff;
      paintSchemaToggle('diff', btn.dataset.schemaDiff);
      if (state.diff.result) renderDiff();
      updateUrl();
    });
  });
  paintSchemaToggle('diff', state.diff.filters.schemaSource);

  $('#diff-a').addEventListener('change', updateUrl);
  $('#diff-b').addEventListener('change', updateUrl);
}

function paintSchemaToggle(view, value) {
  const attr = view === 'browse' ? 'data-schema-browse' : 'data-schema-diff';
  $$(`[${attr}]`).forEach((btn) => {
    const active = btn.getAttribute(attr) === value;
    btn.classList.toggle('bg-slate-700', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('text-slate-400', !active);
    btn.classList.toggle('hover:text-white', !active);
  });
}

async function runDiff() {
  const aFile = $('#diff-a').value;
  const bFile = $('#diff-b').value;
  if (!aFile || !bFile) return;
  if (aFile === bFile) {
    showError($('#diff-status'), 'A and B are the same snapshot.');
    return;
  }
  const status = $('#diff-status');
  status.textContent = 'Loading snapshots...';
  status.classList.remove('text-red-400');
  $('#diff-results').innerHTML = skeletonDiffHtml();

  try {
    const [snapA, snapB] = await Promise.all([
      resolveSnapshot(aFile),
      resolveSnapshot(bFile),
    ]);
    status.textContent = 'Computing diff...';
    const result = diffSnapshots(snapA, snapB);
    state.diff.result = result;
    state.diff.expanded.clear();
    status.textContent = '';
    renderDiff();
    updateUrl();
  } catch (err) {
    $('#diff-results').innerHTML = '';
    showError(status, `Error: ${err.message}`);
  }
}

function renderDiff() {
  const r = state.diff.result;
  const out = $('#diff-results');
  if (!r) {
    out.innerHTML = '';
    return;
  }

  const f = normalizeFilters(state.diff.filters);
  const evtActive = anyEventFilterActive(f);

  // For Added / Removed (full ProviderSnapshot objects)
  const added = r.providersAdded.filter((p) => providerSnapshotMatchesDiff(p, f));
  const removed = r.providersRemoved.filter((p) => providerSnapshotMatchesDiff(p, f));
  // For Changed (ProviderDiff objects)
  const changed = r.providersChanged.filter((pd) => providerDiffMatches(pd, f));

  const eventsAddedTotal = added.reduce((n, p) => n + filterEventList(p.Events, f).length, 0)
                         + changed.reduce((n, p) => n + filterEventList(p.eventsAdded, f).length, 0);
  const eventsRemovedTotal = removed.reduce((n, p) => n + filterEventList(p.Events, f).length, 0)
                           + changed.reduce((n, p) => n + filterEventList(p.eventsRemoved, f).length, 0);
  const eventsChangedTotal = changed.reduce((n, p) => n + filterChangedEventList(p.eventsChanged, f).length, 0);

  const iconPlus  = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
  const iconMinus = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>';
  const iconTilde = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13c0-3 2-5 4-5s3 2 5 2 4-2 4-2 2-2 5-2"/></svg>';

  const summary = `
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      <div class="bg-slate-900 border border-slate-800 rounded-md px-3 py-2.5">
        <div class="text-slate-500 text-xs uppercase tracking-wide">Snapshot A</div>
        <div class="font-mono text-slate-200 text-base mt-1">${escapeHtml(r.osVersionA)}</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-md px-3 py-2.5">
        <div class="text-slate-500 text-xs uppercase tracking-wide">Snapshot B</div>
        <div class="font-mono text-slate-200 text-base mt-1">${escapeHtml(r.osVersionB)}</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-md px-3 py-2.5">
        <div class="flex items-center gap-1.5 text-emerald-400 text-xs uppercase tracking-wide">${iconPlus}<span>Added</span></div>
        <div class="text-emerald-300 text-base mt-1">${added.length} <span class="text-slate-500 text-sm">providers</span></div>
        <div class="text-emerald-300/80 text-sm">${eventsAddedTotal} <span class="text-slate-500">events</span></div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-md px-3 py-2.5">
        <div class="flex items-center gap-1.5 text-amber-400 text-xs uppercase tracking-wide">${iconTilde}<span>Changed</span></div>
        <div class="text-amber-300 text-base mt-1">${changed.length} <span class="text-slate-500 text-sm">providers</span></div>
        <div class="text-amber-300/80 text-sm">${eventsChangedTotal} <span class="text-slate-500">events</span></div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-md px-3 py-2.5">
        <div class="flex items-center gap-1.5 text-rose-400 text-xs uppercase tracking-wide">${iconMinus}<span>Removed</span></div>
        <div class="text-rose-300 text-base mt-1">${removed.length} <span class="text-slate-500 text-sm">providers</span></div>
        <div class="text-rose-300/80 text-sm">${eventsRemovedTotal} <span class="text-slate-500">events</span></div>
      </div>
    </div>`;

  const addedSection = sectionHtml('Providers added (only in B)', 'emerald', added.map((p) => addedRemovedRowHtml(p, 'emerald', state.diff.expanded, f)).join(''), added.length);
  const changedSection = sectionHtml('Providers changed', 'amber', changed.map((p) => changedProviderRowHtml(p, state.diff.expanded, f)).join(''), changed.length);
  const removedSection = sectionHtml('Providers removed (only in A)', 'rose', removed.map((p) => addedRemovedRowHtml(p, 'rose', state.diff.expanded, f)).join(''), removed.length);

  out.innerHTML = summary + addedSection + changedSection + removedSection;

  out.querySelectorAll('[data-toggle-diff-provider]').forEach((row) => {
    row.addEventListener('click', () => {
      const g = row.dataset.toggleDiffProvider;
      if (state.diff.expanded.has(g)) state.diff.expanded.delete(g);
      else state.diff.expanded.add(g);
      renderDiff();
    });
  });
}

function skeletonDiffHtml() {
  const row = `
    <div class="flex items-center gap-3 px-4 py-3 border-b border-slate-800/50 last:border-0">
      <div class="w-3 h-3 skeleton"></div>
      <div class="w-3 h-3 skeleton opacity-70"></div>
      <div class="flex-1">
        <div class="h-4 w-1/3 skeleton mb-1.5"></div>
        <div class="h-3 w-2/3 skeleton opacity-70"></div>
      </div>
    </div>`;
  const cards = Array(5).fill('<div class="h-16 skeleton rounded-md"></div>').join('');
  return `
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">${cards}</div>
    <div class="mt-6">
      <div class="flex items-center gap-3 mb-3">
        <div class="w-1 h-5 rounded-full skeleton"></div>
        <div class="h-4 w-48 skeleton"></div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-md overflow-hidden">
        ${row.repeat(4)}
      </div>
    </div>`;
}

function sectionHtml(title, color, body, count) {
  if (!body) return '';
  const countBadge = count != null
    ? `<span class="text-slate-500 font-normal text-sm ml-2">${count}</span>`
    : '';
  return `
    <div class="mt-6 first:mt-0 mb-4">
      <div class="flex items-center gap-3 mb-3">
        <div class="w-1.5 h-6 bg-gradient-to-b from-${color}-400 to-${color}-600 rounded-full"></div>
        <h3 class="text-${color}-300 font-medium text-base">${title}${countBadge}</h3>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-md overflow-hidden">${body}</div>
    </div>`;
}

function addedRemovedRowHtml(p, color, expandedSet, f) {
  const sign = color === 'emerald' ? '+' : '−';
  const guid = p.ProviderGuid ?? '';
  const expanded = expandedSet.has(guid);
  const totalEvents = (p.Events ?? []).length;
  const evtActive = f && anyEventFilterActive(f);
  const visibleEvents = evtActive ? filterEventList(p.Events, f) : (p.Events ?? []);
  const eventCountLabel = evtActive
    ? `${visibleEvents.length} / ${totalEvents} events`
    : `${totalEvents} events`;

  const head = `
    <div data-toggle-diff-provider="${escapeAttr(guid)}" class="cursor-pointer px-4 py-3.5 hover:bg-slate-800/40 border-b border-slate-800/50 last:border-0 flex items-baseline gap-3 transition-colors">
      <span class="text-slate-600 w-4 text-center">${expanded ? '▾' : '▸'}</span>
      <span class="text-${color}-400 w-4 text-center font-mono">${sign}</span>
      <div class="flex-1 min-w-0">
        <div class="text-base text-slate-100 truncate">${escapeHtml(p.ProviderName ?? '(no name)')}${copyBtn(p.ProviderName ?? '', 'provider name')}</div>
        <div class="text-sm text-slate-500 truncate mt-1"><span class="font-mono text-xs">${escapeHtml(guid)}</span>${copyBtn(guid, 'GUID')} <span class="text-slate-700">·</span> ${escapeHtml(p.SchemaSource ?? '')} <span class="text-slate-700">·</span> ${eventCountLabel}</div>
      </div>
    </div>`;

  if (!expanded) return head;
  let body;
  if (visibleEvents.length === 0) {
    body = evtActive
      ? '<p class="text-slate-500 text-sm">No events match the active filter(s).</p>'
      : '<p class="text-slate-500 text-sm">No events.</p>';
  } else {
    body = diffEventListHtml(visibleEvents, color);
  }
  return head + `<div class="px-6 py-3 bg-slate-950/60 border-b border-slate-800/50">${body}</div>`;
}

function changedProviderRowHtml(pd, expandedSet, f) {
  const expanded = expandedSet.has(pd.providerGuid);
  const evtActive = f && anyEventFilterActive(f);
  const eventsAdded = evtActive ? filterEventList(pd.eventsAdded, f) : pd.eventsAdded;
  const eventsRemoved = evtActive ? filterEventList(pd.eventsRemoved, f) : pd.eventsRemoved;
  const eventsChanged = evtActive ? filterChangedEventList(pd.eventsChanged, f) : pd.eventsChanged;

  const counts = [
    eventsAdded.length ? `<span class="text-emerald-400">+${eventsAdded.length}</span>` : '',
    eventsRemoved.length ? `<span class="text-rose-400">−${eventsRemoved.length}</span>` : '',
    eventsChanged.length ? `<span class="text-amber-400">~${eventsChanged.length}</span>` : '',
    pd.providerFieldsChanged.length ? `<span class="text-sky-400">⚙${pd.providerFieldsChanged.length}</span>` : '',
  ].filter(Boolean).join(' ');

  const head = `
    <div data-toggle-diff-provider="${escapeAttr(pd.providerGuid)}" class="cursor-pointer px-4 py-3.5 hover:bg-slate-800/40 border-b border-slate-800/50 flex items-baseline gap-3 transition-colors">
      <span class="text-slate-600 w-4 text-center">${expanded ? '▾' : '▸'}</span>
      <span class="text-amber-400 w-4 text-center font-mono">~</span>
      <div class="flex-1 min-w-0">
        <div class="text-base text-slate-100 truncate">${escapeHtml(pd.providerName ?? '(no name)')}${copyBtn(pd.providerName ?? '', 'provider name')}</div>
        <div class="text-sm text-slate-500 truncate mt-1"><span class="font-mono text-xs">${escapeHtml(pd.providerGuid)}</span>${copyBtn(pd.providerGuid ?? '', 'GUID')}</div>
      </div>
      <div class="text-sm font-mono">${counts}</div>
    </div>`;

  if (!expanded) return head;

  const fieldsBlock = pd.providerFieldsChanged.length === 0 ? '' : `
    <div class="mb-3">
      <div class="text-xs text-sky-400 font-medium mb-1">Provider field changes</div>
      <table class="text-xs font-mono w-full">
        <thead><tr class="text-slate-500"><th class="text-left pr-3 w-32">Field</th><th class="text-left pr-3">A</th><th class="text-left">B</th></tr></thead>
        <tbody>
          ${pd.providerFieldsChanged.map((c) => `<tr><td class="pr-3 text-slate-300">${escapeHtml(c.field)}</td><td class="pr-3 text-rose-300">${escapeHtml(String(c.a ?? ''))}</td><td class="text-emerald-300">${escapeHtml(String(c.b ?? ''))}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const eventsAddedBlock = eventsAdded.length === 0 ? '' : `
    <div class="mb-3">
      <div class="text-xs text-emerald-400 font-medium mb-1">${eventsAdded.length} event(s) added${evtActive && eventsAdded.length !== pd.eventsAdded.length ? ` (filtered from ${pd.eventsAdded.length})` : ''}</div>
      ${diffEventListHtml(eventsAdded, 'emerald')}
    </div>`;

  const eventsRemovedBlock = eventsRemoved.length === 0 ? '' : `
    <div class="mb-3">
      <div class="text-xs text-rose-400 font-medium mb-1">${eventsRemoved.length} event(s) removed${evtActive && eventsRemoved.length !== pd.eventsRemoved.length ? ` (filtered from ${pd.eventsRemoved.length})` : ''}</div>
      ${diffEventListHtml(eventsRemoved, 'rose')}
    </div>`;

  const eventsChangedBlock = eventsChanged.length === 0 ? '' : `
    <div class="mb-3">
      <div class="text-xs text-amber-400 font-medium mb-1">${eventsChanged.length} event(s) changed${evtActive && eventsChanged.length !== pd.eventsChanged.length ? ` (filtered from ${pd.eventsChanged.length})` : ''}</div>
      ${eventsChanged.map(diffEventChangedHtml).join('')}
    </div>`;

  return head + `<div class="px-6 py-3 bg-slate-950/60 border-b border-slate-800/50">${fieldsBlock}${eventsAddedBlock}${eventsRemovedBlock}${eventsChangedBlock}</div>`;
}

function diffEventListHtml(events, color) {
  return `<table class="w-full text-sm">
    <thead class="text-xs text-slate-500 uppercase">
      <tr>
        <th class="text-left py-1 pr-3 w-12">Id</th>
        <th class="text-left pr-3 w-10">v</th>
        <th class="text-left pr-3 w-12">Level</th>
        <th class="text-left">Description</th>
      </tr>
    </thead>
    <tbody>
      ${events.map((e) => diffEventRowHtml(e, color)).join('')}
    </tbody>
  </table>`;
}

function diffEventRowHtml(e, color) {
  const desc = e.Description ?? '';
  const truncDesc = desc.length > 120 ? desc.slice(0, 117) + '…' : desc;
  return `
    <tr class="border-t border-slate-800/50">
      <td class="py-1 pr-3 font-mono text-${color}-300 align-top">${e.Id}</td>
      <td class="pr-3 font-mono text-slate-500 align-top">${e.Version}</td>
      <td class="pr-3 font-mono text-slate-500 align-top">${e.Level}</td>
      <td class="text-slate-200 py-1">
        <details>
          <summary class="cursor-pointer hover:text-white">${escapeHtml(truncDesc) || '<span class="text-slate-600 italic">no description</span>'}</summary>
          ${eventDetailHtml(e)}
        </details>
      </td>
    </tr>`;
}

// Fields that often contain long, multi-line strings; these get full-width
// stacked panels with a line-diff. Everything else stays in a compact table.
const LONG_TEXT_FIELDS = new Set(['Description', 'Template', 'KeywordNames', 'ResourceFilePath']);

function diffEventChangedHtml(ed) {
  const scalarChanges = ed.changes.filter((c) => !isLongTextChange(c));
  const longChanges = ed.changes.filter((c) => isLongTextChange(c));

  const scalars = scalarChanges.length === 0 ? '' : `
    <table class="text-xs font-mono w-full mb-3">
      <thead><tr class="text-slate-500">
        <th class="text-left pr-3 w-32">Field</th>
        <th class="text-left pr-3">A</th>
        <th class="text-left">B</th>
      </tr></thead>
      <tbody>
        ${scalarChanges.map((c) => `
          <tr>
            <td class="pr-3 text-slate-300 align-top">${escapeHtml(c.field)}</td>
            <td class="pr-3 text-rose-300 align-top whitespace-pre-wrap break-all">${escapeHtml(String(c.a ?? ''))}</td>
            <td class="text-emerald-300 align-top whitespace-pre-wrap break-all">${escapeHtml(String(c.b ?? ''))}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  const longs = longChanges.map(longTextChangePanelHtml).join('');

  return `
    <div class="border border-slate-800 rounded p-3 mb-3 bg-slate-900/40">
      <div class="text-xs text-amber-300 font-mono mb-2">Id ${ed.id} v${ed.version}</div>
      ${scalars}
      ${longs}
    </div>`;
}

function isLongTextChange(c) {
  if (LONG_TEXT_FIELDS.has(c.field)) return true;
  const a = String(c.a ?? '');
  const b = String(c.b ?? '');
  if (a.length > 80 || b.length > 80) return true;
  if (a.includes('\n') || b.includes('\n')) return true;
  return false;
}

function longTextChangePanelHtml(c) {
  const a = c.a == null ? '' : String(c.a);
  const b = c.b == null ? '' : String(c.b);
  const linesA = a.length === 0 ? [] : a.split('\n');
  const linesB = b.length === 0 ? [] : b.split('\n');
  const ops = lcsLineDiff(linesA, linesB);

  const body = ops.map(diffOpHtml).join('');

  return `
    <div class="mb-3 last:mb-0">
      <div class="text-xs text-amber-300 font-medium mb-1">${escapeHtml(c.field)}</div>
      <div class="border border-slate-800 rounded bg-slate-950 font-mono text-xs leading-relaxed overflow-x-auto">
        ${body || '<div class="px-3 py-2 text-slate-600">(no content)</div>'}
      </div>
    </div>`;
}

function diffOpHtml(op) {
  const cls = op.type === 'add'
    ? 'bg-emerald-500/10 text-emerald-200 border-l-2 border-emerald-500/60'
    : op.type === 'remove'
    ? 'bg-rose-500/10 text-rose-200 border-l-2 border-rose-500/60'
    : 'text-slate-400 border-l-2 border-transparent';
  const sigil = op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' ';
  return `<div class="${cls} px-2 whitespace-pre-wrap break-all"><span class="inline-block w-4 text-slate-500 select-none">${sigil}</span>${escapeHtml(op.text) || '&nbsp;'}</div>`;
}

// LCS-based line diff. Returns an array of { type: 'common' | 'add' | 'remove', text }.
// Suitable for ETW Description / Template content (small enough that O(m*n) is fine).
function lcsLineDiff(a, b) {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[0..i] vs b[0..j]
  const dp = Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Int32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ type: 'common', text: a[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: 'remove', text: a[i - 1] });
      i--;
    } else {
      ops.push({ type: 'add', text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) { ops.push({ type: 'remove', text: a[i - 1] }); i--; }
  while (j > 0) { ops.push({ type: 'add', text: b[j - 1] }); j--; }
  ops.reverse();
  return ops;
}

// ---------- Helpers ----------

function showProgress(el, pct, label) {
  el.innerHTML = `
    <div class="w-full bg-slate-800 rounded h-1.5 overflow-hidden">
      <div class="bg-sky-500 h-full transition-all" style="width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%"></div>
    </div>
    <div class="text-xs text-slate-500 mt-1">${escapeHtml(label)}</div>`;
}

function showError(el, message) {
  el.textContent = message;
  el.classList.add('text-red-400');
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ETW keyword bitmasks are 64-bit unsigned, but EtwInspector serializes them
// from C# `long` (signed Int64). High-bit keywords come across the wire as
// negative numbers, so plain .toString(16) renders them as e.g.
// "-8000000000000000" instead of the correct unsigned hex. Mask to 64 bits
// via BigInt to recover the on-the-wire ULONGLONG representation.
function formatKeywordsHex(v) {
  if (v == null) return '0';
  let n;
  try {
    n = typeof v === 'bigint' ? v : BigInt(v);
  } catch {
    return String(v);
  }
  if (n < 0n) n += 1n << 64n;
  return n.toString(16);
}

// Per-event keyword masks always carry the top 16 Microsoft-reserved bits
// (bit 63 MICROSOFT_KEYWORD_RESERVED, bits 48-62 WINEVENT_KEYWORD_*: AUDIT_*,
// CLASSIC_EVENTLOG, CORRELATION_HINT, WDI_*, etc.) - the OS OR's these in
// at registration time, so otherwise every Threat-Intelligence event would
// render as 0x8000000000000004 instead of the user-meaningful 0x4. Strip
// them so the displayed hex matches the provider's keyword table and the
// KeywordNames chips below.
function formatEventKeywordsHex(v) {
  if (v == null) return '0';
  let n;
  try {
    n = typeof v === 'bigint' ? v : BigInt(v);
  } catch {
    return String(v);
  }
  if (n < 0n) n += 1n << 64n;
  n &= 0x0000FFFFFFFFFFFFn;
  return n.toString(16);
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function copyBtn(value, label) {
  if (!value) return '';
  return `<button type="button" data-copy="${escapeAttr(value)}" title="Copy ${escapeAttr(label)}" class="ml-1 text-slate-600 hover:text-sky-400 text-xs align-baseline" aria-label="Copy ${escapeAttr(label)}">&#x2398;</button>`;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  e.stopPropagation();
  e.preventDefault();
  const value = btn.dataset.copy;
  if (!value) return;
  copyToClipboard(value).then((ok) => {
    const orig = btn.textContent;
    if (ok) {
      btn.textContent = '✓';
      btn.classList.add('text-emerald-400');
    } else {
      btn.textContent = '✗';
      btn.classList.add('text-rose-400');
    }
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('text-emerald-400', 'text-rose-400');
    }, 1200);
  });
});

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // Fallback for older / file:// contexts
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Builds the dropdown label. If the human label already contains the
// OS version (e.g. "Build 10.0.26200.7171"), don't repeat it.
function decoratedLabel(label, osVersion) {
  const l = label ?? '';
  if (osVersion && !l.includes(osVersion)) {
    return `${l} (${osVersion})`;
  }
  return l;
}

// Renders the file-of-origin block for an expanded provider row. Manifest/MOF
// providers have a single ResourceFilePath; TraceLogging providers have a
// Sources[] array (the same provider can be embedded in multiple binaries).
function providerSourcesHtml(p) {
  const sources = Array.isArray(p.Sources) ? p.Sources : [];
  if (sources.length > 0) {
    const summary = sources.length === 1
      ? '1 source binary'
      : `${sources.length} source binaries`;
    const list = sources.map((s) => `<li class="font-mono">${escapeHtml(s)}</li>`).join('');
    return `
      <details class="mb-3">
        <summary class="text-xs text-slate-400 cursor-pointer hover:text-slate-200">${summary}</summary>
        <ul class="text-xs text-slate-300 mt-1 space-y-0.5 ml-4 list-disc">${list}</ul>
      </details>`;
  }
  if (p.ResourceFilePath) {
    return `<div class="text-xs text-slate-500 mb-3"><span class="text-slate-400">ResourceFilePath:</span> <span class="font-mono">${escapeHtml(p.ResourceFilePath)}</span></div>`;
  }
  return '';
}

function snapshotSummaryLine(snap) {
  const counts = new Map();
  for (const p of snap.providers ?? []) {
    const key = p.SchemaSource || 'Unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  const parts = [`${(snap.providers ?? []).length} providers`];
  if (breakdown) parts[0] += ` (${breakdown})`;
  parts.push(`OS ${snap.osVersion}`);
  return parts.join(' - ');
}
