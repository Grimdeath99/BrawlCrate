# BrawlCrate MCP server

This integration exposes real BrawlLib document operations through a local Model Context Protocol server. It opens, inspects, edits and exports supported files in a dedicated **headless document session**. It does not attach to a running BrawlCrate window or inspect unsaved GUI edits. Each server process owns its documents; `instance_id` and `document_id` identify that state explicitly.

## Architecture and supported versions

The MCP SDK runs in a Node.js sidecar and launches `BrawlCrate.Mcp.Worker.exe` as its private child. The worker targets .NET Framework 4.7.2, **x86**, matching BrawlLib's native pointer assumptions. It calls the repository's actual `ARCNode`, `MSBinNode`, `ResourceNode.Initialize`, `Name`, `SignalPropertyChange`, `Merge` and `Export(FileStream)` implementations. Application operations run serially on the worker's STA thread. The normal GUI entry point and its services are unchanged; MCP is disabled simply by not launching the server.

| Component | Selection |
| --- | --- |
| Role / transport | Server / local stdio only |
| Official MCP SDK | `@modelcontextprotocol/sdk` **1.32.2** |
| Schema library | `zod` **4.6.7** |
| Primary protocol revision | **2025-11-25**, including initialize/initialized lifecycle |
| Compatibility test | 2024-11-05 initialize and real application call; see verification report |
| Application / worker | BrawlCrate/BrawlLib **0.42.0.1** / worker **1.0.0** |
| Runtime | Windows; .NET Framework 4.7.2+; Node.js 22+ (tested **24.14.0**) |
| Build tools tested | .NET SDK **10.0.301**, Visual Studio MSBuild **18.7.8.30822**, npm **11.9.0** |

The official SDK catalogue and the SDK's published v1 maintenance documentation were checked when selecting this implementation. V1 remains a maintained compatibility line and implements the 2025-11-25 handshake used by the included client. This server does **not** implement the newer 2026-07-28 request model. Do not assume a host that only implements that model can connect. The concrete test client is the official SDK 1.32.2 client; a separate raw JSON-RPC test also verifies transport behavior. No installed AI host was configured or certified.

## Supported files

The selected workflows support uncompressed, version 0x0101 **ARC** archives whose entries are other ARC archives or supported **MSBin** resources, and standalone MSBin files. Input is validated before unsafe BrawlLib code sees it. Typed node initialization bypasses generic format probing. The worker uses DeleteOnClose memory maps for its actual editable documents, rather than rereading the source on every operation.

MSBin support is deliberately limited to valid UTF-8 plain text: maximum 512 encoded bytes per message, no `<`, `[`, backslash or control characters except line feeds. Tool input accepts CR/LF and normalizes line endings; BrawlLib returns CRLF strings. The last message cannot be empty because the application reader drops trailing empty entries. Markup/control-formatted MSBin, compressed resources, redirected ARC entries, opaque payloads, BRRES, models, textures, audio, movesets and all other formats are rejected. An unsupported resource inside an ARC rejects that entire archive. This is not an implementation of every editor workflow.

Limits are 64 MiB per file, eight open documents, 4,096 nodes, nesting depth 16, 16,384 messages per MSBin, 200 results per page, 384 KiB per tool result and 64 queued operations. Input and IPC frames are capped at 1 MiB. The default operation deadline is 30 seconds, including queue time; `--timeout-ms` accepts 100 through 120000.

## Build and package

From the repository root, with Visual Studio Build Tools and the .NET Framework developer pack installed:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build-mcp.ps1
```

This performs locked NuGet restores, builds the existing GUI, updater and worker with full Visual Studio MSBuild, installs the pinned npm lockfile with lifecycle scripts disabled, and creates:

```text
artifacts/BrawlCrate-MCP/
  app/        Existing BrawlCrate GUI, updater and managed/runtime assets
  worker/     x86 worker, BrawlLib and dependencies
  server/     MCP source, node_modules, lockfiles and tests
  config/     Host configuration examples
  docs/       Setup, contracts, verification and dependency locks
  source/     Worker and build-script source additions (full repo needed to rebuild)
  LICENSE
  package-manifest.json
  SHA256SUMS.txt
artifacts/BrawlCrate-MCP.zip
```

The output must be a **new directory inside the repository**. To keep a prior package, use `-OutputDirectory artifacts/BrawlCrate-MCP-new`. Use `-NoZip` while verifying a build; that leaves checksums and the archive for finalization after verification with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/finalize-mcp.ps1 -PackageDirectory artifacts/BrawlCrate-MCP`. Node.js and the Windows .NET Framework are external runtime prerequisites; no npm install is needed to run the delivered package. `-MSBuildPath` overrides Visual Studio discovery. `-SkipRestore` is for already-restored development work, not the reproducible default.

The build script replaces legacy packaging hooks only for this build. Those hooks kill other application instances and remove output directories; the replacement builds into a fresh staging directory and copies required files explicitly. Normal Visual Studio builds retain their prior behavior. Plain `dotnet build` cannot compile this repository's legacy binary .resx files in this environment, so the script uses full Framework MSBuild.

