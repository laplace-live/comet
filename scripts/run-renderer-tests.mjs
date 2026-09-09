import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const testDir = await mkdtemp(path.join(tmpdir(), 'comet-qr-renderer-'))

try {
  await build({
    configFile: false,
    root: projectRoot,
    logLevel: 'error',
    resolve: { alias: { '@': path.join(projectRoot, 'src') } },
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    build: {
      outDir: testDir,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: path.join(projectRoot, 'tests/qr-login-renderer.tsx'),
        name: 'QRCodeLoginTests',
        formats: ['iife'],
        fileName: () => 'renderer.js',
      },
    },
  })
  await writeFile(path.join(testDir, 'index.html'), '<!doctype html><body><script src="renderer.js"></script></body>')
  await writeFile(
    path.join(testDir, 'main.cjs'),
    `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
app.setPath('userData', path.join(__dirname, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const deadline = setTimeout(() => { console.error('Renderer test timeout'); app.exit(1) }, 20000)
  await win.loadFile(path.join(__dirname, 'index.html'))
  const timer = setInterval(async () => {
    const report = await win.webContents.executeJavaScript('window.__qrLoginTestResults || null')
    if (!report) return
    clearInterval(timer)
    clearTimeout(deadline)
    for (const test of report.tests) console.log((test.ok ? 'PASS ' : 'FAIL ') + test.name + (test.error ? '\\n' + test.error : ''))
    app.exit(report.tests.some(test => !test.ok) || report.error ? 1 : 0)
  }, 50)
}).catch(error => { console.error(error); app.exit(1) })
`
  )
  const electron = require('electron')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(testDir, 'main.cjs')], { env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) console.error(`Electron renderer tests terminated by ${signal}`)
      resolve(code ?? (signal ? 1 : 0))
    })
  })
  process.exitCode = exitCode
} finally {
  await rm(testDir, { recursive: true, force: true })
}
