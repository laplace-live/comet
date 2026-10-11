// Preloaded into Electron's main process ahead of the app's own entry, which Electron loads next: moves the
// app onto a throwaway profile, answers its Bilibili traffic from the showcase, and saves each shot. The app's
// code runs unchanged; Bilibili, the network and the renderer's clock are the only stand-ins.

import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import {
  app,
  BrowserWindow,
  type NativeImage,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  systemPreferences,
  type WebContents,
} from 'electron'

import { IpcEvent } from '@/lib/ipc'

import { FACE_SIZE, paintFaces } from './art.ts'
import { CONFIG_ENV, type HarnessConfig } from './config.ts'
import { SHOTS, type Shot } from './shots.ts'
import {
  ACCOUNTS,
  conversationLength,
  conversationName,
  createShowcase,
  SHOWCASE_NOW,
  SHOWCASE_TIME_ZONE,
} from './showcase.ts'

const BOOT_TIMEOUT_MS = 60_000
const LOAD_TIMEOUT_MS = 30_000
/** Between asking for focus and checking it, which also lets a hover the pointer left fade out. */
const FOCUS_SETTLE_MS = 400
/** How long the window waits to take focus while someone uses the Mac; a locked screen doesn't count. */
const FOCUS_TIMEOUT_MS = 5 * 60_000
/** The whole run; a wedged page must not keep a window on the user's screen forever. */
const RUN_TIMEOUT_MS = 15 * 60_000
/** Captures are 2× so a 1× display can't quietly halve what's committed. */
const SCALE_FACTOR = 2
/** Where the window sits while it poses, from a Retina display's top left; a capture doesn't need it unobscured. */
const WINDOW_ORIGIN = { x: 120, y: 100 }
/** Pixels whose channels all lie within this of the committed file's are the same pixel. */
const CHANNEL_TOLERANCE = 8
/**
 * Share of pixels a recapture may differ by and still leave the committed file alone. The same inbox
 * draws the same pixels every run; a changed digit is a change.
 */
const NOISE = 0.00002

const SRGB_PROFILE = '/System/Library/ColorSync/Profiles/sRGB Profile.icc'
const LOGIN_QR = `document.querySelector('img[alt="Login QR Code"]') !== null`

const run = promisify(execFile)

const rawConfig = process.env[CONFIG_ENV]
if (rawConfig === undefined) {
  console.error(`${CONFIG_ENV} is unset — run \`pnpm screenshots\``)
  process.exit(1)
}
const config = JSON.parse(rawConfig) as HarnessConfig

const showcase = createShowcase()

// Before main reads it: userData, and with it the account store, is derived from appData.
app.setPath('appData', config.appData)
// Render in sRGB, so captures don't carry the colours of the display they were taken on.
app.commandLine.appendSwitch('force-color-profile', 'srgb')
// No scroll bars, as overlay ones look when nothing scrolls, whatever the Mac's setting: with a mouse attached,
// or "Always", Chromium draws classic ones, which take width from the lists and show in every picture.
app.commandLine.appendSwitch('hide-scrollbars')
// The run never reaches the network: Bilibili is the showcase, and every other socket is refused,
// which leaves the broadcast WebSocket retrying quietly in the log.
globalThis.fetch = showcase.fetch
net.Socket.prototype.connect = () => {
  throw new Error('no network in a showcase run')
}
// Ahead of main's own `ready` handler, which opens the window that asks for the first pictures.
app.on('ready', () => {
  for (const scheme of ['https', 'http']) protocol.handle(scheme, showcase.serve)
})
// The run ends with app.exit(), which skips will-quit, so a quit from the app menu or the Dock cut it short.
app.on('will-quit', () => {
  console.error('screenshots: the app was quit before the run finished')
  app.exit(1)
})

void app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    console.error(`screenshots: no result after ${String(RUN_TIMEOUT_MS / 60_000)} minutes`)
    app.exit(1)
  }, RUN_TIMEOUT_MS)
  try {
    await session()
    clearTimeout(watchdog)
    app.exit(0)
  } catch (err) {
    console.error('screenshots:', err)
    app.exit(1)
  }
})

/** The app window, once its page's first load has finished. */
async function mainWindow(): Promise<BrowserWindow> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  for (;;) {
    const win = BrowserWindow.getAllWindows().at(0)
    if (win && !win.webContents.isLoading() && win.webContents.getURL().endsWith('/index.html')) return win
    if (Date.now() > deadline) throw new Error('the app window never loaded')
    await sleep(200)
  }
}

