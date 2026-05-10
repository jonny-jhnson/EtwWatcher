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
  // Compare on the basename only - the same DLL/EXE/SYS routinely shows up
  // under different path prefixes (e.g. C:\Windows\System32\foo.dll vs
  // %SystemRoot%\System32\foo.dll), which would otherwise produce a noisy
  // diff for every such provider. The full paths still get reported when
  // the actual file name changes.
  if (resourceFileBasename(a.ResourceFilePath) !== resourceFileBasename(b.ResourceFilePath)) {
    pushIfDifferent(fieldsChanged, 'ResourceFilePath', a.ResourceFilePath, b.ResourceFilePath);
  }
  // For TraceLogging providers, the Sources[] array may differ across builds
  // (a provider gets added to or removed from a binary). Compare on the
  // sorted set of basenames (same rationale as ResourceFilePath above -
  // C:\Windows\... vs %SystemRoot%\... is the same binary), but surface the
  // original full paths in the diff entry when an actual binary changes.
  const aSrc = Array.isArray(a.Sources) ? [...a.Sources].sort().join('\n') : null;
  const bSrc = Array.isArray(b.Sources) ? [...b.Sources].sort().join('\n') : null;
  const aSrcKey = Array.isArray(a.Sources)
    ? [...a.Sources].map(resourceFileBasename).sort().join('\n')
    : null;
  const bSrcKey = Array.isArray(b.Sources)
    ? [...b.Sources].map(resourceFileBasename).sort().join('\n')
    : null;
  if (aSrcKey !== bSrcKey) pushIfDifferent(fieldsChanged, 'Sources', aSrc, bSrc);

  // Group events on each side by the appropriate identity key. Manifest
  // and MOF events identify by Id (with Version distinguishing schema
  // bumps); TraceLogging events identify by Description (event name),
  // because their Id and Version fields are typically 0/0 - the binary
  // embeds a name array, not a numeric ID. Without this split, multiple
  // TraceLogging events sharing (Id=0, Version=0) would collapse in the
  // per-Version map and silently drop entries.
  const schemaSource = (a.SchemaSource ?? b.SchemaSource ?? '').toLowerCase();
  const isTraceLogging = schemaSource === 'tracelogging';
  const groupKey = (e) => (isTraceLogging ? (e.Description ?? '') : (e.Id ?? 0));

  const aByKey = new Map();
  const bByKey = new Map();
  for (const e of a.Events ?? []) {
    const k = groupKey(e);
    if (!aByKey.has(k)) aByKey.set(k, []);
    aByKey.get(k).push(e);
  }
  for (const e of b.Events ?? []) {
    const k = groupKey(e);
    if (!bByKey.has(k)) bByKey.set(k, []);
    bByKey.get(k).push(e);
  }

  const eventsAdded = [];
  const eventsRemoved = [];
  const eventsChanged = [];

  const allKeys = new Set([...aByKey.keys(), ...bByKey.keys()]);
  for (const k of allKeys) {
    const aList = aByKey.get(k) ?? [];
    const bList = bByKey.get(k) ?? [];

    if (aList.length === 0) { eventsAdded.push(...bList); continue; }
    if (bList.length === 0) { eventsRemoved.push(...aList); continue; }

    if (isTraceLogging) {
      // TraceLogging within a same-name group: exact Template match = same
      // event (template content IS the event identity for TraceLogging).
      // Anything left over after exact matching is a distinct event, not a
      // schema evolution - mark as removed/added rather than pairing across
      // different templates and producing a confusing "changed" entry.
      const aRemaining = [...aList];
      const bRemaining = [...bList];
      for (let i = bRemaining.length - 1; i >= 0; i--) {
        const be = bRemaining[i];
        const aIdx = aRemaining.findIndex(
          (ae) => (ae.Template ?? '') === (be.Template ?? ''),
        );
        if (aIdx >= 0) {
          const ed = diffEvent(aRemaining[aIdx], be);
          if (ed) eventsChanged.push(ed);
          aRemaining.splice(aIdx, 1);
          bRemaining.splice(i, 1);
        }
      }
      eventsRemoved.push(...aRemaining);
      eventsAdded.push(...bRemaining);
      continue;
    }

    // Manifest/MOF within a same-Id group: exact (Id, Version) match diffs
    // in place; B versions with no exact A counterpart pair against A's
    // highest version of that Id as a "new version" diff. A-only versions
    // for the same Id are implicitly superseded by B's existing versions.
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

// Reduce a Windows path to its lowercased final segment so prefix variations
// (drive-letter vs %SystemRoot%, backslash vs forward slash, casing) don't
// register as a ResourceFilePath change.
function resourceFileBasename(p) {
  if (!p) return p;
  const parts = String(p).split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}
