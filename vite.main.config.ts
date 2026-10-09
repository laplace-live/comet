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
  build: {
    rolldownOptions: {
      // Mark optional ws dependencies as external (they're not required)
      external: ['bufferutil', 'utf-8-validate'],
      // Strip console.log calls in production (the minifier already drops debugger statements)
      treeshake: mode === 'production' ? { manualPureFunctions: ['console.log'] } : undefined,
    },
  },
}))
