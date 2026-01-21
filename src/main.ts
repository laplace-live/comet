import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, nativeImage, shell } from 'electron'
import started from 'electron-squirrel-startup'
import { UpdateSourceType, updateElectronApp } from 'update-electron-app'

import type { ShowNotificationParams } from './types/electron'

import { registerBilibiliIpcHandlers } from './api/bilibili'
import { cleanupBroadcastWebSocket, initBroadcastWebSocket } from './api/broadcast-websocket'
import { UPDATE_BASE_URL } from './lib/const'

// https://github.com/electron/forge/issues/3439#issuecomment-3197027877
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit()
}

// Configure auto-updates with S3/CloudFront as the update source
// Update the UPDATE_BASE_URL in src/lib/const.ts to point to your S3 bucket or CloudFront distribution
// The baseUrl must include platform and arch as per update-electron-app docs:
// https://github.com/electron/update-electron-app#with-static-file-storage
updateElectronApp({
  updateSource: {
    type: UpdateSourceType.StaticStorage,
    baseUrl: `${UPDATE_BASE_URL}/${process.platform}/${process.arch}`,
  },
  notifyUser: false,
  logger: console,
})

// Set AppUserModelId for Windows - required for proper notification behavior
// This must match the Squirrel installer name for notifications to work correctly
if (process.platform === 'win32') {
  app.setAppUserModelId('live.laplace.comet')
}

// Security helper: only allow http(s) URLs to be opened externally
const isSafeForExternalOpen = (url: string): boolean => {
  try {
    const parsedUrl = new URL(url)
    return ['http:', 'https:'].includes(parsedUrl.protocol)
  } catch {
    return false
  }
}

// Register IPC handlers
registerBilibiliIpcHandlers()

// Initialize WebSocket for real-time notifications
initBroadcastWebSocket()

// App info IPC handler
ipcMain.handle('app:get-version', () => app.getVersion())

// Helper to fetch image from URL and convert to NativeImage
async function fetchImageAsNativeImage(url: string): Promise<Electron.NativeImage | undefined> {
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    return nativeImage.createFromBuffer(buffer)
  } catch (err) {
    console.error('[Notification] Failed to fetch avatar:', err)
    return undefined
  }
}

// Keep references to notifications to prevent garbage collection
const activeNotifications = new Set<Notification>()

// Register notification IPC handler
ipcMain.handle('show-notification', async (_event, params: ShowNotificationParams) => {
  // Check if any window is focused - only show notification if window is not focused
  const windows = BrowserWindow.getAllWindows()
  const anyWindowFocused = windows.some(win => win.isFocused())

  if (anyWindowFocused) {
    return { shown: false, reason: 'window_focused' }
  }

  // Check if notifications are supported
  if (!Notification.isSupported()) {
    return { shown: false, reason: 'not_supported' }
  }

  // Fetch avatar image if URL is provided
  let icon: Electron.NativeImage | undefined
  if (params.icon) {
    icon = await fetchImageAsNativeImage(params.icon)
  }

  const notification = new Notification({
    title: params.title,
    body: params.body,
    icon,
    silent: false,
  })

  // Keep reference to prevent garbage collection
  activeNotifications.add(notification)

  // Handle notification click - activate window and navigate to session
  notification.on('click', () => {
    console.log('[Notification] Click received, navigating to session:', params.talkerId)

    // Get windows at click time, not at registration time
    const currentWindows = BrowserWindow.getAllWindows()
    const mainWindow = currentWindows[0]

    if (mainWindow) {
      // Restore if minimized
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }

      // Show and focus the window (show() is more reliable than focus() alone)
      mainWindow.show()
      mainWindow.focus()

      // On macOS, bring app to front via dock
      if (process.platform === 'darwin') {
        app.dock?.show()
        app.focus({ steal: true })
      }

      // On Windows, use setAlwaysOnTop workaround to force window to foreground
      // Windows has ForegroundLockTimeout that prevents apps from stealing focus
      if (process.platform === 'win32') {
        mainWindow.setAlwaysOnTop(true)
        mainWindow.focus()
        mainWindow.setAlwaysOnTop(false)
      }

      // Send event to renderer to navigate to the session
      mainWindow.webContents.send('bilibili:navigate-to-session', {
        talkerId: params.talkerId,
        sessionType: params.sessionType,
      })
    } else {
      console.error('[Notification] No main window found')
    }

    // Clean up reference
    activeNotifications.delete(notification)
  })

  // Also clean up on close (dismissed without clicking)
  notification.on('close', () => {
    activeNotifications.delete(notification)
  })

  notification.show()
  console.log('[Notification] Shown for:', params.title)
  return { shown: true }
})

