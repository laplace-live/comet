# Windows System Tray + New-Message Indicator — Design

- **Date:** 2026-06-26
- **Status:** Approved design (pre-implementation)
- **Surface:** Electron main process — `src/main.ts`, new `src/tray.ts`, `scripts/generate-icons.ts`, generated tray icon assets

## 1. Goal

Let LAPLACE Comet keep running in the background on Windows (and Linux) instead of quitting when the window is closed, and surface new/unread private messages through a system-tray icon indicator.

## 2. Locked decisions

| Decision                       | Choice                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Close button `[X]` / `Alt+F4`  | **Hide window to tray** — app keeps running, WebSocket stays connected, notifications keep firing. No setting; hardcoded.            |
| Real quit path                 | Tray menu **退出** and a **Ctrl+Q** accelerator (Windows/Linux).                                                                     |
| New-message indicator          | **Static red-dot badge** baked into an alternate tray icon, driven by the existing total-unread count. Clears when unread reaches 0. |
| Platforms                      | **Windows + Linux** get the tray. **macOS unchanged** (no tray; keeps dock badge and current close/quit behavior).                   |
| macOS dev escape hatch         | **Dropped** — no macOS tray code path.                                                                                               |
| `flashFrame` taskbar attention | **Deferred** — not in scope.                                                                                                         |
| Module location                | **`src/tray.ts`** (main-process only, sibling to `main.ts`).                                                                         |

## 3. Non-goals

- No user-facing settings/toggles (hide-to-tray is hardcoded).
- No tray account switcher or DND controls — the menu stays minimal (YAGNI).
- No numeric count rendered on the tray icon (static dot only).
- No change to macOS behavior.
- Not auditing/fixing the existing Windows taskbar overlay badge (see §8 note); the tray indicator does not depend on it.

## 4. Architecture (Approach A — reuse the existing unread signal)

The renderer already computes `totalUnread` and pushes it to the main process on every `sessions` change:

`usePrivateMessages.ts:1606` → `window.electronAPI.setBadgeCount(totalUnread)` → IPC `APP_SET_BADGE_COUNT` → handler in `main.ts:281` (already branches per platform).

The tray indicator hooks into **that same handler**. Result: **no new IPC channels, no preload changes, no renderer changes.**

New main-only module **`src/tray.ts`** owns the `Tray` instance and exports:

- `createTray()` — called on `ready` (Windows/Linux only). Loads the normal icon, sets tooltip + context menu, wires click → `focusMainWindow()`.
- `destroyTray()` — called on `before-quit` to release the icon promptly.
- `updateTrayUnread(count: number)` — swaps to the dot icon when `count > 0`, back to normal at `0`, updates the tooltip. Guards against redundant `setImage` calls by tracking whether the last state already had unread.
- `focusMainWindow()` — the shared restore→show→focus→(Windows `setAlwaysOnTop` dance) helper, replacing three duplicated copies (see §8).

## 5. Window lifecycle & quit semantics

- Add a module-level `isQuitting` flag in `main.ts`. The **existing** `before-quit` handler (`main.ts:524`, currently WebSocket cleanup) also sets `isQuitting = true` and calls `destroyTray()`.
- In `createWindow()`, add a `close` handler:

  ```ts
  mainWindow.on('close', (e) => {
    if (!isQuitting && (process.platform === 'win32' || process.platform === 'linux')) {
      e.preventDefault()
      mainWindow.hide()
      maybeShowTrayHint() // §9
    }
  })
  ```

  So `[X]` and `Alt+F4` hide to tray; the minimize button still minimizes to the taskbar; macOS is never intercepted.
- The `isQuitting` flag is what lets the **tray "退出", Ctrl+Q, and the auto-updater's quit-and-install** actually exit (otherwise the `close` handler would trap them). The tray menu's quit simply calls `app.quit()`, which fires `before-quit` → sets the flag → the now-unguarded `close` proceeds.
- Add a real quit affordance for non-macOS: a menu item with `role: 'quit'`, label `退出`, accelerator `CmdOrCtrl+Q`. (Today the non-mac Window menu only has `关闭`, which now hides — so without this there is no keyboard quit.)
- `window-all-closed` (quits non-darwin) is unchanged: with hide-to-tray the window is never destroyed during normal use, so it only fires during a real quit — harmless safety net.

## 6. New-message indicator (static red dot)

- Two pre-rendered images loaded once at tray creation: **normal** and **unread** (red dot composited into a corner).
- The `APP_SET_BADGE_COUNT` handler additionally calls `updateTrayUnread(count)`:
  - `count > 0` → `tray.setImage(unreadIcon)`, tooltip `"{count} 条未读消息"`.
  - `count === 0` → `tray.setImage(normalIcon)`, tooltip `"LAPLACE Comet"`.
- Because the window only **hides** (never closes/destroys), the renderer stays alive in the tray, the WebSocket → renderer → `setBadgeCount` flow keeps running, and the dot updates live and **clears automatically when messages are read** (unread → 0). On launch with existing unread, the first `sessions` load lights the dot.
- The dot mirrors whatever the existing badge reports (same number, same account scope) — no new unread semantics are introduced.

## 7. Tray icon assets & loading

