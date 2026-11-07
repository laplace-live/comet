# Windows System Tray + New-Message Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let LAPLACE Comet keep running in the background on Windows/Linux when the window is closed, accessible via a system-tray icon that shows a red dot when there are unread messages.

**Architecture:** A new main-process-only module `src/tray.ts` owns the `Tray` instance, the show/focus helper, and the one-time hint. The window's `close` event hides to tray (Windows/Linux) instead of quitting, gated by an `isQuitting` flag. The unread indicator piggybacks on the existing `APP_SET_BADGE_COUNT` IPC handler — no new IPC. Tray icons are pre-rendered PNGs embedded as base64 data URLs so they resolve identically in dev and packaged builds.

**Tech Stack:** Electron 42 (`Tray`, `nativeImage`, `BrowserWindow`, `Notification`), `electron-store` (already a dependency), ImageMagick (`magick`, already used by the icon generator).

## Testing approach (read first)

This repo has **no test runner** (only `lint`), and tray/window/OS behavior cannot be unit-tested without an Electron runtime + display + the target OS. No test framework is introduced. Each task's verification uses, in order:

- `pnpm typecheck` — `tsc --noEmit` (strict; baseline is currently clean). Catches type errors in new and existing code, including the new module before it is imported.
- `pnpm lint` — ESLint.
- `pnpm start` — build/launch smoke on the macOS dev machine (confirms the main process compiles, bundles, and runs without error; the tray itself will not appear on macOS by design).
- **Manual Windows/Linux checklist** — the only place tray behavior is truly verified. The dev machine is macOS, so these steps **must be run on Windows (and ideally Linux) before merge** (spec §12).

Decision logic is kept in small pure functions for clarity, but is verified via the gates above, not unit tests.

## Global Constraints

- **Platforms:** the tray and hide-to-tray behavior are **Windows + Linux only**; **macOS is unchanged** (no tray; keeps dock badge and current close/quit behavior).
- **Code style (Biome):** 2-space indent, single quotes, **no semicolons**, 120-char line width. Import alias `@/` → `./src/`. `src/main.ts` uses relative imports (`./tray`), not `@/`.
- **No new runtime dependencies** and **no new test framework**.
- **Indicator color:** `#ef4444` (matches the existing badge).
- **Tooltip text:** `` `${count} 条未读消息` `` when unread, `'LAPLACE Comet'` otherwise.
- **One-time hint text:** `'LAPLACE Comet 仍在后台运行，可从系统托盘重新打开。'`
- **Tray menu labels:** `'打开 LAPLACE Comet'` and `'退出'`. **Quit accelerator:** `'CmdOrCtrl+Q'`.
- **Out of scope (flagged, do not implement):** the existing `createBadgeIcon` taskbar overlay builds from an SVG buffer that `nativeImage` cannot decode — a separate latent issue, not addressed here.

## File Structure

| File                                                                       | Responsibility                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `scripts/generate-icons.ts` (modify)                                       | Emit `tray.png` + `tray-unread.png` (dev/prod) and the base64 `tray-icons.generated.ts`.                |
| `src/assets/icons/{dev,prod}/tray.png`, `tray-unread.png` (new, generated) | Source tray images (committed).                                                                         |
| `src/assets/tray-icons.generated.ts` (new, generated)                      | `TRAY_ICONS` data-URL map consumed by the tray module.                                                  |
| `src/tray.ts` (new)                                                        | All main-process tray logic: create/destroy, unread indicator, shared `focusMainWindow`, one-time hint. |
| `src/main.ts` (modify)                                                     | Wire the tray into the app lifecycle; refactor duplicated focus logic; add quit path.                   |
| `package.json`, `.eslintrc.json`, `biome.jsonc` (modify)                   | `typecheck` script + ignore the generated module.                                                       |

---

### Task 1: Tray icon assets, generator, and embedded data-URL module

**Files:**

- Modify: `package.json` (scripts)
- Modify: `.eslintrc.json` (ignorePatterns)
- Modify: `biome.jsonc` (files.includes)
- Modify: `scripts/generate-icons.ts`
- Create (generated, committed): `src/assets/icons/dev/tray.png`, `src/assets/icons/dev/tray-unread.png`, `src/assets/icons/prod/tray.png`, `src/assets/icons/prod/tray-unread.png`
- Create (generated, committed): `src/assets/tray-icons.generated.ts`

**Interfaces:**