Optional native `color_smash.exe` is omitted by default. To include it, install the existing application's `i686-pc-windows-msvc` Rust toolchain target and build with `-BuildColorSmash`; Cargo uses the repository lockfile. This optional GUI texture workflow is independent of MCP. Developer plugins, private module maps, local test assets and credentials are not packaged.

## Launch and connection

Assuming the package is installed at `C:/Tools/BrawlCrate-MCP` and the allowed mod directory already exists at `C:/BrawlMods`:

```powershell
node C:/Tools/BrawlCrate-MCP/server/server.mjs --root C:/BrawlMods
```

This is a protocol subprocess, not an interactive console. The MCP host must own stdin/stdout. Logs go to stderr. To permit edits and exports, add `--allow-write` **in the trusted host launch configuration**; a tool cannot enable it. The worker is discovered relative to the server at `../worker/BrawlCrate.Mcp.Worker.exe`. Development can instead pass `--worker ABSOLUTE_EXE_PATH`.

Exact host fields:

```json
{
  "command": "node",
  "args": [
    "C:/Tools/BrawlCrate-MCP/server/server.mjs",
    "--root", "C:/BrawlMods",
    "--allow-write"
  ]
}
```

Working directory: any existing directory; absolute launch arguments make it independent of the host's cwd. The worker uses the allowed root as its cwd. Environment: no integration-specific variables, credentials or tokens are required. `node` must be on PATH (or use its absolute executable path); Windows TEMP must be writable for native resource memory maps.

`config/vscode.mcp.json` follows VS Code's documented `servers`/`type: stdio` format. Replace the two example paths, then merge only the `brawlcrate` entry into the desired `.vscode/mcp.json`. `config/inspector.json` uses the Inspector `mcpServers` format. Both examples default to read-only. Their schema format was checked against official documentation; a full VS Code or Inspector UI session was **not** run. Automated tests use the compatible official SDK client, which is also provided in the package.

Disable MCP by stopping/removing its host server entry. Launch `app/BrawlCrate.exe` normally for the desktop editor. There is no listening port, automatic client registration, remote service or model-provider configuration.

## Capability catalogue

All successful tools return both JSON text and identical `structuredContent: {"data": {...}}`, with a matching output schema. Tool input is strict: unknown fields, invalid types and out-of-range values fail. Operational and argument failures have `isError: true` and a JSON `{error:{code,message}}` text block. Malformed protocol envelopes and unknown protocol operations/tools return JSON-RPC errors. SDK handling of unparseable JSON is a stderr diagnostic followed by recovery, not a promised `-32700` reply.

`document_id` is a session-owned opaque handle. `node_id` is `root` or an index path such as `0/1`. Structural edits are not exposed, so node IDs stay stable. Pages take `offset` (default 0) and `limit` (default 50, maximum 200), returning `items`, `total`, `next_offset` and `revision`.

| Tool | Inputs beyond common IDs | Actual behavior and output | Permission / verification |
| --- | --- | --- | --- |
| `get_status` | none | Worker instance, BrawlLib version, limits, allowed root and open document metadata | Read; checked against live worker |
| `open_document` | relative `path`, `format`: auto/arc/msbin | Validates bytes, initializes native nodes; returns handle, source SHA-256, revision 0 and root metadata; reopening same source returns its existing session state | Read filesystem; tested synthetic ARC/MSBin parsing |
| `get_document` | document ID | Current metadata, original source hash, dirty state, revision and last export path | Read; compared with edits and resource |
| `list_children` | document/node IDs, pagination | Native child names, types, counts and stable IDs | Read; multi-page nested ARC test |
| `read_messages` | document/node IDs, pagination | Native MSBin strings and indexes | Read; Unicode/newline and nested-message tests |
| `rename_node` | document/node IDs, `name`, mutation fields | Changes an ARC header name (1–47 printable ASCII, no slashes or duplicate sibling names); increments revision | `--allow-write`; export/reopen/header bytes checked |
| `set_message` | document/node IDs, `index`, `text`, mutation fields | Changes one existing MSBin string and signals native dirty state; increments revision | `--allow-write`; exported nested text reopened in BrawlLib |
| `export_document` | document ID, relative new `path`, mutation fields | Native merge/rebuild/export to a new binary file; returns path, byte count, SHA-256 and incremented revision | `--allow-write`; output bytes/hash and untouched source verified |
| `close_document` | document ID, `discard_changes` default false, mutation fields | Releases resource maps and expires the handle; dirty documents require an explicit discard | Either mode; dirty rejection, close retry and expired handle tested |

Mutation fields are `expected_revision` (nonnegative integer) and `operation_id` (1–128 characters). Edits are in memory until export; no tool saves over the source. Export does not infer a different format from a filename extension. Its parent directory must exist. The worker writes a uniquely named temporary sibling file, flushes it, validates the rebuilt binary and atomically moves it to the requested **nonexistent** destination. Failed ordinary exports remove their temporary file. Failed/aborted operations must not be reported as completed.

Resources:

