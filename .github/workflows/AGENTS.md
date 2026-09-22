# GitHub Workflows

CI/release automation for the Electron app (macOS + Windows). Keep workflow behavior aligned with `package.json`, `.nvmrc` (Node **26**), `scripts/validate-node.mjs`, and packaging guidance in `build/AGENTS.md`. Host package manager: Bun (`packageManager: bun@1.4.1`). Typecheck in CI uses `@typescript/native` via `bun run typecheck`.

## Files

| File | Role |
| --- | --- |
| `pr-check.yml` | PR/push validation on `develop` and `main`: quality gates on macOS + Windows, full and changed-source coverage, and Node 26 icon-drift validation (mac only). |
| `release.yml` | A `main` push creates `v${package.json.version}` when missing and, in that same run, packages `release-mac` / `release-win` onto one GitHub Release. Non-beta `v*` tags package too. |
| `beta-release.yml` | Push to `develop` (e.g. after PR merge): parallel **mac + Windows** packaging into one **GitHub pre-release** with an auto-incremented beta tag. |
| `measurement.yml` | Weekly (Mon 06:00 UTC) + `workflow_dispatch` measurement lab: synthetic harnesses on macOS/Windows; does **not** ship product changes or gate PRs. |

## PR Check

- `check` matrix: `macos-latest` and `windows-latest` (K31 — no `windows-11-arm`; arm64 Windows packages are cross-built later on x64 runners).
- Defaults to `shell: bash` so changed-files scripts stay portable on Windows runners.
- Before checkout, sets `core.autocrlf=false` / `core.eol=lf` so Windows runners keep LF. Pair with repo-root `.gitattributes` (`* text=auto eol=lf`). Prettier is `endOfLine: "lf"`; without this, only `windows-latest` fails `bun run lint` with Delete `␍`.
- Uses pinned `actions/checkout` and `oven-sh/setup-bun` SHAs; keep pins intentional when upgrading.
- The `check` checkout uses `fetch-depth: 0` so a PR can compare with `github.event.pull_request.base.sha` and a push can compare with `github.event.before`. For an initial push with GitHub's all-zero `before` SHA, it resolves `HEAD^` and reuses that resolved base for changed-source coverage.
- `check` runs `bun install --frozen-lockfile`, `bun run lint`, `bun run format:check`, `bun run typecheck`, **`bun run guardrails`**, **`bun run guardrails:tests`**, **`bun run check:swift-package-layout`**, `bun run build`, and one `bun run test:coverage`.
- It lists added, copied, modified, and renamed `src/**/*.ts` files. When the list is nonempty, it runs related tests and a separate text coverage report with Vitest `--coverage.changed`. That report step **disables percentage floors** (`--coverage.thresholds.*=0`); global floors remain only on the full `test:coverage` step.
- `validate-node` remains **macos-latest only** (iconutil / icns). Sets up Bun plus Node from `.nvmrc` (currently 26), runs `bun run validate:node`, then `git diff --exit-code` for icon drift including `build/icon.ico` and Windows tray PNGs.

## Beta Release (`develop`)

- Triggers on every push to `develop` (including PR merges). Concurrency group `beta-release-${{ github.ref }}` serializes runs so beta numbers do not collide.
- **`prepare`** (`macos-latest`): compute next `v${base}-beta-N` / app version `${base}-beta.N`; create and push the annotated tag on the develop tip; open an empty GitHub **pre-release** shell (notes/body) so parallel jobs only attach assets.
- **`beta-mac`** (`macos-latest`, needs prepare): temporarily set `package.json` version to the beta app version; `package:mac` signed when Apple secrets are complete else `CSC_IDENTITY_AUTO_DISCOVERY=false`; signed path runs `verify:macos-release`; uploads DMG/ZIP + `SHA256SUMS-mac.txt` (+ `latest-mac.yml` when present).
- **`beta-win`** (`windows-latest`, needs prepare): same version bump; optional `WIN_CSC_*` → `CSC_*` (unsigned dogfood if absent, K30); sequential `package:win:x64` then `package:win:arm64`; `merge:windows-latest-yml` (K25); `REQUIRE_UPDATER_YML=1 verify:windows-release`; uploads four exes + `latest.yml` + `SHA256SUMS-win.txt`. Bake `GOOGLE_OAUTH_CLIENT_ID` when present so Connect Google works in beta installers.
- Both platform jobs attach to the **same** pre-release (`prerelease: true`, `make_latest: false`). Use separate checksum fragments to avoid race overwrites.
- Do not commit the temporary beta `package.json` version bump; the git tag always points at the untouched develop commit.
- Do not use `-beta-` tags for official releases; beta tags are owned by this workflow (official `release.yml` skips them).

## Official Release (`main` / `v*`)

- A `main` push creates and pushes `v${package.json.version}` only when missing. Packaging runs in the **same** workflow (GITHUB_TOKEN tag pushes do not start new runs).
- **`prepare`**: resolve/create the official tag; when `run_release=true`, open a GitHub **Release shell** (notes/body, `make_latest: true`) so parallel jobs only attach assets.
- On `v*` tags (non-beta), when `run_release=true`:
  - **`release-mac`**: Apple secrets → signed `package:mac` + verify, or unsigned fallback; uploads DMG/ZIP + `SHA256SUMS-mac.txt` (+ `latest-mac.yml` when present).
  - **`release-win`**: LF checkout; optional `WIN_CSC_*`; sequential `package:win:x64` / `package:win:arm64`; merge `latest.yml`; verify; uploads four exes + `latest.yml` + `SHA256SUMS-win.txt`. Prefer `github.token` for `GH_TOKEN` (not an empty `secrets.GITHUB_TOKEN`).
- Both attach to the **same** Release. Separate checksum fragments avoid race overwrites.

## Measurement lab

- Scheduled evidence collection for the stability/measurement plan (`docs/plans/gogmeet-performance-stability-hardening.md`, `docs/performance/measurement-lab.md`). Does **not** ship product optimizations or gate PRs.
- **Synthetic** matrix (macOS + Windows): script unit tests + harnesses without package (`blocked` OK).
- **Native** jobs (separate, non-PR): host-matching `package:*:dir` then startup/tray/alert (macOS) or +safeStorage (Windows x64); arm64 cross-build is explicitly blocked; upload with `if: always()`.
- Launched probe crash/timeout → measure scripts exit **1** (blocked stays 0); native job fails. Keep this workflow out of PR gates.
- Receipts always `productChange: "none"`; synthetic never claims `nativeExecuted: true`.
- Uses the same Bun install + LF-on-Windows patterns as other workflows where applicable.

## Anti-Patterns

- Do not remove `fetch-depth: 0`; the PR check needs base comparisons and the release/beta jobs need tag visibility.
- Do not mark beta pre-releases as `make_latest: true` or omit `prerelease: true`.
- Do not commit the temporary beta `package.json` version bump from CI.
- Do not add custom Apple password variables or a warning-only artifact check on **official** release. Built-in Electron Builder notarization path and the verifier own official-release proof.
- Do not hand-edit generated icons to satisfy workflow drift; regenerate through `scripts/generate-calendar-tray-icons.mjs`.
- Do not duplicate build/package rules here; source of truth remains package scripts plus `electron-builder.yml`.
- Do not turn `measurement.yml` into a PR-blocking quality gate.
