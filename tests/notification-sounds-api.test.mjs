import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const tempRoot = await mkdtemp(path.join(tmpdir(), 'comet-notification-sounds-'))

const mockModules = {
  electron: `
    export const handlers = new Map()
    export const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
    export const app = {
      isPackaged: false,
      getAppPath: () => ${JSON.stringify(projectRoot)},
    }
    export const BrowserWindow = { getAllWindows: () => [] }
    export const powerMonitor = { getSystemIdleState: () => 'active' }
    export const shell = { beep: () => {} }
  `,
}

let soundsApi
let soundDefs
let channels
let handlers

before(async () => {
  const bundle = await build({
    configFile: false,
    envDir: false,
    root: projectRoot,
    logLevel: 'error',
    resolve: { alias: { '@': path.join(projectRoot, 'src') } },
    build: {
      write: false,
      minify: false,
      target: 'esnext',
      lib: { entry: '\0notification-sounds-test:entry', formats: ['es'] },
      rolldownOptions: {
        input: '\0notification-sounds-test:entry',
        external: /^node:/,
        output: { codeSplitting: false },
      },
    },
    plugins: [
      {
        name: 'notification-sounds-test-electron',
        enforce: 'pre',
        resolveId(id) {
          if (id.startsWith('\0notification-sounds-test:')) return id
          if (id in mockModules) return { id: `\0notification-sounds-test:${id}`, external: false }
        },
        load(id) {
          if (id === '\0notification-sounds-test:entry')
            return `
            export * as soundsApi from '@/api/notification-sounds'
            export * as soundDefs from '@/lib/notification-sounds'
            export { IpcChannel as channels } from '@/lib/ipc'
            export { handlers } from 'electron'
          `
          if (id.startsWith('\0notification-sounds-test:')) {
            return mockModules[id.slice('\0notification-sounds-test:'.length)]
          }
        },
      },
    ],
  })

  const chunk = [bundle]
    .flat()
    .flatMap(result => result.output)
    .find(item => item.type === 'chunk' && item.isEntry)
  assert.ok(chunk, 'Vite must build the notification-sounds test entry')
  ;({ soundsApi, soundDefs, channels, handlers } = await import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
  ))
})

after(() => rm(tempRoot, { recursive: true, force: true }))

test('all curated SND custom notification WAV files exist and have valid RIFF/WAVE headers', async () => {
  assert.equal(soundDefs.CUSTOM_NOTIFICATION_SOUNDS.length, 9)

  const packagedResources = path.join(tempRoot, 'packaged-resources')
  await mkdir(packagedResources, { recursive: true })

  for (const item of soundDefs.CUSTOM_NOTIFICATION_SOUNDS) {
    const devResolved = soundsApi.resolveNotificationSound(item.id, {
      platform: 'darwin',
      isPackaged: false,
      appPath: projectRoot,
    })
    assert.equal(devResolved.kind, 'custom', `${item.id} should resolve in dev mode`)
    assert.equal(devResolved.fileName, item.fileName)

    const bytes = await soundsApi.readNotificationSoundData(item.id, {
      platform: 'win32',
      isPackaged: false,
      appPath: projectRoot,
    })
    assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 44, `${item.id} should return non-empty WAV bytes`)
    const header = Buffer.from(bytes.subarray(0, 12)).toString('ascii')
    assert.equal(header.slice(0, 4), 'RIFF', `${item.fileName} must start with RIFF`)
    assert.equal(header.slice(8, 12), 'WAVE', `${item.fileName} must contain WAVE format marker`)

    await copyFile(devResolved.filePath, path.join(packagedResources, item.fileName))
    const pkgResolved = soundsApi.resolveNotificationSound(item.id, {
      platform: 'darwin',
      isPackaged: true,
      resourcesPath: packagedResources,
    })
    assert.equal(pkgResolved.kind, 'custom', `${item.id} should resolve in packaged mode`)
    assert.equal(pkgResolved.filePath, path.join(packagedResources, item.fileName))
  }
})