- Produces: `export const TRAY_ICONS` in `src/assets/tray-icons.generated.ts` with shape `{ dev: { normal: string; unread: string }; prod: { normal: string; unread: string } }`, where every value is a `data:image/png;base64,…` string. Consumed by Task 2.

**Prerequisites:** ImageMagick (`magick`) and `bun` must be installed (`brew install imagemagick bun`). The generator already errors with install instructions if `magick` is missing.

- [ ] **Step 1: Add a `typecheck` script to package.json**

In `package.json`, add the `typecheck` line to `scripts` (after `lint`):

```json
    "lint": "eslint --ext .ts,.tsx .",
    "typecheck": "tsc --noEmit",
    "generate-icons": "bun run scripts/generate-icons.ts"
```

- [ ] **Step 2: Ignore the generated module in ESLint**

In `.eslintrc.json`, add the generated file to `ignorePatterns`:

```json
  "ignorePatterns": ["node_modules/", "dist/", "out/", "references/", "src/assets/tray-icons.generated.ts"],
```

- [ ] **Step 3: Ignore the generated module in Biome**

In `biome.jsonc`, add a negation to `files.includes` (after `"!references"`):

```jsonc
      "!references",
      "!src/assets/tray-icons.generated.ts",
      "!storybook-static"
```

- [ ] **Step 4: Extend the fs import and add the tray size constant in `scripts/generate-icons.ts`**

