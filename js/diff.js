// Snapshot diff logic.
//
// Mirrors the C# Compare-EtwSnapshot cmdlet in EtwInspector. Two snapshots
// in, structured diff out:
//
//   {
//     osVersionA, osVersionB,
//     providersAdded:   [ProviderSnapshot],     // in B, not A
//     providersRemoved: [ProviderSnapshot],     // in A, not B
//     providersChanged: [ProviderDiff]          // in both, differ
//   }
//
// ProviderDiff: { providerGuid, providerName, providerFieldsChanged,
//                 eventsAdded, eventsRemoved, eventsChanged }
// EventDiff:    { id, version, changes: [{ field, a, b }] }

export function diffSnapshots(snapA, snapB, opts = {}) {
  const { providerNameFilter } = opts;

  const aMap = indexProviders(snapA.providers);
  const bMap = indexProviders(snapB.providers);

  const out = {
    osVersionA: snapA.osVersion,
    osVersionB: snapB.osVersion,
    providersAdded: [],
    providersRemoved: [],
    providersChanged: [],
  };

  for (const [guid, p] of bMap) if (!aMap.has(guid)) out.providersAdded.push(p);
  for (const [guid, p] of aMap) if (!bMap.has(guid)) out.providersRemoved.push(p);

  for (const [guid, a] of aMap) {
    const b = bMap.get(guid);
    if (!b) continue;
    const pd = diffProvider(a, b);
    if (pd) out.providersChanged.push(pd);
  }

  out.providersAdded.sort(byName);
  out.providersRemoved.sort(byName);
  out.providersChanged.sort(byName);

  if (providerNameFilter) {
    const needle = providerNameFilter.toLowerCase();
    const match = (n) => (n ?? '').toLowerCase().includes(needle);
    out.providersAdded = out.providersAdded.filter((p) => match(p.ProviderName));
    out.providersRemoved = out.providersRemoved.filter((p) => match(p.ProviderName));
    out.providersChanged = out.providersChanged.filter((p) => match(p.providerName));
  }

  return out;
}

function indexProviders(providers) {
  const m = new Map();
  for (const p of providers ?? []) {
    const key = normalizeGuid(p.ProviderGuid);
    if (!m.has(key)) m.set(key, p);
  }
  return m;
}

function normalizeGuid(guid) {
  if (!guid) return '';
  return guid.trim().replace(/^\{|\}$/g, '').toLowerCase();
}

const byName = (x, y) => {
  const xn = (x.ProviderName ?? x.providerName ?? '').toLowerCase();
  const yn = (y.ProviderName ?? y.providerName ?? '').toLowerCase();
  return xn < yn ? -1 : xn > yn ? 1 : 0;
};

function diffProvider(a, b) {
  const fieldsChanged = [];
  pushIfDifferent(fieldsChanged, 'ProviderName', a.ProviderName, b.ProviderName);
  pushIfDifferent(fieldsChanged, 'SchemaSource', a.SchemaSource, b.SchemaSource);
  pushIfDifferent(fieldsChanged, 'ResourceFilePath', a.ResourceFilePath, b.ResourceFilePath);

  const aEvents = indexEvents(a.Events);
  const bEvents = indexEvents(b.Events);

  const eventsAdded = [];
  const eventsRemoved = [];
  const eventsChanged = [];

  for (const [k, e] of bEvents) if (!aEvents.has(k)) eventsAdded.push(e);
  for (const [k, e] of aEvents) if (!bEvents.has(k)) eventsRemoved.push(e);
  for (const [k, ae] of aEvents) {
    const be = bEvents.get(k);
    if (!be) continue;
    const ed = diffEvent(ae, be);
    if (ed) eventsChanged.push(ed);
  }

  eventsAdded.sort(eventOrder);
  eventsRemoved.sort(eventOrder);
  eventsChanged.sort(eventOrder);

  if (
    fieldsChanged.length === 0 &&
    eventsAdded.length === 0 &&
    eventsRemoved.length === 0 &&
    eventsChanged.length === 0
  ) {
    return null;
  }

  return {
    providerGuid: b.ProviderGuid,
    providerName: b.ProviderName,
    providerFieldsChanged: fieldsChanged,
    eventsAdded,
    eventsRemoved,
    eventsChanged,
  };
}

function indexEvents(events) {
  const m = new Map();
  for (const e of events ?? []) {
    const k = `${e.Id ?? 0}:${e.Version ?? 0}`;
    if (!m.has(k)) m.set(k, e);
  }
  return m;
}

const eventOrder = (x, y) => (x.Id - y.Id) || (x.Version - y.Version);

function diffEvent(a, b) {
  const changes = [];
  pushIfDifferent(changes, 'Level', a.Level, b.Level);
  pushIfDifferent(changes, 'Opcode', a.Opcode, b.Opcode);
  pushIfDifferent(changes, 'Task', a.Task, b.Task);
  pushIfDifferent(changes, 'Keywords', a.Keywords, b.Keywords);
  pushIfDifferent(changes, 'Description', a.Description, b.Description);
  pushIfDifferent(changes, 'Template', a.Template, b.Template);

  const aKw = new Set(a.KeywordNames ?? []);
  const bKw = new Set(b.KeywordNames ?? []);
  if (!setsEqual(aKw, bKw)) {
    changes.push({
      field: 'KeywordNames',
      a: [...aKw].sort().join(','),
      b: [...bKw].sort().join(','),
    });
  }

  if (changes.length === 0) return null;
  return { id: b.Id, version: b.Version, changes };
}

function pushIfDifferent(list, field, a, b) {
  if (a === b) return;
  // Treat null/undefined as equal
  if ((a == null) && (b == null)) return;
  list.push({ field, a: a ?? null, b: b ?? null });
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