test('macOS system sound discovery maps AlertSounds display names and ignores non-audio entries', async () => {
  const macDir = path.join(tempRoot, 'mac-sounds')
  await mkdir(path.join(macDir, 'NestedDir.aiff'), { recursive: true })
  await writeFile(path.join(macDir, 'Glass.aiff'), 'FORM-AIFF')
  await writeFile(path.join(macDir, 'Tink.aiff'), 'FORM-AIFF')
  await writeFile(path.join(macDir, 'Nova.caf'), 'caff')
  await writeFile(path.join(macDir, '.DS_Store'), 'junk')
  await writeFile(path.join(macDir, 'readme.txt'), 'not audio')

  const list = await soundsApi.listSystemNotificationSounds({
    platform: 'darwin',
    systemSoundsDir: macDir,
  })

  assert.deepEqual(list, [
    { id: 'system:Tink.aiff', label: 'Boop (Tink)' },
    { id: 'system:Glass.aiff', label: 'Crystal (Glass)' },
    { id: 'system:Nova.caf', label: 'Nova' },
  ])
})

test('Windows system sound discovery filters against curated allowlist case-insensitively', async () => {
  const winDir = path.join(tempRoot, 'win-media')
  await mkdir(winDir, { recursive: true })
  await writeFile(path.join(winDir, 'Windows Notify Messaging.wav'), 'RIFF....WAVE')
  await writeFile(path.join(winDir, 'NOTIFY.WAV'), 'RIFF....WAVE')
  await writeFile(path.join(winDir, 'Windows Logon.wav'), 'RIFF....WAVE')

  const list = await soundsApi.listSystemNotificationSounds({
    platform: 'win32',
    systemSoundsDir: winDir,
  })

  assert.deepEqual(list, [
    { id: 'system:Windows Notify Messaging.wav', label: '即时消息 (Messaging)' },
    { id: 'system:NOTIFY.WAV', label: '经典通知 (Notify)' },
  ])
})

test('resolveNotificationSound rejects path traversal and falls back cleanly on missing or foreign OS sounds', async () => {
  const macDir = path.join(tempRoot, 'traversal-mac')
  await mkdir(macDir, { recursive: true })
  await writeFile(path.join(tempRoot, 'secret.aiff'), 'secret')
  await writeFile(path.join(macDir, 'Ping.aiff'), 'FORM-AIFF')

  const invalidIds = [
    'system:../secret.aiff',
    'system:..\\secret.aiff',
    'system:sub/Ping.aiff',
    'custom:../../etc/passwd',
    'custom:nonexistent-sound',
    'unknown:foo',
  ]

  for (const id of invalidIds) {
    const resolved = soundsApi.resolveNotificationSound(id, {
      platform: 'darwin',
      isPackaged: false,
      appPath: projectRoot,
      systemSoundsDir: macDir,
    })
    assert.deepEqual(resolved, { kind: 'default' }, `${id} must fall back to default`)
    const bytes = await soundsApi.readNotificationSoundData(id, {
      platform: 'darwin',
      isPackaged: false,
      appPath: projectRoot,
      systemSoundsDir: macDir,
    })
    assert.equal(bytes, null, `${id} must not expose file bytes`)
  }

  // A macOS system sound migrated onto Windows must fall back to default rather than failing
  const foreignResolved = soundsApi.resolveNotificationSound('system:Ping.aiff', {
    platform: 'win32',
    systemSoundsDir: macDir,
  })
  assert.deepEqual(foreignResolved, { kind: 'default' })
})

