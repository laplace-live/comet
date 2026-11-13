import { type ChildProcess, execFile } from 'node:child_process'
import { type Dirent, readdirSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron'

import type { SystemNotificationSoundOption } from '@/lib/notification-sounds'
import type { NotificationSoundParams } from '@/types/electron'

import { IpcChannel, IpcEvent } from '@/lib/ipc'
import {
  CUSTOM_NOTIFICATION_SOUNDS,
  CUSTOM_SOUND_PREFIX,
  NOTIFICATION_SOUND_DEFAULT,
  NOTIFICATION_SOUND_NONE,
  SYSTEM_SOUND_PREFIX,
  WINDOWS_APP_USER_MODEL_ID,
} from '@/lib/notification-sounds'

/**
 * Mapping from classic `/System/Library/Sounds/<Stem>.aiff` filenames to the display names
 * shown in modern macOS System Settings › Sound (`AlertSounds.loctable`), keeping the classic
 * filename in parentheses so users familiar with either name can spot it immediately.
 */
export const MACOS_ALERT_SOUND_LABELS: Readonly<Record<string, string>> = {
  Basso: 'Mezzo (Basso)',
  Blow: 'Breeze (Blow)',
  Bottle: 'Pebble (Bottle)',
  Frog: 'Jump (Frog)',
  Funk: 'Funky (Funk)',
  Glass: 'Crystal (Glass)',
  Hero: 'Heroine (Hero)',
  Morse: 'Pong (Morse)',
  Ping: 'Sonar (Ping)',
  Pop: 'Bubble (Pop)',
  Purr: 'Pluck (Purr)',
  Sosumi: 'Sonumi (Sosumi)',
  Submarine: 'Submerge (Submarine)',
  Tink: 'Boop (Tink)',
}

/** Curated notification-appropriate system WAVs in `%SystemRoot%\Media` on Windows. */
export const WINDOWS_SYSTEM_SOUNDS: ReadonlyArray<{ fileName: string; label: string }> = [
  { fileName: 'Windows Notify System Generic.wav', label: '系统通用通知 (System Generic)' },
  { fileName: 'Windows Notify Messaging.wav', label: '即时消息 (Messaging)' },
  { fileName: 'Windows Notify Email.wav', label: '新邮件 (Email)' },
  { fileName: 'Windows Notify Calendar.wav', label: '日历提醒 (Calendar)' },
  { fileName: 'notify.wav', label: '经典通知 (Notify)' },
  { fileName: 'chimes.wav', label: '风铃 (Chimes)' },
  { fileName: 'chord.wav', label: '和弦 (Chord)' },
  { fileName: 'ding.wav', label: '叮 (Ding)' },
  { fileName: 'tada.wav', label: '号角 (Tada)' },
]

/** Curated Freedesktop sound theme files on Linux (`/usr/share/sounds/freedesktop/stereo`). */
export const LINUX_SYSTEM_SOUNDS: ReadonlyArray<{ fileName: string; label: string }> = [
  { fileName: 'message-new-instant.oga', label: '新消息 (Instant Message)' },
  { fileName: 'message.oga', label: '消息提示 (Message)' },
  { fileName: 'bell.oga', label: '铃声 (Bell)' },
  { fileName: 'dialog-information.oga', label: '系统提示 (Information)' },
  { fileName: 'complete.oga', label: '完成 (Complete)' },
]

const MACOS_SOUND_EXT_RE = /\.(aiff|caf|wav)$/i

export interface NotificationSoundEnvOptions {
  platform?: NodeJS.Platform
  isPackaged?: boolean
  appPath?: string
  resourcesPath?: string
  systemSoundsDir?: string
  appUserModelId?: string
  hasRendererWindow?: () => boolean
  sendPlayToRenderer?: (soundId: string) => void
  playMacFile?: (filePath: string) => void
  beep?: () => void
  canPlayWindowsSound?: () => boolean | Promise<boolean>
  queryWindowsRegistryKey?: (keyPath: string) => Promise<string | null>
  isScreenLocked?: () => boolean
}

export type ResolvedNotificationSound =
  | { kind: 'default' }
  | { kind: 'none' }
  | { kind: 'custom'; fileName: string; filePath: string }
  | { kind: 'system'; filePath: string }

export interface PreparedNotificationSound {
  silent: boolean
  sound?: string
  afterShow?: () => void | Promise<void>
}

let activePlaybackProcess: ChildProcess | null = null
let latestRendererSoundToken = 0

/** Kill any in-flight `afplay` process and cancel pending async notification sound triggers. */
export function stopActiveSoundPlayback(): void {
  latestRendererSoundToken++
  if (!activePlaybackProcess) return
  const proc = activePlaybackProcess
  activePlaybackProcess = null
  try {
    proc.kill()
  } catch {
    // Process already exited
  }
}

/** Play an audio file asynchronously on macOS via `/usr/bin/afplay`, replacing any prior playback. */
export function playMacAudioFile(filePath: string): void {
  stopActiveSoundPlayback()
  try {
    const proc = execFile('/usr/bin/afplay', [filePath], { windowsHide: true }, err => {
      if (activePlaybackProcess === proc) {
        activePlaybackProcess = null
      }
      if (err && !('killed' in err && err.killed)) {
        console.error('[NotificationSounds] afplay failed:', err.message)
      }
    })
    activePlaybackProcess = proc
  } catch (err) {
    console.error('[NotificationSounds] Failed to spawn afplay:', err)
  }
}

function defaultSystemSoundsDir(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/System/Library/Sounds'
  if (platform === 'win32') {
    const winRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
    return path.join(winRoot, 'Media')
  }
  return '/usr/share/sounds/freedesktop/stereo'
}

function isSafeBaseFileName(fileName: string): boolean {
  return (
    fileName.length > 0 &&
    fileName !== '.' &&
    fileName !== '..' &&
    !fileName.includes('/') &&
    !fileName.includes('\\') &&
    !fileName.includes('\0') &&
    fileName === path.posix.basename(fileName) &&
    fileName === path.win32.basename(fileName)
  )
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false
  } catch {
    return false
  }
}

