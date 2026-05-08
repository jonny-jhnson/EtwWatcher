// NDJSON snapshot loader.
//
// Each snapshot file starts with a header object on line 1:
//   {"SchemaVersion":"1.0","OSVersion":"10.0.26200.0"}
// followed by one provider per line:
//   {"ProviderGuid":"...","ProviderName":"...","Events":[...], ...}
//
// We stream the response body, decode UTF-8 progressively, split on '\n',
// and parse each line. Reports progress so the UI can show a bar.

const _snapshotCache = new Map(); // file -> parsed snapshot

export async function loadSnapshot(file, onProgress) {
  if (_snapshotCache.has(file)) {
    onProgress?.({ done: true, fromCache: true });
    return _snapshotCache.get(file);
  }

  const url = `snapshots/${file}`;
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');

  let header = null;
  const providers = [];
  let buffer = '';
  let bytesRead = 0;
  let isFirstLine = true;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      const obj = JSON.parse(line);
      if (isFirstLine) {
        header = obj;
        isFirstLine = false;
      } else {
        providers.push(obj);
      }
    }

    onProgress?.({
      bytesRead,
      total,
      providers: providers.length,
      done: false,
    });
  }

  // Flush any tail without trailing newline
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    const obj = JSON.parse(tail);
    if (isFirstLine) header = obj;
    else providers.push(obj);
  }

  const snapshot = {
    file,
    schemaVersion: header?.SchemaVersion ?? '1.0',
    osVersion: header?.OSVersion ?? 'unknown',
    providers,
  };

  _snapshotCache.set(file, snapshot);
  onProgress?.({ done: true, fromCache: false });
  return snapshot;
}

export async function loadManifest() {
  const r = await fetch('snapshots/manifest.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Failed to load manifest: ${r.status}`);
  return r.json();
}

export function getCachedSnapshot(file) {
  return _snapshotCache.get(file);
}