| URI | Contents | Verification |
| --- | --- | --- |
| `brawlcrate://session/status` | `application/json`, same current state as get_status | Instance and permissions match tool |
| `brawlcrate://documents/{document_id}` | `application/json`, current metadata/revision for a handle | Same state as get_document; foreign/closed IDs denied |

Prompt `inspect_archive(path)` returns a read-only inspection workflow using the tools above. Retrieval opens no file and executes no action. Resource reads also make no document changes. Resources, templates and the one prompt are discovered through the SDK. Subscriptions, change notifications, completions, tasks, sampling, elicitation, HTTP and MCP client mode are intentionally unsupported and unadvertised.

## Permissions, concurrency and failures

The program has no account-based authorization layer; this local server inherits the launch user's OS permissions and adds an explicit allowed-root boundary. Only relative file paths under `--root` are accepted. Traversal, absolute paths, Windows device/ADS paths and reparse-point ancestors are denied. Roots must be local drive directories. Permissions are checked in the worker, independently of MCP annotations. No shell, script, plugin, generic property setter, arbitrary URL or SQL execution is exposed.

The root and the launcher executable must be trusted local directories. Path checks prevent model-requested escapes; they are not an OS sandbox against another process running as the same user that maliciously swaps directories between checks. The source is copied under a read lock into the session's authoritative native memory map. Later external changes are not silently reloaded. Close and reopen to explicitly reload; exports always use a new path, so external source edits cannot be overwritten.

Every worker executes one operation at a time. A stale expected revision fails before a mutation. Successful mutation receipts are retained for the entire session: an identical retry returns its original result, and a changed request using the same operation ID fails. The 1,000-receipt budget reserves its last 16 slots for exports/closes. Receipt lookup occurs before handle/revision checks, so an exact close/export retry works. Receipts are not durable across restarts. Read the result's revision before making the next change.

Cancellation while queued removes the request without executing it. Cancelling or timing out an **active** native operation terminates its worker because BrawlLib is synchronous and cannot safely unwind at arbitrary native boundaries. All handles become invalid; there is no automatic restart or mutation retry. Reconnect, inspect any destination already created and reopen documents before deciding whether to retry. A write might have reached its final atomic move before disconnect; an abrupt process termination can leave a `.brawlcrate-mcp-*.tmp` sibling file. These are not valid completed exports and can be removed after verifying no session is using them. In-memory unsaved edits are lost when the session ends. DeleteOnClose resource maps are released by Windows when the worker exits.

EOF, host disconnect and termination close the SDK server and kill its private child. No other BrawlCrate process is selected or terminated.

## Run verification

From the delivered `server` directory:

```powershell
node tests/integration.mjs --output ../evidence
node tests/protocol.mjs --server C:/Tools/BrawlCrate-MCP/server/server.mjs --output ../evidence/protocol
node --test tests/bridge.test.mjs
```

The first two use the delivered entry point and default sibling worker. The integration suite generates copyright-free ARC/MSBin fixtures, checks real edits and persisted binary outputs, and retains transcripts/results. The raw client tests protocol revisions and clean stdout. The bridge suite compiles a small disposable .NET test child using the Windows Framework C# compiler to deterministically test timeouts/cancellation/cleanup; those isolated tests do not count as application integration.

For source-tree development, provide `--worker C:/.../BrawlCrate.Mcp.Worker/bin/x86/Release/net472/BrawlCrate.Mcp.Worker.exe` to the integration and protocol scripts. Build changed C# source before testing; tests deliberately execute the selected binary, never substitute source handlers.

See **[mcp-verification.md](mcp-verification.md)** for completed test runs, baseline failures, remaining gaps and evidence locations. GUI rendering/editing, an installed AI host session, native ColorSmash, non-Windows systems and unsupported resource formats are not certified by this test suite.

## Troubleshooting and reference material

Missing worker/DLL: retain the whole package layout; do not copy only server.mjs or the worker executable. Missing .NET runtime or wrong architecture: use Windows with .NET Framework 4.7.2+ and the x86 worker. `READ_ONLY`: add the launch flag only if edits are intended. `PATH_DENIED`: use a relative path under a real, non-junction root. `UNSUPPORTED_OR_INVALID_FILE`: inspect the format scope above; generic parsing is intentionally unavailable. `STALE_REVISION`: read metadata and reconcile changes. `timeout`, `cancelled` or `worker_exited`: start a new session and inspect any exported file before retrying. App startup settings prompts can prevent unattended GUI smoke tests under a restricted account; this was a baseline environment issue, not an MCP worker dependency.

Official references consulted on 2026-10-23:

- [MCP SDK catalogue](https://modelcontextprotocol.io/docs/2026-07-28/sdk)
- [TypeScript SDK v1 documentation and maintenance policy](https://ts.sdk.modelcontextprotocol.io/)
- [2025-11-25 specification](https://modelcontextprotocol.io/specification/2025-11-25), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Inspector](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector)
- [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)

BrawlLib and BrawlCrate are provided under the repository's LGPLv3 license. The integration dynamically references BrawlLib; its source remains in this repository. Bundled npm dependencies retain their package licenses.