async function isRegularFileEntry(dir: string, entry: Dirent): Promise<boolean> {
  if (entry.isFile()) return true
  if (entry.isDirectory()) return false
  try {
    return (await stat(path.join(dir, entry.name))).isFile()
  } catch {
    return false
  }
}

/**
 * List available OS system notification sounds on the current platform.
 * - macOS: built-in alert sounds from `/System/Library/Sounds` (excludes `~/Library/Sounds`).
 * - Windows: curated notification WAVs from `%SystemRoot%\Media`.
 * - Linux: curated Freedesktop stereo notification sounds.
 */
export async function listSystemNotificationSounds(
  options?: NotificationSoundEnvOptions
): Promise<SystemNotificationSoundOption[]> {
  const platform = options?.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    return []
  }

  const dir = options?.systemSoundsDir ?? defaultSystemSoundsDir(platform)

  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  if (platform === 'darwin') {
    const items: SystemNotificationSoundOption[] = []
    for (const entry of entries) {
      if (!isSafeBaseFileName(entry.name) || !MACOS_SOUND_EXT_RE.test(entry.name)) continue
      if (!(await isRegularFileEntry(dir, entry))) continue
      const stem = entry.name.replace(MACOS_SOUND_EXT_RE, '')
      const label = MACOS_ALERT_SOUND_LABELS[stem] ?? stem
      items.push({
        id: `${SYSTEM_SOUND_PREFIX}${entry.name}`,
        label,
      })
    }
    return items.sort((a, b) => a.label.localeCompare(b.label, 'en'))
  }

  const allowlist = platform === 'win32' ? WINDOWS_SYSTEM_SOUNDS : LINUX_SYSTEM_SOUNDS
  const byLower = new Map<string, Dirent>()
  for (const entry of entries) {
    if (isSafeBaseFileName(entry.name)) {
      byLower.set(entry.name.toLowerCase(), entry)
    }
  }

  const items: SystemNotificationSoundOption[] = []
  for (const candidate of allowlist) {
    const entry = byLower.get(candidate.fileName.toLowerCase())
    if (!entry) continue
    if (!(await isRegularFileEntry(dir, entry))) continue
    items.push({
      id: `${SYSTEM_SOUND_PREFIX}${entry.name}`,
      label: candidate.label,
    })
  }
  return items
}

