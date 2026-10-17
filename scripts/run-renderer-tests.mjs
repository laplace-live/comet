import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const testDir = await mkdtemp(path.join(tmpdir(), 'comet-renderer-'))

try {
  // Each tests/*-renderer.tsx file gets its own page, so one file's fakes (timers, electronAPI) can't leak into another
  const names = (await readdir(path.join(projectRoot, 'tests')))
    .filter(file => file.endsWith('-renderer.tsx'))
    .map(file => path.basename(file, '.tsx'))
  for (const name of names) {
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
          entry: path.join(projectRoot, 'tests', `${name}.tsx`),
          name: 'RendererTests',
          formats: ['iife'],
          fileName: () => `${name}.js`,
        },
      },
    })
    await writeFile(
      path.join(testDir, `${name}.html`),
      `<!doctype html><meta charset="utf-8"><body><script src="${name}.js"></script></body>`
    )
  }
  await writeFile(
    path.join(testDir, 'main.cjs'),
    `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const names = ${JSON.stringify(names)}
app.setPath('userData', path.join(__dirname, 'user-data'))
app.disableHardwareAcceleration()
// Closing one file's window must not quit before the next file runs
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  let failed = false
  for (const name of names) {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    const deadline = setTimeout(() => { console.error('Renderer test timeout: ' + name); app.exit(1) }, 20000)
    await win.loadFile(path.join(__dirname, name + '.html'))
    let report = null
    while (!report) {
      await new Promise(resolve => setTimeout(resolve, 50))
      report = await win.webContents.executeJavaScript('window.__rendererTestResults || null')
    }
    clearTimeout(deadline)
    win.destroy()
    for (const test of report.tests) console.log((test.ok ? 'PASS ' : 'FAIL ') + test.name + (test.error ? '\\n' + test.error : ''))
    if (report.tests.some(test => !test.ok) || report.error) failed = true
  }
  app.exit(failed ? 1 : 0)
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
