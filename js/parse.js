// NDJSON snapshot loader.
//
// Each snapshot file starts with a header object on line 1:
//   {"SchemaVersion":"1.0","OSVersion":"10.0.26200.0"}
// followed by one provider per line:
//   {"ProviderGuid":"...","ProviderName":"...","Events":[...], ...}
//
// We stream the body, decode UTF-8 progressively, split on '\n', and parse
// each line. Reports progress so the UI can show a bar. Two entry points:
//   loadSnapshot(file)            -> fetches snapshots/<file>
//   loadSnapshotFromFile(handle)  -> reads a File picked by the user

const _snapshotCache = new Map(); // key -> parsed snapshot

// Per-event Keywords are emitted as signed Int64 by EtwInspector. Values like
// -9223372036854775804 are beyond IEEE 754 safe-integer range, so JSON.parse
// silently rounds them to the nearest representable double (-2^63 here),
// destroying the low keyword bits before any code can see them. Convert the
// raw integer text to an unsigned 64-bit hex string before JSON.parse so
// precision survives the round-trip; downstream code feeds the string into
// BigInt() to render. Lookahead ensures we only rewrite the event-level
// "Keywords":<number>, not the provider-level "Keywords":[...] array.
function preservePrecision(line) {
  return line.replace(/"Keywords":(-?\d+)(?=[,}\]])/g, (_m, num) => {
    let n = BigInt(num);
    if (n < 0n) n += 1n << 64n;
    return `"Keywords":"0x${n.toString(16)}"`;
  });
}

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

  // Compressed payload size, before decompression. We use this for the progress
  // bar (it's the actual number of bytes flowing over the network); the
  // post-gunzip stream will report many more bytes. For plain .ndjson, the
  // compressed and decompressed totals match.
  const total = Number(response.headers.get('content-length')) || 0;

  // GitHub Pages serves .gz files as opaque application/gzip - the browser
  // does NOT auto-decompress. We pipe through DecompressionStream when the
  // filename ends in .gz; otherwise the stream passes through unchanged.
  const stream = file.toLowerCase().endsWith('.gz')
    ? response.body.pipeThrough(new DecompressionStream('gzip'))
    : response.body;

  return consumeNdjsonStream({
    reader: stream.getReader(),
    total,
    onProgress,
    keyForCache: file,
    file,
  });
}

// Parses an NDJSON File handed to us by the user (file picker / drag-drop).
// Returns the parsed snapshot; cache key is `local:<filename>`.
export async function loadSnapshotFromFile(fileHandle, onProgress) {
  const key = `local:${fileHandle.name}`;
  // Replace any prior copy under the same name so re-uploads pick up edits
  _snapshotCache.delete(key);

  const stream = fileHandle.name.toLowerCase().endsWith('.gz')
    ? fileHandle.stream().pipeThrough(new DecompressionStream('gzip'))
    : fileHandle.stream();
  return consumeNdjsonStream({
    reader: stream.getReader(),
    total: fileHandle.size,
    onProgress,
    keyForCache: key,
    file: key,
    isLocal: true,
    sourceName: fileHandle.name,
  });
}

async function consumeNdjsonStream({ reader, total, onProgress, keyForCache, file, isLocal, sourceName }) {
  const decoder = new TextDecoder('utf-8');
  let header = null;
  const providers = [];
  let buffer = '';
  let bytesRead = 0;
  let isFirstLine = true;
  let lineNumber = 0;

  try {
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
        lineNumber++;

        let obj;
        try {
          obj = JSON.parse(preservePrecision(line));
        } catch (e) {
          throw new Error(`Could not parse line ${lineNumber} as JSON: ${e.message}`);
        }
        if (isFirstLine) {
          if (!isHeaderShape(obj)) {
            throw new Error("First line isn't a snapshot header (expected SchemaVersion + OSVersion, no ProviderGuid).");
          }
          header = obj;
          isFirstLine = false;
        } else {
          providers.push(obj);
        }
      }

      onProgress?.({ bytesRead, total, providers: providers.length, done: false });
    }

    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      lineNumber++;
      const obj = JSON.parse(preservePrecision(tail));
      if (isFirstLine) {
        if (!isHeaderShape(obj)) {
          throw new Error("Single-line file isn't a snapshot header.");
        }
        header = obj;
      } else {
        providers.push(obj);
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  if (!header) throw new Error('Snapshot is empty.');
  if (providers.length === 0) throw new Error('Snapshot contains no providers (header only).');

  const snapshot = {
    file,
    isLocal: !!isLocal,
    sourceName: sourceName ?? file,
    schemaVersion: header.SchemaVersion ?? '1.0',
    osVersion: header.OSVersion ?? 'unknown',
    providers,
  };
  _snapshotCache.set(keyForCache, snapshot);
  onProgress?.({ done: true, fromCache: false });
  return snapshot;
}

function isHeaderShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.ProviderGuid) return false;
  return 'SchemaVersion' in obj || 'OSVersion' in obj;
}

export async function loadManifest() {
  const r = await fetch('snapshots/manifest.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Failed to load manifest: ${r.status}`);
  return r.json();
}

export function getCachedSnapshot(file) {
  return _snapshotCache.get(file);
}