function resolveSystemSoundFilePath(
  fileName: string,
  platform: NodeJS.Platform,
  systemSoundsDir: string
): string | null {
  if (!isSafeBaseFileName(fileName)) return null

  if (platform === 'darwin') {
    if (!MACOS_SOUND_EXT_RE.test(fileName)) return null
    const fullPath = path.join(systemSoundsDir, fileName)
    return isRegularFile(fullPath) ? fullPath : null
  }

  if (platform === 'win32' || platform === 'linux') {
    const allowlist = platform === 'win32' ? WINDOWS_SYSTEM_SOUNDS : LINUX_SYSTEM_SOUNDS
    const allowed = allowlist.some(item => item.fileName.toLowerCase() === fileName.toLowerCase())
    if (!allowed) return null

    const directPath = path.join(systemSoundsDir, fileName)
    if (isRegularFile(directPath)) {
      return directPath
    }

    try {
      const match = readdirSync(systemSoundsDir).find(
        entry => isSafeBaseFileName(entry) && entry.toLowerCase() === fileName.toLowerCase()
      )
      if (match) {
        const matchedPath = path.join(systemSoundsDir, match)
        if (isRegularFile(matchedPath)) {
          return matchedPath
        }
      }
    } catch {
      // Directory unreadable or missing
    }
  }

  return null
}

/**
 * Resolve a notification sound ID against the allowlist of bundled SND sounds and OS system sounds.
 * Missing or unrecognized IDs safely fall back to `'default'`.
 */
export function resolveNotificationSound(
  soundId: string | undefined,
  options?: NotificationSoundEnvOptions
): ResolvedNotificationSound {
  if (!soundId || soundId === NOTIFICATION_SOUND_DEFAULT) {
    return { kind: 'default' }
  }
  if (soundId === NOTIFICATION_SOUND_NONE) {
    return { kind: 'none' }
  }

  const platform = options?.platform ?? process.platform
  const isPackaged = options?.isPackaged ?? app.isPackaged

  if (soundId.startsWith(CUSTOM_SOUND_PREFIX)) {
    const custom = CUSTOM_NOTIFICATION_SOUNDS.find(item => item.id === soundId)
    if (!custom) return { kind: 'default' }

    const filePath = isPackaged
      ? path.join(options?.resourcesPath ?? process.resourcesPath, custom.fileName)
      : path.join(options?.appPath ?? app.getAppPath(), 'src', 'assets', 'sounds', custom.fileName)

    if (!isRegularFile(filePath)) {
      return { kind: 'default' }
    }
    return { kind: 'custom', fileName: custom.fileName, filePath }
  }

  if (soundId.startsWith(SYSTEM_SOUND_PREFIX)) {
    const rawName = soundId.slice(SYSTEM_SOUND_PREFIX.length)
    const dir = options?.systemSoundsDir ?? defaultSystemSoundsDir(platform)
    const filePath = resolveSystemSoundFilePath(rawName, platform, dir)
    if (!filePath) return { kind: 'default' }
    return { kind: 'system', filePath }
  }

  return { kind: 'default' }
}

/** Read raw audio bytes for an allowlisted custom or system sound (used by Web Audio on Windows/Linux). */
export async function readNotificationSoundData(
  soundId: string | undefined,
  options?: NotificationSoundEnvOptions
): Promise<Uint8Array | null> {
  const resolved = resolveNotificationSound(soundId, options)
  if (resolved.kind !== 'custom' && resolved.kind !== 'system') {
    return null
  }

  try {
    const buffer = await readFile(resolved.filePath)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  } catch (err) {
    console.error('[NotificationSounds] Failed to read sound file:', err)
    return null
  }
}

function defaultHasRendererWindow(): boolean {
  return BrowserWindow.getAllWindows().some(win => !win.isDestroyed())
}

function defaultSendPlayToRenderer(soundId: string): void {
  const win = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
  win?.webContents.send(IpcEvent.APP_PLAY_NOTIFICATION_SOUND, { soundId })
}

const WINDOWS_NOTIFICATIONS_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings'
const WINDOWS_QUIET_HOURS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\Cache\\DefaultAccount\\$$windows.data.notifications.quiethourssettings\\Current'

const QUIET_HOURS_PREFIX_UTF16LE = Buffer.from('Microsoft.QuietHoursProfile.', 'utf16le')
const PRIORITY_ONLY_UTF16LE = Buffer.from('PriorityOnly', 'utf16le')
const ALARMS_ONLY_UTF16LE = Buffer.from('AlarmsOnly', 'utf16le')

