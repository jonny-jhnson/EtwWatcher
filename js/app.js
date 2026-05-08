// EtwWatcher frontend controller.
// Wires the snapshot picker, browse view, and diff view together.

import { loadManifest, loadSnapshot, getCachedSnapshot } from './parse.js';
import { diffSnapshots } from './diff.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let manifest = null;

const state = {
  browse: { snapshot: null, filter: '', expanded: new Set() },
  diff: { result: null, expanded: new Set() },
};

// ---------- Bootstrap ----------

window.addEventListener('DOMContentLoaded', async () => {
  bindTabs();
  bindBrowseControls();
  bindDiffControls();

  try {
    manifest = await loadManifest();
    populateSnapshotPickers();
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
    btn.classList.toggle('bg-slate-800', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('text-slate-400', !active);
  });
  $$('section[data-view]').forEach((sec) => {
    sec.hidden = sec.dataset.view !== name;
  });
}

function populateSnapshotPickers() {
  const opts = manifest.snapshots.map(
    (s) => `<option value="${s.file}">${s.label} (${s.osVersion})</option>`,
  );
  for (const id of ['#browse-snapshot', '#diff-a', '#diff-b']) {
    $(id).innerHTML = opts.join('');
  }
  if (manifest.snapshots.length >= 2) {
    $('#diff-b').selectedIndex = 1;
  }
}

// ---------- Browse view ----------

function bindBrowseControls() {
  $('#browse-snapshot').addEventListener('change', loadBrowseSnapshot);
  $('#browse-load').addEventListener('click', loadBrowseSnapshot);

  $('#browse-filter').addEventListener('input', (e) => {
    state.browse.filter = e.target.value;
    renderBrowseList();
  });
}

async function loadBrowseSnapshot() {
  const file = $('#browse-snapshot').value;
  if (!file) return;
  const progress = $('#browse-progress');
  showProgress(progress, 0, 'Loading…');
  try {
    const snap = await loadSnapshot(file, (p) => {
      if (p.done) {
        showProgress(progress, 100, p.fromCache ? 'Loaded (cached)' : 'Loaded');
      } else if (p.total > 0) {
        showProgress(progress, (p.bytesRead / p.total) * 100, `${formatBytes(p.bytesRead)} / ${formatBytes(p.total)} • ${p.providers} providers`);
      } else {
        showProgress(progress, 0, `${formatBytes(p.bytesRead)} • ${p.providers} providers`);
      }
    });
    state.browse.snapshot = snap;
    state.browse.expanded.clear();
    $('#browse-meta').textContent = `${snap.providers.length} providers • OS ${snap.osVersion}`;
    renderBrowseList();
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
  const needle = state.browse.filter.trim().toLowerCase();
  const matches = needle
    ? snap.providers.filter((p) => providerMatchesFreeText(p, needle))
    : snap.providers;

  $('#browse-count').textContent = `${matches.length} / ${snap.providers.length}`;

  const rows = matches.slice(0, 500).map((p, i) => providerRowHtml(p, i, state.browse.expanded));
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

function providerMatchesFreeText(p, needle) {
  if ((p.ProviderName ?? '').toLowerCase().includes(needle)) return true;
  if ((p.ProviderGuid ?? '').toLowerCase().includes(needle)) return true;
  if ((p.ResourceFilePath ?? '').toLowerCase().includes(needle)) return true;
  for (const e of p.Events ?? []) {
    if ((e.Description ?? '').toLowerCase().includes(needle)) return true;
    for (const k of e.KeywordNames ?? []) {
      if (k.toLowerCase().includes(needle)) return true;
    }
  }
  for (const k of p.Keywords ?? []) {
    if ((k.Name ?? '').toLowerCase().includes(needle)) return true;
  }
  return false;
}

function providerRowHtml(p, i, expandedSet) {
  const guid = p.ProviderGuid;
  const expanded = expandedSet.has(guid);
  const eventCount = (p.Events ?? []).length;
  const kwCount = (p.Keywords ?? []).length;
  const head = `
    <div data-toggle-provider="${guid}" class="cursor-pointer p-3 hover:bg-slate-800/50 border-b border-slate-800 flex items-baseline gap-3">
      <span class="text-slate-500 w-4 text-center">${expanded ? '▾' : '▸'}</span>
      <div class="flex-1 min-w-0">
        <div class="font-mono text-sm text-slate-200 truncate">${escapeHtml(p.ProviderName ?? '(no name)')}</div>
        <div class="text-xs text-slate-500 truncate">${escapeHtml(guid)} • ${escapeHtml(p.SchemaSource ?? '')} • ${eventCount} events • ${kwCount} keywords</div>
      </div>
    </div>`;
  if (!expanded) return head;

  const path = p.ResourceFilePath ? `<div class="text-xs text-slate-500 mb-3"><span class="text-slate-400">ResourceFilePath:</span> <span class="font-mono">${escapeHtml(p.ResourceFilePath)}</span></div>` : '';
  const keywords = (p.Keywords ?? []).length === 0 ? '' : `
    <details class="mb-3">
      <summary class="text-xs text-slate-400 cursor-pointer hover:text-slate-200">${(p.Keywords ?? []).length} provider keyword(s)</summary>
      <table class="text-xs font-mono mt-2 w-full">
        ${(p.Keywords ?? []).map((k) => `<tr><td class="pr-4 text-slate-300">${escapeHtml(k.Name ?? '')}</td><td class="text-slate-500">0x${(k.Value ?? 0).toString(16)}</td></tr>`).join('')}
      </table>
    </details>`;

  const events = (p.Events ?? []).length === 0 ? '<p class="text-slate-500 text-sm">No events.</p>' : `
    <table class="w-full text-sm">
      <thead class="text-xs text-slate-500 uppercase">
        <tr><th class="text-left py-1 pr-3 w-12">Id</th><th class="text-left pr-3 w-12">v</th><th class="text-left pr-3 w-16">Level</th><th class="text-left">Description</th></tr>
      </thead>
      <tbody>
        ${(p.Events ?? []).map((e, j) => eventRowHtml(p, e, j)).join('')}
      </tbody>
    </table>`;

  return head + `<div class="px-6 py-3 bg-slate-900/40 border-b border-slate-800">${path}${keywords}${events}</div>`;
}

function eventRowHtml(p, e, idx) {
  const id = `${p.ProviderGuid}-${e.Id}-${e.Version}-${idx}`;
  const desc = e.Description ?? '';
  const truncDesc = desc.length > 120 ? desc.slice(0, 117) + '…' : desc;
  const keywordChips = (e.KeywordNames ?? []).map((k) => `<span class="inline-block bg-slate-800 text-slate-300 text-xs px-1.5 py-0.5 rounded mr-1">${escapeHtml(k)}</span>`).join('');
  const template = e.Template ? `<details class="mt-2"><summary class="text-xs text-slate-400 cursor-pointer hover:text-slate-200">Template XML</summary><pre class="text-xs whitespace-pre-wrap text-slate-400 mt-1 font-mono">${escapeHtml(e.Template)}</pre></details>` : '';
  return `
    <tr class="border-t border-slate-800/50">
      <td class="py-1 pr-3 font-mono text-slate-300 align-top">${e.Id}</td>
      <td class="pr-3 font-mono text-slate-500 align-top">${e.Version}</td>
      <td class="pr-3 font-mono text-slate-500 align-top">${e.Level}</td>
      <td class="text-slate-200 py-1">
        <details>
          <summary class="cursor-pointer hover:text-white">${escapeHtml(truncDesc) || '<span class="text-slate-600 italic">no description</span>'}</summary>
          <div class="text-xs text-slate-400 mt-1 space-y-1">
            ${desc.length > 120 ? `<div>${escapeHtml(desc)}</div>` : ''}
            <div><span class="text-slate-500">Opcode:</span> ${e.Opcode} <span class="text-slate-500 ml-3">Task:</span> ${e.Task} <span class="text-slate-500 ml-3">Keywords:</span> 0x${(e.Keywords ?? 0).toString(16)}</div>
            ${keywordChips ? `<div>${keywordChips}</div>` : ''}
            ${template}
          </div>
        </details>
      </td>
    </tr>`;
}

// ---------- Diff view ----------

function bindDiffControls() {
  $('#diff-run').addEventListener('click', runDiff);
  $('#diff-filter').addEventListener('input', () => {
    if (state.diff.result) renderDiff();
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
  status.textContent = 'Loading snapshots…';
  status.classList.remove('text-red-400');

  try {
    const [snapA, snapB] = await Promise.all([
      loadSnapshot(aFile),
      loadSnapshot(bFile),
    ]);
    status.textContent = 'Computing diff…';
    const filter = $('#diff-filter').value.trim();
    const result = diffSnapshots(snapA, snapB, { providerNameFilter: filter });
    state.diff.result = result;
    state.diff.expanded.clear();
    status.textContent = '';
    renderDiff();
  } catch (err) {
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

  const filter = $('#diff-filter').value.trim().toLowerCase();
  const filterFn = (n) => !filter || (n ?? '').toLowerCase().includes(filter);
  const added = r.providersAdded.filter((p) => filterFn(p.ProviderName));
  const removed = r.providersRemoved.filter((p) => filterFn(p.ProviderName));
  const changed = r.providersChanged.filter((p) => filterFn(p.providerName));

  const summary = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 text-sm">
      <div class="bg-slate-900 border border-slate-800 rounded px-3 py-2"><div class="text-slate-500 text-xs uppercase">A</div><div class="font-mono">${escapeHtml(r.osVersionA)}</div></div>
      <div class="bg-slate-900 border border-slate-800 rounded px-3 py-2"><div class="text-slate-500 text-xs uppercase">B</div><div class="font-mono">${escapeHtml(r.osVersionB)}</div></div>
      <div class="bg-slate-900 border border-slate-800 rounded px-3 py-2"><div class="text-slate-500 text-xs uppercase">Added</div><div class="font-mono text-emerald-400">${added.length}</div></div>
      <div class="bg-slate-900 border border-slate-800 rounded px-3 py-2"><div class="text-slate-500 text-xs uppercase">Removed</div><div class="font-mono text-rose-400">${removed.length}</div></div>
      <div class="bg-slate-900 border border-slate-800 rounded px-3 py-2 col-span-2 md:col-span-4"><div class="text-slate-500 text-xs uppercase">Changed</div><div class="font-mono text-amber-400">${changed.length}</div></div>
    </div>`;

  const addedSection = sectionHtml('Providers added (only in B)', 'emerald', added.map((p) => addedRemovedRowHtml(p, 'emerald')).join(''));
  const removedSection = sectionHtml('Providers removed (only in A)', 'rose', removed.map((p) => addedRemovedRowHtml(p, 'rose')).join(''));
  const changedSection = sectionHtml('Providers changed', 'amber', changed.map((p) => changedProviderRowHtml(p, state.diff.expanded)).join(''));

  out.innerHTML = summary + addedSection + removedSection + changedSection;

  out.querySelectorAll('[data-toggle-changed]').forEach((row) => {
    row.addEventListener('click', () => {
      const g = row.dataset.toggleChanged;
      if (state.diff.expanded.has(g)) state.diff.expanded.delete(g);
      else state.diff.expanded.add(g);
      renderDiff();
    });
  });
}

function sectionHtml(title, color, body) {
  if (!body) {
    return `<details class="mb-3"><summary class="cursor-pointer text-slate-500 text-sm">${title} (none)</summary></details>`;
  }
  return `
    <details open class="mb-4">
      <summary class="cursor-pointer text-${color}-300 font-medium mb-2 hover:text-${color}-200">${title}</summary>
      <div class="bg-slate-900 border border-slate-800 rounded">${body}</div>
    </details>`;
}

function addedRemovedRowHtml(p, color) {
  const sign = color === 'emerald' ? '+' : '−';
  return `
    <div class="px-3 py-2 border-b border-slate-800/50 last:border-0">
      <div class="flex items-baseline gap-2">
        <span class="text-${color}-400 font-mono">${sign}</span>
        <span class="font-mono text-sm text-slate-200">${escapeHtml(p.ProviderName ?? '(no name)')}</span>
      </div>
      <div class="text-xs text-slate-500 ml-4 font-mono">${escapeHtml(p.ProviderGuid ?? '')} • ${escapeHtml(p.SchemaSource ?? '')} • ${(p.Events ?? []).length} events</div>
    </div>`;
}

function changedProviderRowHtml(pd, expandedSet) {
  const expanded = expandedSet.has(pd.providerGuid);
  const counts = [
    pd.eventsAdded.length ? `<span class="text-emerald-400">+${pd.eventsAdded.length}</span>` : '',
    pd.eventsRemoved.length ? `<span class="text-rose-400">−${pd.eventsRemoved.length}</span>` : '',
    pd.eventsChanged.length ? `<span class="text-amber-400">~${pd.eventsChanged.length}</span>` : '',
    pd.providerFieldsChanged.length ? `<span class="text-sky-400">⚙${pd.providerFieldsChanged.length}</span>` : '',
  ].filter(Boolean).join(' ');

  const head = `
    <div data-toggle-changed="${pd.providerGuid}" class="cursor-pointer px-3 py-2 hover:bg-slate-800/50 border-b border-slate-800/50 flex items-baseline gap-3">
      <span class="text-slate-500 w-4 text-center">${expanded ? '▾' : '▸'}</span>
      <div class="flex-1 min-w-0">
        <div class="font-mono text-sm text-slate-200 truncate">${escapeHtml(pd.providerName ?? '(no name)')}</div>
        <div class="text-xs text-slate-500 font-mono truncate">${escapeHtml(pd.providerGuid)}</div>
      </div>
      <div class="text-xs font-mono">${counts}</div>
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

  const eventsAddedBlock = pd.eventsAdded.length === 0 ? '' : `
    <div class="mb-3">
      <div class="text-xs text-emerald-400 font-medium mb-1">${pd.eventsAdded.length} event(s) added</div>
      ${diffEventListHtml(pd.eventsAdded, 'emerald')}
    </div>`;

  const eventsRemovedBlock = pd.eventsRemoved.length === 0 ? '' : `
    <div class="mb-3">
      <div class="text-xs text-rose-400 font-medium mb-1">${pd.eventsRemoved.length} event(s) removed</div>
      ${diffEventListHtml(pd.eventsRemoved, 'rose')}
    </div>`;

  const eventsChangedBlock = pd.eventsChanged.length === 0 ? '' : `
    <div class="mb-3">
      <div class="text-xs text-amber-400 font-medium mb-1">${pd.eventsChanged.length} event(s) changed</div>
      ${pd.eventsChanged.map(diffEventChangedHtml).join('')}
    </div>`;

  return head + `<div class="px-6 py-3 bg-slate-950/60 border-b border-slate-800/50">${fieldsBlock}${eventsAddedBlock}${eventsRemovedBlock}${eventsChangedBlock}</div>`;
}

function diffEventListHtml(events, color) {
  return `<table class="text-xs font-mono w-full">
    <thead class="text-slate-500"><tr><th class="text-left pr-3 w-12">Id</th><th class="text-left pr-3 w-10">v</th><th class="text-left">Description</th></tr></thead>
    <tbody>
      ${events.map((e) => `<tr><td class="pr-3 text-${color}-300">${e.Id}</td><td class="pr-3 text-slate-500">${e.Version}</td><td class="text-slate-300">${escapeHtml(((e.Description ?? '').length > 120 ? (e.Description ?? '').slice(0, 117) + '…' : (e.Description ?? '')))}</td></tr>`).join('')}
    </tbody>
  </table>`;
}

function diffEventChangedHtml(ed) {
  return `
    <div class="border border-slate-800 rounded p-2 mb-2 bg-slate-900/40">
      <div class="text-xs text-amber-300 font-mono mb-1">Id ${ed.id} v${ed.version}</div>
      <table class="text-xs font-mono w-full">
        <thead><tr class="text-slate-500"><th class="text-left pr-3 w-32">Field</th><th class="text-left pr-3">A</th><th class="text-left">B</th></tr></thead>
        <tbody>
          ${ed.changes.map((c) => `<tr><td class="pr-3 text-slate-300 align-top">${escapeHtml(c.field)}</td><td class="pr-3 text-rose-300 align-top whitespace-pre-wrap break-all">${escapeHtml(String(c.a ?? ''))}</td><td class="text-emerald-300 align-top whitespace-pre-wrap break-all">${escapeHtml(String(c.b ?? ''))}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;
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