test('prepareNotificationSound selects native UNNotificationSound, afplay, or renderer Web Audio per platform', async () => {
  const macDir = path.join(tempRoot, 'prep-mac')
  await mkdir(macDir, { recursive: true })
  const glassPath = path.join(macDir, 'Glass.aiff')
  await writeFile(glassPath, 'FORM-AIFF')

  const packagedResources = path.join(tempRoot, 'prep-resources')
  await mkdir(packagedResources, { recursive: true })
  await copyFile(
    path.join(projectRoot, 'src', 'assets', 'sounds', 'snd-sine-notification.wav'),
    path.join(packagedResources, 'snd-sine-notification.wav')
  )

  // 1. Muted ('none') and OS default ('default')
  assert.deepEqual(soundsApi.prepareNotificationSound('none'), { silent: true })
  assert.deepEqual(soundsApi.prepareNotificationSound('default'), { silent: false })

  // 2. Packaged macOS + custom sound -> native UNNotificationSound
  const macPackagedCustom = soundsApi.prepareNotificationSound('custom:snd-sine-notification', {
    platform: 'darwin',
    isPackaged: true,
    resourcesPath: packagedResources,
  })
  assert.equal(macPackagedCustom.silent, false)
  assert.equal(macPackagedCustom.sound, 'snd-sine-notification.wav')
  assert.equal(macPackagedCustom.afterShow, undefined)

  // 3. Packaged macOS + system sound -> silent Notification + afplay
  const playedMacFiles = []
  const macSystem = soundsApi.prepareNotificationSound('system:Glass.aiff', {
    platform: 'darwin',
    isPackaged: true,
    systemSoundsDir: macDir,
    playMacFile: filePath => playedMacFiles.push(filePath),
  })
  assert.equal(macSystem.silent, true)
  assert.equal(macSystem.sound, undefined)
  macSystem.afterShow?.()
  assert.deepEqual(playedMacFiles, [glassPath])

  // 4. Windows + custom sound with active renderer window -> silent toast + renderer Web Audio IPC
  const rendererPayloads = []
  const winCustom = soundsApi.prepareNotificationSound('custom:snd-sine-notification', {
    platform: 'win32',
    isPackaged: false,
    appPath: projectRoot,
    hasRendererWindow: () => true,
    canPlayWindowsSound: () => true,
    sendPlayToRenderer: id => rendererPayloads.push(id),
  })
  assert.equal(winCustom.silent, true)
  await winCustom.afterShow?.()
  assert.deepEqual(rendererPayloads, ['custom:snd-sine-notification'])

  // 5. Windows + custom sound without any renderer window -> graceful fallback to OS default toast sound
  const winNoWindow = soundsApi.prepareNotificationSound('custom:snd-sine-notification', {
    platform: 'win32',
    isPackaged: false,
    appPath: projectRoot,
    hasRendererWindow: () => false,
  })
  assert.deepEqual(winNoWindow, { silent: false })
})

