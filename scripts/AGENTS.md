# Scripts

Dev, icons, release verifiers, guardrails, beta tags, and the perf lab. Invoked from `package.json` or CI. Not bundled into the app.

## Files

| File | Role |
|------|------|
| `dev.ts` | Bun: rslib watch, Rsbuild on port 5173, then Electron |
| `generate-calendar-tray-icons.mjs` | Tray PNGs, `build/icon.icns` (macOS `iconutil`), `build/icon.ico` |
| `validate-node.mjs` | Host Node major ≥ 26, then the icon generator |
| `verify-macos-release.mjs` | DMG/ZIP inventory, signing, stapling, dual-source Swift smoke |
| `macos-release-verifier-*.mjs` | Container, helpers, natives. Hash is identity + newline + events |
| `verify-windows-release.mjs` | NSIS + portable x64/arm64. `REQUIRE_UPDATER_YML=1` checks `latest.yml` |
| `windows-latest-yml-verifier.mjs` | Two NSIS entries; primary path is x64 |
| `merge-windows-latest-yml.mjs` | Rebuild `dist/latest.yml` after the sequential arch builds |
| `next-beta-tag.mjs` | `vX.Y.Z-beta-N` tag and `X.Y.Z-beta.N` app version. Workflow-only |
| `guardrails-scan.mjs` | `bun run guardrails`. `--self-test` is `guardrails:self-test` |
| `check-swift-package-layout.mjs` | Both Swift sources on disk, in `files` and `asarUnpack`, distinct hash |
| `performance/report.mjs` | Opt-in JSONL → p50/p95. Exit 1 on bad or empty input |
| `performance/workspace-fingerprint.mjs` | Fixed exclusions. Not a pass/fail gate |
| `performance/measure-*.mjs` | Lab harnesses. `perf:lab` chains google, tray, safe-storage, startup, alert, build |
| `performance/helpers/*` | `stats.mjs`, `google-shadow.mjs` (`MAX_PAGES=10`), `packaged-probe.mjs` |

## dev.ts

Shebang `bun`. Cleans `lib/main` and `lib/preload`, waits for both CJS bundles and TCP `localhost:5173`, then launches Electron with `VITE_DEV_SERVER_URL`. SIGINT/SIGTERM kills the children. Do not replace the TCP check with a fixed sleep.

## Icons and Node 26

`validate:node` refuses host Node below major 26, then generates icons. `NODE_VALIDATE_SKIP_GENERATE=1` is test-only. Do not hand-edit tray PNGs, `icon.icns`, or `icon.ico`. Host Node 26 is contributor tooling, separate from Electron's runtime and from `engines.node` (`>=20`).

## Perf exits

Packaged probes (`perf:tray`, `perf:alert`, `perf:startup`, `perf:safe-storage`): exit 0 for `blocked`, `ok`, `retained`, and threshold `rejected`. Exit 1 for timeout, crash, missing trace, or harness failure. `perf:google` exits 1 on `rejected` plus `paired-shadow-mismatch`. `perf:build-package` exits 1 only when `GOGMEET_PERF_RUN_BUILD=1` and the build fails.

`packaged-probe.mjs` uses a `gogmeet-perf-probe-` userData directory under tmp, a 90s TERM→KILL, and copies only `gogmeet-perf-trace-v1.jsonl`. Row and byte caps live in `src/main/utils/performance-trace.ts`, not in this launcher. Receipts keep `productChange: "none"`. A `retained` receipt does not authorize a product change.

Fingerprint exclusions are fixed: `.omo/evidence/**`, `lib/**`, `dist/**`, `coverage/**`, `node_modules/**`, `.eslintcache`, `*.tsbuildinfo`.

## Release

`package.json` owns the official version. Beta jobs rewrite that version in the CI checkout only; the tag points at the untouched `develop` commit. macOS verifier accepts helper exits 0, 2, or 3 and requires the dual-source `source.hash`. It stays strict for unsigned local builds. Official Windows artifacts are separate `package:win:x64` and `package:win:arm64` runs plus `merge:windows-latest-yml`.

## Tests

`tests/scripts/` covers validate-node, guardrails scan, beta tags, both release verifiers, latest.yml merge, and `performance-*.test.ts`. Bench fixtures are `calendar-parser-bench-fixtures.test.ts`. `bun run bench:calendar-parser` uses `vitest.bench.config.ts`, outside the workspace.
