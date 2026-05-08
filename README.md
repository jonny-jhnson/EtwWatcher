# EtwWatcher

A static web app for browsing and diffing snapshots of Windows ETW (Event Tracing for Windows) provider state across builds. Snapshots are produced by [ETWInspector](https://github.com/jonny-jhnson/ETWInspector) and committed to this repo as NDJSON.

## What it does

- **Browse** - pick a snapshot and explore every Manifest/MOF provider on that Windows build. Filter by name, GUID, event description, or keyword. Drill into a provider to see its events, levels, opcodes, keyword names, and full template XML.
- **Diff** - pick two snapshots (e.g. an older build and a newer one) and see exactly what changed: providers added/removed, providers whose events were added/removed, and per-event field-level changes (level, opcode, task, keyword bitmap, description, template XML).

Everything runs in the browser. No backend, no telemetry. The page fetches the NDJSON files committed to `/snapshots/` and parses them client-side.

## Snapshots

Stored as newline-delimited JSON in `/snapshots/`:

- First line of each file is a header: `{"SchemaVersion":"1.0","OSVersion":"10.0.x.y"}`
- Each subsequent line is one provider record.

`snapshots/manifest.json` lists the snapshots that the UI should expose. Add a new entry there when you commit a new file.

## Adding a snapshot

1. On a target machine, install [ETWInspector](https://github.com/jonny-jhnson/ETWInspector) and run:
   ```powershell
   Import-Module .\EtwInspector\EtwInspectorModule\EtwInspector.psd1 -Force
   Export-EtwSnapshot C:\Snapshots\<build-or-label>.ndjson
   ```
2. Copy the resulting `.ndjson` file into this repo's `snapshots/` directory.
3. Add an entry to `snapshots/manifest.json`:
   ```json
   {
     "file": "<build-or-label>.ndjson",
     "label": "Windows 11 - Build 26200",
     "osVersion": "10.0.26200.0"
   }
   ```
4. Commit and push. GitHub Pages redeploys automatically via `.github/workflows/pages.yml`.

## Running locally

The site is plain HTML + JS + Tailwind via CDN. No build step. Serve the directory with any static file server:

```bash
# Python
python -m http.server 8080

# Node
npx http-server -p 8080
```

Then open `http://localhost:8080`.

> Note: opening `index.html` directly via `file://` won't work - the JS uses `fetch()` and ES module imports, both of which require an HTTP origin. Use a local server.

## Tech

- Vanilla HTML / JS / CSS
- [Tailwind CSS](https://tailwindcss.com) loaded via CDN
- ES modules, no bundler
- Hosted on [GitHub Pages](https://pages.github.com/)

## Backing tool

Snapshots are produced by [ETWInspector](https://github.com/jonny-jhnson/ETWInspector) - a PowerShell module that enumerates Manifest, MOF, and TraceLogging providers and exports them as JSON or NDJSON. The diff algorithm in this site (`js/diff.js`) is a JavaScript port of `Compare-EtwSnapshot` from the same module.

## License

GPL-3.0. See [LICENSE](./LICENSE).