test('Windows notification sound check respects Do Not Disturb, per-app sound toggle, global sound toggle, and lock screen', async () => {
  const GLOBAL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings'
  const APP_KEY = `${GLOBAL_KEY}\\live.laplace.comet`
  const QUIET_KEY =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\Cache\\DefaultAccount\\$$windows.data.notifications.quiethourssettings\\Current'

  const makeCloudStoreHex = (headerByteCount, ...profiles) => {
    const chunks = [Buffer.alloc(headerByteCount, 0x43)]
    for (const profile of profiles) {
      chunks.push(Buffer.from(`Microsoft.QuietHoursProfile.${profile}`, 'utf16le'))
      chunks.push(Buffer.alloc(8, 0))
    }
    return Buffer.concat(chunks).toString('hex').toUpperCase()
  }

  const runWinAfterShow = async (regMap, isScreenLocked = false) => {
    const sent = []
    const prepared = soundsApi.prepareNotificationSound('custom:snd-sine-notification', {
      platform: 'win32',
      isPackaged: false,
      appPath: projectRoot,
      hasRendererWindow: () => true,
      isScreenLocked: () => isScreenLocked,
      queryWindowsRegistryKey: async key => regMap[key] ?? null,
      sendPlayToRenderer: id => sent.push(id),
    })
    await prepared.afterShow?.()
    return sent
  }

  // Missing keys (default Windows install) -> allowed
  assert.deepEqual(await runWinAfterShow({}), ['custom:snd-sine-notification'])

  // Global notification sound disabled -> suppressed
  assert.deepEqual(
    await runWinAfterShow({
      [GLOBAL_KEY]: `${GLOBAL_KEY}\r\n    NOC_GLOBAL_SETTING_ALLOW_NOTIFICATION_SOUND    REG_DWORD    0x0\r\n`,
    }),
    []
  )

  // Global toasts disabled -> suppressed
  assert.deepEqual(
    await runWinAfterShow({
      [GLOBAL_KEY]: `${GLOBAL_KEY}\r\n    NOC_GLOBAL_SETTING_TOASTS_ENABLED    REG_DWORD    0x0\r\n`,
    }),
    []
  )

  // Per-app AllowNotificationSound / Sound / Enabled = 0 -> suppressed
  for (const valueName of ['AllowNotificationSound', 'Sound', 'Enabled']) {
    assert.deepEqual(
      await runWinAfterShow({
        [APP_KEY]: `${APP_KEY}\r\n    ${valueName}    REG_DWORD    0x0\r\n`,
      }),
      [],
      `${valueName}=0x0 should suppress Windows renderer notification sound`
    )
  }

  // Windows Do Not Disturb active (PriorityOnly / AlarmsOnly, including odd-offset binary header) -> suppressed
  assert.deepEqual(
    await runWinAfterShow({
      [QUIET_KEY]: `${QUIET_KEY}\r\n    Data    REG_BINARY    ${makeCloudStoreHex(23, 'PriorityOnly')}\r\n`,
    }),
    []
  )
  assert.deepEqual(
    await runWinAfterShow({
      [QUIET_KEY]: `${QUIET_KEY}\r\n    Data    REG_BINARY    ${makeCloudStoreHex(24, 'AlarmsOnly')}\r\n`,
    }),
    []
  )

  // Unrestricted active profile with trailing automatic rule mentioning PriorityOnly -> allowed
  assert.deepEqual(
    await runWinAfterShow({
      [QUIET_KEY]: `${QUIET_KEY}\r\n    Data    REG_BINARY    ${makeCloudStoreHex(23, 'Unrestricted', 'PriorityOnly')}\r\n`,
    }),
    ['custom:snd-sine-notification']
  )

  // Screen locked with above-lock toasts disabled -> suppressed
  assert.deepEqual(
    await runWinAfterShow(
      {
        [GLOBAL_KEY]: `${GLOBAL_KEY}\r\n    NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK    REG_DWORD    0x0\r\n`,
      },
      true
    ),
    []
  )
})

test('IPC handlers expose list, readData, preview, and system preference sync', async () => {
  const macDir = path.join(tempRoot, 'ipc-mac')
  await mkdir(macDir, { recursive: true })
  await writeFile(path.join(macDir, 'Pop.aiff'), 'FORM-AIFF')

  const played = []
  let beeped = 0
  let syncedSystemPref = null

  soundsApi.registerNotificationSoundIpcHandlers({
    platform: 'darwin',
    isPackaged: false,
    appPath: projectRoot,
    systemSoundsDir: macDir,
    playMacFile: filePath => played.push(filePath),
    beep: () => {
      beeped++
    },
    onSetSystemSoundPref: soundId => {
      syncedSystemPref = soundId
    },
  })

  const listed = await handlers.get(channels.NOTIFICATION_SOUNDS_LIST_SYSTEM)({})
  assert.deepEqual(listed, [{ id: 'system:Pop.aiff', label: 'Bubble (Pop)' }])

  await handlers.get(channels.NOTIFICATION_SOUNDS_PREVIEW)({}, { soundId: 'system:Pop.aiff' })
  assert.deepEqual(played, [path.join(macDir, 'Pop.aiff')])

  await handlers.get(channels.NOTIFICATION_SOUNDS_PREVIEW)({}, { soundId: 'default' })
  assert.equal(beeped, 1)

  await handlers.get(channels.NOTIFICATION_SOUNDS_SET_SYSTEM_PREF)({}, { soundId: 'custom:snd-piano-button' })
  assert.equal(syncedSystemPref, 'custom:snd-piano-button')
})
