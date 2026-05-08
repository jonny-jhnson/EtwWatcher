# EtwWatcher

A static web app for browsing and diffing snapshots of Windows ETW (Event Tracing for Windows) provider state across builds. Snapshots are produced by [ETWInspector](https://github.com/jonny-jhnson/ETWInspector) and committed to this repo as NDJSON.

## Using it

> **Live site: https://jonny-jhnson.github.io/EtwWatcher/**

You don't need to clone or run anything to use EtwWatcher. Open the live site and you can:

- **Browse** any committed snapshot - filter providers by name/GUID, scope by Manifest or MOF, drill into events, search descriptions/keywords/template fields.
- **Diff** any two snapshots to see providers added, changed, and removed - including per-event field-level changes.
- **Bring your own** snapshot via the upload zone at the top of the page. The file is parsed entirely in your browser; nothing is uploaded anywhere.
- **Share findings** by copying the URL - it captures the active tab, picked snapshots, and all filters, so a teammate clicking your link sees the exact same view.

## Why this exists

Detection engineers, threat hunters, and Windows internals researchers frequently need to answer questions like:

- What ETW providers and events exist on a given Windows build?
- Which events were added, removed, or had their metadata changed between two builds?
- Did a Patch Tuesday update silently rename or rewrite an event that an existing detection depends on?
- Which keywords and template fields does a specific event expose, and how did those evolve?

Today, getting this information usually means provisioning a VM, installing tooling, dumping provider state, and repeating the whole process on a second VM to compare. That's a meaningful barrier - and it's why a lot of detection content is written against assumptions that go stale silently.

EtwWatcher does that work once. Real Windows snapshots are produced by [ETWInspector](https://github.com/jonny-jhnson/ETWInspector), committed to this repo, and rendered in a browser-side UI. Anyone can browse, search, and diff provider state across Windows builds without standing up infrastructure - and link a teammate directly to a specific finding.

## What's coming

Snapshots will be added on an ongoing basis. The intent is to cover:

- **Patch Tuesday cumulative updates** for currently-supported Windows builds, so you can see what shifted between e.g. `26200.7171` and `26200.7462`.
- **Insider / Canary builds** as Microsoft ships them - early signal on what providers and events are being added or restructured before they hit general availability.
- **TraceLogging provider support** - extending the snapshot format and the diff UI to cover TraceLogging in addition to Manifest/MOF.

If you want a specific build snapshotted, open an issue with the build number, or grab [ETWInspector](https://github.com/jonny-jhnson/ETWInspector) and contribute the NDJSON directly via the [Adding a snapshot](#adding-a-snapshot-contributors) flow below.

## What it does

- **Browse** - pick a snapshot and explore every Manifest/MOF provider on that Windows build. Filter by provider (name, GUID, resource path), event description, keyword name, or template XML field. Toggle Manifest/MOF/All at the top to scope by schema source. Click a provider to see its events, levels, opcodes, keyword names, and full template XML.
- **Diff** - pick two snapshots and see exactly what changed: providers added, providers whose events were added/removed/changed, and per-event field-level diffs with line-by-line highlighting on Description and Template.

Everything runs in your browser. No backend, no telemetry. The page fetches the NDJSON files committed to `/snapshots/` and parses them client-side.

> **Scope today: Manifest and MOF providers only.** TraceLogging providers aren't in the snapshots yet - support is on the roadmap and will roll in once ETWInspector's TraceLogging output is wired through end-to-end.

## ETW Provider Snapshots

Stored in [NDJSON](https://github.com/ndjson/ndjson-spec) (newline-delimited JSON: one JSON object per line) in `/snapshots/`:

- First line of each file is a header: `{"SchemaVersion":"1.0","OSVersion":"10.0.x.y.z"}` (the OS version is `Major.Minor.Build.UBR`, read straight from the registry by ETWInspector).
- Each subsequent line is one provider record.

`snapshots/manifest.json` is the index of which snapshots show up in the dropdowns - it's regenerated automatically by the deploy workflow whenever NDJSONs change.

## Adding a snapshot (contributors)

1. On a target machine, install [ETWInspector](https://github.com/jonny-jhnson/ETWInspector) and run:
   ```powershell
   Import-Module .\EtwInspector\EtwInspectorModule\EtwInspector.psd1 -Force
   Export-EtwSnapshot C:\Snapshots\<filename>.ndjson
   ```
   Naming convention: `<major>_<minor>_<build>_<UBR>.ndjson` (e.g. `10_0_26200_7171.ndjson`).
2. Copy the file into this repo's `snapshots/` directory.
3. Commit the snapshot and push. The deploy workflow auto-regenerates the manifest before publishing, so the live site picks up your new entry without any extra action.

If you want to preview the new entry locally before pushing, run the script yourself:

```powershell
.\scripts\update-manifest.ps1
```

The script scans `snapshots/*.ndjson`, reads each header to pull the OS version, and rewrites `snapshots/manifest.json` sorted by version. Existing labels are preserved (customizations like `(Insider)` survive re-runs); new entries get a default label of `Build <OSVersion>` that you can edit if you want a prettier name. Commit the manifest along with the snapshot if you want local dev to match what the live site will show.

## Running locally

You only need this if you're developing the site itself. The site is plain HTML + JS + Tailwind via CDN with no build step:

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

MIT. See [LICENSE](./LICENSE).