/** Parse `reg.exe query <key>` output into value-name -> `{ type, data }` pairs. */
export function parseRegQueryOutput(stdout: string): Map<string, { type: string; data: string }> {
  const values = new Map<string, { type: string; data: string }>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(REG_\S+)\s+(\S+)\s*$/.exec(rawLine)
    if (match) {
      values.set(match[1], { type: match[2], data: match[3] })
    }
  }
  return values
}

/**
 * Inspect the `Data` `REG_BINARY` blob from Windows CloudStore `quiethourssettings\Current`.
 * Checks the active `SelectedProfile` (first `Microsoft.QuietHoursProfile.*` entry in the blob)
 * so trailing automatic-rule definitions do not false-positive when Do Not Disturb is off.
 */
export function isWindowsQuietHoursActiveInCloudStoreData(dataBytes: Uint8Array): boolean {
  const buf = Buffer.from(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength)
  const idx = buf.indexOf(QUIET_HOURS_PREFIX_UTF16LE)
  if (idx === -1) return false
  const rest = buf.subarray(idx + QUIET_HOURS_PREFIX_UTF16LE.length)
  return (
    rest.subarray(0, PRIORITY_ONLY_UTF16LE.length).equals(PRIORITY_ONLY_UTF16LE) ||
    rest.subarray(0, ALARMS_ONLY_UTF16LE.length).equals(ALARMS_ONLY_UTF16LE)
  )
}

function isRegDwordZero(values: Map<string, { type: string; data: string }>, name: string): boolean {
  const entry = values.get(name)
  if (entry?.type !== 'REG_DWORD' || entry.data.length === 0) return false
  return Number(entry.data) === 0
}

