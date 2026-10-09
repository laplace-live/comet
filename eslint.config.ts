import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import { createNodeResolver, importX } from 'eslint-plugin-import-x'
import globals from 'globals'
import * as tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['dist/', 'out/', '.vite/', 'references/', 'src/assets/tray-icons.generated.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
      importX.flatConfigs.electron,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ alwaysTryTypes: true, project: './tsconfig.json' }),
        createNodeResolver(),
      ],
    },
  },
])