async function session(): Promise<void> {
  // Window chrome the committed shots don't have, which would rewrite every one of them.
  if (
    systemPreferences.getUserDefault('AppleAccentColor', 'integer') === -1 ||
    systemPreferences.getUserDefault('AppleAquaColorVariant', 'integer') === 6
  ) {
    throw new Error('the Graphite accent colour greys the traffic lights — pick another in Appearance settings')
  }
  if (nativeTheme.shouldUseHighContrastColors) {
    throw new Error('Increase Contrast outlines the window — turn it off in Accessibility › Display settings')
  }
  const win = await mainWindow()
  // Keeps the page drawing while something covers the window, or settling would wait on frames that never come.
  win.webContents.setBackgroundThrottling(false)
  await holdClock(win.webContents)
  // In the page, which has the emoji font, and before signing in shows the first avatar.
  showcase.paint(await inPage(win.webContents, paintFaces, showcase.faces, FACE_SIZE))

  const shots = SHOTS.filter(s => config.only.length === 0 || config.only.includes(s.name))
  mkdirSync(config.out, { recursive: true })
  const work = mkdtempSync(join(config.appData, 'shots-'))
  const take = async (shot: Shot): Promise<void> => {
    await stage(win, shot)
    const raw = join(work, `${shot.name}.raw.png`)
    await captureWindow(win, raw)
    checkAnswered(shot.name)
    const file = join(work, `${shot.name}.png`)
    await run('sips', ['--matchTo', SRGB_PROFILE, raw, '--out', file])
    // The window can change displays while a capture waits for focus.
    const { width } = nativeImage.createFromPath(file).getSize()
    if (width < shot.window.width * SCALE_FACTOR) {
      throw new Error(`${shot.name}: the capture is ${String(width)} px wide, not ${String(SCALE_FACTOR)}× the window`)
    }
    console.info(`screenshots: ${shot.name}.png ${keep(file, join(config.out, `${shot.name}.png`))}`)
  }

  // A fresh profile opens signed out, on the login screen.
  for (const shot of shots.filter(s => s.login)) await take(shot)
  const inbox = shots.filter(s => !s.login)
  if (inbox.length > 0) await signIn(win.webContents)
  for (const shot of inbox) await take(shot)
  checkAnswered('the run')

  if (config.only.length === 0) await removeUnlisted()
}

/**
 * A full run owns the shots: the committed pictures of shots no longer listed go with it. Only files git
 * tracks, so a deletion can be undone and anything else someone keeps in the folder stays.
 */
async function removeUnlisted(): Promise<void> {
  const listed = new Set(SHOTS.map(s => `${s.name}.png`))
  let tracked: string[]
  try {
    // NUL-separated, so a name git would quote still matches.
    tracked = (await run('git', ['ls-files', '-z'], { cwd: config.out })).stdout.split('\0')
  } catch (err) {
    console.info(`screenshots: unlisted PNGs left in place, as git can't list ${config.out}: ${String(err)}`)
    return
  }
  for (const file of tracked) {
    if (!file.endsWith('.png') || file.includes('/') || listed.has(file)) continue
    if (!existsSync(join(config.out, file))) continue
    unlinkSync(join(config.out, file))
    console.info(`screenshots: ${file} removed`)
  }
}

/** Source that calls `fn` with `args` in the page: sent as text, so `fn` can't use anything from this module. */
function source<A extends unknown[]>(fn: (...args: A) => unknown, ...args: A): string {
  return `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(', ')})`
}

/** Calls `fn` with `args` in the page, as {@link source} sends it, and resolves to what it returns. */
function inPage<A extends unknown[], R>(page: WebContents, fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
  return page.executeJavaScript(source(fn, ...args))
}

/**
 * Holds the page's clock at {@link SHOWCASE_NOW} in Beijing time, from its next load on, so "3 分钟前" and
 * "20:31" read the same whenever the run happens. Over the DevTools protocol, so the app's code is untouched.
 */
async function holdClock(page: WebContents): Promise<void> {
  page.debugger.attach('1.3')
  await page.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: SHOWCASE_TIME_ZONE })
  await page.debugger.sendCommand('Page.enable')
  await page.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: source(pinDate, SHOWCASE_NOW) })
}

