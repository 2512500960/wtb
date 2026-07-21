# AGENTS.md — WorldTreeBrowser (WTB)

## Quick start

```bash
npm install         # postinstall auto-runs build:dll
npm start           # dev mode (hot reload, Electron)
```

## Key commands

| Command | What it does |
|---------|-------------|
| `npm test` | Jest (ts-jest, jsdom) |
| `npm run lint` | ESLint on `.js,.jsx,.ts,.tsx` — extends `erb` + `prettier` |
| `npm exec tsc` | TypeScript check (`tsconfig.json`, no emit via `.erb/dll` outDir) |
| `npm run package` | `clean` → `build` → `electron-builder` → `build:dll` |
| `npm run build` | `build:main` + `build:renderer` concurrently |

**CI order** (test.yml): `npm run package` → `npm run lint` → `npm exec tsc` → `npm test`.

## Architecture

- **Electron + React + TypeScript** on electron-react-boilerplate (webpack, SASS).
- **`src/main/main.ts`**: thin orchestrator — creates managers, registers IPC handlers, wires lifecycle. No business logic; offloaded to managers in the same dir.
- **`src/main/` (45 files)**: managers for Yggdrasil, IPFS, Web service, peer coordination, site preheater, app lifecycle, tray, embedded apps, browser windows, etc.
- **`src/renderer/`**: React app with `MemoryRouter`. Routes defined in `App.tsx` — `/`, `/irc`, `/resources`, `/site-services`, `/settings`, `/status`, `/peers`.

## Service startup dependency chain

`Yggdrasil` → `IPFS` → `Web service`. IPFS and Web auto-start after Yggdrasil starts. Stopping Yggdrasil cascades: Web → IPFS → clean up.

## Architecture notes

- Yggdrasil is the core P2P network layer; libp2p (for group chat) is **deprecated** (code commented out, feature flag `FEATURES.chat = false`).
- `AnnouncementsCoordinator` and `ServiceAnnouncementsManager` are **disabled** (commented out). Service sync now uses HTTP pull mode (`ServiceSyncHttpManager`).
- Web content model: three source modes (`local`, `dual`, `ipfs-backed`) managed via `web_content_sources.ts`. IPFS is the preferred storage plane for large files.
- **MFS migration** is explicitly deferred. The manifest-based content model is kept. Use `kubo-rpc-client` for IPFS writes (no blocking CLI calls).
- `src/main/main_window.ts` must register `ready-to-show` before `loadURL()` with a post-load show fallback, or the main window can stay hidden due to a race.
- Do NOT pass `--lang` to Chromium — it overrides per-window Accept-Language. WTB uses per-session language overrides (`zh-CN` for the app, `en-US` for Element).

## Testing quirks

- Tests mock `window.electron.ipcRenderer` (see `App.test.tsx` for pattern).
- `setupFiles` runs `.erb/scripts/check-build-exists.ts` (only creates a marker file).
- Asset imports (images, CSS, SCSS) are mocked via `fileMock.js` and `identity-obj-proxy`.

## Build & packaging

- Electron builder outputs: `release/build/`.
- Build resources: `assets/`. Extra resources bundle `wtb-data/web/`, `assets/`, `yggdrasil/`, `ipfs/`.
- `postinstall` does: `check-native-dep` → `electron-builder install-app-deps` → `build:dll`.
- `npm run package` includes `build:dll` at the end (reproduces DLL after cleanup).
- Windows targets: NSIS installer + portable.

## Repo conventions

- Indent: 2 spaces, LF endings (`.editorconfig`).
- Prettier: single quotes.
- ESLint rule overrides: `import/no-extraneous-dependencies: off`, `react/react-in-jsx-scope: off`, `@typescript-eslint/no-shadow: error`, `@typescript-eslint/no-unused-vars: error`.

## Existing instruction files

- `docs/copilot/wtb-direction.md` — architecture direction (verified above, already reflected here).
- `docs/copilot/mfs-draft.md` — deferred MFS migration analysis.