// Create a badge overlay icon for Windows taskbar
function createBadgeIcon(count: number): Electron.NativeImage {
  // Create a 16x16 badge icon with the count
  const size = 16
  const canvas = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#ef4444"/>
      <text x="${size / 2}" y="${size / 2 + 1}"
        font-family="Arial, sans-serif"
        font-size="${count > 99 ? 7 : count > 9 ? 8 : 10}"
        font-weight="bold"
        fill="white"
        text-anchor="middle"
        dominant-baseline="middle">
        ${count > 99 ? '99+' : count}
      </text>
    </svg>
  `
  return nativeImage.createFromBuffer(Buffer.from(canvas))
}

// Badge count IPC handler (macOS dock badge / Windows taskbar overlay)
ipcMain.handle('app:set-badge-count', (_event, count: number) => {
  if (process.platform === 'darwin') {
    // On macOS, setBadge takes a string - empty string clears the badge
    app.dock?.setBadge(count > 0 ? String(count) : '')
    return { success: true }
  }

  if (process.platform === 'win32') {
    // On Windows, use overlay icon on the taskbar
    const windows = BrowserWindow.getAllWindows()
    const mainWindow = windows[0]

    if (mainWindow) {
      if (count > 0) {
        const badgeIcon = createBadgeIcon(count)
        mainWindow.setOverlayIcon(badgeIcon, `${count} unread messages`)
      } else {
        // Clear the overlay icon
        mainWindow.setOverlayIcon(null, '')
      }
      return { success: true }
    }
    return { success: false, reason: 'no_window' }
  }

  // Linux and other platforms - not supported yet
  return { success: false, reason: 'platform_not_supported' }
})

// Clipboard IPC handler - copy image from URL
interface CopyImageParams {
  imageUrl: string
}

ipcMain.handle('clipboard:copy-image', async (_event, params: CopyImageParams) => {
  try {
    const response = await fetch(params.imageUrl)
    if (!response.ok) {
      return { success: false, error: 'Failed to fetch image' }
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const image = nativeImage.createFromBuffer(buffer)

    if (image.isEmpty()) {
      return { success: false, error: 'Invalid image data' }
    }

    clipboard.writeImage(image)
    return { success: true }
  } catch (err) {
    console.error('[Clipboard] Failed to copy image:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
})

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`))
  }

  // Open the DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools()
  }
}

// Create application menu
const createApplicationMenu = () => {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: '关于 LAPLACE Comet',
                click: () => {
                  const focusedWindow = BrowserWindow.getFocusedWindow()
                  if (focusedWindow) {
                    focusedWindow.webContents.send('app:open-about')
                  }
                },
              },
              { type: 'separator' as const },
              {
                label: '设置...',
                accelerator: 'Cmd+,',
                click: () => {
                  const focusedWindow = BrowserWindow.getFocusedWindow()
                  if (focusedWindow) {
                    focusedWindow.webContents.send('app:open-settings')
                  }
                },
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    // Edit menu
    {
      label: '编辑',
      submenu: [
        { role: 'undo' as const, label: '撤销' },
        { role: 'redo' as const, label: '重做' },
        { type: 'separator' as const },
        { role: 'cut' as const, label: '剪切' },
        { role: 'copy' as const, label: '复制' },
        { role: 'paste' as const, label: '粘贴' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const, label: '粘贴并匹配样式' },
              { role: 'delete' as const, label: '删除' },
              { role: 'selectAll' as const, label: '全选' },
            ]
          : [
              { role: 'delete' as const, label: '删除' },
              { type: 'separator' as const },
              { role: 'selectAll' as const, label: '全选' },
            ]),
      ],
    },
    // View menu
    {
      label: '视图',
      submenu: [
        { role: 'reload' as const, label: '重新加载' },
        { role: 'forceReload' as const, label: '强制重新加载' },
        { role: 'toggleDevTools' as const, label: '开发者工具' },
        { type: 'separator' as const },
        { role: 'resetZoom' as const, label: '重置缩放' },
        { role: 'zoomIn' as const, label: '放大' },
        { role: 'zoomOut' as const, label: '缩小' },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const, label: '全屏' },
      ],
    },
    // Window menu
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' as const, label: '最小化' },
        { role: 'zoom' as const, label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const, label: '前置所有窗口' },
              { type: 'separator' as const },
              { role: 'window' as const },
            ]
          : [{ role: 'close' as const, label: '关闭' }]),
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// Open target="_blank" links in system browser
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeForExternalOpen(url)) {
      setImmediate(() => {
        shell.openExternal(url)
      })
    }
    return { action: 'deny' }
  })

  // Add context menu for editable elements (text inputs, textareas)
  contents.on('context-menu', (_e, params) => {
    // Only show context menu for editable elements
    if (!params.isEditable) return

    const hasSelection = params.selectionText.length > 0

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '剪切',
        role: 'cut',
        enabled: hasSelection,
      },
      {
        label: '复制',
        role: 'copy',
        enabled: hasSelection,
      },
      {
        label: '粘贴',
        role: 'paste',
      },
      { type: 'separator' },
      {
        label: '全选',
        role: 'selectAll',
      },
    ])

    contextMenu.popup()
  })
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  createApplicationMenu()
  createWindow()
})

// Cleanup WebSocket on quit
app.on('before-quit', () => {
  cleanupBroadcastWebSocket()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