/** Runs in the page before its own scripts: `new Date()` and `Date.now()` answer `now`. */
function pinDate(now: number): void {
  const RealDate = Date
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [now] : args, newTarget),
    get: (target, key, receiver) => (key === 'now' ? () => now : Reflect.get(target, key, receiver)),
  })
}

/**
 * Signs in the way a user does, so the account store is the app's own: the phone confirms the login
 * screen's QR code for the station, and the other two accounts follow through the IPC the Add Account
 * sheet polls with. `alt` is then signed out on Bilibili's side and made active, so the next load's
 * login check marks it expired and falls back to the station.
 */
async function signIn(page: WebContents): Promise<void> {
  await until(page, LOGIN_QR, 'the login QR code')
  showcase.scan('station')
  await until(page, source(shows, ACCOUNTS.station.uname), 'the inbox')
  for (const account of ['clips', 'alt'] as const) {
    showcase.scan(account)
    const signedIn = await inPage(page, addAccount, ACCOUNTS[account].mid)
    if (!signedIn) throw new Error(`${ACCOUNTS[account].uname} never signed in${unansweredNote()}`)
  }
  showcase.expire('alt')
  await inPage(page, mid => window.electronAPI.bilibili.setActiveAccount({ mid }), ACCOUNTS.alt.mid)
}

/** Runs in the page: the Add Account sheet's QR login, true once it signs in `mid`. */
async function addAccount(mid: number): Promise<boolean> {
  const { bilibili } = window.electronAPI
  const qr = await bilibili.qrGenerate()
  if (!qr.data) return false
  const poll = await bilibili.qrPoll({ qrcodeKey: qr.data.qrcode_key })
  return poll.code === 0 && poll.data?.code === 0 && poll.userInfo?.mid === mid
}

/** Where the window poses: the main display if it's Retina, or else a display that is. */
function poseOrigin(): { x: number; y: number } {
  const display = [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].find(d => d.scaleFactor === SCALE_FACTOR)
  if (display === undefined) throw new Error(`no Retina (${String(SCALE_FACTOR)}×) display to take the shots on`)
  return { x: display.bounds.x + WINDOW_ORIGIN.x, y: display.bounds.y + WINDOW_ORIGIN.y }
}

/** Reload the page in the shot's window and theme, and open what it shows. */
async function stage(win: BrowserWindow, shot: Shot): Promise<void> {
  const page = win.webContents
  nativeTheme.themeSource = shot.dark ? 'dark' : 'light'
  win.setBounds({ ...poseOrigin(), ...shot.window })
  const { width, height } = win.getBounds()
  if (width !== shot.window.width || height !== shot.window.height) {
    throw new Error(
      `${shot.name}: the screen can't fit a ${String(shot.window.width)}×${String(shot.window.height)} window`
    )
  }
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor
  if (scale !== SCALE_FACTOR) throw new Error(`${shot.name}: the window landed on a ${String(scale)}× display`)
  // Key before it loads: the app marks the open conversation read when the window takes focus, and behind the
  // lock screen this waits, saying so, rather than leaving the page to settle unseen.
  await keyWindow(win)
  const loaded = once(page, 'did-finish-load')
  page.reload()
  await loaded

  if (shot.login) {
    await until(page, LOGIN_QR, `${shot.name}: the login QR code`)
  } else {
    await until(page, source(shows, ACCOUNTS.station.uname, conversationName('yuzu')), `${shot.name}: the inbox`)
  }
  if (shot.open !== undefined) {
    const name = conversationName(shot.open)
    const row = await inPage(page, sessionRow, name)
    if (row === null) throw new Error(`${shot.name}: the session list has no ${name}`)
    press(page, row)
    await until(page, source(chatOpen, name, conversationLength(shot.open)), `${shot.name}: ${name}'s messages`)
  }
  if (shot.overlay !== undefined) {
    // Settings and About open the way the app menu opens them; menus by a click on their trigger.
    if (shot.overlay === 'settings') page.send(IpcEvent.APP_OPEN_SETTINGS)
    else if (shot.overlay === 'about') page.send(IpcEvent.APP_OPEN_ABOUT)
    else {
      const at = await inPage(page, menuTrigger, shot.overlay)
      if (at === null) throw new Error(`${shot.name}: no trigger for the ${shot.overlay} menu`)
      press(page, at)
    }
    const popup = shot.overlay === 'settings' || shot.overlay === 'about' ? 'dialog-popup' : 'menu-popup'
    // Present is enough; settlePage waits out its opening transition.
    await until(page, `document.querySelector('[data-slot=${popup}]') !== null`, `${shot.name}: the ${shot.overlay}`)
  }
  const settled = await inPage(page, settlePage)
  if (settled !== true) throw new Error(`${shot.name}: the page never settled: ${settled}${unansweredNote()}`)
  checkAnswered(shot.name)
}

