import { app, BrowserWindow, Menu, type NativeImage, Notification, nativeImage, Tray } from 'electron'
import Store from 'electron-store'

import { DEFAULT_NOTIFICATION_SOUNDS } from '@/lib/notification-sounds'

import { prepareNotificationSound } from '@/api/notification-sounds'
import { TRAY_ICONS } from '@/assets/tray-icons.generated'

// The tray is only meaningful on Windows and Linux. macOS keeps its dock UX.
function isTraySupported(): boolean {
  return process.platform === 'win32' || process.platform === 'linux'
}

// Mirror forge.config.ts: dev builds use the dev icon set, everything else prod.
const iconEnv = process.env.NODE_ENV === 'development' ? 'dev' : 'prod'

let tray: Tray | null = null
let normalIcon: NativeImage | null = null
let unreadIcon: NativeImage | null = null

// Tracks the last unread state so the tray image is only swapped when crossing
// the zero boundary (e.g. 3 -> 4 updates the tooltip but not the image).
let lastHadUnread: boolean | null = null

// One-shot "still running in the tray" hint, persisted so it shows only once,
// plus the user's chosen system notification sound for main-process notifications.
interface AppPrefsSchema {
  hasShownTrayHint: boolean
  systemNotificationSound: string
}
// Constructed lazily inside maybeShowTrayHint's try/catch, never at module load:
// `new Store()` reads and writes the prefs file on construction, which can throw
// on an unreadable/locked path or a path that is a directory — that would crash
// the main process before any window opens. (clearInvalidConfig only heals
// malformed content, not filesystem errors.)
let prefsStore: Store<AppPrefsSchema> | null = null
function getPrefsStore(): Store<AppPrefsSchema> {
  if (!prefsStore) {
    prefsStore = new Store<AppPrefsSchema>({
      name: 'app-prefs',
      defaults: {
        hasShownTrayHint: false,
        systemNotificationSound: DEFAULT_NOTIFICATION_SOUNDS.system,
      },
      clearInvalidConfig: true,
    })
  }
  return prefsStore
}

/** Sync the renderer's `notificationSounds.system` setting for main-process notifications. */
export function setSystemNotificationSoundPref(soundId: string): void {
  if (!isTraySupported()) return
  try {
    const store = getPrefsStore()
    if (store.get('systemNotificationSound') === soundId) return
    store.set('systemNotificationSound', soundId)
  } catch (err) {
    console.error('[Tray] saving systemNotificationSound failed (non-fatal):', err)
  }
}

function getIcons(): { normal: NativeImage; unread: NativeImage } {
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
  // Resolve the window at call time (not at registration), so a notification-click
  // handler registered earlier still focuses the current window.
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

function buildContextMenu(): Menu {
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
  // A best-effort one-time hint must never bubble out of the window 'close'
  // handler — guard store construction and every read/write (e.g. an unreadable
  // prefs file or a path that is a directory).
  try {
    const store = getPrefsStore()
    if (store.get('hasShownTrayHint')) return
    if (!Notification.isSupported()) return

    const soundId = store.get('systemNotificationSound') || DEFAULT_NOTIFICATION_SOUNDS.system
    const soundOpts = prepareNotificationSound(soundId)

    const notification = new Notification({
      title: 'LAPLACE Comet',
      body: 'LAPLACE Comet 仍在后台运行，可从系统托盘重新打开。',
      silent: soundOpts.silent,
      ...(soundOpts.sound ? { sound: soundOpts.sound } : {}),
    })
    notification.show()
    soundOpts.afterShow?.()

    store.set('hasShownTrayHint', true)
  } catch (err) {
    console.error('[Tray] tray hint failed (non-fatal):', err)
  }
}