function defaultQueryWindowsRegistryKey(keyPath: string): Promise<string | null> {
  if (process.platform !== 'win32') {
    return Promise.resolve(null)
  }
  const winRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const regExe = path.win32.join(winRoot, 'System32', 'reg.exe')
  return new Promise(resolve => {
    try {
      execFile(regExe, ['query', keyPath], { windowsHide: true, timeout: 1500 }, (err, stdout) => {
        resolve(err ? null : stdout)
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * Check whether Windows currently allows Comet notification sounds to play, respecting:
 * - Global toast & notification-sound toggles (`NOC_GLOBAL_SETTING_*`)
 * - Lock-screen toast suppression (`NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK`)
 * - Per-app notification & sound toggles (`Notifications\Settings\<AUMID>`)
 * - Windows Do Not Disturb / Focus Assist (`quiethourssettings\Current`)
 */
export async function canPlayWindowsNotificationSound(options?: NotificationSoundEnvOptions): Promise<boolean> {
  if (options?.canPlayWindowsSound) {
    return await options.canPlayWindowsSound()
  }

  const queryKey = options?.queryWindowsRegistryKey ?? defaultQueryWindowsRegistryKey
  const isLocked = options?.isScreenLocked ?? (() => powerMonitor.getSystemIdleState(60) === 'locked')
  const appId = options?.appUserModelId ?? WINDOWS_APP_USER_MODEL_ID
  const appSettingsKey = `${WINDOWS_NOTIFICATIONS_SETTINGS_KEY}\\${appId}`

  const [globalOut, appOut, quietOut] = await Promise.all([
    queryKey(WINDOWS_NOTIFICATIONS_SETTINGS_KEY),
    queryKey(appSettingsKey),
    queryKey(WINDOWS_QUIET_HOURS_KEY),
  ])

  if (globalOut) {
    const globalVals = parseRegQueryOutput(globalOut)
    if (
      isRegDwordZero(globalVals, 'NOC_GLOBAL_SETTING_TOASTS_ENABLED') ||
      isRegDwordZero(globalVals, 'NOC_GLOBAL_SETTING_ALLOW_NOTIFICATION_SOUND') ||
      (isLocked() && isRegDwordZero(globalVals, 'NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK'))
    ) {
      return false
    }
  }

  if (appOut) {
    const appVals = parseRegQueryOutput(appOut)
    if (
      isRegDwordZero(appVals, 'Enabled') ||
      isRegDwordZero(appVals, 'AllowNotificationSound') ||
      isRegDwordZero(appVals, 'Sound')
    ) {
      return false
    }
  }

  if (quietOut) {
    const quietVals = parseRegQueryOutput(quietOut)
    const dataEntry = quietVals.get('Data')
    if (
      dataEntry?.type === 'REG_BINARY' &&
      dataEntry.data.length > 0 &&
      dataEntry.data.length % 2 === 0 &&
      /^[0-9a-fA-F]+$/.test(dataEntry.data)
    ) {
      if (isWindowsQuietHoursActiveInCloudStoreData(Buffer.from(dataEntry.data, 'hex'))) {
        return false
      }
    }
  }

  return true
}

/**
 * Prepare Electron `Notification` constructor options (`silent`, `sound`) and an optional post-`show()`
 * audio trigger so custom and OS sounds play consistently across macOS, Windows, and Linux.
 */
export function prepareNotificationSound(
  soundId: string | undefined,
  options?: NotificationSoundEnvOptions
): PreparedNotificationSound {
  const resolved = resolveNotificationSound(soundId, options)

  if (resolved.kind === 'none') {
    return { silent: true }
  }

  if (resolved.kind === 'default') {
    return { silent: false }
  }

  const platform = options?.platform ?? process.platform
  const isPackaged = options?.isPackaged ?? app.isPackaged
  const playMac = options?.playMacFile ?? playMacAudioFile
  const hasWindow = options?.hasRendererWindow ?? defaultHasRendererWindow
  const sendToRenderer = options?.sendPlayToRenderer ?? defaultSendPlayToRenderer

  if (platform === 'darwin') {
    // Packaged macOS bundles place custom WAVs in Contents/Resources/, where UNNotificationSound
    // plays them natively and automatically respects macOS Focus / Do Not Disturb.
    if (resolved.kind === 'custom' && isPackaged) {
      return { silent: false, sound: resolved.fileName }
    }
    // UNNotificationSound does not search /System/Library/Sounds (nor unbundled dev paths),
    // so suppress the default banner tone and play the chosen file via afplay.
    return {
      silent: true,
      afterShow: () => playMac(resolved.filePath),
    }
  }

  // On Windows and Linux, Electron ignores Notification.sound; mute the toast's default chime
  // and play the selected sound through Web Audio in the renderer window once shown (respecting
  // Windows Do Not Disturb and notification sound settings).
  if (soundId && hasWindow()) {
    return {
      silent: true,
      afterShow: async () => {
        const token = ++latestRendererSoundToken
        if (platform === 'win32') {
          const allowed = await canPlayWindowsNotificationSound(options)
          if (!allowed || token !== latestRendererSoundToken) {
            return
          }
        }
        sendToRenderer(soundId)
      },
    }
  }

  return { silent: false }
}

/** Play a preview sound in the main process (used on macOS for all sounds, and everywhere for 'default'). */
export function previewNotificationSoundInMain(
  soundId: string | undefined,
  options?: NotificationSoundEnvOptions
): void {
  stopActiveSoundPlayback()
  const resolved = resolveNotificationSound(soundId, options)
  if (resolved.kind === 'none') return

  const platform = options?.platform ?? process.platform
  const playMac = options?.playMacFile ?? playMacAudioFile
  const beep = options?.beep ?? (() => shell.beep())

  if (platform === 'darwin' && (resolved.kind === 'custom' || resolved.kind === 'system')) {
    playMac(resolved.filePath)
    return
  }

  beep()
}

export interface RegisterNotificationSoundHandlersOptions extends NotificationSoundEnvOptions {
  onSetSystemSoundPref?: (soundId: string) => void
}

export function registerNotificationSoundIpcHandlers(options?: RegisterNotificationSoundHandlersOptions): void {
  ipcMain.handle(IpcChannel.NOTIFICATION_SOUNDS_LIST_SYSTEM, () => listSystemNotificationSounds(options))

  ipcMain.handle(IpcChannel.NOTIFICATION_SOUNDS_READ_DATA, (_event, params: NotificationSoundParams) =>
    readNotificationSoundData(params?.soundId, options)
  )

  ipcMain.handle(IpcChannel.NOTIFICATION_SOUNDS_PREVIEW, (_event, params: NotificationSoundParams) => {
    previewNotificationSoundInMain(params?.soundId, options)
  })

  ipcMain.handle(IpcChannel.NOTIFICATION_SOUNDS_SET_SYSTEM_PREF, (_event, params: NotificationSoundParams) => {
    if (typeof params?.soundId === 'string' && params.soundId.length > 0) {
      options?.onSetSystemSoundPref?.(params.soundId)
    }
  })
}