const unansweredNote = (): string =>
  showcase.unanswered.length === 0 ? '' : ` — the showcase had no answer for ${showcase.unanswered.join(', ')}`

/** Fails the run, naming them, once the showcase has had requests it couldn't answer. */
function checkAnswered(what: string): void {
  if (showcase.unanswered.length > 0) throw new Error(`${what}${unansweredNote()}`)
}

async function until(page: WebContents, expression: string, what: string): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  while ((await page.executeJavaScript(expression)) !== true) {
    // A request the showcase couldn't answer is usually what the page waits on: say so now, not in 30 seconds.
    if (Date.now() > deadline || showcase.unanswered.length > 0) {
      throw new Error(`${what} never showed${unansweredNote()}`)
    }
    await sleep(100)
  }
}

/**
 * A left click at page px `[x, y]`, as a mouse makes it. Not `click()`: without a pointer, Chromium treats what
 * follows as keyboard use, so a menu highlights its first item and a dialog rings the link it focuses.
 */
function press(page: WebContents, [x, y]: [number, number]): void {
  page.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  page.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

/** Runs in the page: it shows every one of `texts`. */
function shows(...texts: string[]): boolean {
  return texts.every(text => document.body.innerText.includes(text))
}

/** Runs in the page: the centre of the session list row named `name`, in page px. */
function sessionRow(name: string): [number, number] | null {
  const row = [...document.querySelectorAll('button')].find(b =>
    [...b.querySelectorAll('span')].some(s => s.textContent === name)
  )
  if (!row) return null
  const r = row.getBoundingClientRect()
  return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
}

/** Runs in the page: the chat pane shows `name` with all `length` of its messages. */
function chatOpen(name: string, length: number): boolean {
  return (
    [...document.querySelectorAll('h3')].some(h => h.textContent === name) &&
    document.body.innerText.includes(`${String(length)} 条消息`)
  )
}

/** Runs in the page: the centre of the account menu's or the chat header menu's trigger, in page px. */
function menuTrigger(menu: 'accounts' | 'chat-menu'): [number, number] | null {
  const trigger =
    menu === 'accounts'
      ? [...document.querySelectorAll('[data-slot=menu-trigger]')].find(t => t.textContent.includes('UID:'))
      : document.querySelector('[aria-label="用户设置"]')
  if (!trigger) return null
  const r = trigger.getBoundingClientRect()
  return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
}

/**
 * Runs in the page: resolves once every picture on screen has drawn, no spinner turns, and the page has
 * gone still; or the reasons it hasn't, after 20 seconds.
 */
async function settlePage(): Promise<true | string> {
  const wait = (ms: number): Promise<void> =>
    new Promise(resolve => {
      setTimeout(resolve, ms)
    })
  const started = performance.now()
  const late = (): boolean => performance.now() - started > 20_000
  await document.fonts.ready
  const onScreen = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  }
  const pending = (): string[] => [
    ...[...document.images].filter(i => onScreen(i) && (!i.complete || i.naturalWidth === 0)).map(i => i.src),
    ...[...document.querySelectorAll('[data-slot=avatar-fallback]')].filter(onScreen).map(() => 'an avatar'),
    ...[...document.querySelectorAll('.animate-spin')].filter(onScreen).map(() => 'a spinner'),
  ]
  for (let left = pending(); left.length > 0; left = pending()) {
    if (late()) return left.join(', ')
    await wait(100)
  }
  let changed = performance.now()
  const observer = new MutationObserver(() => {
    changed = performance.now()
  })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  // Transitions run out; loops (a status ping) never do and are held at capture instead.
  const moving = (): boolean =>
    document
      .getAnimations()
      .some(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
  while (performance.now() - changed < 300 || moving()) {
    if (late()) {
      observer.disconnect()
      return 'the page kept changing'
    }
    await wait(50)
  }
  observer.disconnect()
  // Two frames, so what settled has been drawn. A page that draws none (a sleeping display) says so instead.
  const drew = await new Promise<boolean>(resolve => {
    setTimeout(() => {
      resolve(false)
    }, 2000)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve(true)
      })
    })
  })
  return drew ? true : `no frame drew while the page was ${document.visibilityState}`
}