Change the `node:fs` import:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
```

Add this constant immediately after the `windowsSizes` declaration (near the top, before `iconConfigs`):

```ts
// Tray icon: a single 32x32 base, plus an "unread" variant with a red dot
// composited into the top-right corner. Generated for dev and prod only.
const TRAY_SIZE = 32
```

- [ ] **Step 5: Add the tray generation functions in `scripts/generate-icons.ts`**

Insert these three functions immediately before `function generateIconsForEnvironment(`:

```ts
function generateTrayIcons(sourceIcon: string, outputDir: string, description: string) {
  console.log(`Generating ${description} tray icons...`)
  ensureDirectoryExists(outputDir)

  const normalPath = path.join(outputDir, 'tray.png')
  const unreadPath = path.join(outputDir, 'tray-unread.png')

  try {
    execSync(`magick "${sourceIcon}" -resize ${TRAY_SIZE}x${TRAY_SIZE} "${normalPath}"`, { stdio: 'inherit' })
    // White halo (radius 9) then a red dot (radius 6) in the top-right corner,
    // so the badge stays legible when Windows downscales the icon to ~16px.
    execSync(
      `magick "${normalPath}" -fill white -draw "circle 23,9 23,0" -fill "#ef4444" -draw "circle 23,9 23,3" "${unreadPath}"`,
      { stdio: 'inherit' }
    )
    console.log(`✓ Generated ${description} tray.png + tray-unread.png`)
  } catch (error) {
    console.error(`Failed to generate ${description} tray icons:`, error)
  }
}

function pngToDataUrl(pngPath: string): string {
  const base64 = readFileSync(pngPath).toString('base64')
  return `data:image/png;base64,${base64}`
}

function generateTrayIconModule() {
  const envs = (['dev', 'prod'] as const).filter(env => {
    const dir = iconConfigs[env].outputDir
    return existsSync(path.join(dir, 'tray.png')) && existsSync(path.join(dir, 'tray-unread.png'))
  })

  if (envs.length === 0) {
    console.error('No tray icons found; skipping tray-icons.generated.ts')
    return
  }

  const body = envs
    .map(env => {
      const dir = iconConfigs[env].outputDir
      const normal = pngToDataUrl(path.join(dir, 'tray.png'))
      const unread = pngToDataUrl(path.join(dir, 'tray-unread.png'))
      return `  ${env}: {\n    normal: '${normal}',\n    unread: '${unread}',\n  },`
    })
    .join('\n')

  const content = `// AUTO-GENERATED by scripts/generate-icons.ts — do not edit by hand.
// Tray icons are embedded as base64 PNG data URLs so they resolve identically
// in development and in packaged (asar) builds with no filesystem path lookup.

export const TRAY_ICONS = {
${body}
} as const
`

  writeFileSync('src/assets/tray-icons.generated.ts', content)
  console.log('✓ Generated src/assets/tray-icons.generated.ts')
}
```

- [ ] **Step 6: Call the tray functions from the generator flow**

In `generateIconsForEnvironment`, after the three existing `generate…Icon(config.source, …)` calls, add:

```ts
if (environment === 'dev' || environment === 'prod') {
  generateTrayIcons(config.source, config.outputDir, config.description)
}
```

In `main()`, call `generateTrayIconModule()` after the all-environments loop **and** after the single-environment call. In the no-argument branch, immediately after the `Object.keys(iconConfigs).forEach(...)` loop:

```ts
Object.keys(iconConfigs).forEach(env => {
  generateIconsForEnvironment(env)
})

generateTrayIconModule()
```

In the single-argument branch, immediately after `generateIconsForEnvironment(environment)`:

```ts
generateIconsForEnvironment(environment)
generateTrayIconModule()
```

- [ ] **Step 7: Generate the assets**

Run: `pnpm generate-icons`
Expected: output includes `✓ Generated Development tray.png + tray-unread.png`, `✓ Generated Production tray.png + tray-unread.png`, and `✓ Generated src/assets/tray-icons.generated.ts`. (Run the no-argument form so **both** dev and prod end up in the module.)

- [ ] **Step 8: Verify the generated files**

Run: `ls src/assets/icons/dev/tray*.png src/assets/icons/prod/tray*.png && head -c 120 src/assets/tray-icons.generated.ts && grep -c "data:image/png;base64," src/assets/tray-icons.generated.ts`
Expected: all four PNGs listed; the file begins with the `// AUTO-GENERATED` comment; the grep count is `4` (dev normal+unread, prod normal+unread).

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: no output, exit code 0.

- [ ] **Step 10: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add package.json .eslintrc.json biome.jsonc scripts/generate-icons.ts src/assets/icons/dev/tray.png src/assets/icons/dev/tray-unread.png src/assets/icons/prod/tray.png src/assets/icons/prod/tray-unread.png src/assets/tray-icons.generated.ts
git commit -m "feat: generate tray icons and embedded data-url module"
```

---

### Task 2: Create the `src/tray.ts` module

**Files:**

- Create: `src/tray.ts`

**Interfaces:**

- Consumes: `TRAY_ICONS` from `@/assets/tray-icons.generated` (Task 1).
- Produces (all consumed by `src/main.ts` in Tasks 3–5):
  - `export function createTray(): void`
  - `export function destroyTray(): void`
  - `export function updateTrayUnread(count: number): void`
  - `export function focusMainWindow(): BrowserWindow | null`
  - `export function maybeShowTrayHint(): void`

This module is not imported anywhere yet, so it has no runtime effect this task; `tsc` still typechecks it because `tsconfig.json` includes `src/**/*`.

- [ ] **Step 1: Create `src/tray.ts` with full content**

```ts
import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron'
import Store from 'electron-store'

import { TRAY_ICONS } from '@/assets/tray-icons.generated'

// The tray is only meaningful on Windows and Linux. macOS keeps its dock UX.
function isTraySupported(): boolean {
  return process.platform === 'win32' || process.platform === 'linux'
}

// Mirror forge.config.ts: dev builds use the dev icon set, everything else prod.
const iconEnv = process.env.NODE_ENV === 'development' ? 'dev' : 'prod'

let tray: Tray | null = null
let normalIcon: Electron.NativeImage | null = null
let unreadIcon: Electron.NativeImage | null = null

// Tracks the last unread state so the tray image is only swapped when crossing
// the zero boundary (e.g. 3 -> 4 updates the tooltip but not the image).
let lastHadUnread: boolean | null = null

// One-shot "still running in the tray" hint, persisted so it shows only once.
interface AppPrefsSchema {
  hasShownTrayHint: boolean
}
const prefsStore = new Store<AppPrefsSchema>({
  name: 'app-prefs',
  defaults: { hasShownTrayHint: false },
})

function getIcons(): { normal: Electron.NativeImage; unread: Electron.NativeImage } {
  if (!normalIcon) normalIcon = nativeImage.createFromDataURL(TRAY_ICONS[iconEnv].normal)
  if (!unreadIcon) unreadIcon = nativeImage.createFromDataURL(TRAY_ICONS[iconEnv].unread)
  return { normal: normalIcon, unread: unreadIcon }
}

/**
 * Restore, show, and focus the main window, working around the Windows
 * ForegroundLockTimeout that otherwise prevents apps from stealing focus.
 * Returns the window so callers can post follow-up messages to it.
 */
export function focusMainWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null

  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()

  if (process.platform === 'darwin') {
    app.dock?.show()
    app.focus({ steal: true })
  }

  if (process.platform === 'win32') {
    win.setAlwaysOnTop(true)
    win.focus()
    win.setAlwaysOnTop(false)
  }

  return win
}

function buildContextMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: '打开 LAPLACE Comet', click: () => focusMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
}

/** Create the tray icon (Windows/Linux only). No-op elsewhere or if already created. */
export function createTray(): void {
  if (!isTraySupported() || tray) return

  const { normal } = getIcons()
  tray = new Tray(normal)
  tray.setToolTip('LAPLACE Comet')
  tray.setContextMenu(buildContextMenu())
  tray.on('click', () => focusMainWindow())
  tray.on('double-click', () => focusMainWindow())
}

/** Destroy the tray icon and release its resources. */
export function destroyTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
  lastHadUnread = null
}

/**
 * Update the tray to reflect the current unread count. The tooltip always
 * reflects the latest count; the icon image only swaps when crossing the zero
 * boundary. No-op when there is no tray (e.g. macOS).
 */
export function updateTrayUnread(count: number): void {
  if (!tray) return

  const hasUnread = count > 0
  tray.setToolTip(hasUnread ? `${count} 条未读消息` : 'LAPLACE Comet')

  if (lastHadUnread === hasUnread) return
  lastHadUnread = hasUnread

  const { normal, unread } = getIcons()
  tray.setImage(hasUnread ? unread : normal)
}

/**
 * The first time the window is hidden to the tray, show a one-shot
 * notification so users know the app is still running. Persisted via
 * electron-store so it never repeats.
 */
export function maybeShowTrayHint(): void {
  if (prefsStore.get('hasShownTrayHint')) return
  if (!Notification.isSupported()) return

  new Notification({
    title: 'LAPLACE Comet',
    body: 'LAPLACE Comet 仍在后台运行，可从系统托盘重新打开。',
  }).show()

  prefsStore.set('hasShownTrayHint', true)
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no output, exit code 0. (If it errors with a missing `dev`/`prod` key on `TRAY_ICONS`, re-run `pnpm generate-icons` with no arguments so both environments are present.)

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/tray.ts
git commit -m "feat: add system tray module (create/indicator/focus/hint)"
```

---

### Task 3: Extract `focusMainWindow()` and refactor existing call sites

No behavior change — replaces two duplicated copies of the restore/show/focus logic with the shared helper from Task 2.

**Files:**

- Modify: `src/main.ts` (import; `second-instance` handler; notification `click` handler)

**Interfaces:**

- Consumes: `focusMainWindow` from `./tray` (Task 2).

- [ ] **Step 1: Import `focusMainWindow`**

In `src/main.ts`, add after the existing `import { IpcChannel, IpcEvent } from './lib/ipc'` line:

```ts
import { focusMainWindow } from './tray'
```

- [ ] **Step 2: Refactor the `second-instance` handler**

Replace the entire body of the `app.on('second-instance', …)` callback (currently the `const windows = …` block through the `if (mainWindow) { … }` block):

```ts
app.on('second-instance', () => {
  focusMainWindow()
})
```

- [ ] **Step 3: Refactor the notification `click` handler**

In the `SHOW_NOTIFICATION` handler, replace the `notification.on('click', …)` body's window lookup + focus dance with the shared helper, keeping the navigation send:

```ts
notification.on('click', () => {
  console.log('[Notification] Click received, navigating to session:', params.talkerId)

  const mainWindow = focusMainWindow()

  if (mainWindow) {
    mainWindow.webContents.send(IpcEvent.BILIBILI_NAVIGATE_TO_SESSION, {
      talkerId: params.talkerId,
      sessionType: params.sessionType,
    })
  } else {
    console.error('[Notification] No main window found')
  }

  // Clean up reference
  activeNotifications.delete(notification)
})
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: no output, exit code 0.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: no errors. (In particular, no `no-unused-vars` for the removed inline logic.)

- [ ] **Step 6: Build smoke (macOS dev machine)**

Run: `pnpm start`
Expected: the app launches with no errors in the terminal. Close it (Cmd+Q). This confirms `main.ts` still compiles/bundles and imports `./tray` cleanly. (Notification-click and second-instance behavior are unchanged and are verified end-to-end in Task 6.)

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "refactor: share focusMainWindow between second-instance and notification click"
```

---

### Task 4: Hide-to-tray window lifecycle, quit path, and one-time hint

**Files:**

- Modify: `src/main.ts` (import; `isQuitting` flag; `createWindow` close handler; `ready` handler; `before-quit` handler; application menu quit item)

**Interfaces:**

- Consumes: `createTray`, `destroyTray`, `maybeShowTrayHint` from `./tray` (Task 2); `focusMainWindow` already imported in Task 3.

- [ ] **Step 1: Extend the tray import**

In `src/main.ts`, change the tray import line to:

```ts
import { createTray, destroyTray, focusMainWindow, maybeShowTrayHint } from './tray'
```

- [ ] **Step 2: Add the `isQuitting` flag**

Add immediately after the `__dirname` definition near the top of `src/main.ts`:

```ts
// Set to true once the user explicitly quits (tray menu, Ctrl+Q, or an update
// install) so the window 'close' handler stops hiding to the tray and lets the
// app actually exit.
let isQuitting = false
```

- [ ] **Step 3: Add the close-to-tray handler in `createWindow`**

In `createWindow()`, after the `if (process.env.NODE_ENV === 'development') { … openDevTools() }` block and before the closing `}` of the function, add:

```ts
// On Windows/Linux, closing the window hides it to the tray instead of
// quitting, so the app keeps receiving messages in the background. A real
// quit (tray menu / Ctrl+Q / update install) sets isQuitting first.
mainWindow.on('close', event => {
  if (!isQuitting && (process.platform === 'win32' || process.platform === 'linux')) {
    event.preventDefault()
    mainWindow.hide()
    maybeShowTrayHint()
  }
})
```

- [ ] **Step 4: Create the tray on `ready`**

Update the `app.on('ready', …)` handler:

```ts
app.on('ready', () => {
  createApplicationMenu()
  createWindow()
  createTray()
})
```

- [ ] **Step 5: Set `isQuitting` and destroy the tray on `before-quit`**

Update the existing `app.on('before-quit', …)` handler:

```ts
app.on('before-quit', () => {
  isQuitting = true
  destroyTray()
  cleanupBroadcastWebSocket()
})
```

- [ ] **Step 6: Add a Ctrl+Q quit item to the non-macOS Window menu**

In `createApplicationMenu`, in the Window menu's `submenu`, replace the non-macOS branch `: [{ role: 'close' as const, label: '关闭' }]` with:

```ts
          : [
              { role: 'close' as const, label: '关闭' },
              { type: 'separator' as const },
              { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
            ]),
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no output, exit code 0.

