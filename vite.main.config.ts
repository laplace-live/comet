import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vitejs.dev/config
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  esbuild: {
    // Strip console.log and debugger statements in production
    drop: mode === 'production' ? ['debugger'] : [],
    pure: mode === 'production' ? ['console.log'] : [],
  },
  build: {
    lib: {
      formats: ['es'],
      entry: './src/main.ts',
      fileName: 'main',
    },
    rollupOptions: {
      // Mark optional ws dependencies as external (they're not required).
      // node-sqlite3-wasm loads its sibling .wasm via __dirname + readFileSync and
      // must never be bundled — it is loaded at runtime via createRequire() so the
      // .wasm resolves against node_modules.
      external: ['bufferutil', 'utf-8-validate', 'node-sqlite3-wasm'],
    },
  },
}))
