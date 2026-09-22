# Build Hooks and Packaging Assets

Electron Builder resources and packaging hooks. Operational packaging code, not app runtime. Root `package.json` is the version source of truth; `electron-builder.yml` consumes it through `${version}` in artifact names. Package scripts live in `package.json` (mac DMG+ZIP; win NSIS+portable x64/arm64).

## Files

| File                             | Role                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `after-pack.cjs`                 | Post-package optimizations on **darwin only**; no-ops for win32/linux                                                       |
| `entitlements.mac.plist`         | Main app entitlements (mac signing)                                                                                         |
| `entitlements.mac.inherit.plist` | Inherited helper/framework entitlements                                                                                     |
| `icon.icns`                      | macOS app icon (`scripts/generate-calendar-tray-icons.mjs` + iconutil)                                                      |
| `icon.ico`                       | Windows app icon multi-size (same script via sharp, any OS)                                                                 |
| `notarize.cjs`                   | Darwin `afterSign` hook: notarizes with `notarytool`, then staples and validates the app when Apple credentials are present |

## Where to Look

| Task                        | Location                                      | Notes                                              |
| --------------------------- | --------------------------------------------- | -------------------------------------------------- |
| Packaged file set / targets | `../electron-builder.yml`                     | mac DMG/ZIP; win NSIS+portable; `asarUnpack` **both** Swift sources |
| Shrink mac bundle           | `after-pack.cjs`                              | Gate: `electronPlatformName === "darwin"`          |
| App / tray icons            | `../scripts/generate-calendar-tray-icons.mjs` | icns, ico, mac 18/36 tray, win 16/32 tray          |

## Packaging rules

- `afterPack` / `afterSign` wired from root `electron-builder.yml`.
- Keep release versions in root `package.json`. Electron Builder interpolates that value through `${version}`; do not maintain a second version in build assets.
- Mac: DMG+ZIP for arm64 + x64; `minimumSystemVersion` **11.0.0**; built-in `notarize: false`. The custom `afterSign` hook runs only for Darwin, submits the signed `.app` with `notarytool`, then staples and validates it before container creation when `APPLE_ID`, `APPLE_TEAM_ID`, and an app-specific password are available. It also accepts the legacy password variable with a warning, and skips notarization when credentials are absent.
- Official Windows artifacts: separate `--x64` and `--arm64` invocations (not dual-arch single NSIS).
- Both Swift sources must stay in `files` and `asarUnpack` for mac packaged builds: `src/main/googlemeet-events.swift` and `src/main/swift/event-occurrence-identity.swift` (compile-on-device + dual-source integrity hash).
- Do not hand-edit generated `icon.icns` / `icon.ico` / tray PNGs.
- Source plists grant `allow-jit`, Calendar, Apple Events, and `allow-unsigned-executable-memory`. The plist comment still says Electron 43; `package.json` depends on `electron` `^44.4.3`. `assertEntitlements` requires `allow-jit` and rejects `allow-unsigned-executable-memory` and `disable-library-validation` on the signed app. Do not add `disable-library-validation`.

## Anti-patterns

- Assuming `.app` layout on non-darwin after-pack paths.
- Removing `en.lproj` when pruning locales.
- Claiming Windows Authenticode is always required (unsigned dogfood allowed when `WIN_CSC_*` absent).