**Generation.** Extend `scripts/generate-icons.ts` to emit, for `dev` and `prod`, a 32×32 `tray.png` from the environment source icon and a `tray-unread.png` with a red circle composited into a corner (same ImageMagick `magick` pipeline already used). Main selects dev vs prod the same way `forge.config.ts` does (`NODE_ENV === 'development'`). Generated PNGs are committed so builds don't require running the script.

**Loading (primary approach — data URLs).** To resolve reliably in _both_ `pnpm start` and a packaged asar build without filesystem/asar path guesswork, the generator also emits a tiny generated module (e.g. `src/assets/tray-icons.generated.ts`) exporting the PNGs as base64 data URLs; `tray.ts` builds images via `nativeImage.createFromDataURL(...)`. The bytes live in the JS bundle, so there is no runtime path to resolve. 32px PNGs are ~1–2 KB each, negligible.

**Alternative (if preferred):** `nativeImage.createFromPath()` with a Vite-asset-resolved path (`new URL('./assets/...', import.meta.url)` → `fileURLToPath`). This must be verified against a packaged build (asar) — hence the data-URL approach is the default.

## 8. `focusMainWindow()` refactor + note

The restore→show→focus→(Windows `setAlwaysOnTop`) sequence is currently duplicated in `second-instance` (`main.ts:39`) and the notification `click` (`main.ts:212`). Extract it once into `focusMainWindow()` in `src/tray.ts` and reuse it in both, plus the tray click — 3 copies → 1. The notification-click path keeps its extra `BILIBILI_NAVIGATE_TO_SESSION` send after focusing. Like the existing code, the helper resolves the window via `BrowserWindow.getAllWindows()[0]` (single-window app).

> **Note (out of scope, flagged):** the existing `createBadgeIcon` (`main.ts:260`) builds the taskbar overlay from an **SVG** buffer, but `nativeImage` renders PNG/JPEG only (not SVG) — so that overlay may be a latent no-op. The tray indicator sidesteps this entirely by using pre-rendered PNGs. Auditing/fixing the overlay is a separate task.

## 9. One-time "still running" hint

The first time the window hides to tray, show a one-shot notice — _"LAPLACE Comet 仍在后台运行，可从系统托盘重新打开"_ — via a `Notification`. Gate it with a `hasShownTrayHint` flag in a small dedicated `electron-store` instance (separate from the accounts store at `bilibili.ts:153`), so it never repeats.

## 10. Platform matrix

| Behavior                    | Windows            | Linux              | macOS                  |
| --------------------------- | ------------------ | ------------------ | ---------------------- |
| Tray icon                   | ✅                 | ✅ (DE-dependent)  | ❌ (unchanged)         |
| `[X]` hides to tray         | ✅                 | ✅                 | ❌ (current behavior)  |
| Tray red-dot indicator      | ✅                 | ✅                 | n/a                    |
| Existing overlay/dock badge | taskbar overlay    | n/a                | dock badge (unchanged) |
| Quit                        | tray menu / Ctrl+Q | tray menu / Ctrl+Q | Cmd+Q (unchanged)      |

## 11. Edge cases

- **Auto-update install:** `quitAndInstall` → `before-quit` sets `isQuitting` → window close allowed → installs. ✅
- **Second instance:** `focusMainWindow()` un-hides a tray-hidden window. ✅
- **Notification click:** `focusMainWindow()` + navigate. ✅
- **Hidden in tray:** renderer/WebSocket stay alive → indicator updates live. ✅
- **Linux DE without a tray `click` event:** context-menu **打开** is the reliable path. ✅
- **Redundant updates:** `updateTrayUnread` only calls `setImage` when crossing the 0 boundary, avoiding churn on every sessions tick.

## 12. Verification plan

The dev machine is **macOS**, and the escape hatch was dropped, so the tray and close-to-tray paths **cannot be exercised locally** — they must be verified on Windows/Linux before merge.

- **Windows (primary):** close/`Alt+F4` hides to tray; tray present with correct dev/prod icon; new message → red dot + tooltip count; click tray → restore + focus; read messages → dot clears; tray **退出** exits; **Ctrl+Q** exits; auto-update still installs; second instance focuses; first hide shows the one-time hint once.
- **Linux:** smoke test — tray present, menu opens, hide/show works.
- **macOS:** regression — confirm unchanged (no tray, same close/quit, dock badge intact).

## 13. Files changed

- `src/tray.ts` — **new** (Tray ownership, indicator, `focusMainWindow`).
- `src/main.ts` — create tray on `ready`; `close` → hide + `isQuitting`; set flag + `destroyTray()` in `before-quit`; call `updateTrayUnread()` in the badge handler; add non-mac Ctrl+Q quit; refactor duplicated focus logic to `focusMainWindow()`.
- `scripts/generate-icons.ts` — emit `tray.png` + `tray-unread.png` (dev/prod) and the base64 tray-icons module.
- `src/assets/icons/{dev,prod}/tray.png`, `tray-unread.png` — **new** (generated, committed).
- `src/assets/tray-icons.generated.ts` — **new** (generated data-URL module; primary loading approach).

## 14. Implementation risks

1. **Main-process static asset loading in a packaged (asar) build** — mitigated by the base64 data-URL approach (no runtime path). Confirm in a packaged build during verification.
2. **Red-dot legibility** at 16px render — tune dot size/position in the generator.
3. **Linux tray DE variance** — accepted; the context menu is the reliable interaction.