- [ ] **Step 8: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 9: Build smoke + macOS regression**

Run: `pnpm start`
Expected: app launches with no errors. On macOS, closing the window behaves exactly as before (the close handler's guard excludes darwin — the window is **not** hidden to a tray, and no tray icon appears). Quit with Cmd+Q.

- [ ] **Step 10: Manual verification — Windows/Linux (cannot be done on macOS)**

On a Windows (and ideally Linux) build (`pnpm start` or a packaged build):

- A tray icon appears with the correct dev/prod image and tooltip `LAPLACE Comet`.
- Clicking the window's `[X]` (and `Alt+F4`) **hides** the window to the tray; the app keeps running.
- The **first** hide shows the notification `LAPLACE Comet 仍在后台运行，…` exactly once (not on subsequent hides).
- The minimize button still minimizes to the taskbar (not the tray).
- Tray left-click / double-click and the menu item `打开 LAPLACE Comet` restore and focus the window.
- Tray menu `退出` quits the app; `Ctrl+Q` quits the app.

- [ ] **Step 11: Commit**

```bash
git add src/main.ts
git commit -m "feat: hide window to system tray on close (Windows/Linux)"
```

---

### Task 5: New-message tray indicator

**Files:**

- Modify: `src/main.ts` (import; `APP_SET_BADGE_COUNT` handler)

**Interfaces:**

- Consumes: `updateTrayUnread` from `./tray` (Task 2).

- [ ] **Step 1: Extend the tray import**

In `src/main.ts`, change the tray import line to:

```ts
import { createTray, destroyTray, focusMainWindow, maybeShowTrayHint, updateTrayUnread } from './tray'
```

- [ ] **Step 2: Drive the tray from the existing badge handler**

In the `ipcMain.handle(IpcChannel.APP_SET_BADGE_COUNT, …)` handler, add `updateTrayUnread(count)` as the first statement, before the `if (process.platform === 'darwin')` block:

```ts
ipcMain.handle(IpcChannel.APP_SET_BADGE_COUNT, (_event, count: number) => {
  // Reflect unread state on the system tray (Windows/Linux); no-op elsewhere.
  updateTrayUnread(count)

  if (process.platform === 'darwin') {
```

(The rest of the handler is unchanged.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no output, exit code 0.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 5: Build smoke (macOS)**

Run: `pnpm start`
Expected: app launches with no errors; `updateTrayUnread` is a no-op on macOS (no tray). Quit.

- [ ] **Step 6: Manual verification — Windows/Linux (cannot be done on macOS)**

On a Windows/Linux build, logged in with at least one unread conversation:

- With unread messages, the tray icon shows the **red dot** variant and the tooltip reads `N 条未读消息`.
- Reading all messages (unread → 0) returns the tray icon to the **normal** variant with tooltip `LAPLACE Comet`.
- Receiving a new message **while hidden in the tray** lights the dot (the renderer/WebSocket stay alive while hidden).

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat: show unread red-dot indicator on the tray icon"
```

---

### Task 6: Full verification pass (manual, Windows/Linux + macOS regression)

**Files:** none (verification + spec status update only).

This consolidates the end-to-end behavior, including interactions not covered by single tasks. The dev machine is macOS, so the Windows/Linux items must be run on those platforms.

- [ ] **Step 1: Windows end-to-end checklist**

Verify on Windows (spec §11–§12):

- Close/`Alt+F4` hides to tray; tray icon present with correct dev/prod image.
- New message → red dot + tooltip count; reading all → dot clears.
- Tray click / `打开` → restore + focus; tray `退出` → exits; `Ctrl+Q` → exits.
- Launching a second instance focuses the existing (possibly tray-hidden) window.
- Clicking a desktop notification restores/focuses the window and navigates to the session.
- Triggering an app update install (auto-updater) actually quits and installs (the `isQuitting` flag lets the close handler through).
- First hide shows the one-time hint exactly once across restarts.

- [ ] **Step 2: Linux smoke**

Tray icon appears (DE-dependent); context menu opens; `打开`/`退出` work; close hides to tray.

- [ ] **Step 3: macOS regression**

No tray icon; closing/quitting behave as before; the dock badge still reflects unread count.

- [ ] **Step 4: Mark the spec implemented and commit**

In `docs/superpowers/specs/2026-06-26-windows-system-tray-design.md`, change the `Status:` line to `Implemented & verified`.

```bash
git add docs/superpowers/specs/2026-06-26-windows-system-tray-design.md
git commit -m "docs: mark system tray spec implemented"
```

---

## Self-Review

**Spec coverage:**

- §2 hide-to-tray on close → Task 4 ✓ · quit via tray/Ctrl+Q → Task 4 ✓ · red-dot indicator → Tasks 1,2,5 ✓ · Windows+Linux only, macOS unchanged → Task 2 (`isTraySupported`), Task 4 (close guard) ✓ · no flashFrame → not implemented ✓ · `src/tray.ts` location → Task 2 ✓
- §4 reuse badge flow, no new IPC → Task 5 ✓
- §5 `isQuitting`, close handler, Ctrl+Q → Task 4 ✓
- §6 indicator behavior, tooltip, zero-boundary guard → Task 2 (`updateTrayUnread`) + Task 5 (wiring) ✓
- §7 generation + data-URL module → Task 1 ✓
- §8 `focusMainWindow` refactor → Task 3 ✓
- §9 one-time hint → Task 2 (`maybeShowTrayHint`) + Task 4 (call site) ✓
- §10 platform matrix → guards in Tasks 2/4 ✓
- §11 edge cases → Task 6 ✓
- §12 verification → Tasks 4,5,6 ✓
- §13 files → all listed in File Structure ✓
- §14 risks → data-URL approach (Task 1) sidesteps asar path resolution; dot legibility tuned in Task 1; Linux variance noted in Task 6 ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/vague steps — every code step shows the exact code; every verify step shows the exact command and expected result.

**Type consistency:** `createTray`/`destroyTray`/`updateTrayUnread(count: number)`/`focusMainWindow(): BrowserWindow | null`/`maybeShowTrayHint` are defined in Task 2 and consumed with identical names/signatures in Tasks 3–5. `TRAY_ICONS` shape in Task 1 matches the `TRAY_ICONS[iconEnv].normal/.unread` access in Task 2.