/** Runs in the page just before a capture: no caret blinking, and looping animations at their first frame. */
function holdStill(): void {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur()
  for (const animation of document.getAnimations()) {
    if (animation.effect?.getComputedTiming().iterations !== Infinity) continue
    animation.pause()
    animation.currentTime = 0
  }
}

function focus(win: BrowserWindow): void {
  // Focusing a minimized window doesn't bring it back.
  if (win.isMinimized()) win.restore()
  app.focus({ steal: true })
  win.focus()
}

/** Whether the lock screen is up. Electron's own check only notices a lock that begins after it starts. */
async function screenLocked(): Promise<boolean> {
  try {
    const { stdout } = await run('ioreg', ['-n', 'Root', '-d1', '-a'])
    return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(stdout)
  } catch {
    return false
  }
}

/**
 * Brings the window forward and waits until it's key. macOS can refuse the activation while someone uses
 * another app, and nothing takes focus behind the lock screen, so this keeps asking and says what it waits on.
 */
async function keyWindow(win: BrowserWindow): Promise<void> {
  let asked = Date.now()
  let told = false
  let toldLocked = false
  while (!win.isFocused()) {
    if (await screenLocked()) {
      if (!toldLocked) console.info('screenshots: the screen is locked — unlock the Mac to continue')
      toldLocked = true
      asked = Date.now()
    } else if (Date.now() - asked > FOCUS_TIMEOUT_MS) {
      throw new Error('the app window never stayed key')
    } else if (!told && Date.now() - asked > 5000) {
      // macOS lets an app keep focus but not take it back from another one.
      console.info('screenshots: click the LAPLACE Comet window to continue, then leave the Mac alone')
      told = true
    }
    focus(win)
    await sleep(FOCUS_SETTLE_MS)
  }
}

/** Bring the window forward and let macOS draw it, traffic lights and shadow included. */
async function captureWindow(win: BrowserWindow, file: string): Promise<void> {
  const page = win.webContents
  win.moveTop()
  const id = /^window:(\d+):/.exec(win.getMediaSourceId())?.[1]
  if (id === undefined) throw new Error(`no CGWindowID in ${win.getMediaSourceId()}`)
  // Key on both sides of the capture, or macOS draws grey traffic lights and a smaller shadow.
  for (;;) {
    await keyWindow(win)
    // Once it's key, however long that took: no caret, loops at their first frame, and no pointer, neither the
    // one the presses left nor a real one a click left over the window. The wait lets their transitions finish.
    await inPage(page, holdStill)
    page.sendInputEvent({ type: 'mouseLeave', x: -1, y: -1 })
    await sleep(FOCUS_SETTLE_MS)
    if (!win.isFocused()) continue
    await run('screencapture', ['-x', `-l${id}`, file])
    if (win.isFocused()) return
  }
}

/** Copy `file` over `dest` unless the committed one differs by no more than {@link NOISE}; says which. */
function keep(file: string, dest: string): string {
  if (!existsSync(dest)) {
    copyFileSync(file, dest)
    return 'new'
  }
  const share = changedShare(nativeImage.createFromPath(file), nativeImage.createFromPath(dest))
  const percent = `${(share * 100).toFixed(3)}% of pixels`
  if (share <= NOISE) return `unchanged (${percent} within noise)`
  copyFileSync(file, dest)
  return `updated (${percent})`
}

/** The share of pixels that moved by more than {@link CHANNEL_TOLERANCE} in any channel; 1 when sizes differ. */
function changedShare(a: NativeImage, b: NativeImage): number {
  const size = a.getSize()
  const other = b.getSize()
  if (size.width !== other.width || size.height !== other.height) return 1
  const pa = a.toBitmap()
  const pb = b.toBitmap()
  let changed = 0
  for (let i = 0; i < pa.length; i += 4) {
    if (
      Math.abs(pa[i] - pb[i]) > CHANNEL_TOLERANCE ||
      Math.abs(pa[i + 1] - pb[i + 1]) > CHANNEL_TOLERANCE ||
      Math.abs(pa[i + 2] - pb[i + 2]) > CHANNEL_TOLERANCE ||
      Math.abs(pa[i + 3] - pb[i + 3]) > CHANNEL_TOLERANCE
    ) {
      changed++
    }
  }
  return changed / (size.width * size.height)
}
