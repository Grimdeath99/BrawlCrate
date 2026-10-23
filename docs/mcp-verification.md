# MCP verification record

Verification dates: 2026-10-23–24 (Europe/Stockholm). Source location: the current BrawlCrate checkout. Existing `.claude/` and local `Test/` game/mod assets were preserved and excluded from the package. No installed host settings, account credentials or remote endpoints were changed.

## Baseline

The unchanged GUI source compiles in Release/x86 with Visual Studio MSBuild 18.7.8.30822 and the repository's existing .NET Framework 4.7.2 target. The existing `/changelog` launch mode exits successfully and writes the actual title `BrawlCrate v0.42 Hotfix 1` and an 800-byte current changelog. The same smoke test passed from the preview delivery directory. The MCP server is a separate executable; normal GUI startup does not load or enable it.

Baseline environment issues, resolved or isolated rather than attributed to MCP:

| Check | Result |
| --- | --- |
| NuGet restore inside restricted sandbox | Initially NU1301; approved network restore succeeded; dependency locks saved |
| Default direct-project Release prebuild | Assumes SolutionDir and invokes Cargo incorrectly; reproducible package script bypasses legacy hooks |
| Plain dotnet build | MSB3822/MSB3823 for legacy non-string .resx resources; full Visual Studio MSBuild passes |
| GUI `/changelog` inside restricted account | Settings dialog prevented exit; same command outside sandbox passed |
| Existing compile diagnostics | CS0219 unused frameAlign and Doxygen command-syntax diagnostic; build exit 0 |
| Native ColorSmash | i686 Rust target absent; omitted by default and not claimed tested |

Evidence is retained locally in `artifacts/mcp-evidence/baseline-summary.json`, baseline build/restore logs and `baseline-gui-escalated-result.json`. No existing executable C# regression suite was found. Internal Deque tester classes and ColorSmash Rust tests were inventoried; unrelated native tests were not run.

## Implemented integration checks

| Layer | Test | Current verified result |
| --- | --- | --- |
| Real application operations | `mcp/tests/integration.mjs` | Development run: **28 passed, 0 failed** through SDK client + stdio + actual x86 BrawlLib worker |
| Protocol | `mcp/tests/protocol.mjs` | Development run: **15 passed, 0 failed**, one process-inventory skip under restricted WMI |
| Lifecycle/IPC isolation | `mcp/tests/bridge.test.mjs` | **10 passed, 0 failed** with a disposable compiled test child, not a substitute for application integration |
| Direct worker investigation | Synthetic ARC/MSBin IPC checks | **28 passed**; persistent header/text state verified |
| Packaged release | Same suites from delivery directory | **28 application + 16 protocol + 10 lifecycle checks passed; 0 failures, 0 skips** |

The official SDK 1.32.2 client discovers exactly nine tools, one listed status resource, one document resource template and one prompt. The primary protocol revision is 2025-11-25. A separate raw client negotiates that revision and 2024-11-05 and invokes real `get_status` operations. No claim is made for the 2026-07-28 request model or other untested host versions.

Application integration checks include native archive parsing, pagination, metadata/resources, prompt retrieval without side effects, root/header rename, nested MSBin reads and edits, Unicode and CRLF behavior, binary export, source SHA-256 preservation, reloading exported state through BrawlLib, and reopening exported files after process restart. Permissions are checked through read-only launch, foreign session handles, traversal/absolute paths, ADS/device paths and actual directory junctions. Malformed input, file/depth/page/document limits, stale revisions, concurrent conflicting edits, operation-ID conflicts, exact export/close retries and dirty-document disposal all have explicit assertions.

The lifecycle suite verifies queued cancellation without dispatch, active cancellation and timeout invalidating the session, queue admission bounds, malformed/oversized worker replies, unexpected process exit, disconnect cleanup and EOF during stalled startup. It checks the fixture child PIDs are gone. Initial real-worker WMI discovery was unavailable under the sandbox; the final raw protocol test uses a before/after Get-Process inventory and verified that its uniquely identified **real worker** exited after stdin EOF. The final run has no process-cleanup skip. Deterministic boundary fixtures are clearly distinguished from real application effects.

Development test iterations are retained rather than hidden. An early integration run executed a stale binary before three worker fixes were rebuilt (wrong-format reopen, final empty message and reopening at the document limit); it had five failed checks, including cascading stale state. After rebuilding, all 28 passed. A preview package predating malformed-envelope classification returned -32603; the corrected current server returns -32602 and passes the protocol suite. Preview artifacts are not the final delivery.

