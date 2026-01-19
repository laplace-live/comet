import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, Notification, nativeImage, nativeTheme, shell } from 'electron'
import started from 'electron-squirrel-startup'

import { registerBilibiliIpcHandlers } from './api/bilibili'
import { cleanupBroadcastWebSocket, initBroadcastWebSocket } from './api/broadcast-websocket'

// Notification params interface
interface ShowNotificationParams {
  title: string
  body: string
  icon?: string
  talkerId: number
  sessionType: number
}

// https://github.com/electron/forge/issues/3439#issuecomment-3197027877
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit()
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

      // On macOS, also bring app to front
      if (process.platform === 'darwin') {
        app.dock?.show()
        app.focus({ steal: true })
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

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Set dark mode based on system preference
  if (nativeTheme.shouldUseDarkColors) {
    mainWindow.webContents.executeJavaScript('document.documentElement.classList.add("dark")')
  }

  // Listen for theme changes
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    mainWindow.webContents.executeJavaScript(
      isDark ? 'document.documentElement.classList.add("dark")' : 'document.documentElement.classList.remove("dark")'
    )
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
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow)

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
