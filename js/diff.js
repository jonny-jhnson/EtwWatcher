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
// EventDiff:    { id, version, changes: [{ field, a, b }], a, b }
//               (a and b are the full event objects, used by the diff view's
//               render-time filtering by description/keyword/template)

export function diffSnapshots(snapA, snapB) {
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
  // For TraceLogging providers, the Sources[] array may differ across builds
  // (a provider gets added to or removed from a binary). Compare as joined,
  // sorted strings so unrelated ordering doesn't trip a false-positive.
  const aSrc = Array.isArray(a.Sources) ? [...a.Sources].sort().join('\n') : null;
  const bSrc = Array.isArray(b.Sources) ? [...b.Sources].sort().join('\n') : null;
  if (aSrc !== bSrc) pushIfDifferent(fieldsChanged, 'Sources', aSrc, bSrc);

  // Group events by Id on each side. For each Id seen, exact (Id, Version)
  // pairs diff in-place; B versions with no exact A counterpart pair against
  // A's highest version of that Id so the schema delta surfaces as a "new
  // version" diff rather than landing in eventsAdded. Critically this also
  // catches the case where B keeps A's version AND adds newer versions on
  // top (e.g. A has v1, B has v1+v2+v3) - the prior cross-bucket approach
  // missed this because A's leftover bucket was empty after exact match.
  const aByIdMap = new Map();
  const bByIdMap = new Map();
  for (const e of a.Events ?? []) {
    const id = e.Id ?? 0;
    if (!aByIdMap.has(id)) aByIdMap.set(id, []);
    aByIdMap.get(id).push(e);
  }
  for (const e of b.Events ?? []) {
    const id = e.Id ?? 0;
    if (!bByIdMap.has(id)) bByIdMap.set(id, []);
    bByIdMap.get(id).push(e);
  }

  const eventsAdded = [];
  const eventsRemoved = [];
  const eventsChanged = [];

  const allIds = new Set([...aByIdMap.keys(), ...bByIdMap.keys()]);
  for (const id of allIds) {
    const aList = aByIdMap.get(id) ?? [];
    const bList = bByIdMap.get(id) ?? [];

    if (aList.length === 0) { eventsAdded.push(...bList); continue; }
    if (bList.length === 0) { eventsRemoved.push(...aList); continue; }

    const aByVer = new Map();
    for (const e of aList) aByVer.set(e.Version ?? 0, e);
    const baselineA = [...aList].sort(
      (x, y) => (y.Version ?? 0) - (x.Version ?? 0),
    )[0];

    for (const be of bList) {
      const ae = aByVer.get(be.Version ?? 0);
      if (ae) {
        const ed = diffEvent(ae, be);
        if (ed) eventsChanged.push(ed);
      } else {
        const ed = diffEvent(baselineA, be);
        if (ed) {
          ed.versionChanged = true;
          eventsChanged.push(ed);
        }
      }
    }
    // A-only versions for this Id (in aList but not bList) are implicitly
    // superseded by B's existing versions - skipping eventsRemoved here
    // avoids noisy "v1 removed, v3 added" entries when the real story is
    // "schema bumped".
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
    resourceFilePath: b.ResourceFilePath,
    schemaSource: b.SchemaSource,
    sources: Array.isArray(b.Sources) ? b.Sources : undefined,
    providerFieldsChanged: fieldsChanged,
    eventsAdded,
    eventsRemoved,
    eventsChanged,
  };
}

const eventOrder = (x, y) => (x.Id - y.Id) || (x.Version - y.Version);

function diffEvent(a, b) {
  const changes = [];
  pushIfDifferent(changes, 'Version', a.Version, b.Version);
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
  return { id: b.Id, version: b.Version, changes, a, b };
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