## Final delivery evidence

The final `artifacts/BrawlCrate-MCP` package was built with locked dependencies and tested from **its own server directory**, without `--worker` or a development-node_modules fallback. All server/library source copies were compared against the source tree. The packaged GUI's existing `/changelog` mode also passed (exit 0, actual title and 800-byte changelog). The repository base commit is `a4c1ee3385010d5c64a88df9c56267c61f213321`; these integration additions are working-tree changes, not a new commit.

| Evidence inside the package | Recorded result |
| --- | --- |
| `evidence/application/results.json` and `transcript.json` | 28 passed, 0 failed, empty worker/server stderr; real SDK calls and results |
| `evidence/protocol-final/protocol-results.json` | 16 passed, 0 failed, 0 skipped; two revisions, actual PID cleanup, raw wire transcripts |
| `evidence/lifecycle-results.json` | 10 passed, 0 failed; exact packaged command and captured test output |
| `evidence/final-app-smoke.json` | Original desktop launch mode passed from delivery directory |
| `evidence/final-package-build.log` | Existing GUI, updater and worker build succeeded; pinned production npm install succeeded |
| `evidence/fixtures/` | Synthetic originals plus renamed/edited native binary exports |

The original nested ARC SHA-256 is `c9d42984c63c87f7cefa164d2198efea48b0063b83ec0486ba857951849eb2bb`. Its exported ARC SHA-256 is `6a9837d0988275e632e7575b6431db316f7999e6d77e8af04329bff05563dfad`. The exported header contains `RenamedViaMCP`; BrawlLib reopening returns that name. The source hash remains unchanged. The nested MSBin export reopens with the winning concurrent edit and retains its native archive structure. These checks establish application effects beyond discovery.

The release ZIP is `artifacts/BrawlCrate-MCP.zip`. `SHA256SUMS.txt` covers all packaged files except itself. The finalizer was independently tested to exclude its own checksum and reject existing ZIPs, out-of-repository paths and actual junctions. Build/runtime files, source additions, tests, docs, examples and curated evidence are included; oversized test scratch files and junctions are kept outside the delivery.

## Known gaps and precise next actions

- **GUI host:** VS Code and Inspector examples follow official documented formats, but neither full UI host was launched. To certify a specific host/version, merge the example entry into that host, connect, open a synthetic fixture, edit/export and compare its saved bytes. No client configuration was modified automatically.
- **Desktop editor:** The normal command/startup smoke passes. Interactive window rendering, GUI edits, graphics/audio and plugin workflows remain unexecuted. Open the delivered `app/BrawlCrate.exe` interactively to validate those baseline features on the intended workstation.
- **Formats:** Only the bounded ARC/plain MSBin scope is implemented; other game formats are explicit unsupported errors. Extend preflight and typed loaders, then add native export/reopen tests before expanding the catalogue.
- **Cancellation:** No rollback of a completed export is promised. An interrupted native operation ends the session; inspect output files before retrying. Receipt deduplication is session-local.
- **Malformed JSON:** The pinned SDK's stdio parser reports unparseable JSON to stderr and recovers for the next valid message. A JSON-RPC -32700 reply is not implemented or claimed.
- **Platform:** Windows x86 worker/GUI and Node24.14.0 were tested. Non-Windows and other Node/runtime versions are not certified. Runtime prerequisites are documented rather than bundled.
- **Optional native component:** Install the existing i686 Rust target and run `tools/build-mcp.ps1 -BuildColorSmash` to package and separately test ColorSmash. No MCP workflow depends on it.

## Reproduction commands

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build-mcp.ps1 -OutputDirectory artifacts/BrawlCrate-MCP -NoZip
Set-Location artifacts/BrawlCrate-MCP/server
node tests/integration.mjs --output ../evidence
node tests/protocol.mjs --server C:/Users/alexa/Documents/GitHub/BrawlCrate/artifacts/BrawlCrate-MCP/server/server.mjs --output ../evidence/protocol
node --test tests/bridge.test.mjs
```

The package build uses locked restores and includes runtime dependency files. `SHA256SUMS.txt` records the final delivery contents. Source tests and logs remain available for reviewing failures separately from passing checks.
