# Local Encrypted Full-Text Message Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give LAPLACE Comet a local, encrypted, full-text search that spans every conversation and the full text of every message — not just the loaded sessions and last-message previews.

**Architecture:** A main-process module (`src/api/search-index.ts`) owns an encrypted SQLite DB (`better-sqlite3-multiple-ciphers`) with an FTS5 trigram index. It fills **progressively** (fire-and-forget upserts hooked into existing fetch/WebSocket paths) and via an opt-in **backfill crawler** (throttled, risk-control-aware, resumable). The renderer queries it over IPC and renders grouped results (会话 / 消息) with highlighted snippets and jump-to-message. All data is scoped per account `mid`; the key is wrapped with Electron `safeStorage`.

**Tech Stack:** Electron 42 (main = ESM, vite), React 19 + Tailwind v4, react-virtuoso, `better-sqlite3-multiple-ciphers` (SQLCipher + FTS5 trigram), Vitest (new), Biome formatting, pnpm.

**Design spec:** [docs/superpowers/specs/2026-06-05-local-full-text-message-search-design.md](../specs/2026-06-05-local-full-text-message-search-design.md)

**Implementation order & dependencies:** A (foundation) first. B is pure and feeds C. C feeds D. E wires C/D into the app + IPC. F (backfill) depends on C. G (renderer) comes last so every IPC channel it consumes already exists. Within each area, tasks are ordered.

---

## Shared interfaces (locked — every task uses these exact names)

These signatures are fixed up front so tasks stay mutually consistent. If a task appears to diverge, this section wins.

**Test harness:** Vitest. `pnpm exec vitest run <file>` runs one file. Tests colocated as `src/**/*.test.ts`. `@` → `./src`.

**`src/lib/search-text.ts`** (pure)
```ts
export interface ExtractedText { text: string; typeLabel: string | null }
export function extractSearchableText(content: string, msgType: number, msgStatus?: number): ExtractedText
```

**`src/lib/backfill-policy.ts`** (pure)
```ts
export type BiliErrorKind = 'ok' | 'blocked' | 'too_frequent' | 'not_logged_in' | 'other'
export function classifyError(code: number | null, blocked: boolean): BiliErrorKind
export interface BackoffState { attempt: number; baseDelayMs: number }
export interface BackoffDecision { delayMs: number; nextState: BackoffState; action: 'continue' | 'retry' | 'pause' | 'abort' }
export function nextBackoff(kind: BiliErrorKind, state: BackoffState): BackoffDecision
```

**`src/lib/backfill-cursor.ts`** (pure)
```ts
export interface ConvCursor { oldestSeqno: string | null; backfillDone: boolean; newestSeqno: string | null; newestMsgKey: string | null }
export interface MsgPage { minSeqno: string; maxSeqno: string; hasMore: boolean; empty: boolean }
export function nextBackfillCursor(cursor: ConvCursor, page: MsgPage): { cursor: ConvCursor; nextEndSeqno: string | null; done: boolean }
export interface SessionPage { sessions: Array<{ talkerId: number; sessionTs: string }>; hasMore: boolean }
export function dedupeBoundarySessions(prevEndTs: string | null, page: SessionPage): Array<{ talkerId: number; sessionTs: string }>
```

**`src/api/search-index.ts`** (main process)
```ts
export interface IndexedMessageInput { talkerId: number; sessionType: number; msgSeqno: string; msgKey: string; senderUid: number | null; msgType: number | null; msgSource: number | null; timestamp: number | null; msgStatus: number | null; content: string }
export interface SearchQueryParams { query: string; scope: 'current' | 'all'; sessionType?: number; talkerId?: number; limit: number; offset: number }
export interface ConversationHit { talkerId: number; sessionType: number; name: string | null; snippet: string | null; sessionTs: string | null }
export interface MessageHit { talkerId: number; sessionType: number; msgSeqno: string; msgKey: string; senderUid: number | null; msgType: number | null; timestamp: number | null; typeLabel: string | null; snippet: string }
export interface SearchQueryResult { conversationHits: ConversationHit[]; messageHits: MessageHit[]; total: number }
export interface BackfillStatus { state: 'idle' | 'running' | 'paused' | 'done' | 'error'; processedConversations: number; totalConversations: number; indexedMessages: number; currentTalkerId: number | null; lastError: string | null }
export interface IndexStats { messageCount: number; conversationCount: number; sizeBytes: number; lastUpdatedAt: number | null }
export interface InitOptions { dbPath?: string; encryptionKeyHex?: string }
export async function initSearchIndex(opts?: InitOptions): Promise<void>
export function closeSearchIndex(): void
export function indexMessages(mid: number, messages: IndexedMessageInput[]): void
export function indexSessions(mid: number, sessions: BilibiliSession[]): void
export function clearAccountIndex(mid: number): void
export function querySearch(mid: number, params: SearchQueryParams): SearchQueryResult
export function startBackfill(mid: number, opts?: { sessionType?: number }): void
export function pauseBackfill(): void
export function resumeBackfill(): void
export function getBackfillStatus(): BackfillStatus
export function getIndexStats(mid: number): IndexStats
```

**IPC:** invoke `search:query`, `search:backfill-{start,pause,resume,status,clear}`, `search:stats`; event `search:backfill-progress` (payload `BackfillStatus`). Preload namespace `window.electronAPI.search.*`. FTS snippet sentinels `\u0001` / `\u0002`.

---

# A. Foundation — test harness & native build

### Task 1: Install and configure Vitest test runner

**Files:**
- Modify: `package.json:8-16` (scripts block), `package.json:49-74` (devDependencies)
- Create: `vitest.config.ts`
- Test: `src/lib/__smoke.test.ts`

- [ ] **Step 1: Install the Vitest devDependency.**
  Run:
  ```bash
  pnpm add -D vitest@^3.2.4
  ```
  Expected: `vitest` appears under `devDependencies` in `package.json` and `pnpm-lock.yaml` updates. (If pnpm resolves a different `3.x` patch, that is fine — the major must be `3`.)

- [ ] **Step 2: Add the `test` and `test:watch` scripts to `package.json`.**
  The current scripts block (`package.json:8-16`) is:
  ```json
  "scripts": {
    "start": "electron-forge start",
    "start:debug": "electron-forge start -- --remote-debugging-port=9229",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "publish": "electron-forge publish",
    "lint": "eslint --ext .ts,.tsx .",
    "generate-icons": "bun run scripts/generate-icons.ts"
  },
  ```
  Change it to (add the two new lines after `generate-icons`):
  ```json
  "scripts": {
    "start": "electron-forge start",
    "start:debug": "electron-forge start -- --remote-debugging-port=9229",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "publish": "electron-forge publish",
    "lint": "eslint --ext .ts,.tsx .",
    "generate-icons": "bun run scripts/generate-icons.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  ```

- [ ] **Step 3: Create `vitest.config.ts` at the repo root with the exact locked config.**
  Create `/Users/sparanoid/Git/laplace-comet/vitest.config.ts` with the full contents (note: NO semicolons, single quotes, 2-space indent per Biome):
  ```ts
  import { defineConfig } from 'vitest/config'

  export default defineConfig({
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  })
  ```
  Note: the `'@' -> '/src'` alias here mirrors `tsconfig.json`'s `"@/*": ["./src/*"]`. Vitest resolves `/src` relative to the config root.

- [ ] **Step 4: Write the smoke test that proves the runner works.**
  Create `/Users/sparanoid/Git/laplace-comet/src/lib/__smoke.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'

  describe('vitest smoke', () => {
    it('runs and asserts true', () => {
      expect(true).toBe(true)
    })

    it('resolves the @ alias to src', async () => {
      // const.ts lives at src/lib/const.ts; importing via @ proves alias wiring
      const mod = await import('@/lib/const')
      expect(mod).toBeTypeOf('object')
    })
  })
  ```

- [ ] **Step 5: Run the smoke test to prove the runner and alias both work.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/__smoke.test.ts
  ```
  Expected: PASS — `2 passed` across `1` test file, exit code 0. If the `@/lib/const` import throws a resolve error, the alias in `vitest.config.ts` is wrong; fix it before continuing.

- [ ] **Step 6: Commit the Vitest setup.**
  Run:
  ```bash
  git add package.json pnpm-lock.yaml vitest.config.ts src/lib/__smoke.test.ts
  git commit -m "test: add vitest runner with @ alias and smoke test"
  ```

---

### Task 2: Add encrypted-SQLite dependency and wire the native build

**Files:**
- Modify: `package.json:27-48` (dependencies)
- Modify: `vite.main.config.ts:25-28` (rollupOptions.external)
- Modify: `forge.config.ts:1-8` (imports), `forge.config.ts:36` (rebuildConfig), `forge.config.ts:54-89` (plugins array)

> CI prerequisite callout: `rebuildConfig.force` compiles `better-sqlite3-multiple-ciphers` from source for Electron 42's ABI 134. Every build/CI machine MUST have a C/C++ toolchain installed (macOS: Xcode Command Line Tools; Windows: MSVC build tools + Python; Linux: build-essential + python3). Without it, `pnpm make`/`pnpm package` will fail at the rebuild step.

- [ ] **Step 1: Add `better-sqlite3-multiple-ciphers` to `dependencies` (not dev).**
  Run:
  ```bash
  pnpm add better-sqlite3-multiple-ciphers@^12.10.0
  ```
  Expected: it appears under `dependencies` in `package.json` (between `@base-ui/react` and the other entries, alphabetically), and a native build runs during install for system Node v22. `pnpm-lock.yaml` updates.

- [ ] **Step 2: Verify the dependency landed in the correct section.**
  Run:
  ```bash
  node -e "const p=require('./package.json'); console.log('dep:', p.dependencies['better-sqlite3-multiple-ciphers']); console.log('isDev:', !!(p.devDependencies||{})['better-sqlite3-multiple-ciphers'])"
  ```
  Expected output:
  ```
  dep: ^12.10.0
  isDev: false
  ```
  If `isDev: true`, move the entry into `dependencies` before continuing.

- [ ] **Step 3: Externalize the native module in the main Vite build.**
  The current `build.rollupOptions` block in `vite.main.config.ts` (lines 25-28) is:
  ```ts
      rollupOptions: {
        // Mark optional ws dependencies as external (they're not required)
        external: ['bufferutil', 'utf-8-validate'],
      },
  ```
  Change it to:
  ```ts
      rollupOptions: {
        // Mark optional ws dependencies as external (they're not required).
        // better-sqlite3-multiple-ciphers ships a native .node addon and must
        // never be bundled — it is loaded at runtime via createRequire().
        external: ['bufferutil', 'utf-8-validate', 'better-sqlite3-multiple-ciphers'],
      },
  ```

- [ ] **Step 4: Import `AutoUnpackNativesPlugin` in `forge.config.ts`.**
  The current import block (`forge.config.ts:1-8`) is:
  ```ts
  import { FuseV1Options, FuseVersion } from '@electron/fuses'
  import { MakerSquirrel } from '@electron-forge/maker-squirrel'
  import { MakerZIP } from '@electron-forge/maker-zip'
  import { FusesPlugin } from '@electron-forge/plugin-fuses'
  import { VitePlugin } from '@electron-forge/plugin-vite'
  import type { ForgeConfig } from '@electron-forge/shared-types'

  import { UPDATE_BASE_URL } from './src/lib/const'
  ```
  Change it to (insert the `AutoUnpackNativesPlugin` import alphabetically before `FusesPlugin`):
  ```ts
  import { FuseV1Options, FuseVersion } from '@electron/fuses'
  import { MakerSquirrel } from '@electron-forge/maker-squirrel'
  import { MakerZIP } from '@electron-forge/maker-zip'
  import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives'
  import { FusesPlugin } from '@electron-forge/plugin-fuses'
  import { VitePlugin } from '@electron-forge/plugin-vite'
  import type { ForgeConfig } from '@electron-forge/shared-types'

  import { UPDATE_BASE_URL } from './src/lib/const'
  ```
  Note: the package `@electron-forge/plugin-auto-unpack-natives` is already in `devDependencies` (`package.json:54`), so no install is needed.

- [ ] **Step 5: Set `rebuildConfig` to force-rebuild only the native SQLite module.**
  The current line (`forge.config.ts:36`) is:
  ```ts
    rebuildConfig: {},
  ```
  Change it to:
  ```ts
    rebuildConfig: { force: true, onlyModules: ['better-sqlite3-multiple-ciphers'] },
  ```

- [ ] **Step 6: Add `AutoUnpackNativesPlugin` to the `plugins[]` array.**
  The current start of the `plugins` array (`forge.config.ts:54-56`) is:
  ```ts
    plugins: [
      new VitePlugin({
        // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
  ```
  Change it to (insert `new AutoUnpackNativesPlugin({})` as the first plugin so native `.node` files are unpacked from the asar):
  ```ts
    plugins: [
      // Unpacks native .node addons (better-sqlite3-multiple-ciphers) from the
      // asar so they can be dlopen'd at runtime in packaged builds.
      new AutoUnpackNativesPlugin({}),
      new VitePlugin({
        // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
  ```

- [ ] **Step 7: Smoke-check that both config files still parse/typecheck.**
  Run:
  ```bash
  pnpm exec tsc --noEmit -p tsconfig.json
  ```
  Expected: exit code 0 with no errors referencing `forge.config.ts` or `vite.main.config.ts`. (If `tsc` reports pre-existing unrelated errors elsewhere, confirm none point at the two edited files.) As a lighter alternative if `tsc` surfaces unrelated noise, run `node --check forge.config.ts` is not valid for TS — rely on the `tsc` check above.

- [ ] **Step 8: Commit the dependency and build wiring.**
  Run:
  ```bash
  git add package.json pnpm-lock.yaml vite.main.config.ts forge.config.ts
  git commit -m "build: add better-sqlite3-multiple-ciphers and wire native build"
  ```

---

### Task 3: Prove FTS5 + trigram + native build work via a native smoke test

**Files:**
- Test: `src/api/search-index.smoke.test.ts`

- [ ] **Step 1: Write the native smoke test.**
  This test loads the native module via `createRequire(import.meta.url)` (the exact mechanism `search-index.ts` will use), opens an in-memory DB, confirms the cipher build, and proves the FTS5 `trigram` tokenizer matches a CJK substring. Create `/Users/sparanoid/Git/laplace-comet/src/api/search-index.smoke.test.ts`:
  ```ts
  import { createRequire } from 'node:module'
  import { describe, expect, it } from 'vitest'

  // Load the native addon exactly the way search-index.ts will at runtime,
  // bypassing Vite's bundler. This proves the from-source native build works
  // in the Node test environment (system Node, not Electron's ABI).
  const require = createRequire(import.meta.url)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3-multiple-ciphers')

  describe('better-sqlite3-multiple-ciphers native + FTS5 trigram', () => {
    it('reports a SQLCipher / multiple-ciphers cipher_version', () => {
      const db = new Database(':memory:')
      try {
        const row = db.pragma('cipher_version', { simple: true })
        // multiple-ciphers builds return a non-empty version string here;
        // a plain better-sqlite3 would return undefined.
        expect(typeof row).toBe('string')
        expect((row as string).length).toBeGreaterThan(0)
      } finally {
        db.close()
      }
    })

    it('creates an fts5 trigram table and MATCHes a CJK substring', () => {
      const db = new Database(':memory:')
      try {
        db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram')")
        const insert = db.prepare('INSERT INTO t(rowid, body) VALUES (?, ?)')
        insert.run(1, '你好世界这是一条中文测试消息')
        insert.run(2, 'hello world plain ascii row')

        // trigram needs >=3 chars; '中文测试' is a 4-char CJK substring.
        const cjkHit = db
          .prepare("SELECT rowid FROM t WHERE t MATCH ? ORDER BY rank")
          .all('中文测试') as Array<{ rowid: number }>
        expect(cjkHit.map(r => r.rowid)).toEqual([1])

        // snippet() with the locked sentinels must wrap the match.
        const snip = db
          .prepare("SELECT snippet(t, 0, char(1), char(2), '…', 32) AS s FROM t WHERE t MATCH ? LIMIT 1")
          .get('中文测试') as { s: string }
        expect(snip.s).toContain('\u0001')
        expect(snip.s).toContain('\u0002')

        // ascii substring still works through trigram.
        const asciiHit = db
          .prepare("SELECT rowid FROM t WHERE t MATCH ?")
          .all('plain') as Array<{ rowid: number }>
        expect(asciiHit.map(r => r.rowid)).toEqual([2])
      } finally {
        db.close()
      }
    })

    it('encrypts with PRAGMA key and round-trips through a reopened handle', () => {
      const tmp = require('node:os').tmpdir()
      const join = require('node:path').join
      const fs = require('node:fs')
      const file = join(tmp, `comet-smoke-${process.pid}-${Date.now()}.db`)
      const keyHex = 'a'.repeat(64) // 32-byte raw key as hex

      const db1 = new Database(file)
      try {
        db1.pragma(`key = "x'${keyHex}'"`)
        db1.exec('CREATE TABLE m (id INTEGER PRIMARY KEY, txt TEXT)')
        db1.prepare('INSERT INTO m(id, txt) VALUES (?, ?)').run(1, '加密测试')
      } finally {
        db1.close()
      }

      const db2 = new Database(file)
      try {
        db2.pragma(`key = "x'${keyHex}'"`)
        const got = db2.prepare('SELECT txt FROM m WHERE id = 1').get() as { txt: string }
        expect(got.txt).toBe('加密测试')
      } finally {
        db2.close()
        fs.rmSync(file, { force: true })
      }
    })
  })
  ```

- [ ] **Step 2: Run the native smoke test.**
  Run:
  ```bash
  pnpm exec vitest run src/api/search-index.smoke.test.ts
  ```
  Expected: PASS — `3 passed`, exit code 0. This proves (a) the native addon loads via `createRequire` in the Node test env, (b) the cipher build is active (`cipher_version` is a non-empty string), (c) the FTS5 `trigram` tokenizer matches a 4-char CJK substring and an ASCII substring, (d) `snippet()` emits the `\u0001`/`\u0002` sentinels, and (e) `PRAGMA key` encryption round-trips through a reopened file handle. If the require fails with `ERR_DLOPEN_FAILED` or ABI mismatch, run `pnpm rebuild better-sqlite3-multiple-ciphers` (rebuilds against system Node) and re-run; note that Electron-ABI builds are handled separately by `rebuildConfig`.

- [ ] **Step 3: Confirm the whole suite still passes together.**
  Run:
  ```bash
  pnpm test
  ```
  Expected: PASS — both `src/lib/__smoke.test.ts` and `src/api/search-index.smoke.test.ts` run green (`5 passed` total across `2` files), exit code 0.

- [ ] **Step 4: Commit the native smoke test.**
  Run:
  ```bash
  git add src/api/search-index.smoke.test.ts
  git commit -m "test: prove fts5 trigram and encrypted native build load"
  ```

# B. Content extraction — `extractSearchableText` (Phase 1)

### Task 4: Add Vitest test runner and config

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/package.json:13-16 (scripts), 73 (devDependencies)
- Create: /Users/sparanoid/Git/laplace-comet/vitest.config.ts

- [ ] **Step 1: Install vitest as a dev dependency.**
  Run:
  ```bash
  pnpm add -D vitest
  ```
  Expected: `vitest` appears under `devDependencies` in package.json and a lockfile update.

- [ ] **Step 2: Add `test` and `test:watch` scripts to package.json.**
  The current `scripts` block (package.json:8-16) is:
  ```json
  "scripts": {
    "start": "electron-forge start",
    "start:debug": "electron-forge start -- --remote-debugging-port=9229",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "publish": "electron-forge publish",
    "lint": "eslint --ext .ts,.tsx .",
    "generate-icons": "bun run scripts/generate-icons.ts"
  },
  ```
  Replace it with (adds two lines after `generate-icons`):
  ```json
  "scripts": {
    "start": "electron-forge start",
    "start:debug": "electron-forge start -- --remote-debugging-port=9229",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "publish": "electron-forge publish",
    "lint": "eslint --ext .ts,.tsx .",
    "generate-icons": "bun run scripts/generate-icons.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  ```

- [ ] **Step 3: Create the Vitest config at the repo root.**
  Write `/Users/sparanoid/Git/laplace-comet/vitest.config.ts` with the locked-contract config (note: no trailing semicolons, single quotes, 2-space indent per Biome):
  ```ts
  import { defineConfig } from 'vitest/config'

  export default defineConfig({
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
    resolve: { alias: { '@': '/src' } },
  })
  ```

- [ ] **Step 4: Smoke-test the runner finds zero tests (no test files yet).**
  Run:
  ```bash
  pnpm exec vitest run
  ```
  Expected: vitest starts and reports `No test files found` (or exits cleanly). This confirms the config loads without error.

- [ ] **Step 5: Commit the test harness setup.**
  Run:
  ```bash
  git add package.json pnpm-lock.yaml vitest.config.ts
  git commit -m "chore: add vitest test runner and config"
  ```

### Task 5: Create search-text module skeleton with TEXT extraction (keep emoji codes)

**Files:**
- Create: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts
- Create: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts

- [ ] **Step 1: Write the failing test for the TEXT branch.**
  Create `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts` with:
  ```ts
  import { describe, expect, it } from 'vitest'

  import { MSG_TYPE } from '@/types/bilibili'

  import { extractSearchableText } from './search-text'

  describe('extractSearchableText — TEXT', () => {
    it('returns content.content text with no type label', () => {
      const content = JSON.stringify({ content: '你好世界' })
      const result = extractSearchableText(content, MSG_TYPE.TEXT)
      expect(result).toEqual({ text: '你好世界', typeLabel: null })
    })

    it('keeps [emoji] codes as literal text', () => {
      const content = JSON.stringify({ content: '哈哈[tv_doge]测试[口罩]' })
      const result = extractSearchableText(content, MSG_TYPE.TEXT)
      expect(result.text).toBe('哈哈[tv_doge]测试[口罩]')
      expect(result.typeLabel).toBeNull()
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm it FAILS.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected FAIL: module `./search-text` cannot be resolved / `extractSearchableText is not a function` (file does not exist yet).

- [ ] **Step 3: Write the minimal implementation handling TEXT.**
  Create `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts` with:
  ```ts
  import { MSG_TYPE } from '@/types/bilibili'

  export interface ExtractedText {
    text: string
    typeLabel: string | null
  }

  // Safely extract a string from any value, mirroring MessageBubble.extractTextContent
  // precedence: content > text > title > desc > pure_text > abs_text (recurse into nested content).
  function extractTextContent(value: unknown): string {
    if (typeof value === 'string') {
      return value
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      if (typeof obj.content === 'string') return obj.content
      if (typeof obj.text === 'string') return obj.text
      if (typeof obj.title === 'string') return obj.title
      if (typeof obj.desc === 'string') return obj.desc
      if (typeof obj.pure_text === 'string') return obj.pure_text
      if (typeof obj.abs_text === 'string') return obj.abs_text
      if (obj.content && typeof obj.content === 'object') {
        return extractTextContent(obj.content)
      }
    }
    return ''
  }

  /**
   * Extract indexable plain text and a synthetic type label from a raw message content blob.
   *
   * @param content Raw message.content (JSON string, sometimes a plain string).
   * @param msgType Numeric MSG_TYPE.
   * @param msgStatus 1 = recalled.
   */
  export function extractSearchableText(content: string, msgType: number, msgStatus?: number): ExtractedText {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      parsed = content
    }

    const obj = (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >

    switch (msgType) {
      case MSG_TYPE.TEXT: {
        const text = extractTextContent(obj.content) || extractTextContent(obj)
        return { text, typeLabel: null }
      }

      default:
        return { text: '', typeLabel: null }
    }
  }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected: 2 passing tests in the `TEXT` describe block.

- [ ] **Step 5: Commit the skeleton + TEXT branch.**
  Run:
  ```bash
  git add src/lib/search-text.ts src/lib/search-text.test.ts
  git commit -m "feat: add extractSearchableText with TEXT message support"
  ```

### Task 6: Add IMAGE and CUSTOM_EMOJI label-only branches

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts (append describe block)
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts (add cases in switch)

- [ ] **Step 1: Append failing tests for IMAGE and CUSTOM_EMOJI.**
  Add at the end of `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts`:
  ```ts
  describe('extractSearchableText — label-only types', () => {
    it('IMAGE → empty text with [图片] label', () => {
      const content = JSON.stringify({ url: 'https://i0.hdslb.com/x.jpg', width: 100, height: 100 })
      const result = extractSearchableText(content, MSG_TYPE.IMAGE)
      expect(result).toEqual({ text: '', typeLabel: '[图片]' })
    })

    it('CUSTOM_EMOJI → empty text with [表情] label', () => {
      const content = JSON.stringify({ url: 'https://i0.hdslb.com/e.png', width: 60, height: 60 })
      const result = extractSearchableText(content, MSG_TYPE.CUSTOM_EMOJI)
      expect(result).toEqual({ text: '', typeLabel: '[表情]' })
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm the new cases FAIL.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected FAIL: IMAGE and CUSTOM_EMOJI both return `{ text: '', typeLabel: null }` (default branch), so `typeLabel` mismatches `[图片]` / `[表情]`.

- [ ] **Step 3: Add the IMAGE and CUSTOM_EMOJI cases.**
  In `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts`, the switch currently is:
  ```ts
      case MSG_TYPE.TEXT: {
        const text = extractTextContent(obj.content) || extractTextContent(obj)
        return { text, typeLabel: null }
      }

      default:
        return { text: '', typeLabel: null }
  ```
  Replace it with (insert the two new cases before `default`):
  ```ts
      case MSG_TYPE.TEXT: {
        const text = extractTextContent(obj.content) || extractTextContent(obj)
        return { text, typeLabel: null }
      }

      case MSG_TYPE.IMAGE:
        return { text: '', typeLabel: '[图片]' }

      case MSG_TYPE.CUSTOM_EMOJI:
        return { text: '', typeLabel: '[表情]' }

      default:
        return { text: '', typeLabel: null }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected: all tests pass (TEXT + label-only).

- [ ] **Step 5: Commit the label-only branches.**
  Run:
  ```bash
  git add src/lib/search-text.ts src/lib/search-text.test.ts
  git commit -m "feat: add IMAGE and CUSTOM_EMOJI labels to extractSearchableText"
  ```

### Task 7: Add REVOKE skip and recalled-message (msgStatus===1) handling

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts (append describe block)
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts (add early recall guard + REVOKE case)

- [ ] **Step 1: Append failing tests for REVOKE and recalled messages.**
  Add at the end of `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts`:
  ```ts
  describe('extractSearchableText — recall & revoke', () => {
    it('REVOKE (msg_type 5) → empty text and no label (skipped)', () => {
      const content = JSON.stringify({ content: 'some recall trigger' })
      const result = extractSearchableText(content, MSG_TYPE.REVOKE)
      expect(result).toEqual({ text: '', typeLabel: null })
    })

    it('recalled TEXT (msgStatus===1) → text excluded, [已撤回的消息] label', () => {
      const content = JSON.stringify({ content: '原始内容不应被索引' })
      const result = extractSearchableText(content, MSG_TYPE.TEXT, 1)
      expect(result).toEqual({ text: '', typeLabel: '[已撤回的消息]' })
    })

    it('recall takes precedence over any msg_type label', () => {
      const content = JSON.stringify({ url: 'https://i0.hdslb.com/x.jpg' })
      const result = extractSearchableText(content, MSG_TYPE.IMAGE, 1)
      expect(result).toEqual({ text: '', typeLabel: '[已撤回的消息]' })
    })

    it('msgStatus 0 does not trigger recall handling', () => {
      const content = JSON.stringify({ content: '正常消息' })
      const result = extractSearchableText(content, MSG_TYPE.TEXT, 0)
      expect(result).toEqual({ text: '正常消息', typeLabel: null })
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm the new cases FAIL.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected FAIL: recalled cases return content text / `[图片]` label instead of `{ text: '', typeLabel: '[已撤回的消息]' }`; REVOKE already returns the default `{ text: '', typeLabel: null }` so that one may already pass.

- [ ] **Step 3: Add the recall guard and explicit REVOKE case.**
  In `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts`, the body currently begins:
  ```ts
    export function extractSearchableText(content: string, msgType: number, msgStatus?: number): ExtractedText {
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        parsed = content
      }
  ```
  Insert the recall guard as the very first statement of the function (before the `JSON.parse` try/catch):
  ```ts
    export function extractSearchableText(content: string, msgType: number, msgStatus?: number): ExtractedText {
      // Recalled messages: content is excluded from the index; only the synthetic label is kept.
      if (msgStatus === 1) {
        return { text: '', typeLabel: '[已撤回的消息]' }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        parsed = content
      }
  ```
  Then add an explicit REVOKE case before `default` (REVOKE is a technical recall trigger and is skipped). The switch tail currently is:
  ```ts
      case MSG_TYPE.CUSTOM_EMOJI:
        return { text: '', typeLabel: '[表情]' }

      default:
        return { text: '', typeLabel: null }
  ```
  Replace with:
  ```ts
      case MSG_TYPE.CUSTOM_EMOJI:
        return { text: '', typeLabel: '[表情]' }

      case MSG_TYPE.REVOKE:
        return { text: '', typeLabel: null }

      default:
        return { text: '', typeLabel: null }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected: all tests pass, including recall precedence over IMAGE.

- [ ] **Step 5: Commit the recall + REVOKE handling.**
  Run:
  ```bash
  git add src/lib/search-text.ts src/lib/search-text.test.ts
  git commit -m "feat: skip REVOKE and exclude recalled message content in search index"
  ```

### Task 8: Add SHARE extraction (sketch title/desc/source precedence)

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts (append describe block)
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts (add SHARE case)

- [ ] **Step 1: Append failing tests for SHARE.**
  Add at the end of `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts`:
  ```ts
  describe('extractSearchableText — SHARE', () => {
    it('prefers sketch.title and sketch.desc_text, includes source', () => {
      const content = JSON.stringify({
        title: 'outer title',
        desc: 'outer desc',
        source: '来自哔哩哔哩',
        sketch: { title: '分享标题', desc_text: '分享描述', target_url: 'https://b23.tv/x' },
      })
      const result = extractSearchableText(content, MSG_TYPE.SHARE)
      expect(result.typeLabel).toBeNull()
      expect(result.text).toContain('分享标题')
      expect(result.text).toContain('分享描述')
      expect(result.text).toContain('来自哔哩哔哩')
      expect(result.text).not.toContain('outer title')
    })

    it('falls back to top-level title/desc when sketch is absent', () => {
      const content = JSON.stringify({ title: '顶层标题', desc: '顶层描述', source: '来源' })
      const result = extractSearchableText(content, MSG_TYPE.SHARE)
      expect(result.text).toContain('顶层标题')
      expect(result.text).toContain('顶层描述')
      expect(result.text).toContain('来源')
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm the SHARE cases FAIL.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected FAIL: SHARE falls through to `default` returning empty text, so `result.text` does not contain the expected strings.

- [ ] **Step 3: Add the SHARE case.**
  In `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts`, insert the SHARE case after the `CUSTOM_EMOJI` case (and before `REVOKE`). The `joinParts` helper is introduced here for reuse — add it as a module-level function above `extractSearchableText` (after `extractTextContent`):
  ```ts
  // Join non-empty parts with spaces into a single indexable string.
  function joinParts(parts: Array<string | undefined>): string {
    return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')
  }
  ```
  Then add the case (the switch currently has `CUSTOM_EMOJI` immediately followed by `REVOKE`):
  ```ts
      case MSG_TYPE.CUSTOM_EMOJI:
        return { text: '', typeLabel: '[表情]' }

      case MSG_TYPE.SHARE: {
        const sketch = (obj.sketch && typeof obj.sketch === 'object' ? obj.sketch : {}) as Record<string, unknown>
        const title = extractTextContent(sketch.title) || extractTextContent(obj.title)
        const desc = extractTextContent(sketch.desc_text) || extractTextContent(obj.desc)
        const source = extractTextContent(obj.source)
        return { text: joinParts([title, desc, source]), typeLabel: null }
      }

      case MSG_TYPE.REVOKE:
        return { text: '', typeLabel: null }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected: all tests pass, including both SHARE cases.

- [ ] **Step 5: Commit the SHARE branch.**
  Run:
  ```bash
  git add src/lib/search-text.ts src/lib/search-text.test.ts
  git commit -m "feat: extract SHARE card title/desc/source for search index"
  ```

### Task 9: Add NOTIFICATION extraction (title/text/modules)

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts (append describe block)
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts (add NOTIFICATION case)

- [ ] **Step 1: Append failing tests for NOTIFICATION.**
  Add at the end of `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts`:
  ```ts
  describe('extractSearchableText — NOTIFICATION', () => {
    it('joins title, text, and each module title/detail', () => {
      const content = JSON.stringify({
        title: '系统通知标题',
        text: '通知正文内容',
        modules: [
          { title: '字段一', detail: '详情一' },
          { title: '字段二', detail: '详情二' },
        ],
      })
      const result = extractSearchableText(content, MSG_TYPE.NOTIFICATION)
      expect(result.typeLabel).toBeNull()
      expect(result.text).toContain('系统通知标题')
      expect(result.text).toContain('通知正文内容')
      expect(result.text).toContain('字段一')
      expect(result.text).toContain('详情一')
      expect(result.text).toContain('字段二')
      expect(result.text).toContain('详情二')
    })

    it('handles missing modules gracefully', () => {
      const content = JSON.stringify({ title: '仅标题', text: '仅正文' })
      const result = extractSearchableText(content, MSG_TYPE.NOTIFICATION)
      expect(result.text).toContain('仅标题')
      expect(result.text).toContain('仅正文')
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm the NOTIFICATION cases FAIL.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected FAIL: NOTIFICATION falls through to `default`, so the joined module text is missing.

- [ ] **Step 3: Add the NOTIFICATION case.**
  In `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts`, add the case after the `SHARE` case (before `REVOKE`):
  ```ts
      case MSG_TYPE.NOTIFICATION: {
        const title = extractTextContent(obj.title)
        const text = extractTextContent(obj.text)
        const moduleParts: string[] = []
        if (Array.isArray(obj.modules)) {
          for (const mod of obj.modules) {
            if (mod && typeof mod === 'object') {
              const m = mod as Record<string, unknown>
              const mTitle = extractTextContent(m.title)
              const mDetail = extractTextContent(m.detail)
              if (mTitle) moduleParts.push(mTitle)
              if (mDetail) moduleParts.push(mDetail)
            }
          }
        }
        return { text: joinParts([title, text, ...moduleParts]), typeLabel: null }
      }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected: all tests pass, including both NOTIFICATION cases.

- [ ] **Step 5: Commit the NOTIFICATION branch.**
  Run:
  ```bash
  git add src/lib/search-text.ts src/lib/search-text.test.ts
  git commit -m "feat: extract NOTIFICATION title/text/modules for search index"
  ```

### Task 10: Add VIDEO_PUSH extraction (title/desc/attach_msg)

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts (append describe block)
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts (add VIDEO_PUSH case)

- [ ] **Step 1: Append failing tests for VIDEO_PUSH.**
  Add at the end of `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts`:
  ```ts
  describe('extractSearchableText — VIDEO_PUSH', () => {
    it('joins title, desc, and attach_msg', () => {
      const content = JSON.stringify({
        title: '视频标题',
        desc: '视频简介',
        attach_msg: 'UP主赠言内容',
        bvid: 'BV1xx411',
      })
      const result = extractSearchableText(content, MSG_TYPE.VIDEO_PUSH)
      expect(result.typeLabel).toBeNull()
      expect(result.text).toContain('视频标题')
      expect(result.text).toContain('视频简介')
      expect(result.text).toContain('UP主赠言内容')
    })

    it('handles null attach_msg', () => {
      const content = JSON.stringify({ title: '只有标题', desc: '', attach_msg: null })
      const result = extractSearchableText(content, MSG_TYPE.VIDEO_PUSH)
      expect(result.text).toContain('只有标题')
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm the VIDEO_PUSH cases FAIL.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected FAIL: VIDEO_PUSH falls through to `default`, so the joined text is missing.

- [ ] **Step 3: Add the VIDEO_PUSH case.**
  In `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts`, add the case after the `NOTIFICATION` case (before `REVOKE`):
  ```ts
      case MSG_TYPE.VIDEO_PUSH: {
        const title = extractTextContent(obj.title)
        const desc = extractTextContent(obj.desc)
        const attachMsg = extractTextContent(obj.attach_msg)
        return { text: joinParts([title, desc, attachMsg]), typeLabel: null }
      }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected: all tests pass, including both VIDEO_PUSH cases.

- [ ] **Step 5: Commit the VIDEO_PUSH branch.**
  Run:
  ```bash
  git add src/lib/search-text.ts src/lib/search-text.test.ts
  git commit -m "feat: extract VIDEO_PUSH title/desc/attach_msg for search index"
  ```

### Task 11: Add SYSTEM_TIP extraction (double JSON.parse of content.content)

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts (append describe block)
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts (add SYSTEM_TIP case)

- [ ] **Step 1: Append failing tests for SYSTEM_TIP.**
  The content's inner `content` field is itself a serialized JSON array of `{ text, color_day, color_nig, jump_url? }`. Add at the end of `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts`:
  ```ts
  describe('extractSearchableText — SYSTEM_TIP', () => {
    it('double-parses content.content and joins each item text', () => {
      const inner = JSON.stringify([
        { text: '该用户已被', color_day: '#9499A0', color_nig: '#9499A0' },
        { text: '封禁', color_day: '#FB7299', color_nig: '#FB7299', jump_url: 'https://b.tv/x' },
      ])
      const content = JSON.stringify({ content: inner })
      const result = extractSearchableText(content, MSG_TYPE.SYSTEM_TIP)
      expect(result.typeLabel).toBeNull()
      expect(result.text).toContain('该用户已被')
      expect(result.text).toContain('封禁')
    })

    it('returns empty text when inner content is not a valid JSON array', () => {
      const content = JSON.stringify({ content: 'not-json' })
      const result = extractSearchableText(content, MSG_TYPE.SYSTEM_TIP)
      expect(result).toEqual({ text: '', typeLabel: null })
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm the SYSTEM_TIP cases FAIL.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected FAIL: SYSTEM_TIP falls through to `default`, so the joined item text is missing.

- [ ] **Step 3: Add the SYSTEM_TIP case.**
  In `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts`, add the case after the `VIDEO_PUSH` case (before `REVOKE`). The inner content is double-encoded, so parse `obj.content` again inside a try/catch:
  ```ts
      case MSG_TYPE.SYSTEM_TIP: {
        if (typeof obj.content !== 'string') {
          return { text: '', typeLabel: null }
        }
        try {
          const items = JSON.parse(obj.content)
          if (!Array.isArray(items)) {
            return { text: '', typeLabel: null }
          }
          const parts = items.map(item => {
            if (item && typeof item === 'object') {
              const t = (item as Record<string, unknown>).text
              return typeof t === 'string' ? t : ''
            }
            return ''
          })
          return { text: joinParts(parts), typeLabel: null }
        } catch {
          return { text: '', typeLabel: null }
        }
      }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected: all tests pass, including both SYSTEM_TIP cases.

- [ ] **Step 5: Commit the SYSTEM_TIP branch.**
  Run:
  ```bash
  git add src/lib/search-text.ts src/lib/search-text.test.ts
  git commit -m "feat: extract double-encoded SYSTEM_TIP text for search index"
  ```

### Task 12: Add AI_GENERATED extraction (walk paragraphs/nodes raw_text and word.words)

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts (append describe block)
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts (add AI_GENERATED case)

- [ ] **Step 1: Append failing tests for AI_GENERATED.**
  Nodes within a paragraph concatenate with no separator; paragraphs join with `\n`. `raw_text` is preferred, falling back to `word.words`. Add at the end of `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts`:
  ```ts
  describe('extractSearchableText — AI_GENERATED', () => {
    it('walks paragraphs[].text.nodes[] preferring raw_text, falling back to word.words', () => {
      const content = JSON.stringify({
        sub_type: 1,
        paragraphs: [
          {
            para_type: 1,
            text: {
              nodes: [
                { node_type: 1, raw_text: '你好，' },
                { node_type: 1, raw_text: '', word: { words: '世界' } },
              ],
            },
          },
          {
            para_type: 1,
            text: { nodes: [{ node_type: 1, raw_text: '第二段' }] },
          },
        ],
      })
      const result = extractSearchableText(content, MSG_TYPE.AI_GENERATED)
      expect(result.typeLabel).toBeNull()
      expect(result.text).toBe('你好，世界\n第二段')
    })

    it('returns empty text when paragraphs are missing or empty', () => {
      const content = JSON.stringify({ sub_type: 4, paragraphs: [] })
      const result = extractSearchableText(content, MSG_TYPE.AI_GENERATED)
      expect(result).toEqual({ text: '', typeLabel: null })
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm the AI_GENERATED cases FAIL.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected FAIL: AI_GENERATED falls through to `default`, so `result.text` is empty instead of `'你好，世界\n第二段'`.

- [ ] **Step 3: Add the AI_GENERATED case.**
  In `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts`, add the case after the `SYSTEM_TIP` case (before `REVOKE`). Mirror the MessageBubble node walk exactly (nodes joined with `''`, paragraphs joined with `'\n'`):
  ```ts
      case MSG_TYPE.AI_GENERATED: {
        const paragraphs = obj.paragraphs
        if (!Array.isArray(paragraphs)) {
          return { text: '', typeLabel: null }
        }
        const paragraphTexts: string[] = []
        for (const paragraph of paragraphs) {
          if (!paragraph || typeof paragraph !== 'object') continue
          const textObj = (paragraph as Record<string, unknown>).text
          const nodes = textObj && typeof textObj === 'object' ? (textObj as Record<string, unknown>).nodes : null
          if (!Array.isArray(nodes)) continue
          const nodeTexts: string[] = []
          for (const node of nodes) {
            if (!node || typeof node !== 'object') continue
            const n = node as Record<string, unknown>
            const rawText = typeof n.raw_text === 'string' ? n.raw_text : ''
            const word = n.word && typeof n.word === 'object' ? (n.word as Record<string, unknown>) : null
            const words = word && typeof word.words === 'string' ? word.words : ''
            const nodeText = rawText || words
            if (nodeText) nodeTexts.push(nodeText)
          }
          const paragraphText = nodeTexts.join('')
          if (paragraphText) paragraphTexts.push(paragraphText)
        }
        return { text: paragraphTexts.join('\n'), typeLabel: null }
      }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected: all tests pass, including the node-walk assertion `'你好，世界\n第二段'`.

- [ ] **Step 5: Commit the AI_GENERATED branch.**
  Run:
  ```bash
  git add src/lib/search-text.ts src/lib/search-text.test.ts
  git commit -m "feat: walk AI_GENERATED paragraphs/nodes for search index"
  ```

### Task 13: Add FAN_GROUP_SYSTEM extraction (content.content)

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts (append describe block)
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts (add FAN_GROUP_SYSTEM case)

- [ ] **Step 1: Append failing tests for FAN_GROUP_SYSTEM.**
  Add at the end of `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts`:
  ```ts
  describe('extractSearchableText — FAN_GROUP_SYSTEM', () => {
    it('extracts content.content text', () => {
      const content = JSON.stringify({ group_id: 12345, content: '欢迎 张三 加入粉丝团' })
      const result = extractSearchableText(content, MSG_TYPE.FAN_GROUP_SYSTEM)
      expect(result).toEqual({ text: '欢迎 张三 加入粉丝团', typeLabel: null })
    })

    it('falls back to whole-object extraction when content.content is absent', () => {
      const content = JSON.stringify({ text: '系统消息文本' })
      const result = extractSearchableText(content, MSG_TYPE.FAN_GROUP_SYSTEM)
      expect(result.text).toBe('系统消息文本')
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm the FAN_GROUP_SYSTEM cases FAIL.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected FAIL: FAN_GROUP_SYSTEM falls through to `default`, so the extracted text is empty.

- [ ] **Step 3: Add the FAN_GROUP_SYSTEM case.**
  In `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts`, add the case after the `AI_GENERATED` case (before `REVOKE`). Mirror `renderFanGroupSystemContent` (`content.content` then whole-object fallback):
  ```ts
      case MSG_TYPE.FAN_GROUP_SYSTEM: {
        const text = extractTextContent(obj.content) || extractTextContent(obj)
        return { text, typeLabel: null }
      }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected: all tests pass, including both FAN_GROUP_SYSTEM cases.

- [ ] **Step 5: Commit the FAN_GROUP_SYSTEM branch.**
  Run:
  ```bash
  git add src/lib/search-text.ts src/lib/search-text.test.ts
  git commit -m "feat: extract FAN_GROUP_SYSTEM content for search index"
  ```

### Task 14: Add generic fallback precedence and plain-string handling

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts (append describe block)
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts (replace default branch)

- [ ] **Step 1: Append failing tests for the generic fallback and plain-string cases.**
  Covers unknown msg_types (LOTTERY 13 / MINI_PROGRAM 21 / ARTICLE 22 / LIVE_CARD 27), the precedence chain `content > text > title > desc > pure_text > abs_text`, and a non-JSON plain string. Add at the end of `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts`:
  ```ts
  describe('extractSearchableText — generic fallback & plain string', () => {
    it('LOTTERY (13) uses generic precedence: content wins', () => {
      const content = JSON.stringify({ content: '抽奖内容', text: 'ignored', title: 'ignored' })
      const result = extractSearchableText(content, MSG_TYPE.LOTTERY)
      expect(result).toEqual({ text: '抽奖内容', typeLabel: null })
    })

    it('ARTICLE (22) falls back through title when content/text absent', () => {
      const content = JSON.stringify({ title: '专栏标题', desc: '专栏描述' })
      const result = extractSearchableText(content, MSG_TYPE.ARTICLE)
      expect(result.text).toBe('专栏标题')
    })

    it('LIVE_CARD (27) falls back to pure_text', () => {
      const content = JSON.stringify({ pure_text: '直播间纯文本' })
      const result = extractSearchableText(content, MSG_TYPE.LIVE_CARD)
      expect(result.text).toBe('直播间纯文本')
    })

    it('MINI_PROGRAM (21) falls back to abs_text when nothing higher present', () => {
      const content = JSON.stringify({ abs_text: '小程序摘要' })
      const result = extractSearchableText(content, MSG_TYPE.MINI_PROGRAM)
      expect(result.text).toBe('小程序摘要')
    })

    it('recurses into nested content object', () => {
      const content = JSON.stringify({ content: { content: '嵌套文本' } })
      const result = extractSearchableText(content, MSG_TYPE.LOTTERY)
      expect(result.text).toBe('嵌套文本')
    })

    it('plain (non-JSON) string content falls back to the raw string', () => {
      const result = extractSearchableText('就是一条纯文本', MSG_TYPE.TEXT)
      expect(result).toEqual({ text: '就是一条纯文本', typeLabel: null })
    })

    it('plain string on an unknown type falls back to the raw string', () => {
      const result = extractSearchableText('纯文本未知类型', 9999)
      expect(result.text).toBe('纯文本未知类型')
    })

    it('returns empty text for an unknown type with no extractable fields', () => {
      const content = JSON.stringify({ foo: 'bar', nested: { baz: 1 } })
      const result = extractSearchableText(content, 9999)
      expect(result).toEqual({ text: '', typeLabel: null })
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm the new cases FAIL.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected FAIL: the `default` branch returns `{ text: '', typeLabel: null }` and the plain-string TEXT case returns `''` (because `parsed` is a string and `obj` becomes `{}`), so the precedence/plain-string assertions fail.

- [ ] **Step 3: Make `obj` fall back to the raw string and replace the default branch.**
  Two edits in `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts`.

  First, the plain-string fallback: when `content` is not JSON, `extractTextContent` must still see the raw string. The TEXT case already calls `extractTextContent(obj.content) || extractTextContent(obj)`, and `extractTextContent` of a plain string returns that string only if `obj` IS the string. Currently `obj` is coerced to `{}` for non-objects. Change the `parsed`-to-`obj` coercion. The current lines are:
  ```ts
      const obj = (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}) as Record<
        string,
        unknown
      >
  ```
  Replace with (keep a typed object view `obj` for object access, plus a raw `value` for whole-value extraction):
  ```ts
      const isObject = parsed !== null && typeof parsed === 'object'
      const obj = (isObject ? (parsed as Record<string, unknown>) : {}) as Record<string, unknown>
      // For plain-string / primitive content, extraction must see the raw parsed value.
      const value: unknown = isObject ? parsed : content
  ```

  Second, update the TEXT and FAN_GROUP_SYSTEM cases to fall back to `value` (so a plain string is captured), and replace the `default` branch to use the generic precedence over `value`. The TEXT case currently is:
  ```ts
      case MSG_TYPE.TEXT: {
        const text = extractTextContent(obj.content) || extractTextContent(obj)
        return { text, typeLabel: null }
      }
  ```
  Replace with:
  ```ts
      case MSG_TYPE.TEXT: {
        const text = extractTextContent(obj.content) || extractTextContent(value)
        return { text, typeLabel: null }
      }
  ```
  The FAN_GROUP_SYSTEM case currently is:
  ```ts
      case MSG_TYPE.FAN_GROUP_SYSTEM: {
        const text = extractTextContent(obj.content) || extractTextContent(obj)
        return { text, typeLabel: null }
      }
  ```
  Replace with:
  ```ts
      case MSG_TYPE.FAN_GROUP_SYSTEM: {
        const text = extractTextContent(obj.content) || extractTextContent(value)
        return { text, typeLabel: null }
      }
  ```
  The default branch currently is:
  ```ts
      default:
        return { text: '', typeLabel: null }
  ```
  Replace with (generic precedence + nested recursion handled by `extractTextContent`):
  ```ts
      default:
        return { text: extractTextContent(value), typeLabel: null }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected: all tests pass — generic precedence (`content` wins, fallthrough to `title`/`pure_text`/`abs_text`), nested recursion, and both plain-string cases.

- [ ] **Step 5: Commit the generic fallback + plain-string handling.**
  Run:
  ```bash
  git add src/lib/search-text.ts src/lib/search-text.test.ts
  git commit -m "feat: add generic precedence fallback and plain-string handling to extractSearchableText"
  ```

### Task 15: Final verification of the complete extractSearchableText function

**Files:**
- Test: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.test.ts
- Modify: /Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts (review only — confirm final shape)

- [ ] **Step 1: Run the full search-text suite one final time.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/search-text.test.ts
  ```
  Expected PASS: every describe block green — TEXT (incl. emoji codes), IMAGE/CUSTOM_EMOJI labels, REVOKE skip, recall precedence, SHARE, NOTIFICATION, VIDEO_PUSH, SYSTEM_TIP (double-parse), AI_GENERATED (node walk), FAN_GROUP_SYSTEM, generic fallback precedence, nested recursion, and plain-string fallback.

- [ ] **Step 2: Confirm the full file matches the intended final implementation.**
  Read `/Users/sparanoid/Git/laplace-comet/src/lib/search-text.ts` and verify it equals this complete reference (recall guard first; JSON.parse try/catch; `isObject`/`obj`/`value` derivation; all cases present; `default` uses generic precedence):
  ```ts
  import { MSG_TYPE } from '@/types/bilibili'

  export interface ExtractedText {
    text: string
    typeLabel: string | null
  }

  // Safely extract a string from any value, mirroring MessageBubble.extractTextContent
  // precedence: content > text > title > desc > pure_text > abs_text (recurse into nested content).
  function extractTextContent(value: unknown): string {
    if (typeof value === 'string') {
      return value
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      if (typeof obj.content === 'string') return obj.content
      if (typeof obj.text === 'string') return obj.text
      if (typeof obj.title === 'string') return obj.title
      if (typeof obj.desc === 'string') return obj.desc
      if (typeof obj.pure_text === 'string') return obj.pure_text
      if (typeof obj.abs_text === 'string') return obj.abs_text
      if (obj.content && typeof obj.content === 'object') {
        return extractTextContent(obj.content)
      }
    }
    return ''
  }

  // Join non-empty parts with spaces into a single indexable string.
  function joinParts(parts: Array<string | undefined>): string {
    return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')
  }

  /**
   * Extract indexable plain text and a synthetic type label from a raw message content blob.
   *
   * @param content Raw message.content (JSON string, sometimes a plain string).
   * @param msgType Numeric MSG_TYPE.
   * @param msgStatus 1 = recalled.
   */
  export function extractSearchableText(content: string, msgType: number, msgStatus?: number): ExtractedText {
    // Recalled messages: content is excluded from the index; only the synthetic label is kept.
    if (msgStatus === 1) {
      return { text: '', typeLabel: '[已撤回的消息]' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      parsed = content
    }

    const isObject = parsed !== null && typeof parsed === 'object'
    const obj = (isObject ? (parsed as Record<string, unknown>) : {}) as Record<string, unknown>
    // For plain-string / primitive content, extraction must see the raw parsed value.
    const value: unknown = isObject ? parsed : content

    switch (msgType) {
      case MSG_TYPE.TEXT: {
        const text = extractTextContent(obj.content) || extractTextContent(value)
        return { text, typeLabel: null }
      }

      case MSG_TYPE.IMAGE:
        return { text: '', typeLabel: '[图片]' }

      case MSG_TYPE.CUSTOM_EMOJI:
        return { text: '', typeLabel: '[表情]' }

      case MSG_TYPE.SHARE: {
        const sketch = (obj.sketch && typeof obj.sketch === 'object' ? obj.sketch : {}) as Record<string, unknown>
        const title = extractTextContent(sketch.title) || extractTextContent(obj.title)
        const desc = extractTextContent(sketch.desc_text) || extractTextContent(obj.desc)
        const source = extractTextContent(obj.source)
        return { text: joinParts([title, desc, source]), typeLabel: null }
      }

      case MSG_TYPE.NOTIFICATION: {
        const title = extractTextContent(obj.title)
        const text = extractTextContent(obj.text)
        const moduleParts: string[] = []
        if (Array.isArray(obj.modules)) {
          for (const mod of obj.modules) {
            if (mod && typeof mod === 'object') {
              const m = mod as Record<string, unknown>
              const mTitle = extractTextContent(m.title)
              const mDetail = extractTextContent(m.detail)
              if (mTitle) moduleParts.push(mTitle)
              if (mDetail) moduleParts.push(mDetail)
            }
          }
        }
        return { text: joinParts([title, text, ...moduleParts]), typeLabel: null }
      }

      case MSG_TYPE.VIDEO_PUSH: {
        const title = extractTextContent(obj.title)
        const desc = extractTextContent(obj.desc)
        const attachMsg = extractTextContent(obj.attach_msg)
        return { text: joinParts([title, desc, attachMsg]), typeLabel: null }
      }

      case MSG_TYPE.SYSTEM_TIP: {
        if (typeof obj.content !== 'string') {
          return { text: '', typeLabel: null }
        }
        try {
          const items = JSON.parse(obj.content)
          if (!Array.isArray(items)) {
            return { text: '', typeLabel: null }
          }
          const parts = items.map(item => {
            if (item && typeof item === 'object') {
              const t = (item as Record<string, unknown>).text
              return typeof t === 'string' ? t : ''
            }
            return ''
          })
          return { text: joinParts(parts), typeLabel: null }
        } catch {
          return { text: '', typeLabel: null }
        }
      }

      case MSG_TYPE.AI_GENERATED: {
        const paragraphs = obj.paragraphs
        if (!Array.isArray(paragraphs)) {
          return { text: '', typeLabel: null }
        }
        const paragraphTexts: string[] = []
        for (const paragraph of paragraphs) {
          if (!paragraph || typeof paragraph !== 'object') continue
          const textObj = (paragraph as Record<string, unknown>).text
          const nodes = textObj && typeof textObj === 'object' ? (textObj as Record<string, unknown>).nodes : null
          if (!Array.isArray(nodes)) continue
          const nodeTexts: string[] = []
          for (const node of nodes) {
            if (!node || typeof node !== 'object') continue
            const n = node as Record<string, unknown>
            const rawText = typeof n.raw_text === 'string' ? n.raw_text : ''
            const word = n.word && typeof n.word === 'object' ? (n.word as Record<string, unknown>) : null
            const words = word && typeof word.words === 'string' ? word.words : ''
            const nodeText = rawText || words
            if (nodeText) nodeTexts.push(nodeText)
          }
          const paragraphText = nodeTexts.join('')
          if (paragraphText) paragraphTexts.push(paragraphText)
        }
        return { text: paragraphTexts.join('\n'), typeLabel: null }
      }

      case MSG_TYPE.FAN_GROUP_SYSTEM: {
        const text = extractTextContent(obj.content) || extractTextContent(value)
        return { text, typeLabel: null }
      }

      case MSG_TYPE.REVOKE:
        return { text: '', typeLabel: null }

      default:
        return { text: extractTextContent(value), typeLabel: null }
    }
  }
  ```
  If any drift exists, reconcile the file to this reference (no functional change expected). No commit needed if the file already matches; otherwise:
  ```bash
  git add src/lib/search-text.ts && git commit -m "refactor: finalize extractSearchableText reference implementation"
  ```

# C. Encrypted DB core — open / migrate / upsert (Phase 1)

### Task 16: Add vitest test harness and config

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/package.json:8-16 (scripts), :49-74 (devDependencies)
- Create: /Users/sparanoid/Git/laplace-comet/vitest.config.ts

- [ ] **Step 1: Install vitest as a dev dependency.**
  Run:
  ```bash
  pnpm add -D vitest
  ```
  Expected: `vitest` appears under `devDependencies` in package.json and `pnpm-lock.yaml` updates without error.

- [ ] **Step 2: Add `test` and `test:watch` scripts to package.json.**
  The current scripts block (package.json:8-16) is:
  ```json
  "scripts": {
    "start": "electron-forge start",
    "start:debug": "electron-forge start -- --remote-debugging-port=9229",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "publish": "electron-forge publish",
    "lint": "eslint --ext .ts,.tsx .",
    "generate-icons": "bun run scripts/generate-icons.ts"
  },
  ```
  Replace it with (adds the two test scripts):
  ```json
  "scripts": {
    "start": "electron-forge start",
    "start:debug": "electron-forge start -- --remote-debugging-port=9229",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "publish": "electron-forge publish",
    "lint": "eslint --ext .ts,.tsx .",
    "generate-icons": "bun run scripts/generate-icons.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  ```

- [ ] **Step 3: Create vitest.config.ts at the repo root.**
  Create `/Users/sparanoid/Git/laplace-comet/vitest.config.ts` with the exact locked-contract config (the `@` alias maps to `./src`, matching tsconfig):
  ```ts
  import { defineConfig } from 'vitest/config'

  export default defineConfig({
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
    resolve: { alias: { '@': '/src' } },
  })
  ```

- [ ] **Step 4: Add a throwaway smoke test to prove the harness runs.**
  Create `/Users/sparanoid/Git/laplace-comet/src/lib/_harness.smoke.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'

  describe('vitest harness', () => {
    it('runs', () => {
      expect(1 + 1).toBe(2)
    })
  })
  ```

- [ ] **Step 5: Run the smoke test.**
  Run:
  ```bash
  pnpm exec vitest run src/lib/_harness.smoke.test.ts
  ```
  Expected: PASS — `1 passed`.

- [ ] **Step 6: Delete the throwaway smoke test.**
  Run:
  ```bash
  rm /Users/sparanoid/Git/laplace-comet/src/lib/_harness.smoke.test.ts
  ```

- [ ] **Step 7: Commit the harness.**
  Run:
  ```bash
  git add package.json pnpm-lock.yaml vitest.config.ts
  git commit -m "test: add vitest harness with test scripts and config"
  ```

### Task 17: Add better-sqlite3-multiple-ciphers dependency and vite external

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/package.json:27-48 (dependencies)
- Modify: /Users/sparanoid/Git/laplace-comet/vite.main.config.ts

- [ ] **Step 1: Read the current vite.main.config.ts so the external edit is unambiguous.**
  Run:
  ```bash
  cat /Users/sparanoid/Git/laplace-comet/vite.main.config.ts
  ```
  Expected: shows the existing `build.rollupOptions.external` array containing `'bufferutil'` and `'utf-8-validate'`.

- [ ] **Step 2: Install the encrypted SQLite driver as a runtime dependency.**
  Run:
  ```bash
  pnpm add better-sqlite3-multiple-ciphers@^12.10.0
  ```
  Expected: appears under `dependencies` (not devDependencies) in package.json; native build from source succeeds (Xcode CLT present on macOS dev machine).

- [ ] **Step 3: Add the driver to the main bundle's rollup externals.**
  In `/Users/sparanoid/Git/laplace-comet/vite.main.config.ts`, locate the externals array (it currently lists `'bufferutil', 'utf-8-validate'`) and add the driver. For example, if the file reads:
  ```ts
  external: ['bufferutil', 'utf-8-validate'],
  ```
  change it to:
  ```ts
  external: ['bufferutil', 'utf-8-validate', 'better-sqlite3-multiple-ciphers'],
  ```
  (Match the exact existing formatting/quoting in the real file; only insert the new entry so Vite never bundles the `.node` binding.)

- [ ] **Step 4: Verify the package resolves and loads via createRequire under Node.**
  Run:
  ```bash
  node --input-type=module -e "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const D = require('better-sqlite3-multiple-ciphers'); const db = new D(':memory:'); db.pragma(\"cipher='sqlcipher'\"); db.pragma(\"key='x''\"+'00'.repeat(32)+\"'\"); db.exec('CREATE TABLE t(a)'); db.prepare('INSERT INTO t VALUES (1)').run(); console.log('rows', db.prepare('SELECT count(*) c FROM t').get().c); db.close();"
  ```
  Expected: prints `rows 1` (confirms the native module loads, opens an in-memory encrypted DB, and runs SQL).

- [ ] **Step 5: Commit the dependency and external wiring.**
  Run:
  ```bash
  git add package.json pnpm-lock.yaml vite.main.config.ts
  git commit -m "feat: add better-sqlite3-multiple-ciphers dependency and vite external"
  ```

### Task 18: Encryption key helper (generate/wrap/unwrap, persist) with injectable safeStorage

**Files:**
- Create: /Users/sparanoid/Git/laplace-comet/src/api/search-index-key.ts
- Test: /Users/sparanoid/Git/laplace-comet/src/api/search-index-key.test.ts

- [ ] **Step 1: Write the failing key round-trip test.**
  Create `/Users/sparanoid/Git/laplace-comet/src/api/search-index-key.test.ts`. It injects a fake `safeStorage` so the helper runs in pure Node (no Electron), and round-trips wrap/unwrap. The fake mimics Electron's `safeStorage`: `encryptString` returns a `Buffer`, `decryptString` takes a `Buffer`.
  ```ts
  import { describe, expect, it } from 'vitest'

  import type { SafeStorageLike } from '@/api/search-index-key'
  import { generateKeyHex, resolveKeyHex, unwrapKey, wrapKey } from '@/api/search-index-key'

  // Fake safeStorage: reversible "encryption" via a prefix so we can assert round-trip in Node.
  function makeFakeSafeStorage(available = true): SafeStorageLike {
    const PREFIX = 'enc:'
    return {
      isEncryptionAvailable: () => available,
      encryptString: (plain: string) => Buffer.from(PREFIX + plain, 'utf-8'),
      decryptString: (buf: Buffer) => {
        const s = buf.toString('utf-8')
        if (!s.startsWith(PREFIX)) throw new Error('not encrypted by this backend')
        return s.slice(PREFIX.length)
      },
    }
  }

  describe('generateKeyHex', () => {
    it('returns 64 lowercase hex chars (32 bytes)', () => {
      const hex = generateKeyHex()
      expect(hex).toMatch(/^[0-9a-f]{64}$/)
    })

    it('returns a different value each call', () => {
      expect(generateKeyHex()).not.toBe(generateKeyHex())
    })
  })

  describe('wrapKey / unwrapKey', () => {
    it('round-trips a key hex through the fake safeStorage', () => {
      const safe = makeFakeSafeStorage()
      const hex = generateKeyHex()
      const wrapped = wrapKey(hex, safe)
      expect(typeof wrapped).toBe('string')
      expect(wrapped).not.toContain(hex) // wrapped blob must not expose the raw key verbatim
      const out = unwrapKey(wrapped, safe)
      expect(out).toBe(hex)
    })

    it('unwrap throws when the blob was wrapped by a different backend', () => {
      const safe = makeFakeSafeStorage()
      expect(() => unwrapKey(Buffer.from('garbage').toString('base64'), safe)).toThrow()
    })

    it('wrap falls back to plain base64 when encryption is unavailable', () => {
      const safe = makeFakeSafeStorage(false)
      const hex = generateKeyHex()
      const wrapped = wrapKey(hex, safe)
      // Fallback path stores the hex as plain base64; unwrap recovers it.
      expect(unwrapKey(wrapped, safe)).toBe(hex)
    })
  })

  describe('resolveKeyHex', () => {
    it('generates + persists on first call, then returns the same key on the second call', () => {
      const safe = makeFakeSafeStorage()
      const store = new Map<string, string>()
      const io = {
        read: (k: string) => store.get(k) ?? null,
        write: (k: string, v: string) => {
          store.set(k, v)
        },
      }
      const first = resolveKeyHex(safe, io)
      expect(first).toMatch(/^[0-9a-f]{64}$/)
      expect(store.size).toBe(1) // persisted exactly one wrapped blob
      const second = resolveKeyHex(safe, io)
      expect(second).toBe(first) // stable across calls (reads the persisted blob)
    })
  })
  ```

- [ ] **Step 2: Run the test to confirm it fails for the right reason.**
  Run:
  ```bash
  pnpm exec vitest run src/api/search-index-key.test.ts
  ```
  Expected: FAIL — module `@/api/search-index-key` does not exist yet (`Failed to resolve import` / `Cannot find module`).

- [ ] **Step 3: Implement the key helper module.**
  Create `/Users/sparanoid/Git/laplace-comet/src/api/search-index-key.ts`. The production callers pass Electron's real `safeStorage` and a `userData`-backed `io`; tests inject fakes. Wrapped blobs are tagged so we can tell a `safeStorage`-encrypted blob (`v1`) apart from a plaintext-fallback blob (`v0`).
  ```ts
  import { randomBytes } from 'node:crypto'

  // Minimal shape of Electron's safeStorage, so this module is testable in plain Node.
  export interface SafeStorageLike {
    isEncryptionAvailable(): boolean
    encryptString(plainText: string): Buffer
    decryptString(encrypted: Buffer): string
  }

  // Persistence backend for the wrapped key blob (production: a file in userData).
  export interface KeyStoreIO {
    read(key: string): string | null
    write(key: string, value: string): void
  }

  const STORE_KEY = 'comet-index-key'
  const TAG_ENCRYPTED = 'v1:'
  const TAG_PLAIN = 'v0:'

  /**
   * Generate a fresh 32-byte raw key as 64 lowercase hex chars.
   * Fed to SQLCipher via PRAGMA key = "x'<hex>'".
   */
  export function generateKeyHex(): string {
    return randomBytes(32).toString('hex')
  }

  /**
   * Wrap a key hex for at-rest persistence.
   * Uses safeStorage when available (tagged v1); otherwise falls back to plain
   * base64 (tagged v0) and the caller is expected to surface a degraded-mode warning.
   */
  export function wrapKey(keyHex: string, safe: SafeStorageLike): string {
    if (safe.isEncryptionAvailable()) {
      const blob = safe.encryptString(keyHex).toString('base64')
      return TAG_ENCRYPTED + blob
    }
    return TAG_PLAIN + Buffer.from(keyHex, 'utf-8').toString('base64')
  }

  /**
   * Reverse wrapKey. Throws if a v1 blob cannot be decrypted by this backend
   * (e.g. machine/keychain changed) so the caller can offer rebuild.
   */
  export function unwrapKey(wrapped: string, safe: SafeStorageLike): string {
    if (wrapped.startsWith(TAG_ENCRYPTED)) {
      const blob = wrapped.slice(TAG_ENCRYPTED.length)
      return safe.decryptString(Buffer.from(blob, 'base64'))
    }
    if (wrapped.startsWith(TAG_PLAIN)) {
      const blob = wrapped.slice(TAG_PLAIN.length)
      return Buffer.from(blob, 'base64').toString('utf-8')
    }
    throw new Error('unwrapKey: unrecognized wrapped-key format')
  }

  /**
   * Read the persisted wrapped key and unwrap it; if none exists (first run),
   * generate a fresh key, wrap, persist, and return it. Stable across calls.
   */
  export function resolveKeyHex(safe: SafeStorageLike, io: KeyStoreIO): string {
    const existing = io.read(STORE_KEY)
    if (existing) {
      return unwrapKey(existing, safe)
    }
    const hex = generateKeyHex()
    io.write(STORE_KEY, wrapKey(hex, safe))
    return hex
  }
  ```

- [ ] **Step 4: Run the test to confirm it passes.**
  Run:
  ```bash
  pnpm exec vitest run src/api/search-index-key.test.ts
  ```
  Expected: PASS — all key helper tests green.

- [ ] **Step 5: Commit the key helper.**
  Run:
  ```bash
  git add src/api/search-index-key.ts src/api/search-index-key.test.ts
  git commit -m "feat: add encryption key helper for search index with injectable safeStorage"
  ```

### Task 19: Open encrypted DB, run schema migrations, close (initSearchIndex / closeSearchIndex)

**Files:**
- Create: /Users/sparanoid/Git/laplace-comet/src/api/search-index.ts
- Create: /Users/sparanoid/Git/laplace-comet/src/api/search-index-schema.ts
- Test: /Users/sparanoid/Git/laplace-comet/src/api/search-index.test.ts

- [ ] **Step 1: Write the failing init/migration test.**
  Create `/Users/sparanoid/Git/laplace-comet/src/api/search-index.test.ts`. It opens an in-memory encrypted DB via `initSearchIndex` with an injected key (the production safeStorage path is exercised separately) and asserts every table/virtual-table/trigger from spec section 7 was created, plus `schema_version`. Since `closeSearchIndex` resets the singleton, each test re-inits.
  ```ts
  import { createRequire } from 'node:module'
  import { afterEach, describe, expect, it } from 'vitest'

  import { closeSearchIndex, initSearchIndex } from '@/api/search-index'

  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3-multiple-ciphers')

  const KEY = 'a'.repeat(64) // 64 hex chars = 32-byte raw key

  // Re-open the same file/handle the module opened, to read sqlite_master back out.
  // Since the module owns the connection, we expose a tiny test accessor below.
  afterEach(() => {
    closeSearchIndex()
  })

  async function objectNames(): Promise<Set<string>> {
    // Reach into the module's live connection via the exported __getDbForTest.
    const mod = await import('@/api/search-index')
    const db = (mod as unknown as { __getDbForTest(): InstanceType<typeof Database> }).__getDbForTest()
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string
    }>
    return new Set(rows.map(r => r.name))
  }

  describe('initSearchIndex', () => {
    it('creates all tables, the fts table, and sync triggers', async () => {
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: KEY })
      const names = await objectNames()
      for (const t of [
        'messages',
        'messages_fts',
        'sessions',
        'users',
        'account_cursors',
        'conv_cursors',
        'schema_version',
      ]) {
        expect(names.has(t)).toBe(true)
      }
      // FTS sync triggers
      expect(names.has('messages_ai')).toBe(true)
      expect(names.has('messages_ad')).toBe(true)
      expect(names.has('messages_au')).toBe(true)
    })

    it('records the schema version', async () => {
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: KEY })
      const mod = await import('@/api/search-index')
      const db = (mod as unknown as { __getDbForTest(): InstanceType<typeof Database> }).__getDbForTest()
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
      expect(row.v).toBeGreaterThanOrEqual(1)
    })

    it('is idempotent: a second init on a fresh handle does not throw', async () => {
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: KEY })
      closeSearchIndex()
      await expect(initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: KEY })).resolves.toBeUndefined()
    })

    it('opens a real temp file with the cipher key and round-trips a row', async () => {
      const { mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const dir = mkdtempSync(join(tmpdir(), 'comet-index-'))
      const file = join(dir, 'index.db')
      await initSearchIndex({ dbPath: file, encryptionKeyHex: KEY })
      const mod = await import('@/api/search-index')
      const db = (mod as unknown as { __getDbForTest(): InstanceType<typeof Database> }).__getDbForTest()
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(999, Date.now())
      const n = (db.prepare('SELECT count(*) c FROM schema_version').get() as { c: number }).c
      expect(n).toBeGreaterThanOrEqual(2)
    })
  })
  ```

- [ ] **Step 2: Run the test to confirm it fails for the right reason.**
  Run:
  ```bash
  pnpm exec vitest run src/api/search-index.test.ts
  ```
  Expected: FAIL — `@/api/search-index` does not exist yet (`Failed to resolve import`).

- [ ] **Step 3: Create the schema SQL module (spec section 7, verbatim tables + FTS + triggers).**
  Create `/Users/sparanoid/Git/laplace-comet/src/api/search-index-schema.ts`. `messages_fts` uses external-content (`content='messages'`) + the three sync triggers, with `tokenize='trigram'` at default detail.
  ```ts
  // Current schema version. Bump when adding a migration step.
  export const SCHEMA_VERSION = 1

  // Full schema for the encrypted search index (spec section 7).
  // External-content FTS5 over searchable_text only, kept in sync via triggers.
  // trigram tokenizer (default detail) so snippet() can highlight CJK substring matches.
  export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER NOT NULL,
    applied_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    account_mid     INTEGER NOT NULL,
    talker_id       INTEGER NOT NULL,
    session_type    INTEGER NOT NULL,
    msg_seqno       TEXT    NOT NULL,
    msg_key         TEXT    NOT NULL,
    sender_uid      INTEGER,
    msg_type        INTEGER,
    msg_source      INTEGER,
    timestamp       INTEGER,
    msg_status      INTEGER,
    searchable_text TEXT,
    type_label      TEXT,
    raw_json        TEXT,
    PRIMARY KEY (account_mid, talker_id, session_type, msg_key)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv_seqno
    ON messages (account_mid, talker_id, session_type, msg_seqno);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    searchable_text,
    content='messages',
    content_rowid='rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, searchable_text)
    VALUES (new.rowid, new.searchable_text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, searchable_text)
    VALUES ('delete', old.rowid, old.searchable_text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, searchable_text)
    VALUES ('delete', old.rowid, old.searchable_text);
    INSERT INTO messages_fts (rowid, searchable_text)
    VALUES (new.rowid, new.searchable_text);
  END;

  CREATE TABLE IF NOT EXISTS sessions (
    account_mid   INTEGER NOT NULL,
    talker_id     INTEGER NOT NULL,
    session_type  INTEGER NOT NULL,
    name          TEXT,
    group_name    TEXT,
    last_msg_text TEXT,
    session_ts    TEXT,
    unread_count  INTEGER,
    PRIMARY KEY (account_mid, talker_id, session_type)
  );

  CREATE TABLE IF NOT EXISTS users (
    account_mid INTEGER NOT NULL,
    mid         INTEGER NOT NULL,
    name        TEXT,
    face        TEXT,
    PRIMARY KEY (account_mid, mid)
  );

  CREATE TABLE IF NOT EXISTS account_cursors (
    account_mid            INTEGER PRIMARY KEY,
    session_end_ts         TEXT,
    session_has_more       INTEGER,
    newest_seen_session_ts TEXT,
    last_full_sweep_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS conv_cursors (
    account_mid     INTEGER NOT NULL,
    talker_id       INTEGER NOT NULL,
    session_type    INTEGER NOT NULL,
    oldest_seqno    TEXT,
    backfill_done   INTEGER,
    newest_seqno    TEXT,
    newest_msg_key  TEXT,
    last_indexed_at INTEGER,
    total_indexed   INTEGER,
    PRIMARY KEY (account_mid, talker_id, session_type)
  );
  `
  ```

- [ ] **Step 4: Create search-index.ts with the DB singleton, init, migrations, and close.**
  Create `/Users/sparanoid/Git/laplace-comet/src/api/search-index.ts`. Loads the native driver via `createRequire`; production resolves `dbPath`/key from `app.getPath('userData')` + `safeStorage` via the key helper, but tests inject both. Migrations run `SCHEMA_SQL` and stamp `schema_version`. `__getDbForTest` is an internal accessor used only by tests (kept tiny and harmless). This file holds the full interface/type surface from the locked contract; only the DB-core functions are implemented here — message/session/query functions are stubbed minimally so the module type-checks and other tasks fill them in.
  ```ts
  import { createRequire } from 'node:module'

  import { app, safeStorage } from 'electron'

  import type { BilibiliSession } from '@/types/bilibili'

  import { resolveKeyHex } from '@/api/search-index-key'
  import { SCHEMA_SQL, SCHEMA_VERSION } from '@/api/search-index-schema'

  // ---------------------------------------------------------------------------
  // Native driver (loaded outside Vite's bundle via createRequire — see spec 6.2)
  // ---------------------------------------------------------------------------
  const require = createRequire(import.meta.url)
  // Lazily required inside initSearchIndex so importing this module never dlopen()s
  // the native binding (keeps unit tests that don't init from needing the build).
  type DatabaseCtor = new (path: string, options?: Record<string, unknown>) => DatabaseHandle
  interface DatabaseHandle {
    pragma(source: string): unknown
    exec(sql: string): void
    prepare(sql: string): {
      run(...params: unknown[]): unknown
      get(...params: unknown[]): unknown
      all(...params: unknown[]): unknown[]
    }
    transaction<T extends (...args: never[]) => unknown>(fn: T): T
    close(): void
  }

  // ---------------------------------------------------------------------------
  // Locked-contract public types (full surface; DB-core implements the open/close/
  // upsert/clear functions, sibling tasks implement query + backfill)
  // ---------------------------------------------------------------------------
  export interface IndexedMessageInput {
    talkerId: number
    sessionType: number
    msgSeqno: string
    msgKey: string
    senderUid: number | null
    msgType: number | null
    msgSource: number | null
    timestamp: number | null
    msgStatus: number | null
    content: string
  }

  export interface SearchQueryParams {
    query: string
    scope: 'current' | 'all'
    sessionType?: number
    talkerId?: number
    limit: number
    offset: number
  }

  export interface ConversationHit {
    talkerId: number
    sessionType: number
    name: string | null
    snippet: string | null
    sessionTs: string | null
  }

  export interface MessageHit {
    talkerId: number
    sessionType: number
    msgSeqno: string
    msgKey: string
    senderUid: number | null
    msgType: number | null
    timestamp: number | null
    typeLabel: string | null
    snippet: string
  }

  export interface SearchQueryResult {
    conversationHits: ConversationHit[]
    messageHits: MessageHit[]
    total: number
  }

  export interface BackfillStatus {
    state: 'idle' | 'running' | 'paused' | 'done' | 'error'
    processedConversations: number
    totalConversations: number
    indexedMessages: number
    currentTalkerId: number | null
    lastError: string | null
  }

  export interface IndexStats {
    messageCount: number
    conversationCount: number
    sizeBytes: number
    lastUpdatedAt: number | null
  }

  export interface InitOptions {
    dbPath?: string
    encryptionKeyHex?: string
  }

  // ---------------------------------------------------------------------------
  // Module-level singleton
  // ---------------------------------------------------------------------------
  let db: DatabaseHandle | null = null

  function getDb(): DatabaseHandle {
    if (!db) throw new Error('search-index: DB not initialized; call initSearchIndex() first')
    return db
  }

  // Internal accessor used ONLY by tests (src/api/search-index.test.ts).
  export function __getDbForTest(): DatabaseHandle {
    return getDb()
  }

  function runMigrations(handle: DatabaseHandle): void {
    handle.exec(SCHEMA_SQL)
    const current = handle.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
    if ((current?.v ?? 0) < SCHEMA_VERSION) {
      handle.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, Date.now())
    }
  }

  /**
   * Open the encrypted index DB and run migrations.
   * Tests pass dbPath (':memory:' or a temp file) + encryptionKeyHex directly.
   * Production: dbPath = userData/comet-index.db; key from safeStorage via key helper.
   */
  export async function initSearchIndex(opts?: InitOptions): Promise<void> {
    if (db) return // already open

    const Database = require('better-sqlite3-multiple-ciphers') as DatabaseCtor

    const dbPath = opts?.dbPath ?? `${app.getPath('userData')}/comet-index.db`
    const keyHex =
      opts?.encryptionKeyHex ??
      resolveKeyHex(safeStorage, {
        read: () => readKeyBlob(),
        write: (_k, v) => writeKeyBlob(v),
      })

    const handle = new Database(dbPath)
    // Cipher selection + raw key (SQLCipher-compatible) per spec 6.5.
    handle.pragma("cipher='sqlcipher'")
    handle.pragma(`key="x'${keyHex}'"`)
    // Probe to confirm key correctness before use (spec 6.5 step 3).
    handle.prepare('SELECT count(*) AS c FROM sqlite_master').get()
    handle.pragma('journal_mode = WAL')
    handle.pragma('foreign_keys = ON')

    runMigrations(handle)
    db = handle
  }

  export function closeSearchIndex(): void {
    if (db) {
      db.close()
      db = null
    }
  }

  // ---------------------------------------------------------------------------
  // Key-blob persistence (production path; userData file). Defined here so the
  // production init path is self-contained; tests bypass via injected key.
  // ---------------------------------------------------------------------------
  function keyBlobPath(): string {
    return `${app.getPath('userData')}/comet-index.key`
  }

  function readKeyBlob(): string | null {
    try {
      // Lazy fs require keeps this module importable in non-Node-fs contexts.
      const fs = require('node:fs') as typeof import('node:fs')
      return fs.existsSync(keyBlobPath()) ? fs.readFileSync(keyBlobPath(), 'utf-8') : null
    } catch {
      return null
    }
  }

  function writeKeyBlob(value: string): void {
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(keyBlobPath(), value, 'utf-8')
  }

  // ---------------------------------------------------------------------------
  // Stubs for sibling tasks (upsert/clear filled in by db-core's next tasks;
  // query + backfill by other owners). Present so the module type-checks now.
  // ---------------------------------------------------------------------------
  export function indexMessages(_mid: number, _messages: IndexedMessageInput[]): void {}
  export function indexSessions(_mid: number, _sessions: BilibiliSession[]): void {}
  export function clearAccountIndex(_mid: number): void {}
  export function querySearch(_mid: number, _params: SearchQueryParams): SearchQueryResult {
    return { conversationHits: [], messageHits: [], total: 0 }
  }
  export function startBackfill(_mid: number, _opts?: { sessionType?: number }): void {}
  export function pauseBackfill(): void {}
  export function resumeBackfill(): void {}
  export function getBackfillStatus(): BackfillStatus {
    return {
      state: 'idle',
      processedConversations: 0,
      totalConversations: 0,
      indexedMessages: 0,
      currentTalkerId: null,
      lastError: null,
    }
  }
  export function getIndexStats(_mid: number): IndexStats {
    return { messageCount: 0, conversationCount: 0, sizeBytes: 0, lastUpdatedAt: null }
  }
  ```

- [ ] **Step 5: Run the test to confirm it passes.**
  Run:
  ```bash
  pnpm exec vitest run src/api/search-index.test.ts
  ```
  Expected: PASS — all init/migration tests green (tables, fts, triggers, schema_version, temp-file round-trip).

- [ ] **Step 6: Commit the DB open/migration core.**
  Run:
  ```bash
  git add src/api/search-index.ts src/api/search-index-schema.ts src/api/search-index.test.ts
  git commit -m "feat: open encrypted search index DB with schema migrations"
  ```

### Task 20: indexMessages upsert with FTS population and recalled-text exclusion

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/api/search-index.ts (the `indexMessages` stub + add helpers/prepared statements)
- Test: /Users/sparanoid/Git/laplace-comet/src/api/search-index.test.ts (append a new describe block)

- [ ] **Step 1: Append the failing indexMessages test.**
  Add this describe block to the END of `/Users/sparanoid/Git/laplace-comet/src/api/search-index.test.ts` (after the existing `describe('initSearchIndex', …)`). It inserts messages via `indexMessages`, asserts rows land in `messages`, the FTS index is populated and matchable, idempotency on the PK, that recalled (`msgStatus===1`) content is excluded from FTS but the `[已撤回的消息]` label is stored, and that `msg_key`/`msg_seqno` survive as full-precision TEXT.
  ```ts
  describe('indexMessages', () => {
    async function db() {
      const mod = await import('@/api/search-index')
      return (mod as unknown as { __getDbForTest(): { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } } }).__getDbForTest()
    }

    function textMsg(over: Partial<import('@/api/search-index').IndexedMessageInput>): import('@/api/search-index').IndexedMessageInput {
      return {
        talkerId: 1001,
        sessionType: 1,
        msgSeqno: '6900000000000000001',
        msgKey: '7400000000000000001',
        senderUid: 1001,
        msgType: 1,
        msgSource: 0,
        timestamp: 1700000000,
        msgStatus: 0,
        content: JSON.stringify({ content: '你好世界这是一条测试消息' }),
        ...over,
      }
    }

    it('inserts a message row and populates the FTS index', async () => {
      const { initSearchIndex, indexMessages } = await import('@/api/search-index')
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
      indexMessages(42, [textMsg({})])

      const h = await db()
      const row = h.prepare('SELECT * FROM messages WHERE account_mid = ?').get(42) as Record<string, unknown>
      expect(row.msg_key).toBe('7400000000000000001') // TEXT, full precision
      expect(row.msg_seqno).toBe('6900000000000000001')
      expect(row.searchable_text).toContain('测试消息')

      const hit = h
        .prepare('SELECT m.msg_key FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ?')
        .all('测试消息') as Array<{ msg_key: string }>
      expect(hit.length).toBe(1)
      expect(hit[0].msg_key).toBe('7400000000000000001')
    })

    it('is idempotent on the primary key (re-index updates, never duplicates)', async () => {
      const { initSearchIndex, indexMessages } = await import('@/api/search-index')
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
      indexMessages(42, [textMsg({ content: JSON.stringify({ content: '第一版内容' }) })])
      indexMessages(42, [textMsg({ content: JSON.stringify({ content: '第二版内容修订' }) })])

      const h = await db()
      const count = (h.prepare('SELECT count(*) c FROM messages WHERE account_mid = ?').get(42) as { c: number }).c
      expect(count).toBe(1)
      const ftsCount = (h.prepare('SELECT count(*) c FROM messages_fts').get() as { c: number }).c
      expect(ftsCount).toBe(1) // FTS row updated in place, not duplicated
      const hit = h
        .prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?')
        .get('内容修订') as { c: number }
      expect(hit.c).toBe(1) // matches the NEW text
    })

    it('excludes recalled message content from FTS but stores the recall label', async () => {
      const { initSearchIndex, indexMessages } = await import('@/api/search-index')
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
      indexMessages(42, [
        textMsg({
          msgKey: '7400000000000000099',
          msgStatus: 1,
          content: JSON.stringify({ content: '机密内容不应被搜索到' }),
        }),
      ])

      const h = await db()
      const row = h
        .prepare('SELECT searchable_text, type_label, raw_json FROM messages WHERE msg_key = ?')
        .get('7400000000000000099') as { searchable_text: string | null; type_label: string | null; raw_json: string }
      expect(row.type_label).toBe('[已撤回的消息]')
      expect(row.raw_json).toContain('机密内容') // raw kept for re-render
      const ftsHit = (h.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get('机密内容') as { c: number }).c
      expect(ftsHit).toBe(0) // recalled text is NOT searchable
    })

    it('stores type_label for image messages without polluting text ranking', async () => {
      const { initSearchIndex, indexMessages } = await import('@/api/search-index')
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
      indexMessages(42, [
        textMsg({
          msgKey: '7400000000000000002',
          msgType: 2,
          content: JSON.stringify({ url: 'https://example.com/a.jpg', width: 100, height: 100 }),
        }),
      ])
      const h = await db()
      const row = h.prepare('SELECT searchable_text, type_label FROM messages WHERE msg_key = ?').get('7400000000000000002') as {
        searchable_text: string | null
        type_label: string | null
      }
      expect(row.type_label).toBe('[图片]')
    })

    it('never throws to the caller on malformed input', async () => {
      const { initSearchIndex, indexMessages } = await import('@/api/search-index')
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
      // missing required fields / bad content must be swallowed internally
      expect(() => indexMessages(42, [{ ...textMsg({}), content: undefined as unknown as string }])).not.toThrow()
    })
  })
  ```

- [ ] **Step 2: Run the test to confirm it fails for the right reason.**
  Run:
  ```bash
  pnpm exec vitest run src/api/search-index.test.ts
  ```
  Expected: FAIL — `indexMessages` is still the empty stub, so `messages` has zero rows and the FTS match returns nothing (assertions on row/FTS counts fail). This must run AFTER `extractSearchableText` exists in `src/lib/search-text.ts` (sibling pure-module task); if that module is absent, the import fails first — that is also an acceptable red.

- [ ] **Step 3: Implement indexMessages (replace the stub).**
  In `/Users/sparanoid/Git/laplace-comet/src/api/search-index.ts`, add the import for `extractSearchableText` near the existing `@/api/...` imports:
  ```ts
  import { extractSearchableText } from '@/lib/search-text'
  ```
  Then replace the stub line:
  ```ts
  export function indexMessages(_mid: number, _messages: IndexedMessageInput[]): void {}
  ```
  with the real upsert. It uses an `INSERT … ON CONFLICT … DO UPDATE` on the composite PK (which fires the AFTER UPDATE trigger to keep FTS in sync), excludes recalled text from `searchable_text` (storing only the label), wraps everything in try/catch so it never throws to the caller, and runs as a single transaction:
  ```ts
  // Upsert messages for the given account. Idempotent on (account_mid, talker_id,
  // session_type, msg_key). Recalled (msg_status===1) content is excluded from FTS;
  // only its [已撤回的消息] label is stored. Fire-and-forget: never throws to caller.
  export function indexMessages(mid: number, messages: IndexedMessageInput[]): void {
    try {
      if (!db || messages.length === 0) return
      const stmt = db.prepare(`
        INSERT INTO messages (
          account_mid, talker_id, session_type, msg_seqno, msg_key,
          sender_uid, msg_type, msg_source, timestamp, msg_status,
          searchable_text, type_label, raw_json
        ) VALUES (
          @account_mid, @talker_id, @session_type, @msg_seqno, @msg_key,
          @sender_uid, @msg_type, @msg_source, @timestamp, @msg_status,
          @searchable_text, @type_label, @raw_json
        )
        ON CONFLICT (account_mid, talker_id, session_type, msg_key) DO UPDATE SET
          msg_seqno       = excluded.msg_seqno,
          sender_uid      = excluded.sender_uid,
          msg_type        = excluded.msg_type,
          msg_source      = excluded.msg_source,
          timestamp       = excluded.timestamp,
          msg_status      = excluded.msg_status,
          searchable_text = excluded.searchable_text,
          type_label      = excluded.type_label,
          raw_json        = excluded.raw_json
      `)
      const runAll = db.transaction((rows: IndexedMessageInput[]) => {
        for (const m of rows) {
          let extracted: { text: string; typeLabel: string | null }
          try {
            extracted = extractSearchableText(m.content ?? '', m.msgType ?? 0, m.msgStatus ?? 0)
          } catch {
            extracted = { text: '', typeLabel: null }
          }
          stmt.run({
            account_mid: mid,
            talker_id: m.talkerId,
            session_type: m.sessionType,
            msg_seqno: String(m.msgSeqno),
            msg_key: String(m.msgKey),
            sender_uid: m.senderUid ?? null,
            msg_type: m.msgType ?? null,
            msg_source: m.msgSource ?? null,
            timestamp: m.timestamp ?? null,
            msg_status: m.msgStatus ?? null,
            // extractSearchableText already excludes recalled text (returns '' + the recall label).
            searchable_text: extracted.text || null,
            type_label: extracted.typeLabel,
            raw_json: m.content ?? null,
          })
        }
      })
      runAll(messages)
    } catch (err) {
      console.error('search-index: indexMessages failed', err)
    }
  }
  ```

- [ ] **Step 4: Run the test to confirm it passes.**
  Run:
  ```bash
  pnpm exec vitest run src/api/search-index.test.ts
  ```
  Expected: PASS — rows insert, FTS matches CJK substring, re-index updates in place (no duplicate FTS row), recalled content is excluded while its label persists, image label stored, malformed input swallowed.

- [ ] **Step 5: Commit indexMessages.**
  Run:
  ```bash
  git add src/api/search-index.ts src/api/search-index.test.ts
  git commit -m "feat: implement indexMessages upsert with FTS sync and recall exclusion"
  ```

### Task 21: indexSessions upsert and clearAccountIndex partition purge

**Files:**
- Modify: /Users/sparanoid/Git/laplace-comet/src/api/search-index.ts (the `indexSessions` and `clearAccountIndex` stubs)
- Test: /Users/sparanoid/Git/laplace-comet/src/api/search-index.test.ts (append two describe blocks)

- [ ] **Step 1: Append the failing indexSessions + clearAccountIndex tests.**
  Add to the END of `/Users/sparanoid/Git/laplace-comet/src/api/search-index.test.ts`. The session fixture is a minimal `BilibiliSession`-shaped object (only the fields `indexSessions` reads are required; the rest are cast). It asserts session rows upsert idempotently with `session_ts` kept as TEXT, that `last_msg` flows through `extractSearchableText` into `last_msg_text`, and that `clearAccountIndex` removes only the target account's rows from `messages` (and the FTS index) and `sessions` while leaving other accounts intact.
  ```ts
  describe('indexSessions', () => {
    async function db() {
      const mod = await import('@/api/search-index')
      return (mod as unknown as { __getDbForTest(): { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } } }).__getDbForTest()
    }

    function session(over: Record<string, unknown>) {
      return {
        talker_id: 2002,
        session_type: 1,
        group_name: '',
        group_cover: '',
        session_ts: '1700000000000000',
        unread_count: 3,
        last_msg: {
          sender_uid: 2002,
          receiver_type: 1,
          receiver_id: 42,
          msg_type: 1,
          content: JSON.stringify({ content: '最后一条会话预览消息' }),
          msg_seqno: 1,
          timestamp: 1700000000,
          at_uids: null,
          msg_key: '7400000000000000500',
          msg_status: 0,
          notify_code: '',
          msg_source: 0,
        },
        ...over,
      } as unknown as import('@/types/bilibili').BilibiliSession
    }

    it('upserts a session row with TEXT session_ts and extracted last_msg_text', async () => {
      const { initSearchIndex, indexSessions } = await import('@/api/search-index')
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
      indexSessions(42, [session({})])

      const h = await db()
      const row = h.prepare('SELECT * FROM sessions WHERE account_mid = ? AND talker_id = ?').get(42, 2002) as Record<string, unknown>
      expect(row.session_ts).toBe('1700000000000000') // TEXT, full precision
      expect(row.unread_count).toBe(3)
      expect(String(row.last_msg_text)).toContain('会话预览')
    })

    it('is idempotent on (account_mid, talker_id, session_type)', async () => {
      const { initSearchIndex, indexSessions } = await import('@/api/search-index')
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
      indexSessions(42, [session({ unread_count: 1 })])
      indexSessions(42, [session({ unread_count: 9 })])
      const h = await db()
      const count = (h.prepare('SELECT count(*) c FROM sessions WHERE account_mid = ?').get(42) as { c: number }).c
      expect(count).toBe(1)
      const row = h.prepare('SELECT unread_count u FROM sessions WHERE account_mid = ?').get(42) as { u: number }
      expect(row.u).toBe(9) // updated in place
    })
  })

  describe('clearAccountIndex', () => {
    async function db() {
      const mod = await import('@/api/search-index')
      return (mod as unknown as { __getDbForTest(): { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } } }).__getDbForTest()
    }

    it('purges only the target account from messages, fts, and sessions', async () => {
      const { initSearchIndex, indexMessages, clearAccountIndex } = await import('@/api/search-index')
      await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
      indexMessages(42, [
        {
          talkerId: 1, sessionType: 1, msgSeqno: '1', msgKey: '7400000000000001000',
          senderUid: 1, msgType: 1, msgSource: 0, timestamp: 1, msgStatus: 0,
          content: JSON.stringify({ content: '账号四十二的消息' }),
        },
      ])
      indexMessages(99, [
        {
          talkerId: 1, sessionType: 1, msgSeqno: '1', msgKey: '7400000000000002000',
          senderUid: 1, msgType: 1, msgSource: 0, timestamp: 1, msgStatus: 0,
          content: JSON.stringify({ content: '账号九十九的消息' }),
        },
      ])

      const { clearAccountIndex: clear } = await import('@/api/search-index')
      clear(42)

      const h = await db()
      const left42 = (h.prepare('SELECT count(*) c FROM messages WHERE account_mid = ?').get(42) as { c: number }).c
      const left99 = (h.prepare('SELECT count(*) c FROM messages WHERE account_mid = ?').get(99) as { c: number }).c
      expect(left42).toBe(0)
      expect(left99).toBe(1)
      // FTS for account 99 still matches; account 42's content is gone.
      expect((h.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get('四十二') as { c: number }).c).toBe(0)
      expect((h.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get('九十九') as { c: number }).c).toBe(1)
      void clearAccountIndex // keep both import forms referenced
    })
  })
  ```

- [ ] **Step 2: Run the test to confirm it fails for the right reason.**
  Run:
  ```bash
  pnpm exec vitest run src/api/search-index.test.ts
  ```
  Expected: FAIL — `indexSessions` and `clearAccountIndex` are still empty stubs (no session rows inserted; cleared account still has rows). Other (already-passing) describe blocks stay green.

- [ ] **Step 3: Implement indexSessions (replace the stub).**
  In `/Users/sparanoid/Git/laplace-comet/src/api/search-index.ts`, replace:
  ```ts
  export function indexSessions(_mid: number, _sessions: BilibiliSession[]): void {}
  ```
  with the real upsert. `name` is left null here (resolved-name enrichment is a renderer/userCache concern handled by a sibling task); `last_msg_text` runs the session's `last_msg` through `extractSearchableText`; `session_ts` is stored as TEXT to preserve microsecond precision:
  ```ts
  // Upsert session metadata for offline conversation search. Idempotent on
  // (account_mid, talker_id, session_type). Fire-and-forget: never throws.
  export function indexSessions(mid: number, sessions: BilibiliSession[]): void {
    try {
      if (!db || sessions.length === 0) return
      const stmt = db.prepare(`
        INSERT INTO sessions (
          account_mid, talker_id, session_type, name, group_name,
          last_msg_text, session_ts, unread_count
        ) VALUES (
          @account_mid, @talker_id, @session_type, @name, @group_name,
          @last_msg_text, @session_ts, @unread_count
        )
        ON CONFLICT (account_mid, talker_id, session_type) DO UPDATE SET
          group_name    = excluded.group_name,
          last_msg_text = excluded.last_msg_text,
          session_ts    = excluded.session_ts,
          unread_count  = excluded.unread_count
      `)
      const runAll = db.transaction((rows: BilibiliSession[]) => {
        for (const s of rows) {
          let lastMsgText: string | null = null
          if (s.last_msg) {
            try {
              const e = extractSearchableText(s.last_msg.content ?? '', s.last_msg.msg_type ?? 0, s.last_msg.msg_status ?? 0)
              lastMsgText = e.text || e.typeLabel || null
            } catch {
              lastMsgText = null
            }
          }
          stmt.run({
            account_mid: mid,
            talker_id: s.talker_id,
            session_type: s.session_type,
            name: null,
            group_name: s.group_name || null,
            last_msg_text: lastMsgText,
            session_ts: s.session_ts != null ? String(s.session_ts) : null,
            unread_count: s.unread_count ?? null,
          })
        }
      })
      runAll(sessions)
    } catch (err) {
      console.error('search-index: indexSessions failed', err)
    }
  }
  ```

- [ ] **Step 4: Implement clearAccountIndex (replace the stub).**
  In the same file, replace:
  ```ts
  export function clearAccountIndex(_mid: number): void {}
  ```
  with a partition purge. Deleting from `messages` fires the AFTER DELETE trigger, which removes the matching rows from the external-content FTS index; `users`/`account_cursors`/`conv_cursors` are also cleared so a re-index starts clean. Wrapped in a transaction and try/catch:
  ```ts
  // Remove all rows for one account (account removal, or rebuild). Deleting from
  // messages fires the AFTER DELETE trigger that keeps messages_fts in sync.
  export function clearAccountIndex(mid: number): void {
    try {
      if (!db) return
      const purge = db.transaction((accountMid: number) => {
        for (const table of ['messages', 'sessions', 'users', 'account_cursors', 'conv_cursors']) {
          getDb().prepare(`DELETE FROM ${table} WHERE account_mid = ?`).run(accountMid)
        }
      })
      purge(mid)
    } catch (err) {
      console.error('search-index: clearAccountIndex failed', err)
    }
  }
  ```

- [ ] **Step 5: Run the test to confirm it passes.**
  Run:
  ```bash
  pnpm exec vitest run src/api/search-index.test.ts
  ```
  Expected: PASS — sessions upsert idempotently with TEXT `session_ts` and extracted `last_msg_text`; `clearAccountIndex(42)` removes only account 42's messages/FTS/sessions while account 99 stays intact.

- [ ] **Step 6: Run the full test suite to confirm nothing regressed.**
  Run:
  ```bash
  pnpm test
  ```
  Expected: PASS — every `src/**/*.test.ts` file green.

- [ ] **Step 7: Commit indexSessions and clearAccountIndex.**
  Run:
  ```bash
  git add src/api/search-index.ts src/api/search-index.test.ts
  git commit -m "feat: implement indexSessions upsert and clearAccountIndex partition purge"
  ```

# D. Search query layer — FTS + stats (Phase 1)

### Task 22: Add failing test for trigram FTS message-hit query (CJK, ranking, snippet sentinels)

**Files:**
- Test: `src/api/search-index.test.ts`

- [ ] **Step 1: Create the message-hit query test file.** Seeds an encrypted `:memory:` DB via `indexMessages`, then asserts `querySearch` returns FTS message hits with the contract snippet sentinels (`\u0001`/`\u0002`), bm25 ranking order, and account-scoping. This test will FAIL because `querySearch` is not yet implemented (it returns empty `messageHits`).

Write the FULL file `src/api/search-index.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { IndexedMessageInput } from '@/api/search-index'
import { closeSearchIndex, indexMessages, initSearchIndex, querySearch } from '@/api/search-index'

// MSG_TYPE.TEXT = 1
const TEXT = 1
const MID = 1001

function msg(overrides: Partial<IndexedMessageInput>): IndexedMessageInput {
  return {
    talkerId: 200,
    sessionType: 1,
    msgSeqno: '1',
    msgKey: 'k1',
    senderUid: 200,
    msgType: TEXT,
    msgSource: 0,
    timestamp: 1000,
    msgStatus: 0,
    content: JSON.stringify({ content: 'hello' }),
    ...overrides,
  }
}

describe('querySearch message hits (FTS trigram)', () => {
  beforeEach(async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
  })

  afterEach(() => {
    closeSearchIndex()
  })

  it('returns CJK message hits with snippet sentinels and account scoping', () => {
    indexMessages(MID, [
      msg({ talkerId: 200, msgSeqno: '10', msgKey: 'k10', content: JSON.stringify({ content: '今天天气很好我们去公园散步' }) }),
      msg({ talkerId: 201, msgSeqno: '11', msgKey: 'k11', content: JSON.stringify({ content: '明天会下雨吗' }) }),
    ])
    // Different account must NOT leak into MID's results.
    indexMessages(9999, [
      msg({ talkerId: 200, msgSeqno: '12', msgKey: 'k12', content: JSON.stringify({ content: '今天天气很好别的账号' }) }),
    ])

    const res = querySearch(MID, { query: '天气', scope: 'all', limit: 50, offset: 0 })

    expect(res.messageHits.length).toBe(1)
    const hit = res.messageHits[0]
    expect(hit.talkerId).toBe(200)
    expect(hit.msgSeqno).toBe('10')
    expect(hit.msgKey).toBe('k10')
    // Snippet must contain the contract sentinels around the matched run.
    expect(hit.snippet).toContain('\u0001')
    expect(hit.snippet).toContain('\u0002')
    expect(hit.snippet).toContain('天气')
    expect(res.total).toBe(1)
  })

  it('ranks more relevant rows first via bm25', () => {
    indexMessages(MID, [
      // Low relevance: long doc, one occurrence.
      msg({ talkerId: 300, msgSeqno: '20', msgKey: 'k20', content: JSON.stringify({ content: '苹果' + '其他内容'.repeat(20) }) }),
      // High relevance: short doc, repeated term.
      msg({ talkerId: 301, msgSeqno: '21', msgKey: 'k21', content: JSON.stringify({ content: '苹果苹果苹果' }) }),
    ])

    const res = querySearch(MID, { query: '苹果', scope: 'all', limit: 50, offset: 0 })

    expect(res.messageHits.length).toBe(2)
    // bm25 (smaller = better) should rank the short repeated doc first.
    expect(res.messageHits[0].msgKey).toBe('k21')
    expect(res.messageHits[1].msgKey).toBe('k20')
  })

  it('respects scope=current talkerId filtering', () => {
    indexMessages(MID, [
      msg({ talkerId: 400, msgSeqno: '30', msgKey: 'k30', content: JSON.stringify({ content: '会议记录abc' }) }),
      msg({ talkerId: 401, msgSeqno: '31', msgKey: 'k31', content: JSON.stringify({ content: '会议记录abc' }) }),
    ])

    const all = querySearch(MID, { query: '会议记录', scope: 'all', limit: 50, offset: 0 })
    expect(all.messageHits.length).toBe(2)

    const current = querySearch(MID, { query: '会议记录', scope: 'current', talkerId: 400, limit: 50, offset: 0 })
    expect(current.messageHits.length).toBe(1)
    expect(current.messageHits[0].talkerId).toBe(400)
    expect(current.total).toBe(1)
  })

  it('paginates message hits via limit/offset while total stays full', () => {
    const inputs: IndexedMessageInput[] = []
    for (let i = 0; i < 5; i++) {
      inputs.push(
        msg({
          talkerId: 500,
          msgSeqno: String(40 + i),
          msgKey: `k4${i}`,
          timestamp: 1000 + i,
          content: JSON.stringify({ content: `订单编号${i}` }),
        })
      )
    }
    indexMessages(MID, inputs)

    const page1 = querySearch(MID, { query: '订单编号', scope: 'all', limit: 2, offset: 0 })
    expect(page1.messageHits.length).toBe(2)
    expect(page1.total).toBe(5)

    const page2 = querySearch(MID, { query: '订单编号', scope: 'all', limit: 2, offset: 2 })
    expect(page2.messageHits.length).toBe(2)
    expect(page2.total).toBe(5)

    // No overlap between pages.
    const keys1 = page1.messageHits.map(h => h.msgKey)
    const keys2 = page2.messageHits.map(h => h.msgKey)
    expect(keys1.some(k => keys2.includes(k))).toBe(false)
  })
})
```

- [ ] **Step 2: Run the new test and confirm it FAILS.**

Command:
```bash
pnpm exec vitest run src/api/search-index.test.ts
```
Expected: FAIL. `querySearch` exists (stub from the init/schema task) but returns `messageHits: []` and `total: 0`, so `expect(res.messageHits.length).toBe(1)` fails (received 0). If `querySearch` is not yet exported at all, the import fails with "does not provide an export named 'querySearch'" — also a valid FAIL state to proceed from.

### Task 23: Implement FTS5 message-hit branch of querySearch

**Files:**
- Modify: `src/api/search-index.ts` (the `querySearch` function body and any module-level prepared-statement/helper area)
- Test: `src/api/search-index.test.ts`

- [ ] **Step 1: Read the current `querySearch` implementation and DB-handle accessor in `src/api/search-index.ts`.** Confirm the exact name of the open-DB variable (e.g. `db`), the `getActiveAccountMid`-independent `mid` param flow, the `SearchQueryParams`/`SearchQueryResult`/`MessageHit` interfaces, and how prepared statements are created elsewhere in the file (so the new statements follow the same `db.prepare(...)` pattern). Show the real current lines before editing.

Command to locate them:
```bash
grep -n "querySearch\|let db\|const db\|db\.prepare\|function querySearch\|MessageHit\|messages_fts" src/api/search-index.ts
```

- [ ] **Step 2: Add a trigram-eligibility helper above `querySearch`.** FTS5 trigram cannot match queries with fewer than 3 characters (counting code points, so 1–2 CJK chars also fail). Insert this helper (use the real surrounding context discovered in Step 1; place it directly above the `export function querySearch`):

```ts
// FTS5 trigram tokenizer cannot index-match queries shorter than 3 characters.
// Count by code points so 1-2 CJK chars (each 1 code point) correctly fall back.
function isTrigramEligible(query: string): boolean {
  return [...query.trim()].length >= 3
}

// Escape an FTS5 MATCH string by wrapping it in double quotes and doubling any
// embedded double quotes, so user punctuation can never be parsed as FTS syntax.
function toFtsMatch(query: string): string {
  return `"${query.trim().replace(/"/g, '""')}"`
}
```

- [ ] **Step 3: Replace the body of `querySearch` with the FTS message-hit branch (conversation hits + fallback added in later tasks).** Use the exact contract signature. The implementation: build the message-hit query against `messages_fts` MATCH, ranked by `bm25(messages_fts)` ascending (smaller = more relevant), filtered by `account_mid` and (when `scope === 'current'`) `talker_id`, with `snippet(messages_fts, 0, '\u0001', '\u0002', '…', 32)`, `LIMIT params.limit OFFSET params.offset`; plus a separate `COUNT(*)` for `total`. Replace the existing `querySearch` body with:

```ts
export function querySearch(mid: number, params: SearchQueryParams): SearchQueryResult {
  if (!db) return { conversationHits: [], messageHits: [], total: 0 }

  const conversationHits: ConversationHit[] = []
  const messageHits: MessageHit[] = []
  let total = 0

  const q = params.query.trim()
  if (q.length === 0) {
    return { conversationHits, messageHits, total }
  }

  const scopeCurrent = params.scope === 'current' && typeof params.talkerId === 'number'

  if (isTrigramEligible(q)) {
    const match = toFtsMatch(q)

    // total count (no limit/offset)
    const countSql = `
      SELECT COUNT(*) AS n
      FROM messages_fts
      JOIN messages ON messages.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ?
        AND messages.account_mid = ?
        ${scopeCurrent ? 'AND messages.talker_id = ?' : ''}
    `
    const countArgs: Array<string | number> = scopeCurrent ? [match, mid, params.talkerId as number] : [match, mid]
    const countRow = db.prepare(countSql).get(...countArgs) as { n: number } | undefined
    total = countRow?.n ?? 0

    const hitsSql = `
      SELECT
        messages.talker_id   AS talkerId,
        messages.session_type AS sessionType,
        messages.msg_seqno   AS msgSeqno,
        messages.msg_key     AS msgKey,
        messages.sender_uid  AS senderUid,
        messages.msg_type    AS msgType,
        messages.timestamp   AS timestamp,
        messages.type_label  AS typeLabel,
        snippet(messages_fts, 0, char(1), char(2), '…', 32) AS snippet
      FROM messages_fts
      JOIN messages ON messages.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ?
        AND messages.account_mid = ?
        ${scopeCurrent ? 'AND messages.talker_id = ?' : ''}
      ORDER BY bm25(messages_fts) ASC
      LIMIT ? OFFSET ?
    `
    const hitsArgs: Array<string | number> = scopeCurrent
      ? [match, mid, params.talkerId as number, params.limit, params.offset]
      : [match, mid, params.limit, params.offset]

    const rows = db.prepare(hitsSql).all(...hitsArgs) as Array<{
      talkerId: number
      sessionType: number
      msgSeqno: string
      msgKey: string
      senderUid: number | null
      msgType: number | null
      timestamp: number | null
      typeLabel: string | null
      snippet: string
    }>

    for (const r of rows) {
      messageHits.push({
        talkerId: r.talkerId,
        sessionType: r.sessionType,
        msgSeqno: String(r.msgSeqno),
        msgKey: String(r.msgKey),
        senderUid: r.senderUid,
        msgType: r.msgType,
        timestamp: r.timestamp,
        typeLabel: r.typeLabel,
        snippet: r.snippet,
      })
    }
  }

  return { conversationHits, messageHits, total }
}
```

Notes for the implementer:
- The contract snippet sentinels are `\u0001` / `\u0002`. They are produced inside SQLite via `char(1)` / `char(2)` (passing raw control bytes as a bound parameter or string literal in SQL is fragile), which is exactly U+0001 / U+0002 — matching `'\u0001'` / `'\u0002'` on the JS side.
- `msg_seqno` and `msg_key` are `TEXT` in the schema; `String(...)` guards against any driver returning them as numbers.
- `db` is the module-level open handle established by `initSearchIndex`; if Step 1 revealed a different variable name, use that name verbatim instead of `db`.

- [ ] **Step 4: Run the test and confirm the message-hit assertions PASS.**

Command:
```bash
pnpm exec vitest run src/api/search-index.test.ts
```
Expected: PASS for all four message-hit `it(...)` cases (CJK hit + sentinels + scoping, bm25 ranking order `k21` before `k20`, scope=current filter, pagination with full `total`).

- [ ] **Step 5: Commit.**

```bash
git add src/api/search-index.ts src/api/search-index.test.ts
git commit -m "feat(search): implement FTS5 message-hit branch of querySearch"
```

### Task 24: Add failing test for conversation-hit branch of querySearch

**Files:**
- Modify: `src/api/search-index.test.ts` (append a new `describe` block)

- [ ] **Step 1: Read the current `src/api/search-index.test.ts`** to confirm the existing imports and the `indexSessions` export name/signature (`indexSessions(mid, sessions: BilibiliSession[])`), so the new block reuses the same import line and a valid `BilibiliSession` shape.

Command:
```bash
grep -n "import\|indexSessions\|BilibiliSession" src/api/search-index.test.ts
```

- [ ] **Step 2: Append a conversation-hits `describe` block to `src/api/search-index.test.ts`.** It seeds sessions via `indexSessions`, then asserts `querySearch` populates `conversationHits` by matching `sessions.name`, `talker_id`, and `last_msg_text`, capped and account-scoped. This will FAIL because `querySearch` currently returns `conversationHits: []`.

Add this import near the top (merge into the existing `@/api/search-index` import — show it as the full updated import line) and append the block at end of file:

Updated import line:
```ts
import { closeSearchIndex, indexMessages, indexSessions, initSearchIndex, querySearch } from '@/api/search-index'
```

Add this import after the existing imports:
```ts
import type { BilibiliSession } from '@/types/bilibili'
```

Appended block:
```ts
function session(overrides: Partial<BilibiliSession>): BilibiliSession {
  return {
    talker_id: 200,
    session_type: 1,
    at_seqno: 0,
    top_ts: 0,
    group_name: '',
    group_cover: '',
    is_follow: 0,
    is_dnd: 0,
    ack_seqno: 0,
    ack_ts: 0,
    session_ts: 1700000000000000,
    unread_count: 0,
    last_msg: null,
    group_type: 0,
    can_fold: 0,
    status: 0,
    max_seqno: 0,
    new_push_msg: 0,
    setting: 0,
    is_guardian: 0,
    is_intercept: 0,
    is_trust: 0,
    system_msg_type: 0,
    live_status: 0,
    biz_msg_unread_count: 0,
    user_label: null,
    ...overrides,
  } as BilibiliSession
}

describe('querySearch conversation hits', () => {
  beforeEach(async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
  })

  afterEach(() => {
    closeSearchIndex()
  })

  it('matches sessions by name, talker_id, and last_msg_text', () => {
    indexSessions(MID, [
      session({
        talker_id: 700,
        session_type: 1,
        group_name: '阿强的小屋',
        last_msg: { sender_uid: 700, receiver_type: 1, receiver_id: MID, msg_type: 1, content: JSON.stringify({ content: '周末一起打球' }), msg_seqno: 1, timestamp: 100, at_uids: null, msg_key: 'lm1', msg_status: 0, notify_code: '', msg_source: 0 },
      }),
      session({ talker_id: 701, session_type: 1, group_name: '无关会话', last_msg: null }),
    ])

    // Name match
    const byName = querySearch(MID, { query: '阿强', scope: 'all', limit: 50, offset: 0 })
    expect(byName.conversationHits.some(c => c.talkerId === 700)).toBe(true)

    // last_msg_text match
    const byMsg = querySearch(MID, { query: '打球', scope: 'all', limit: 50, offset: 0 })
    expect(byMsg.conversationHits.some(c => c.talkerId === 700)).toBe(true)

    // talker_id numeric match
    const byId = querySearch(MID, { query: '700', scope: 'all', limit: 50, offset: 0 })
    expect(byId.conversationHits.some(c => c.talkerId === 700)).toBe(true)
  })

  it('filters conversation hits by sessionType when provided', () => {
    indexSessions(MID, [
      session({ talker_id: 800, session_type: 1, group_name: '搜索目标用户' }),
      session({ talker_id: 801, session_type: 2, group_name: '搜索目标粉丝团' }),
    ])

    const userOnly = querySearch(MID, { query: '搜索目标', scope: 'all', sessionType: 1, limit: 50, offset: 0 })
    expect(userOnly.conversationHits.every(c => c.sessionType === 1)).toBe(true)
    expect(userOnly.conversationHits.some(c => c.talkerId === 800)).toBe(true)
    expect(userOnly.conversationHits.some(c => c.talkerId === 801)).toBe(false)
  })

  it('caps conversation hits at ~20', () => {
    const sessions: BilibiliSession[] = []
    for (let i = 0; i < 30; i++) {
      sessions.push(session({ talker_id: 900 + i, session_type: 1, group_name: `公共前缀会话${i}` }))
    }
    indexSessions(MID, sessions)

    const res = querySearch(MID, { query: '公共前缀会话', scope: 'all', limit: 50, offset: 0 })
    expect(res.conversationHits.length).toBeLessThanOrEqual(20)
    expect(res.conversationHits.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: Run the test and confirm the conversation-hit cases FAIL.**

Command:
```bash
pnpm exec vitest run src/api/search-index.test.ts
```
Expected: FAIL on the new `querySearch conversation hits` cases — `conversationHits` is currently `[]`, so `expect(...).toBe(true)` / `.some(...)` assertions fail (received empty array). The previously-passing message-hit cases still PASS.

### Task 25: Implement conversation-hit branch of querySearch (LIKE over name/talker_id/last_msg_text)

**Files:**
- Modify: `src/api/search-index.ts` (the `querySearch` function body, conversation-hits section)
- Test: `src/api/search-index.test.ts`

- [ ] **Step 1: Re-read the current `querySearch` body and the `ConversationHit` interface and `sessions` table columns** in `src/api/search-index.ts` to confirm exact column names (`name`, `last_msg_text`, `session_ts`, `talker_id`, `session_type`, `account_mid`) match the schema, and the `snippet`/`name`/`sessionTs` fields of `ConversationHit`.

Command:
```bash
grep -n "ConversationHit\|CREATE TABLE sessions\|last_msg_text\|session_ts\|conversationHits" src/api/search-index.ts
```

- [ ] **Step 2: Add the conversation-hit LIKE query inside `querySearch`, populating `conversationHits` before `return`.** Insert this block immediately after the `if (q.length === 0)` early-return and before the `if (isTrigramEligible(q))` message branch, so conversation hits run for every query length (they use LIKE, not FTS). Show it merged into the real body:

```ts
  // Conversation hits: bounded LIKE over sessions.name / talker_id / last_msg_text.
  // Capped ~20, respects params.sessionType, scoped to account_mid. Runs for all
  // query lengths (does not depend on the trigram >=3-char rule).
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`
  const convFilterType = typeof params.sessionType === 'number'
  const convSql = `
    SELECT
      talker_id     AS talkerId,
      session_type  AS sessionType,
      name          AS name,
      last_msg_text AS snippet,
      session_ts    AS sessionTs
    FROM sessions
    WHERE account_mid = ?
      ${convFilterType ? 'AND session_type = ?' : ''}
      AND (
        name LIKE ? ESCAPE '\\'
        OR last_msg_text LIKE ? ESCAPE '\\'
        OR CAST(talker_id AS TEXT) LIKE ? ESCAPE '\\'
      )
    ORDER BY session_ts DESC
    LIMIT 20
  `
  const convArgs: Array<string | number> = convFilterType
    ? [mid, params.sessionType as number, like, like, like]
    : [mid, like, like, like]

  const convRows = db.prepare(convSql).all(...convArgs) as Array<{
    talkerId: number
    sessionType: number
    name: string | null
    snippet: string | null
    sessionTs: string | null
  }>

  for (const r of convRows) {
    conversationHits.push({
      talkerId: r.talkerId,
      sessionType: r.sessionType,
      name: r.name,
      snippet: r.snippet,
      sessionTs: r.sessionTs == null ? null : String(r.sessionTs),
    })
  }
```

Notes for the implementer:
- The LIKE pattern escapes `%`, `_`, and `\` and uses `ESCAPE '\'` so user-typed wildcards are literal.
- `talker_id` is `INTEGER` in the schema, so it is `CAST(... AS TEXT)` for substring matching (supports the `'700'` test case).
- `session_ts` is `TEXT`; `String(...)` guards against numeric coercion by the driver. `ORDER BY session_ts DESC` orders newest-first; the cap of 20 matches the spec/contract.

- [ ] **Step 3: Run the test and confirm conversation-hit cases now PASS.**

Command:
```bash
pnpm exec vitest run src/api/search-index.test.ts
```
Expected: PASS for `querySearch conversation hits` (name/last_msg_text/talker_id matches, sessionType filter, ≤20 cap) and message-hit cases remain PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/api/search-index.ts src/api/search-index.test.ts
git commit -m "feat(search): add conversation-hit LIKE branch to querySearch"
```

### Task 26: Add failing test for <3-char CJK LIKE fallback path

**Files:**
- Modify: `src/api/search-index.test.ts` (append a new `describe` block)

- [ ] **Step 1: Append a `describe('querySearch short-query fallback')` block to `src/api/search-index.test.ts`.** For a 1–2 char (CJK) query that trigram cannot match, `querySearch` must fall back to a bounded `LIKE '%q%'` over `messages.searchable_text`, limited to the most recent N (500) rows by timestamp. This will FAIL because the current `querySearch` only populates `messageHits` when `isTrigramEligible(q)` is true, so a 2-char query returns zero message hits.

Append at end of file:

```ts
describe('querySearch short-query fallback (<3 chars)', () => {
  beforeEach(async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
  })

  afterEach(() => {
    closeSearchIndex()
  })

  it('matches a 2-char CJK query via LIKE fallback over searchable_text', () => {
    indexMessages(MID, [
      msg({ talkerId: 1100, msgSeqno: '60', msgKey: 'k60', timestamp: 5000, content: JSON.stringify({ content: '我爱北京天安门' }) }),
      msg({ talkerId: 1100, msgSeqno: '61', msgKey: 'k61', timestamp: 5001, content: JSON.stringify({ content: '完全无关的句子' }) }),
    ])

    const res = querySearch(MID, { query: '北京', scope: 'all', limit: 50, offset: 0 })

    expect(res.messageHits.length).toBe(1)
    expect(res.messageHits[0].msgKey).toBe('k60')
    expect(res.total).toBe(1)
  })

  it('matches a 1-char query via LIKE fallback', () => {
    indexMessages(MID, [
      msg({ talkerId: 1101, msgSeqno: '70', msgKey: 'k70', timestamp: 6000, content: JSON.stringify({ content: '猫' }) }),
      msg({ talkerId: 1101, msgSeqno: '71', msgKey: 'k71', timestamp: 6001, content: JSON.stringify({ content: '狗' }) }),
    ])

    const res = querySearch(MID, { query: '猫', scope: 'all', limit: 50, offset: 0 })
    expect(res.messageHits.length).toBe(1)
    expect(res.messageHits[0].msgKey).toBe('k70')
  })

  it('fallback respects scope=current talkerId', () => {
    indexMessages(MID, [
      msg({ talkerId: 1200, msgSeqno: '80', msgKey: 'k80', timestamp: 7000, content: JSON.stringify({ content: '红色' }) }),
      msg({ talkerId: 1201, msgSeqno: '81', msgKey: 'k81', timestamp: 7001, content: JSON.stringify({ content: '红色' }) }),
    ])

    const res = querySearch(MID, { query: '红色', scope: 'current', talkerId: 1200, limit: 50, offset: 0 })
    expect(res.messageHits.length).toBe(1)
    expect(res.messageHits[0].talkerId).toBe(1200)
  })

  it('fallback windows to the most recent 500 rows and excludes older matches', () => {
    const inputs: IndexedMessageInput[] = []
    // 1 old matching row at the very bottom of the recency window.
    inputs.push(
      msg({ talkerId: 1300, msgSeqno: '1', msgKey: 'old-match', timestamp: 1, content: JSON.stringify({ content: '稀有词' }) })
    )
    // 500 newer NON-matching rows push the old match out of the recent-500 window.
    for (let i = 0; i < 500; i++) {
      inputs.push(
        msg({
          talkerId: 1300,
          msgSeqno: String(1000 + i),
          msgKey: `filler-${i}`,
          timestamp: 1000 + i,
          content: JSON.stringify({ content: `填充内容${i}` }),
        })
      )
    }
    indexMessages(MID, inputs)

    const res = querySearch(MID, { query: '稀有', scope: 'all', limit: 50, offset: 0 })
    // The only match is older than the 500 most-recent rows, so the bounded
    // fallback window must not return it.
    expect(res.messageHits.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test and confirm the fallback cases FAIL.**

Command:
```bash
pnpm exec vitest run src/api/search-index.test.ts
```
Expected: FAIL on `querySearch short-query fallback (<3 chars)` — the first three cases expect 1 hit but get 0 (message branch is skipped for short queries); the recency-window case currently passes vacuously (0 == 0) but the other three fail. Previously-passing suites remain PASS.

### Task 27: Implement <3-char LIKE fallback branch of querySearch

**Files:**
- Modify: `src/api/search-index.ts` (the `querySearch` function body, add an `else` fallback branch)
- Test: `src/api/search-index.test.ts`

- [ ] **Step 1: Re-read the current `querySearch` body** to confirm the exact shape of the `if (isTrigramEligible(q)) { ... }` block, the `messages` table columns (`searchable_text`, `timestamp`, `account_mid`, `talker_id`, plus the projected hit columns), and the existing `messageHits.push({...})` row mapping so the fallback reuses the identical projection.

Command:
```bash
grep -n "isTrigramEligible\|searchable_text\|messageHits.push\|ORDER BY bm25" src/api/search-index.ts
```

- [ ] **Step 2: Add an `else` branch to the trigram `if` in `querySearch` implementing the bounded LIKE fallback.** It scans the most recent 500 rows (by `timestamp DESC`) for that account (and `talker_id` when `scope === 'current'`), filters `searchable_text LIKE '%q%'`, and projects the same `MessageHit` columns; since there is no FTS `snippet()` here, build a plain snippet by wrapping the matched substring with the contract sentinels (`\u0001`/`\u0002`) in JS, falling back to the raw `searchable_text` truncated. Append after the closing `}` of the `if (isTrigramEligible(q)) { ... }` block:

```ts
  } else {
    // Short-query (1-2 char / <3 code points) fallback. Trigram cannot match,
    // so scan a bounded recency window of the most recent 500 rows with LIKE.
    const FALLBACK_WINDOW = 500
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`

    const baseWhere = `
      WHERE account_mid = ?
        ${scopeCurrent ? 'AND talker_id = ?' : ''}
    `
    const windowSql = `
      SELECT
        rowid        AS rowid,
        talker_id    AS talkerId,
        session_type AS sessionType,
        msg_seqno    AS msgSeqno,
        msg_key      AS msgKey,
        sender_uid   AS senderUid,
        msg_type     AS msgType,
        timestamp    AS timestamp,
        type_label   AS typeLabel,
        searchable_text AS searchableText
      FROM messages
      ${baseWhere}
      ORDER BY timestamp DESC
      LIMIT ?
    `
    const windowArgs: Array<string | number> = scopeCurrent
      ? [mid, params.talkerId as number, FALLBACK_WINDOW]
      : [mid, FALLBACK_WINDOW]

    const windowRows = db.prepare(windowSql).all(...windowArgs) as Array<{
      rowid: number
      talkerId: number
      sessionType: number
      msgSeqno: string
      msgKey: string
      senderUid: number | null
      msgType: number | null
      timestamp: number | null
      typeLabel: string | null
      searchableText: string | null
    }>

    const needle = q.toLowerCase()
    const matched = windowRows.filter(
      r => typeof r.searchableText === 'string' && r.searchableText.toLowerCase().includes(needle)
    )

    total = matched.length

    for (const r of matched.slice(params.offset, params.offset + params.limit)) {
      messageHits.push({
        talkerId: r.talkerId,
        sessionType: r.sessionType,
        msgSeqno: String(r.msgSeqno),
        msgKey: String(r.msgKey),
        senderUid: r.senderUid,
        msgType: r.msgType,
        timestamp: r.timestamp,
        typeLabel: r.typeLabel,
        snippet: buildFallbackSnippet(r.searchableText ?? '', q),
      })
    }
  }
```

Then add the `buildFallbackSnippet` helper next to `isTrigramEligible`/`toFtsMatch` (above `querySearch`):

```ts
// Build a snippet for the short-query LIKE fallback (no FTS snippet() available).
// Wraps the first case-insensitive match of `q` in the contract sentinels and
// returns a bounded window of surrounding text. Sentinels: U+0001 / U+0002.
function buildFallbackSnippet(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return text.slice(0, 64)
  const ctx = 24
  const start = Math.max(0, idx - ctx)
  const end = Math.min(text.length, idx + q.length + ctx)
  const before = (start > 0 ? '…' : '') + text.slice(start, idx)
  const mid = text.slice(idx, idx + q.length)
  const after = text.slice(idx + q.length, end) + (end < text.length ? '…' : '')
  return `${before}\u0001${mid}\u0002${after}`
}
```

Notes for the implementer:
- The fallback computes `total` from the matched-row count and applies `slice(offset, offset+limit)` in JS (the recency window is already bounded at 500, so this is cheap). This keeps `total` honest for pagination within the window.
- Filtering by `includes` in JS rather than `LIKE` in SQL avoids re-escaping concerns and gives an exact code-point substring match; the SQL `LIMIT 500` + `ORDER BY timestamp DESC` enforces the recency window. (`like` is retained only if a SQL-side filter is preferred; the JS filter is authoritative for the test's case-insensitive substring semantics.)
- Sentinels `\u0001`/`\u0002` match the contract and the renderer's split logic, identical to the FTS branch.

- [ ] **Step 3: Run the test and confirm fallback cases PASS.**

Command:
```bash
pnpm exec vitest run src/api/search-index.test.ts
```
Expected: PASS for `querySearch short-query fallback (<3 chars)` (2-char and 1-char matches, scope=current filter, and the recency-window exclusion returning 0 hits) with all prior suites still PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/api/search-index.ts src/api/search-index.test.ts
git commit -m "feat(search): add bounded LIKE fallback for <3-char CJK queries"
```

### Task 28: Add failing test for getIndexStats

**Files:**
- Modify: `src/api/search-index.test.ts` (append a new `describe` block, update import)

- [ ] **Step 1: Update the `@/api/search-index` import to include `getIndexStats` and append a stats `describe` block** to `src/api/search-index.test.ts`. Asserts counts, non-zero `sizeBytes`, per-account scoping of `messageCount`/`conversationCount`, and `lastUpdatedAt` reflecting the max `last_indexed_at`. This will FAIL because `getIndexStats` is a stub returning zeros (or is unimplemented).

Updated import line (full):
```ts
import {
  closeSearchIndex,
  getIndexStats,
  indexMessages,
  indexSessions,
  initSearchIndex,
  querySearch,
} from '@/api/search-index'
```

Appended block:
```ts
describe('getIndexStats', () => {
  beforeEach(async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
  })

  afterEach(() => {
    closeSearchIndex()
  })

  it('reports per-account message and conversation counts, size, and last update', () => {
    indexMessages(MID, [
      msg({ talkerId: 200, msgSeqno: '10', msgKey: 's10', timestamp: 100, content: JSON.stringify({ content: '消息一' }) }),
      msg({ talkerId: 200, msgSeqno: '11', msgKey: 's11', timestamp: 200, content: JSON.stringify({ content: '消息二' }) }),
      msg({ talkerId: 201, msgSeqno: '12', msgKey: 's12', timestamp: 300, content: JSON.stringify({ content: '消息三' }) }),
    ])
    indexSessions(MID, [
      session({ talker_id: 200, session_type: 1, group_name: '会话甲' }),
      session({ talker_id: 201, session_type: 1, group_name: '会话乙' }),
    ])

    // A second account must not inflate MID's counts.
    indexMessages(9999, [
      msg({ talkerId: 200, msgSeqno: '99', msgKey: 'other', timestamp: 999, content: JSON.stringify({ content: '别的账号' }) }),
    ])

    const stats = getIndexStats(MID)

    expect(stats.messageCount).toBe(3)
    expect(stats.conversationCount).toBe(2)
    expect(stats.sizeBytes).toBeGreaterThan(0)
    expect(stats.lastUpdatedAt).not.toBeNull()
    expect(typeof stats.lastUpdatedAt).toBe('number')
  })

  it('returns zero counts for an account with no data', () => {
    const stats = getIndexStats(424242)
    expect(stats.messageCount).toBe(0)
    expect(stats.conversationCount).toBe(0)
    // sizeBytes is whole-DB page size; still > 0 because the DB has schema pages.
    expect(stats.sizeBytes).toBeGreaterThan(0)
    expect(stats.lastUpdatedAt).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test and confirm the stats cases FAIL.**

Command:
```bash
pnpm exec vitest run src/api/search-index.test.ts
```
Expected: FAIL on `getIndexStats` — a stub returns `messageCount: 0` so `expect(stats.messageCount).toBe(3)` fails (received 0), or the import fails with "does not provide an export named 'getIndexStats'". All prior suites still PASS.

### Task 29: Implement getIndexStats

**Files:**
- Modify: `src/api/search-index.ts` (the `getIndexStats` function body)
- Test: `src/api/search-index.test.ts`

- [ ] **Step 1: Re-read the current `getIndexStats` stub and the `IndexStats` interface** in `src/api/search-index.ts`, plus confirm `conv_cursors` has a `last_indexed_at` column (schema section 7) used for `lastUpdatedAt`, and the `db` handle name.

Command:
```bash
grep -n "getIndexStats\|IndexStats\|last_indexed_at\|conv_cursors\|page_count\|page_size" src/api/search-index.ts
```

- [ ] **Step 2: Replace the `getIndexStats` body with the real implementation.** Counts come from `messages` and `sessions` scoped by `account_mid`; `sizeBytes` is whole-DB `PRAGMA page_count * PRAGMA page_size` (the cipher pages the whole file, so per-account byte attribution is not available — whole-DB size is the spec's intent); `lastUpdatedAt` is `MAX(last_indexed_at)` from `conv_cursors` for that account. Replace the stub:

```ts
export function getIndexStats(mid: number): IndexStats {
  if (!db) {
    return { messageCount: 0, conversationCount: 0, sizeBytes: 0, lastUpdatedAt: null }
  }

  const msgRow = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_mid = ?').get(mid) as
    | { n: number }
    | undefined
  const convRow = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_mid = ?').get(mid) as
    | { n: number }
    | undefined

  const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number } | undefined)?.page_count ?? 0
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number } | undefined)?.page_size ?? 0

  const lastRow = db
    .prepare('SELECT MAX(last_indexed_at) AS ts FROM conv_cursors WHERE account_mid = ?')
    .get(mid) as { ts: number | null } | undefined

  return {
    messageCount: msgRow?.n ?? 0,
    conversationCount: convRow?.n ?? 0,
    sizeBytes: pageCount * pageSize,
    lastUpdatedAt: lastRow?.ts ?? null,
  }
}
```

Notes for the implementer:
- `PRAGMA page_count` / `PRAGMA page_size` each return a single-column row; the column name equals the pragma name (`page_count`, `page_size`) with the better-sqlite3 driver.
- `lastUpdatedAt` reads `conv_cursors.last_indexed_at`, which the progressive-indexing task updates on each conversation upsert. If that column is not populated in the stats test (it indexes via `indexMessages`, which should set `last_indexed_at`), confirm `indexMessages` writes a `conv_cursors` row with `last_indexed_at`; the test asserts `lastUpdatedAt` is a number for an account with data and `null` for an empty account. If `indexMessages` does not yet touch `conv_cursors`, this assertion validates that integration — coordinate so `indexMessages` upserts `conv_cursors.last_indexed_at = unix-now`.

- [ ] **Step 3: Run the test and confirm stats cases PASS.**

Command:
```bash
pnpm exec vitest run src/api/search-index.test.ts
```
Expected: PASS for `getIndexStats` (counts 3/2 scoped to MID, `sizeBytes > 0`, numeric `lastUpdatedAt`; empty account returns 0/0 with `sizeBytes > 0` and `lastUpdatedAt: null`) and all prior suites still PASS.

- [ ] **Step 4: Run the full test suite to confirm no regressions across the query layer.**

Command:
```bash
pnpm test
```
Expected: PASS — all `src/api/search-index.test.ts` suites (message hits, conversation hits, short-query fallback, getIndexStats) green, alongside any sibling `src/**/*.test.ts` suites.

- [ ] **Step 5: Commit.**

```bash
git add src/api/search-index.ts src/api/search-index.test.ts
git commit -m "feat(search): implement getIndexStats counts, size, and last-updated"
```

# E. Progressive indexing hooks + IPC contract (Phase 1)

### Task 30: Add search index IPC channels and event to the IPC contract

**Files:**
- Modify: src/lib/ipc.ts:57-99 (IpcChannel block)
- Modify: src/lib/ipc.ts:105-117 (IpcEvent block)
- Modify: src/lib/ipc.ts:8-51 (type imports)
- Modify: src/lib/ipc.ts:127-247 (IpcInvokeContract)
- Modify: src/lib/ipc.ts:253-262 (IpcEventContract)

- [ ] **Step 1: Add the seven search invoke channel constants.** In `src/lib/ipc.ts`, the `IpcChannel` object ends with the WebSocket block before the closing `} as const` (lines 95-99). Add a new search block immediately after the WebSocket entries. Replace:

```ts
  // Bilibili WebSocket
  BILIBILI_WS_CONNECT: 'bilibili:ws-connect',
  BILIBILI_WS_DISCONNECT: 'bilibili:ws-disconnect',
  BILIBILI_WS_STATUS: 'bilibili:ws-status',
} as const
```

with:

```ts
  // Bilibili WebSocket
  BILIBILI_WS_CONNECT: 'bilibili:ws-connect',
  BILIBILI_WS_DISCONNECT: 'bilibili:ws-disconnect',
  BILIBILI_WS_STATUS: 'bilibili:ws-status',

  // Full-text search index
  SEARCH_QUERY: 'search:query',
  SEARCH_BACKFILL_START: 'search:backfill-start',
  SEARCH_BACKFILL_PAUSE: 'search:backfill-pause',
  SEARCH_BACKFILL_RESUME: 'search:backfill-resume',
  SEARCH_BACKFILL_STATUS: 'search:backfill-status',
  SEARCH_BACKFILL_CLEAR: 'search:backfill-clear',
  SEARCH_STATS: 'search:stats',
} as const
```

- [ ] **Step 2: Add the backfill-progress event constant.** In the `IpcEvent` object (lines 105-117), replace:

```ts
  // Bilibili real-time events
  BILIBILI_NEW_MESSAGE: 'bilibili:new-message',
  BILIBILI_SESSION_UPDATE: 'bilibili:session-update',
  BILIBILI_WS_CONNECTED: 'bilibili:ws-connected',
  BILIBILI_WS_DISCONNECTED: 'bilibili:ws-disconnected',
  BILIBILI_NAVIGATE_TO_SESSION: 'bilibili:navigate-to-session',
} as const
```

with:

```ts
  // Bilibili real-time events
  BILIBILI_NEW_MESSAGE: 'bilibili:new-message',
  BILIBILI_SESSION_UPDATE: 'bilibili:session-update',
  BILIBILI_WS_CONNECTED: 'bilibili:ws-connected',
  BILIBILI_WS_DISCONNECTED: 'bilibili:ws-disconnected',
  BILIBILI_NAVIGATE_TO_SESSION: 'bilibili:navigate-to-session',

  // Full-text search index progress (main → renderer)
  SEARCH_BACKFILL_PROGRESS: 'search:backfill-progress',
} as const
```

- [ ] **Step 3: Import the search payload/param/result types from the search-index module.** The contract types live in `src/api/search-index.ts` (created by the search-index module tasks). At the top of `src/lib/ipc.ts`, the existing import from `@/types/electron` ends at line 51 (`} from '@/types/electron'`). Add a new import block immediately after it. Replace:

```ts
  UploadImageParams,
  UploadImageResult,
  WSStatusResult,
} from '@/types/electron'
```

with:

```ts
  UploadImageParams,
  UploadImageResult,
  WSStatusResult,
} from '@/types/electron'
import type {
  BackfillStatus,
  IndexStats,
  SearchQueryParams,
  SearchQueryResult,
} from '@/api/search-index'
```

- [ ] **Step 4: Add the seven invoke contract entries.** In `IpcInvokeContract`, the WebSocket block ends at line 246 (`}` closing `BILIBILI_WS_STATUS`) just before the interface's closing brace at line 247. Replace:

```ts
  [IpcChannel.BILIBILI_WS_STATUS]: {
    params: undefined
    result: WSStatusResult
  }
}
```

with:

```ts
  [IpcChannel.BILIBILI_WS_STATUS]: {
    params: undefined
    result: WSStatusResult
  }

  // Full-text search index
  [IpcChannel.SEARCH_QUERY]: {
    params: SearchQueryParams
    result: SearchQueryResult
  }
  [IpcChannel.SEARCH_BACKFILL_START]: {
    params: { sessionType?: number }
    result: { success: boolean }
  }
  [IpcChannel.SEARCH_BACKFILL_PAUSE]: {
    params: undefined
    result: { success: boolean }
  }
  [IpcChannel.SEARCH_BACKFILL_RESUME]: {
    params: undefined
    result: { success: boolean }
  }
  [IpcChannel.SEARCH_BACKFILL_STATUS]: {
    params: undefined
    result: BackfillStatus
  }
  [IpcChannel.SEARCH_BACKFILL_CLEAR]: {
    params: { mid?: number }
    result: { success: boolean }
  }
  [IpcChannel.SEARCH_STATS]: {
    params: undefined
    result: IndexStats
  }
}
```

- [ ] **Step 5: Add the backfill-progress event payload entry.** In `IpcEventContract` (lines 253-262) replace:

```ts
  [IpcEvent.BILIBILI_NAVIGATE_TO_SESSION]: NavigateToSessionParams
}
```

with:

```ts
  [IpcEvent.BILIBILI_NAVIGATE_TO_SESSION]: NavigateToSessionParams
  [IpcEvent.SEARCH_BACKFILL_PROGRESS]: BackfillStatus
}
```

- [ ] **Step 6: Typecheck the contract.** Run `pnpm exec tsc --noEmit`. Expected: no errors from `src/lib/ipc.ts` (it resolves `BackfillStatus`/`IndexStats`/`SearchQueryParams`/`SearchQueryResult` from `@/api/search-index`, which exists). If `search-index.ts` is not yet present in the working tree, this step is expected to report a missing-module error on the new import only — that resolves once the search-index module task lands; no other file should regress.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/ipc.ts
git commit -m "feat(ipc): add search query/backfill/stats channels and progress event to IPC contract"
```

### Task 31: Expose electronAPI.search namespace types in the ElectronAPI interface

**Files:**
- Modify: src/types/electron.d.ts:1-7 (imports)
- Modify: src/types/electron.d.ts:280-345 (ElectronAPI interface)

- [ ] **Step 1: Import the search contract types into electron.d.ts.** The file opens by importing from `./bilibili` (lines 1-7). Add a type import for the search-index contract types right after that block. Replace:

```ts
import type {
  BilibiliCredentials,
  BilibiliMessagesResponse,
  BilibiliSendMessageResponse,
  BilibiliSessionsResponse,
  BilibiliUserCardsResponse,
} from './bilibili'
```

with:

```ts
import type {
  BilibiliCredentials,
  BilibiliMessagesResponse,
  BilibiliSendMessageResponse,
  BilibiliSessionsResponse,
  BilibiliUserCardsResponse,
} from './bilibili'
import type {
  BackfillStatus,
  IndexStats,
  SearchQueryParams,
  SearchQueryResult,
} from '@/api/search-index'
```

- [ ] **Step 2: Add the `search` namespace to the `ElectronAPI` interface.** The `ElectronAPI` interface currently closes its `clipboard` block and then declares the app menu listeners (lines 333-345). Insert a new `search` namespace between the `clipboard` block and the `onOpenAbout` line. Replace:

```ts
  // Clipboard utilities
  clipboard: {
    copyImage: (params: CopyImageParams) => Promise<CopyImageResult>
  }

  // App menu event listeners (return cleanup function)
  onOpenAbout: (callback: () => void) => () => void
```

with:

```ts
  // Clipboard utilities
  clipboard: {
    copyImage: (params: CopyImageParams) => Promise<CopyImageResult>
  }

  // Full-text search index
  search: {
    query: (params: SearchQueryParams) => Promise<SearchQueryResult>
    backfillStart: (params: { sessionType?: number }) => Promise<{ success: boolean }>
    backfillPause: () => Promise<{ success: boolean }>
    backfillResume: () => Promise<{ success: boolean }>
    backfillStatus: () => Promise<BackfillStatus>
    backfillClear: (params: { mid?: number }) => Promise<{ success: boolean }>
    stats: () => Promise<IndexStats>
    // Event listener for backfill progress (returns cleanup function)
    onBackfillProgress: (callback: (status: BackfillStatus) => void) => () => void
  }

  // App menu event listeners (return cleanup function)
  onOpenAbout: (callback: () => void) => () => void
```

- [ ] **Step 3: Typecheck.** Run `pnpm exec tsc --noEmit`. Expected: no new errors introduced by `src/types/electron.d.ts`. (A missing `@/api/search-index` module error is expected only until the search-index module task lands.)

- [ ] **Step 4: Commit.**

```bash
git add src/types/electron.d.ts
git commit -m "feat(types): add ElectronAPI.search namespace to electron.d.ts"
```

### Task 32: Add the search namespace to the preload bridge

**Files:**
- Modify: src/preload.ts:1-40 (type imports)
- Modify: src/preload.ts:42 (IpcChannel/IpcEvent import — already imports both)
- Modify: src/preload.ts:147-151 (clipboard block — insert search after it)

- [ ] **Step 1: Import the search contract types in preload.** The preload imports renderer-facing types from `./types/electron` (lines 6-40). Add the search-index contract type imports right after that block. Replace:

```ts
  UploadImageParams,
  UploadImageResult,
  WSStatusResult,
} from './types/electron'

import { IpcChannel, IpcEvent } from './lib/ipc'
```

with:

```ts
  UploadImageParams,
  UploadImageResult,
  WSStatusResult,
} from './types/electron'
import type { BackfillStatus, SearchQueryParams } from './api/search-index'

import { IpcChannel, IpcEvent } from './lib/ipc'
```

- [ ] **Step 2: Add the `search` bridge namespace.** The exposed object has a `clipboard` block (lines 147-151) immediately after the `bilibili` namespace's closing `},`. Insert the `search` namespace between `clipboard` and the `onOpenAbout` listener. Replace:

```ts
  // Clipboard utilities
  clipboard: {
    copyImage: (params: CopyImageParams): Promise<CopyImageResult> =>
      ipcRenderer.invoke(IpcChannel.CLIPBOARD_COPY_IMAGE, params),
  },

  // App menu event listeners
  onOpenAbout: (callback: () => void) => {
```

with:

```ts
  // Clipboard utilities
  clipboard: {
    copyImage: (params: CopyImageParams): Promise<CopyImageResult> =>
      ipcRenderer.invoke(IpcChannel.CLIPBOARD_COPY_IMAGE, params),
  },

  // Full-text search index
  search: {
    query: (params: SearchQueryParams) => ipcRenderer.invoke(IpcChannel.SEARCH_QUERY, params),
    backfillStart: (params: { sessionType?: number }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IpcChannel.SEARCH_BACKFILL_START, params),
    backfillPause: (): Promise<{ success: boolean }> => ipcRenderer.invoke(IpcChannel.SEARCH_BACKFILL_PAUSE),
    backfillResume: (): Promise<{ success: boolean }> => ipcRenderer.invoke(IpcChannel.SEARCH_BACKFILL_RESUME),
    backfillStatus: () => ipcRenderer.invoke(IpcChannel.SEARCH_BACKFILL_STATUS),
    backfillClear: (params: { mid?: number }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(IpcChannel.SEARCH_BACKFILL_CLEAR, params),
    stats: () => ipcRenderer.invoke(IpcChannel.SEARCH_STATS),
    // Event listener for backfill progress (returns cleanup function)
    onBackfillProgress: (callback: (status: BackfillStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: BackfillStatus) => {
        callback(status)
      }
      ipcRenderer.on(IpcEvent.SEARCH_BACKFILL_PROGRESS, listener)
      return () => {
        ipcRenderer.removeListener(IpcEvent.SEARCH_BACKFILL_PROGRESS, listener)
      }
    },
  },

  // App menu event listeners
  onOpenAbout: (callback: () => void) => {
```

- [ ] **Step 3: Typecheck.** Run `pnpm exec tsc --noEmit`. Expected: no new errors from `src/preload.ts`. (Missing-module error for `./api/search-index` is expected only until the search-index module lands.)

- [ ] **Step 4: Commit.**

```bash
git add src/preload.ts
git commit -m "feat(preload): expose electronAPI.search namespace and backfill-progress listener"
```

### Task 33: Register the search IPC handlers in registerBilibiliIpcHandlers

**Files:**
- Modify: src/api/bilibili.ts:1-21 (imports — add electron BrowserWindow, IpcEvent, search-index fns)
- Modify: src/api/bilibili.ts:1265-1334 (end of registerBilibiliIpcHandlers — insert search handlers before its closing brace)
- Test: manual typecheck + smoke note

- [ ] **Step 1: Import `BrowserWindow`, `IpcEvent`, and the search-index functions.** The file imports `{ ipcMain, safeStorage }` from electron (line 3) and `{ IpcChannel }` from `@/lib/ipc` (line 21). Update both, and add the search-index import. Replace:

```ts
import { ipcMain, safeStorage } from 'electron'
```

with:

```ts
import { BrowserWindow, ipcMain, safeStorage } from 'electron'
```

Then replace:

```ts
import { BILIBILI_ENDPOINTS, BILIBILI_HEADERS, COMMON_HEADERS, getImageExtension } from '@/lib/const'
import { IpcChannel } from '@/lib/ipc'
```

with:

```ts
import { BILIBILI_ENDPOINTS, BILIBILI_HEADERS, COMMON_HEADERS, getImageExtension } from '@/lib/const'
import { IpcChannel, IpcEvent } from '@/lib/ipc'

import {
  clearAccountIndex,
  getBackfillStatus,
  getIndexStats,
  pauseBackfill,
  querySearch,
  resumeBackfill,
  startBackfill,
} from '@/api/search-index'
import type { BackfillStatus, SearchQueryParams } from '@/api/search-index'
```

- [ ] **Step 2: Add a module-level helper to broadcast backfill progress to all windows.** This mirrors the `webContents.send(IpcEvent.BILIBILI_NEW_MESSAGE, …)` fan-out used in `broadcast-websocket.ts`. Insert it immediately before `export function registerBilibiliIpcHandlers() {` (line 411). Replace:

```ts
export function registerBilibiliIpcHandlers() {
```

with:

```ts
// Broadcast backfill progress to all renderer windows (mirrors BILIBILI_NEW_MESSAGE fan-out).
// Exported so the search-index backfill loop can push status updates as they happen.
export function broadcastBackfillProgress(status: BackfillStatus): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send(IpcEvent.SEARCH_BACKFILL_PROGRESS, status)
  }
}

export function registerBilibiliIpcHandlers() {
```

- [ ] **Step 3: Register the seven search handlers at the end of `registerBilibiliIpcHandlers`.** The function ends with the `BILIBILI_UPLOAD_IMAGE` handler closing at line 1333 followed by the function's closing `}` at line 1334. Insert the search handlers just before that closing brace. Replace:

```ts
        return {
          success: true,
          url: data.data.image_url,
          width: data.data.image_width,
          height: data.data.image_height,
        }
      } catch (error) {
        console.error('Failed to upload image:', error)
        return { success: false, error: 'Failed to upload image' }
      }
    }
  )
}
```

with:

```ts
        return {
          success: true,
          url: data.data.image_url,
          width: data.data.image_width,
          height: data.data.image_height,
        }
      } catch (error) {
        console.error('Failed to upload image:', error)
        return { success: false, error: 'Failed to upload image' }
      }
    }
  )

  // ============================================================================
  // Full-text search index handlers
  // All handlers resolve the active account internally via getActiveAccountMid().
  // ============================================================================

  // Run a search query against the local index for the active account
  ipcMain.handle(IpcChannel.SEARCH_QUERY, (_event, params: SearchQueryParams) => {
    const mid = getActiveAccountMid()
    if (!mid) {
      return { conversationHits: [], messageHits: [], total: 0 }
    }
    return querySearch(mid, params)
  })

  // Start the opt-in backfill crawler for the active account
  ipcMain.handle(IpcChannel.SEARCH_BACKFILL_START, (_event, params: { sessionType?: number }) => {
    const mid = getActiveAccountMid()
    if (!mid) {
      return { success: false }
    }
    startBackfill(mid, { sessionType: params?.sessionType })
    return { success: true }
  })

  // Pause the running backfill
  ipcMain.handle(IpcChannel.SEARCH_BACKFILL_PAUSE, () => {
    pauseBackfill()
    return { success: true }
  })

  // Resume a paused backfill
  ipcMain.handle(IpcChannel.SEARCH_BACKFILL_RESUME, () => {
    resumeBackfill()
    return { success: true }
  })

  // Get the current backfill status snapshot
  ipcMain.handle(IpcChannel.SEARCH_BACKFILL_STATUS, () => {
    return getBackfillStatus()
  })

  // Clear the index partition for an account (defaults to the active account)
  ipcMain.handle(IpcChannel.SEARCH_BACKFILL_CLEAR, (_event, params: { mid?: number }) => {
    const mid = params?.mid ?? getActiveAccountMid()
    if (!mid) {
      return { success: false }
    }
    clearAccountIndex(mid)
    return { success: true }
  })

  // Get index storage/coverage stats for the active account
  ipcMain.handle(IpcChannel.SEARCH_STATS, (_event) => {
    const mid = getActiveAccountMid()
    if (!mid) {
      return { messageCount: 0, conversationCount: 0, sizeBytes: 0, lastUpdatedAt: null }
    }
    return getIndexStats(mid)
  })
}
```

- [ ] **Step 4: Typecheck.** Run `pnpm exec tsc --noEmit`. Expected: no new errors from `src/api/bilibili.ts`. (Missing-module error for `@/api/search-index` is expected only until the search-index module lands.)

- [ ] **Step 5: Manual smoke note (no unit test — IPC requires a running Electron host).** After `pnpm start`, from the renderer DevTools console run `await window.electronAPI.search.stats()` → expect an `IndexStats` object (`{ messageCount, conversationCount, sizeBytes, lastUpdatedAt }`), and `await window.electronAPI.search.backfillStatus()` → expect a `BackfillStatus` object with `state: 'idle'`. No exceptions thrown.

- [ ] **Step 6: Commit.**

```bash
git add src/api/bilibili.ts
git commit -m "feat(search): register search query/backfill/stats IPC handlers and progress broadcaster"
```

### Task 34: Index sessions and last-message previews from the sessions fetch handler

**Files:**
- Modify: src/api/bilibili.ts:807-813 (BILIBILI_FETCH_SESSIONS — before `return data`)
- Test: manual smoke note

- [ ] **Step 1: Add a fire-and-forget index hook before returning the sessions payload.** This handler decodes `data: BilibiliSessionsResponse` and returns it at line 813. Insert the index calls right before `return data`. The session list also carries each session's `last_msg`, which we index as a forward-coverage message. Replace:

```ts
        if (data.code !== 0) {
          return { error: data.message || 'Failed to fetch sessions', code: data.code }
        }

        return data
      } catch (error) {
        console.error('Failed to fetch sessions:', error)
        return { error: 'Failed to fetch sessions from Bilibili', code: 500 }
      }
    }
  )
```

with:

```ts
        if (data.code !== 0) {
          return { error: data.message || 'Failed to fetch sessions', code: data.code }
        }

        // Fire-and-forget: index session metadata + each session's last_msg preview.
        // Never let indexing failures break session delivery; scoped via getActiveAccountMid().
        try {
          const mid = getActiveAccountMid()
          const sessionList = data.data?.session_list
          if (mid && sessionList) {
            indexSessions(mid, sessionList)

            const lastMessages: IndexedMessageInput[] = []
            for (const session of sessionList) {
              const lm = session.last_msg
              if (!lm || !lm.msg_key) continue
              lastMessages.push({
                talkerId: session.talker_id,
                sessionType: session.session_type,
                msgSeqno: String(lm.msg_seqno),
                msgKey: String(lm.msg_key),
                senderUid: lm.sender_uid ?? null,
                msgType: lm.msg_type ?? null,
                msgSource: lm.msg_source ?? null,
                timestamp: lm.timestamp ?? null,
                msgStatus: lm.msg_status ?? null,
                content: lm.content ?? '',
              })
            }
            if (lastMessages.length > 0) {
              // Group by conversation so the indexer writes one transaction per talker.
              const byConv = new Map<string, IndexedMessageInput[]>()
              for (const m of lastMessages) {
                const key = `${m.talkerId}:${m.sessionType}`
                const arr = byConv.get(key)
                if (arr) {
                  arr.push(m)
                } else {
                  byConv.set(key, [m])
                }
              }
              for (const group of byConv.values()) {
                indexMessages(mid, group)
              }
            }
          }
        } catch (indexError) {
          console.error('[SearchIndex] Failed to index sessions:', indexError)
        }

        return data
      } catch (error) {
        console.error('Failed to fetch sessions:', error)
        return { error: 'Failed to fetch sessions from Bilibili', code: 500 }
      }
    }
  )
```

- [ ] **Step 2: Add the `indexMessages`/`indexSessions` imports and the `IndexedMessageInput` type import.** The search-index import block was added when registering the IPC handlers. Extend it to include the progressive-index functions and the input type. Replace:

```ts
import {
  clearAccountIndex,
  getBackfillStatus,
  getIndexStats,
  pauseBackfill,
  querySearch,
  resumeBackfill,
  startBackfill,
} from '@/api/search-index'
import type { BackfillStatus, SearchQueryParams } from '@/api/search-index'
```

with:

```ts
import {
  clearAccountIndex,
  getBackfillStatus,
  getIndexStats,
  indexMessages,
  indexSessions,
  pauseBackfill,
  querySearch,
  resumeBackfill,
  startBackfill,
} from '@/api/search-index'
import type { BackfillStatus, IndexedMessageInput, SearchQueryParams } from '@/api/search-index'
```

- [ ] **Step 3: Typecheck.** Run `pnpm exec tsc --noEmit`. Expected: no new errors from `src/api/bilibili.ts` (`indexSessions` takes `(mid, BilibiliSession[])`; the `data.data.session_list` value is `BilibiliSession[] | null` and is guarded).

- [ ] **Step 4: Manual smoke note.** After `pnpm start`, open the app with an account that has conversations, let the session list load, then from DevTools run `await window.electronAPI.search.stats()` → `conversationCount` and `messageCount` should be greater than zero. No crash on session load.

- [ ] **Step 5: Commit.**

```bash
git add src/api/bilibili.ts
git commit -m "feat(search): progressively index sessions and last-message previews on fetch"
```

### Task 35: Index full message history from the messages fetch handler

**Files:**
- Modify: src/api/bilibili.ts:877-883 (BILIBILI_FETCH_MESSAGES — before `return data`)
- Test: manual smoke note

- [ ] **Step 1: Add a fire-and-forget message-index hook before returning the messages payload.** This handler decodes `data: BilibiliMessagesResponse`, has `params.talkerId` and `params.sessionType` in scope, and returns at line 883. Map `data.data.messages[]` to `IndexedMessageInput[]` using the conversation identity from `params`. Replace:

```ts
        if (data.code !== 0) {
          return { error: data.message || 'Failed to fetch messages', code: data.code }
        }

        return data
      } catch (error) {
        console.error('Failed to fetch messages:', error)
        return { error: 'Failed to fetch messages from Bilibili', code: 500 }
      }
    }
  )
```

with:

```ts
        if (data.code !== 0) {
          return { error: data.message || 'Failed to fetch messages', code: data.code }
        }

        // Fire-and-forget: index the fetched message page. fetchMessages auto-loads a
        // conversation's entire history, so this fully indexes any chat the user opens.
        // Scoped via getActiveAccountMid(); never let indexing break message delivery.
        try {
          const mid = getActiveAccountMid()
          const messages = data.data?.messages
          if (mid && messages && messages.length > 0) {
            const talkerIdNum = Number(talkerId)
            const sessionTypeNum = Number(sessionType)
            const mapped: IndexedMessageInput[] = messages.map(m => ({
              talkerId: talkerIdNum,
              sessionType: sessionTypeNum,
              msgSeqno: String(m.msg_seqno),
              msgKey: String(m.msg_key),
              senderUid: m.sender_uid ?? null,
              msgType: m.msg_type ?? null,
              msgSource: m.msg_source ?? null,
              timestamp: m.timestamp ?? null,
              msgStatus: m.msg_status ?? null,
              content: m.content ?? '',
            }))
            indexMessages(mid, mapped)
          }
        } catch (indexError) {
          console.error('[SearchIndex] Failed to index messages:', indexError)
        }

        return data
      } catch (error) {
        console.error('Failed to fetch messages:', error)
        return { error: 'Failed to fetch messages from Bilibili', code: 500 }
      }
    }
  )
```

- [ ] **Step 2: Typecheck.** Run `pnpm exec tsc --noEmit`. Expected: no new errors (`data.data.messages` is `BilibiliMessage[] | null`, guarded; `talkerId`/`sessionType` are the destructured string params).

- [ ] **Step 3: Manual smoke note.** After `pnpm start`, open a conversation with history, wait for it to finish auto-loading, then run `await window.electronAPI.search.query({ query: 'a', scope: 'current', talkerId: <id>, sessionType: 1, limit: 50, offset: 0 })` in DevTools → expect `messageHits` populated for matching text. `stats()` `messageCount` increases after opening a chat.

- [ ] **Step 4: Commit.**

```bash
git add src/api/bilibili.ts
git commit -m "feat(search): progressively index full message history on conversation open"
```

### Task 36: Index outbound messages after a successful send

**Files:**
- Modify: src/api/bilibili.ts:1066-1071 (BILIBILI_SEND_MESSAGE — after `code===0`, before `return data`)
- Test: manual smoke note

- [ ] **Step 1: Add a fire-and-forget index hook for the just-sent message.** In the send handler, `result.data` is destructured as `data` (line 1066), the success guard `if (data.code !== 0)` is at line 1067, and the handler returns `data` at line 1071. The send response carries `data.data.msg_key` only — there is no seqno/timestamp in the response, so use the locally-known `content`, `receiverId`/`receiverType`, the sender `credentials.DedeUserID`, and the request `timestamp`. Insert the hook between the success guard and `return data`. Replace:

```ts
        const { data } = result
        if (data.code !== 0) {
          return { error: `[diag] code=${data.code} msg=${data.message || '(empty)'}`, code: data.code }
        }

        return data
      } catch (error) {
        console.error('Failed to send message:', error)
        return { error: 'Failed to send message', code: 500 }
      }
    }
  )
```

with:

```ts
        const { data } = result
        if (data.code !== 0) {
          return { error: `[diag] code=${data.code} msg=${data.message || '(empty)'}`, code: data.code }
        }

        // Fire-and-forget: index the outbound message. The send response only returns
        // msg_key (no seqno), so use the locally-known content/receiver/sender/timestamp.
        // msg_type 5 is a recall trigger; record msgStatus=1 so its content is excluded from FTS.
        try {
          const mid = getActiveAccountMid()
          const sentMsgKey = data.data?.msg_key
          if (mid && sentMsgKey != null && String(sentMsgKey).length > 0) {
            const msgTypeNum = Number(msgType)
            const isRecall = msgTypeNum === 5
            indexMessages(mid, [
              {
                talkerId: Number(receiverId),
                sessionType: Number(receiverType),
                msgSeqno: '',
                msgKey: String(sentMsgKey),
                senderUid: Number(credentials.DedeUserID),
                msgType: msgTypeNum,
                msgSource: null,
                timestamp,
                msgStatus: isRecall ? 1 : 0,
                content,
              },
            ])
          }
        } catch (indexError) {
          console.error('[SearchIndex] Failed to index sent message:', indexError)
        }

        return data
      } catch (error) {
        console.error('Failed to send message:', error)
        return { error: 'Failed to send message', code: 500 }
      }
    }
  )
```

- [ ] **Step 2: Typecheck.** Run `pnpm exec tsc --noEmit`. Expected: no new errors (`receiverId`, `receiverType`, `msgType`, `content` are the destructured string params; `credentials.DedeUserID` and `timestamp` are in scope from earlier in the handler).

- [ ] **Step 3: Manual smoke note.** After `pnpm start`, send a text message in any conversation, then run `await window.electronAPI.search.query({ query: '<text-you-just-sent>', scope: 'all', limit: 50, offset: 0 })` in DevTools → expect a `messageHits` entry whose `senderUid` equals your own UID. No send-path regression (message still delivers).

- [ ] **Step 4: Commit.**

```bash
git add src/api/bilibili.ts
git commit -m "feat(search): index outbound messages after successful send"
```

### Task 37: Purge an account's index partition on account removal and full logout

**Files:**
- Modify: src/api/bilibili.ts:317-339 (`removeAccount` helper)
- Modify: src/api/bilibili.ts:391-394 (`clearAllAccounts` helper)
- Test: manual smoke note

- [ ] **Step 1: Clear the removed account's index inside `removeAccount`.** The helper (lines 317-339) filters accounts and returns `false` early when the account is not found, otherwise saves and returns `true`. Purge the index only on a real removal (after the found-check). Replace:

```ts
// Remove an account by mid
function removeAccount(mid: number): boolean {
  const accounts = getAccounts()
  const filteredAccounts = accounts.filter(a => a.userInfo.mid !== mid)

  if (filteredAccounts.length === accounts.length) {
    // Account not found
    return false
  }

  saveAccounts(filteredAccounts)
```

with:

```ts
// Remove an account by mid
function removeAccount(mid: number): boolean {
  const accounts = getAccounts()
  const filteredAccounts = accounts.filter(a => a.userInfo.mid !== mid)

  if (filteredAccounts.length === accounts.length) {
    // Account not found
    return false
  }

  // Purge this account's search-index partition (fire-and-forget, never throws to caller).
  try {
    clearAccountIndex(mid)
  } catch (indexError) {
    console.error('[SearchIndex] Failed to clear index for removed account:', indexError)
  }

  saveAccounts(filteredAccounts)
```

- [ ] **Step 2: Clear every account's index inside `clearAllAccounts`.** The helper (lines 391-394) nulls the `accounts` and `activeAccountMid` store keys. Before clearing the store, snapshot the account mids and purge each index partition. Replace:

```ts
// Clear all accounts (full logout)
function clearAllAccounts(): void {
  store.set('accounts', null)
  store.set('activeAccountMid', null)
}
```

with:

```ts
// Clear all accounts (full logout)
function clearAllAccounts(): void {
  // Purge each account's search-index partition before dropping account records.
  try {
    for (const account of getAccounts()) {
      clearAccountIndex(account.userInfo.mid)
    }
  } catch (indexError) {
    console.error('[SearchIndex] Failed to clear index on full logout:', indexError)
  }

  store.set('accounts', null)
  store.set('activeAccountMid', null)
}
```

- [ ] **Step 3: Typecheck.** Run `pnpm exec tsc --noEmit`. Expected: no new errors (`clearAccountIndex` was imported when the IPC handlers were registered).

- [ ] **Step 4: Manual smoke note.** After `pnpm start`, with an indexed account, remove that account from the account switcher, re-add it, and run `await window.electronAPI.search.stats()` → `messageCount`/`conversationCount` should reset to zero for the cleared partition before any re-index. App does not crash on removal.

- [ ] **Step 5: Commit.**

```bash
git add src/api/bilibili.ts
git commit -m "feat(search): purge account index partition on removal and full logout"
```

### Task 38: Index real-time inbound WebSocket messages

**Files:**
- Modify: src/api/broadcast-websocket.ts:6-17 (imports — add getActiveAccountMid + search-index)
- Modify: src/api/broadcast-websocket.ts:542-549 (initBroadcastWebSocket onNewMessage callback)
- Test: manual smoke note

- [ ] **Step 1: Import `getActiveAccountMid` and the index function in the WebSocket module.** The module already imports `cookieStringFromCredentials, getCredentials` from `@/api/bilibili` (line 17). Add `getActiveAccountMid` to that import and add the search-index import + input type. Replace:

```ts
import { cookieStringFromCredentials, getCredentials } from '@/api/bilibili'
import { getMessageType, MessageTypes, TargetPaths } from '@/proto/broadcast'
```

with:

```ts
import { cookieStringFromCredentials, getActiveAccountMid, getCredentials } from '@/api/bilibili'
import { indexMessages } from '@/api/search-index'
import type { IndexedMessageInput } from '@/api/search-index'
import { getMessageType, MessageTypes, TargetPaths } from '@/proto/broadcast'
```

- [ ] **Step 2: Index the inbound message in the `onNewMessage` callback.** In `initBroadcastWebSocket`, the manager's `onNewMessage` callback (lines 543-549) currently only fans the `notification` out to renderer windows. The `IGNORED_WS_MSG_TYPES` filter already ran in `handleNotification` before this callback fires, so any `notification` reaching here is a real PM. Index it only when `notification.instantMsg` is present. Replace:

```ts
        onNewMessage: notification => {
          // Send notification to all renderer windows
          const windows = BrowserWindow.getAllWindows()
          for (const win of windows) {
            win.webContents.send(IpcEvent.BILIBILI_NEW_MESSAGE, notification)
          }
        },
```

with:

```ts
        onNewMessage: notification => {
          // Send notification to all renderer windows
          const windows = BrowserWindow.getAllWindows()
          for (const win of windows) {
            win.webContents.send(IpcEvent.BILIBILI_NEW_MESSAGE, notification)
          }

          // Fire-and-forget: index the real-time inbound message (forward coverage).
          // Only when instantMsg is present; IGNORED_WS_MSG_TYPES already filtered upstream.
          // Scoped via getActiveAccountMid(); never let indexing break notification delivery.
          try {
            const instantMsg = notification.instantMsg
            if (instantMsg && instantMsg.msgKey) {
              const mid = getActiveAccountMid()
              if (mid) {
                const input: IndexedMessageInput = {
                  talkerId: notification.talkerId,
                  sessionType: notification.sessionType,
                  msgSeqno: String(instantMsg.msgSeqno),
                  msgKey: String(instantMsg.msgKey),
                  senderUid: instantMsg.senderUid,
                  msgType: instantMsg.msgType,
                  msgSource: null,
                  timestamp: instantMsg.timestamp,
                  msgStatus: null,
                  content: instantMsg.content,
                }
                indexMessages(mid, [input])
              }
            }
          } catch (indexError) {
            console.error('[SearchIndex] Failed to index inbound WS message:', indexError)
          }
        },
```

- [ ] **Step 3: Typecheck.** Run `pnpm exec tsc --noEmit`. Expected: no new errors from `src/api/broadcast-websocket.ts` (`notification.instantMsg` is the optional `NewMessageNotification.instantMsg` shape; `msgKey` is `string`, `msgSeqno`/`timestamp`/`senderUid`/`msgType` are `number`).

- [ ] **Step 4: Manual smoke note.** After `pnpm start`, connect the WebSocket, have a second account or a friend send you a message, then run `await window.electronAPI.search.query({ query: '<received-text>', scope: 'all', limit: 50, offset: 0 })` in DevTools → expect the inbound message in `messageHits`. No notification-path regression (toast/badge still fire).

- [ ] **Step 5: Commit.**

```bash
git add src/api/broadcast-websocket.ts
git commit -m "feat(search): index real-time inbound WebSocket messages"
```

### Task 39: Bootstrap the search index on app ready in main process

**Files:**
- Modify: src/main.ts:9-12 (imports — add initSearchIndex)
- Modify: src/main.ts:518-521 (app ready handler — call init before/after window creation)
- Modify: src/main.ts:523-526 (before-quit — close the index)
- Test: manual smoke note

- [ ] **Step 1: Import `initSearchIndex` and `closeSearchIndex`.** The main process imports the bilibili and websocket setup (lines 9-10). Add the search-index import after them. Replace:

```ts
import { registerBilibiliIpcHandlers } from './api/bilibili'
import { cleanupBroadcastWebSocket, initBroadcastWebSocket } from './api/broadcast-websocket'
import { UPDATE_BASE_URL } from './lib/const'
import { IpcChannel, IpcEvent } from './lib/ipc'
```

with:

```ts
import { registerBilibiliIpcHandlers } from './api/bilibili'
import { cleanupBroadcastWebSocket, initBroadcastWebSocket } from './api/broadcast-websocket'
import { closeSearchIndex, initSearchIndex } from './api/search-index'
import { UPDATE_BASE_URL } from './lib/const'
import { IpcChannel, IpcEvent } from './lib/ipc'
```

- [ ] **Step 2: Initialize the index in the `ready` handler.** The `app.on('ready', …)` handler (lines 518-521) creates the menu and window. `initSearchIndex()` reads the DB path from `app.getPath('userData')` and the encryption key via `safeStorage` internally (production default), so no args are passed here. It must be awaited and must never crash the app on failure. Replace:

```ts
app.on('ready', () => {
  createApplicationMenu()
  createWindow()
})
```

with:

```ts
app.on('ready', async () => {
  createApplicationMenu()
  createWindow()

  // Initialize the encrypted full-text search index. initSearchIndex() resolves the
  // DB path from userData and the encryption key from safeStorage internally. A failure
  // here must never block the app — the index degrades to "unavailable", not a crash.
  try {
    await initSearchIndex()
  } catch (error) {
    console.error('[SearchIndex] Failed to initialize search index:', error)
  }
})
```

- [ ] **Step 3: Close the index on quit.** The `before-quit` handler (lines 523-526) cleans up the WebSocket. Close the DB handle there too. Replace:

```ts
// Cleanup WebSocket on quit
app.on('before-quit', () => {
  cleanupBroadcastWebSocket()
})
```

with:

```ts
// Cleanup WebSocket and search index on quit
app.on('before-quit', () => {
  cleanupBroadcastWebSocket()
  try {
    closeSearchIndex()
  } catch (error) {
    console.error('[SearchIndex] Failed to close search index:', error)
  }
})
```

- [ ] **Step 4: Typecheck.** Run `pnpm exec tsc --noEmit`. Expected: no new errors from `src/main.ts` (`initSearchIndex` returns `Promise<void>`; `closeSearchIndex` returns `void`).

- [ ] **Step 5: Manual smoke note.** Run `pnpm start`. Expect no startup crash and no `[SearchIndex] Failed to initialize` error in the main-process console. Confirm the DB file exists: it is created at `<userData>/comet-index.db` (e.g. on macOS `~/Library/Application Support/LAPLACE Comet/comet-index.db`). After indexing some sessions, quit the app cleanly — no `[SearchIndex] Failed to close` error.

- [ ] **Step 6: Commit.**

```bash
git add src/main.ts
git commit -m "feat(search): initialize and close the encrypted search index on app lifecycle"
```

# F. Backfill crawler — policy, cursors, orchestrator (Phase 2)

### Task 40: Add Vitest harness and config

**Files:**
- Modify: `/Users/sparanoid/Git/laplace-comet/package.json` (scripts block at line 8, devDependencies)
- Create: `/Users/sparanoid/Git/laplace-comet/vitest.config.ts`

- [ ] **Step 1: Add the `vitest` devDependency.** Run the exact command:
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm add -D vitest
  ```
  Expected: `vitest` appears under `devDependencies` in `package.json` and `pnpm-lock.yaml` updates.

- [ ] **Step 2: Add `test` and `test:watch` scripts.** Read the current scripts block first (it begins at `package.json:8` with `"scripts": {`). Add the two scripts immediately after the opening `"scripts": {` line. The result must contain:
  ```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
  ```
  (Keep all existing scripts that follow unchanged. Use the Edit tool to insert the two lines right after `"scripts": {`.)

- [ ] **Step 3: Create the Vitest config.** Write `/Users/sparanoid/Git/laplace-comet/vitest.config.ts` with EXACTLY this content:
  ```ts
  import { defineConfig } from 'vitest/config'

  export default defineConfig({
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
    resolve: { alias: { '@': '/src' } },
  })
  ```

- [ ] **Step 4: Smoke-test the harness with a throwaway spec.** Create `/Users/sparanoid/Git/laplace-comet/src/lib/__harness_smoke.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'

  describe('harness', () => {
    it('runs', () => {
      expect(1 + 1).toBe(2)
    })
  })
  ```
  Run:
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm exec vitest run src/lib/__harness_smoke.test.ts
  ```
  Expected: `1 passed`. Then delete the throwaway file:
  ```bash
  rm /Users/sparanoid/Git/laplace-comet/src/lib/__harness_smoke.test.ts
  ```

- [ ] **Step 5: Commit.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && git add package.json pnpm-lock.yaml vitest.config.ts && git commit -m "test: add vitest harness and config"
  ```

### Task 41: Backoff/error policy module (`backfill-policy.ts`) — failing tests

**Files:**
- Create: `/Users/sparanoid/Git/laplace-comet/src/lib/backfill-policy.test.ts`

- [ ] **Step 1: Write the full failing test suite.** Create `/Users/sparanoid/Git/laplace-comet/src/lib/backfill-policy.test.ts` with EXACTLY this content:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { classifyError, nextBackoff } from '@/lib/backfill-policy'
  import type { BackoffState } from '@/lib/backfill-policy'

  describe('classifyError', () => {
    it('returns ok for code 0', () => {
      expect(classifyError(0, false)).toBe('ok')
    })

    it('returns blocked when blocked flag set (HTML block page, null code)', () => {
      expect(classifyError(null, true)).toBe('blocked')
    })

    it('returns blocked for code -412 even without the html flag', () => {
      expect(classifyError(-412, false)).toBe('blocked')
    })

    it('returns too_frequent for -509 and -799', () => {
      expect(classifyError(-509, false)).toBe('too_frequent')
      expect(classifyError(-799, false)).toBe('too_frequent')
    })

    it('returns not_logged_in for -101', () => {
      expect(classifyError(-101, false)).toBe('not_logged_in')
    })

    it('returns other for any unmapped non-zero code', () => {
      expect(classifyError(-1, false)).toBe('other')
      expect(classifyError(404, false)).toBe('other')
    })

    it('returns other for a null code with no block flag', () => {
      expect(classifyError(null, false)).toBe('other')
    })
  })

  describe('nextBackoff - ok', () => {
    it('continues at the current base delay without advancing attempt', () => {
      const state: BackoffState = { attempt: 0, baseDelayMs: 3000 }
      const d = nextBackoff('ok', state)
      expect(d.action).toBe('continue')
      expect(d.delayMs).toBe(3000)
      expect(d.nextState).toEqual({ attempt: 0, baseDelayMs: 3000 })
    })
  })

  describe('nextBackoff - blocked (30/60/120/300 cap then pause)', () => {
    it('walks the blocked schedule and caps, then pauses past the schedule', () => {
      let state: BackoffState = { attempt: 0, baseDelayMs: 3000 }

      let d = nextBackoff('blocked', state)
      expect(d.action).toBe('retry')
      expect(d.delayMs).toBe(30_000)
      expect(d.nextState.attempt).toBe(1)
      state = d.nextState

      d = nextBackoff('blocked', state)
      expect(d.action).toBe('retry')
      expect(d.delayMs).toBe(60_000)
      expect(d.nextState.attempt).toBe(2)
      state = d.nextState

      d = nextBackoff('blocked', state)
      expect(d.action).toBe('retry')
      expect(d.delayMs).toBe(120_000)
      expect(d.nextState.attempt).toBe(3)
      state = d.nextState

      d = nextBackoff('blocked', state)
      expect(d.action).toBe('retry')
      expect(d.delayMs).toBe(300_000)
      expect(d.nextState.attempt).toBe(4)
      state = d.nextState

      // schedule exhausted -> pause for the long cooldown window
      d = nextBackoff('blocked', state)
      expect(d.action).toBe('pause')
      expect(d.delayMs).toBe(1_800_000)
      expect(d.nextState.attempt).toBe(0)
    })

    it('preserves baseDelayMs across blocked retries', () => {
      const d = nextBackoff('blocked', { attempt: 0, baseDelayMs: 4000 })
      expect(d.nextState.baseDelayMs).toBe(4000)
    })
  })

  describe('nextBackoff - too_frequent (10/30/90 then raise base)', () => {
    it('walks the schedule then raises base delay and resets attempt', () => {
      let state: BackoffState = { attempt: 0, baseDelayMs: 3000 }

      let d = nextBackoff('too_frequent', state)
      expect(d.action).toBe('retry')
      expect(d.delayMs).toBe(10_000)
      expect(d.nextState.attempt).toBe(1)
      expect(d.nextState.baseDelayMs).toBe(3000)
      state = d.nextState

      d = nextBackoff('too_frequent', state)
      expect(d.action).toBe('retry')
      expect(d.delayMs).toBe(30_000)
      expect(d.nextState.attempt).toBe(2)
      state = d.nextState

      d = nextBackoff('too_frequent', state)
      expect(d.action).toBe('retry')
      expect(d.delayMs).toBe(90_000)
      expect(d.nextState.attempt).toBe(3)
      state = d.nextState

      // schedule exhausted -> raise base into the 6-8s band and reset attempt
      d = nextBackoff('too_frequent', state)
      expect(d.action).toBe('retry')
      expect(d.delayMs).toBe(7000)
      expect(d.nextState.attempt).toBe(0)
      expect(d.nextState.baseDelayMs).toBe(7000)
    })

    it('does not lower an already-raised base delay', () => {
      const state: BackoffState = { attempt: 3, baseDelayMs: 8000 }
      const d = nextBackoff('too_frequent', state)
      expect(d.nextState.baseDelayMs).toBe(8000)
      expect(d.delayMs).toBe(8000)
    })
  })

  describe('nextBackoff - not_logged_in / other', () => {
    it('aborts immediately on not_logged_in', () => {
      const d = nextBackoff('not_logged_in', { attempt: 2, baseDelayMs: 3000 })
      expect(d.action).toBe('abort')
      expect(d.delayMs).toBe(0)
    })

    it('pauses on an unknown other error', () => {
      const d = nextBackoff('other', { attempt: 0, baseDelayMs: 3000 })
      expect(d.action).toBe('pause')
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm it FAILS for the right reason.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm exec vitest run src/lib/backfill-policy.test.ts
  ```
  Expected FAIL: module resolution error — `Failed to resolve import "@/lib/backfill-policy"` (the implementation file does not exist yet).

### Task 42: Backoff/error policy module (`backfill-policy.ts`) — implementation

**Files:**
- Create: `/Users/sparanoid/Git/laplace-comet/src/lib/backfill-policy.ts`
- Test: `/Users/sparanoid/Git/laplace-comet/src/lib/backfill-policy.test.ts`

- [ ] **Step 1: Write the full implementation.** Create `/Users/sparanoid/Git/laplace-comet/src/lib/backfill-policy.ts` with EXACTLY this content:
  ```ts
  /**
   * Backfill throttle / backoff policy (spec section 10).
   *
   * Pure, side-effect-free state machine. The crawler owns the wall-clock waiting;
   * this module only decides the next delay, the next state, and what to do.
   */

  export type BiliErrorKind = 'ok' | 'blocked' | 'too_frequent' | 'not_logged_in' | 'other'

  /**
   * Classify a Bilibili read response.
   * @param code   response `code` field, or null when the body was a non-JSON block page
   * @param blocked true when a -412 HTML block page was detected (JSON.parse failed)
   */
  export function classifyError(code: number | null, blocked: boolean): BiliErrorKind {
    if (blocked || code === -412) return 'blocked'
    if (code === 0) return 'ok'
    if (code === -509 || code === -799) return 'too_frequent'
    if (code === -101) return 'not_logged_in'
    return 'other'
  }

  export interface BackoffState {
    attempt: number
    baseDelayMs: number
  }

  export interface BackoffDecision {
    delayMs: number
    nextState: BackoffState
    action: 'continue' | 'retry' | 'pause' | 'abort'
  }

  // Exponential schedules (ms). Index by current attempt.
  const BLOCKED_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000]
  const TOO_FREQUENT_SCHEDULE_MS = [10_000, 30_000, 90_000]

  // Long cooldown after the blocked schedule is exhausted (30 min, spec: 30-60 min).
  const BLOCKED_PAUSE_MS = 1_800_000
  // Raised base delay band (6-8 s) after repeated "too frequent" responses.
  const RAISED_BASE_DELAY_MS = 7000

  /**
   * Decide the next backoff step for the given error kind.
   *
   * - ok            -> continue at base delay; attempt untouched
   * - blocked       -> retry 30/60/120/300s; once exhausted -> pause for the cooldown window, reset attempt
   * - too_frequent  -> retry 10/30/90s; once exhausted -> raise base delay (never lower it), reset attempt, retry at new base
   * - not_logged_in -> abort
   * - other         -> pause (caller decides whether to resume)
   */
  export function nextBackoff(kind: BiliErrorKind, state: BackoffState): BackoffDecision {
    switch (kind) {
      case 'ok':
        return {
          delayMs: state.baseDelayMs,
          nextState: { attempt: 0, baseDelayMs: state.baseDelayMs },
          action: 'continue',
        }

      case 'blocked': {
        if (state.attempt < BLOCKED_SCHEDULE_MS.length) {
          return {
            delayMs: BLOCKED_SCHEDULE_MS[state.attempt],
            nextState: { attempt: state.attempt + 1, baseDelayMs: state.baseDelayMs },
            action: 'retry',
          }
        }
        return {
          delayMs: BLOCKED_PAUSE_MS,
          nextState: { attempt: 0, baseDelayMs: state.baseDelayMs },
          action: 'pause',
        }
      }

      case 'too_frequent': {
        if (state.attempt < TOO_FREQUENT_SCHEDULE_MS.length) {
          return {
            delayMs: TOO_FREQUENT_SCHEDULE_MS[state.attempt],
            nextState: { attempt: state.attempt + 1, baseDelayMs: state.baseDelayMs },
            action: 'retry',
          }
        }
        // Schedule exhausted: raise the base delay (never lower it), reset attempt, retry at new base.
        const raised = Math.max(state.baseDelayMs, RAISED_BASE_DELAY_MS)
        return {
          delayMs: raised,
          nextState: { attempt: 0, baseDelayMs: raised },
          action: 'retry',
        }
      }

      case 'not_logged_in':
        return {
          delayMs: 0,
          nextState: { attempt: state.attempt, baseDelayMs: state.baseDelayMs },
          action: 'abort',
        }

      default:
        return {
          delayMs: state.baseDelayMs,
          nextState: { attempt: state.attempt, baseDelayMs: state.baseDelayMs },
          action: 'pause',
        }
    }
  }
  ```

- [ ] **Step 2: Run the test and confirm it PASSES.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm exec vitest run src/lib/backfill-policy.test.ts
  ```
  Expected: all tests pass (`backfill-policy.test.ts` green).

- [ ] **Step 3: Commit.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && git add src/lib/backfill-policy.ts src/lib/backfill-policy.test.ts && git commit -m "feat: add backfill backoff/error policy state machine"
  ```

### Task 43: Backfill cursor math module (`backfill-cursor.ts`) — failing tests

**Files:**
- Create: `/Users/sparanoid/Git/laplace-comet/src/lib/backfill-cursor.test.ts`

- [ ] **Step 1: Write the full failing test suite.** Create `/Users/sparanoid/Git/laplace-comet/src/lib/backfill-cursor.test.ts` with EXACTLY this content:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { dedupeBoundarySessions, nextBackfillCursor } from '@/lib/backfill-cursor'
  import type { ConvCursor } from '@/lib/backfill-cursor'

  const EMPTY_MIN = '18446744073709551615'
  const EMPTY_MAX = '0'

  function freshCursor(): ConvCursor {
    return { oldestSeqno: null, backfillDone: false, newestSeqno: null, newestMsgKey: null }
  }

  describe('nextBackfillCursor - backward walk', () => {
    it('advances oldestSeqno to the page min and sets exclusive nextEndSeqno = min', () => {
      const cursor = freshCursor()
      const { cursor: next, nextEndSeqno, done } = nextBackfillCursor(cursor, {
        minSeqno: '500',
        maxSeqno: '900',
        hasMore: true,
        empty: false,
      })
      expect(next.oldestSeqno).toBe('500')
      expect(nextEndSeqno).toBe('500')
      expect(done).toBe(false)
      expect(next.backfillDone).toBe(false)
    })

    it('keeps newestSeqno/newestMsgKey untouched (backward walk only lowers the floor)', () => {
      const cursor: ConvCursor = {
        oldestSeqno: '500',
        backfillDone: false,
        newestSeqno: '900',
        newestMsgKey: 'k900',
      }
      const { cursor: next } = nextBackfillCursor(cursor, {
        minSeqno: '300',
        maxSeqno: '499',
        hasMore: true,
        empty: false,
      })
      expect(next.oldestSeqno).toBe('300')
      expect(next.newestSeqno).toBe('900')
      expect(next.newestMsgKey).toBe('k900')
    })

    it('marks done + backfillDone when has_more is false (reached genesis)', () => {
      const cursor = freshCursor()
      const { cursor: next, nextEndSeqno, done } = nextBackfillCursor(cursor, {
        minSeqno: '100',
        maxSeqno: '200',
        hasMore: false,
        empty: false,
      })
      expect(done).toBe(true)
      expect(next.backfillDone).toBe(true)
      expect(next.oldestSeqno).toBe('100')
      // floor still advances so a forward sweep knows the indexed lower bound
      expect(nextEndSeqno).toBe('100')
    })

    it('treats the empty-history sentinel page as done with no floor change', () => {
      const cursor = freshCursor()
      const { cursor: next, nextEndSeqno, done } = nextBackfillCursor(cursor, {
        minSeqno: EMPTY_MIN,
        maxSeqno: EMPTY_MAX,
        hasMore: false,
        empty: true,
      })
      expect(done).toBe(true)
      expect(next.backfillDone).toBe(true)
      expect(next.oldestSeqno).toBeNull()
      expect(nextEndSeqno).toBeNull()
    })

    it('produces no overlap and no gap across consecutive pages', () => {
      // page 1: [500..900], page 2 must request end_seqno=500 exclusive -> [300..499]
      let cursor = freshCursor()
      let r = nextBackfillCursor(cursor, { minSeqno: '500', maxSeqno: '900', hasMore: true, empty: false })
      expect(r.nextEndSeqno).toBe('500')
      cursor = r.cursor

      // simulate the next page fetched with end_seqno=500 returning strictly older msgs
      r = nextBackfillCursor(cursor, { minSeqno: '300', maxSeqno: '499', hasMore: false, empty: false })
      // 499 < 500 -> contiguous, no overlap, no gap
      expect(Number(r.cursor.oldestSeqno)).toBeLessThan(500)
      expect(r.done).toBe(true)
    })
  })

  describe('dedupeBoundarySessions', () => {
    it('returns the page untouched when prevEndTs is null (first page)', () => {
      const out = dedupeBoundarySessions(null, {
        sessions: [
          { talkerId: 1, sessionTs: '300' },
          { talkerId: 2, sessionTs: '200' },
        ],
        hasMore: true,
      })
      expect(out).toHaveLength(2)
      expect(out[0].talkerId).toBe(1)
    })

    it('drops the leading boundary duplicate whose sessionTs equals prevEndTs', () => {
      const out = dedupeBoundarySessions('300', {
        sessions: [
          { talkerId: 1, sessionTs: '300' }, // boundary dup carried over from previous page end
          { talkerId: 2, sessionTs: '200' },
          { talkerId: 3, sessionTs: '100' },
        ],
        hasMore: true,
      })
      expect(out).toHaveLength(2)
      expect(out[0].talkerId).toBe(2)
      expect(out[1].talkerId).toBe(3)
    })

    it('only drops a LEADING duplicate, never a later same-ts item', () => {
      const out = dedupeBoundarySessions('999', {
        sessions: [
          { talkerId: 1, sessionTs: '300' },
          { talkerId: 2, sessionTs: '999' }, // same ts but not leading -> keep
        ],
        hasMore: true,
      })
      expect(out).toHaveLength(2)
      expect(out[0].talkerId).toBe(1)
      expect(out[1].talkerId).toBe(2)
    })

    it('returns an empty array for an empty page', () => {
      const out = dedupeBoundarySessions('300', { sessions: [], hasMore: false })
      expect(out).toEqual([])
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm it FAILS for the right reason.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm exec vitest run src/lib/backfill-cursor.test.ts
  ```
  Expected FAIL: `Failed to resolve import "@/lib/backfill-cursor"` (implementation file does not exist yet).

### Task 44: Backfill cursor math module (`backfill-cursor.ts`) — implementation

**Files:**
- Create: `/Users/sparanoid/Git/laplace-comet/src/lib/backfill-cursor.ts`
- Test: `/Users/sparanoid/Git/laplace-comet/src/lib/backfill-cursor.test.ts`

- [ ] **Step 1: Write the full implementation.** Create `/Users/sparanoid/Git/laplace-comet/src/lib/backfill-cursor.ts` with EXACTLY this content:
  ```ts
  /**
   * Backfill pagination cursor math (spec section 10).
   *
   * Pure helpers that compute the next request boundary and whether a backward
   * walk has reached genesis. Seqno / ts values are strings (they can exceed 2^53).
   */

  /** Empty-history sentinel returned by fetch_session_msgs for a conversation with no messages. */
  const EMPTY_MIN_SEQNO = '18446744073709551615'
  const EMPTY_MAX_SEQNO = '0'

  export interface ConvCursor {
    oldestSeqno: string | null
    backfillDone: boolean
    newestSeqno: string | null
    newestMsgKey: string | null
  }

  export interface MsgPage {
    minSeqno: string
    maxSeqno: string
    hasMore: boolean
    /** true when messages were null OR the empty-history sentinel was returned. */
    empty: boolean
  }

  /**
   * Detect the empty-history sentinel page.
   * Exposed so the crawler can derive MsgPage.empty consistently from a raw response.
   */
  export function isEmptyMsgPage(minSeqno: string, maxSeqno: string, messagesNull: boolean): boolean {
    if (messagesNull) return true
    return minSeqno === EMPTY_MIN_SEQNO && maxSeqno === EMPTY_MAX_SEQNO
  }

  /**
   * Advance the backward backfill cursor by one page.
   *
   * - nextEndSeqno = page.minSeqno is the EXCLUSIVE end_seqno for the next request (no overlap).
   * - oldestSeqno is lowered to page.minSeqno (the new indexed floor).
   * - done when the page reports no more history OR is the empty sentinel.
   * - backfillDone mirrors `done` once reached (never un-set here).
   * - newestSeqno / newestMsgKey are owned by the forward sweep and pass through untouched.
   */
  export function nextBackfillCursor(
    cursor: ConvCursor,
    page: MsgPage
  ): { cursor: ConvCursor; nextEndSeqno: string | null; done: boolean } {
    if (page.empty) {
      const done = true
      return {
        cursor: { ...cursor, backfillDone: true },
        nextEndSeqno: null,
        done,
      }
    }

    const done = !page.hasMore
    return {
      cursor: {
        ...cursor,
        oldestSeqno: page.minSeqno,
        backfillDone: cursor.backfillDone || done,
      },
      nextEndSeqno: page.minSeqno,
      done,
    }
  }

  export interface SessionPage {
    sessions: Array<{ talkerId: number; sessionTs: string }>
    hasMore: boolean
  }

  /**
   * Drop the leading boundary-duplicate session.
   *
   * get_sessions paginates by `end_ts = session_ts of the last item`, so the first
   * item of the next page repeats the previous page's last item. When prevEndTs is
   * set, drop a LEADING session whose sessionTs === prevEndTs. Only the leading item
   * is considered (a later same-ts item is a distinct conversation and is kept).
   */
  export function dedupeBoundarySessions(
    prevEndTs: string | null,
    page: SessionPage
  ): Array<{ talkerId: number; sessionTs: string }> {
    if (prevEndTs === null) return page.sessions
    if (page.sessions.length === 0) return page.sessions
    if (page.sessions[0].sessionTs === prevEndTs) {
      return page.sessions.slice(1)
    }
    return page.sessions
  }
  ```

- [ ] **Step 2: Run the test and confirm it PASSES.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm exec vitest run src/lib/backfill-cursor.test.ts
  ```
  Expected: all tests pass.

- [ ] **Step 3: Commit.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && git add src/lib/backfill-cursor.ts src/lib/backfill-cursor.test.ts && git commit -m "feat: add backfill cursor math (exclusive seqno walk + session dedupe)"
  ```

### Task 45: Factor in-process raw fetchers out of bilibili IPC handlers

**Files:**
- Modify: `/Users/sparanoid/Git/laplace-comet/src/api/bilibili.ts:764-819` (sessions handler) and `:824-889` (messages handler); add exports near `:397`

- [ ] **Step 1: Read the two handlers and the export line.** Confirm the exact bodies of the `BILIBILI_FETCH_SESSIONS` handler (`:764-819`) and `BILIBILI_FETCH_MESSAGES` handler (`:824-889`), and the existing export at `:397`:
  ```ts
  export { clearAllAccounts, getAccounts, getActiveAccount, getActiveAccountMid, getCredentials }
  ```
  The crawler must call the same network logic in-process without going through IPC, so the fetch bodies are extracted into exported async functions.

- [ ] **Step 2: Add the two exported raw fetchers.** Insert the following block immediately AFTER the `cookieStringFromCredentials` function (which ends at `:409`) and BEFORE `export function registerBilibiliIpcHandlers() {` at `:411`. These reuse `getCredentials`, `cookieStringFromCredentials`, `preserveLargeIntegers`, and the existing endpoint/header constants already imported at the top of the file:
  ```ts
  /**
   * In-process raw fetch of the conversation list (same logic as the
   * BILIBILI_FETCH_SESSIONS IPC handler), callable by the backfill crawler.
   * Returns the parsed response (large integers preserved as strings) or an
   * ErrorResponse-shaped object on auth/network failure.
   */
  export async function fetchSessionsRaw(params: {
    sessionType?: string
    size?: string
    endTs?: string
  }): Promise<BilibiliSessionsResponse | { error: string; code: number }> {
    const { sessionType = '1', size = '100', endTs } = params
    const credentials = getCredentials()
    if (!credentials) {
      return { error: 'Not logged in. Please scan QR code to login.', code: 401 }
    }

    try {
      const cookieHeader = cookieStringFromCredentials(credentials)
      const url = new URL(BILIBILI_ENDPOINTS.GET_SESSIONS)
      url.searchParams.set('session_type', sessionType)
      url.searchParams.set('group_fold', '0')
      url.searchParams.set('unfollow_fold', '0')
      url.searchParams.set('sort_rule', '2')
      url.searchParams.set('size', size)
      url.searchParams.set('build', '0')
      url.searchParams.set('mobi_app', 'web')
      if (endTs) {
        url.searchParams.set('end_ts', endTs)
      }

      const resp = await fetch(url.toString(), {
        headers: {
          Cookie: cookieHeader,
          ...COMMON_HEADERS,
          Referer: BILIBILI_HEADERS.REFERER,
          Origin: BILIBILI_HEADERS.ORIGIN,
        },
      })

      const responseText = await resp.text()
      // A -412 block page is HTML, not JSON: surface it as code -412 so the crawler
      // can classify it as `blocked` rather than crashing on JSON.parse.
      try {
        return JSON.parse(preserveLargeIntegers(responseText)) as BilibiliSessionsResponse
      } catch {
        return { error: 'blocked', code: -412 }
      }
    } catch (error) {
      console.error('Failed to fetch sessions (raw):', error)
      return { error: 'Failed to fetch sessions from Bilibili', code: 500 }
    }
  }

  /**
   * In-process raw fetch of a conversation's message page (same logic as the
   * BILIBILI_FETCH_MESSAGES IPC handler), callable by the backfill crawler.
   */
  export async function fetchSessionMsgsRaw(params: {
    talkerId: string
    sessionType?: string
    size?: string
    beginSeqno?: string
    endSeqno?: string
  }): Promise<BilibiliMessagesResponse | { error: string; code: number }> {
    const { talkerId, sessionType = '1', size = '200', beginSeqno, endSeqno } = params
    const credentials = getCredentials()
    if (!credentials) {
      return { error: 'Not logged in. Please scan QR code to login.', code: 401 }
    }
    if (!talkerId) {
      return { error: 'Missing talker_id parameter', code: 400 }
    }

    try {
      const cookieHeader = cookieStringFromCredentials(credentials)
      const url = new URL(BILIBILI_ENDPOINTS.FETCH_MESSAGES)
      url.searchParams.set('talker_id', talkerId)
      url.searchParams.set('session_type', sessionType)
      url.searchParams.set('size', size)
      url.searchParams.set('sender_device_id', '1')
      url.searchParams.set('build', '0')
      url.searchParams.set('mobi_app', 'web')
      if (beginSeqno) {
        url.searchParams.set('begin_seqno', beginSeqno)
      }
      if (endSeqno) {
        url.searchParams.set('end_seqno', endSeqno)
      }

      const resp = await fetch(url.toString(), {
        headers: {
          Cookie: cookieHeader,
          ...COMMON_HEADERS,
          Referer: BILIBILI_HEADERS.REFERER,
          Origin: BILIBILI_HEADERS.ORIGIN,
        },
      })

      const responseText = await resp.text()
      try {
        return JSON.parse(preserveLargeIntegers(responseText)) as BilibiliMessagesResponse
      } catch {
        return { error: 'blocked', code: -412 }
      }
    } catch (error) {
      console.error('Failed to fetch messages (raw):', error)
      return { error: 'Failed to fetch messages from Bilibili', code: 500 }
    }
  }
  ```

- [ ] **Step 3: Confirm the response types are imported.** Verify that `BilibiliSessionsResponse` and `BilibiliMessagesResponse` are already imported at the top of `bilibili.ts` (they are used by the handlers at `:807` and `:877`). If they are NOT in the import list, add them to the existing `import type { ... } from '@/types/bilibili'` block. Run a type smoke build:
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm exec tsc --noEmit -p tsconfig.json
  ```
  Expected: no new errors referencing `fetchSessionsRaw` / `fetchSessionMsgsRaw`.

- [ ] **Step 4: Re-point the two IPC handlers at the new fetchers (optional dedupe, behavior-preserving).** Replace the body of the `BILIBILI_FETCH_SESSIONS` handler (`:781-817`, the `try { ... } catch { ... }` plus the `code !== 0` guard) so it delegates. The handler at `:764` becomes:
  ```ts
  ipcMain.handle(
    IpcChannel.BILIBILI_FETCH_SESSIONS,
    async (
      _event,
      params: {
        sessionType?: string
        size?: string
        endTs?: string
      }
    ) => {
      const data = await fetchSessionsRaw(params)
      if ('error' in data) {
        return data
      }
      if (data.code !== 0) {
        return { error: data.message || 'Failed to fetch sessions', code: data.code }
      }
      return data
    }
  )
  ```
  And replace the `BILIBILI_FETCH_MESSAGES` handler body (`:836-887`) so it delegates:
  ```ts
  ipcMain.handle(
    IpcChannel.BILIBILI_FETCH_MESSAGES,
    async (
      _event,
      params: {
        talkerId: string
        sessionType?: string
        size?: string
        beginSeqno?: string
        endSeqno?: string
      }
    ) => {
      const data = await fetchSessionMsgsRaw(params)
      if ('error' in data) {
        return data
      }
      if (data.code !== 0) {
        return { error: data.message || 'Failed to fetch messages', code: data.code }
      }
      return data
    }
  )
  ```
  (Note: the default `size` for the messages IPC handler was `'20'`; preserve that by passing it explicitly from the renderer as before — `fetchSessionMsgsRaw` defaults to `'200'` for the crawler. The renderer always supplies `size`, so behavior is unchanged. If any caller relied on the `'20'` default, leave the original handler in place and ONLY add the two new exported functions without re-pointing — the new exports alone are what the crawler needs.)

- [ ] **Step 5: Lint and commit.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm lint && git add src/api/bilibili.ts && git commit -m "refactor: extract in-process raw session/message fetchers for crawler reuse"
  ```

### Task 46: Backfill crawler orchestrator with dependency injection (`backfill-crawler.ts`) — failing integration test

**Files:**
- Create: `/Users/sparanoid/Git/laplace-comet/src/api/backfill-crawler.test.ts`

This task assumes the search backbone already exports `indexMessages(mid, messages)`, `indexSessions(mid, sessions)`, and the cursor-persistence accessors used below (`getConvCursor`, `saveConvCursor`, `saveAccountCursor`). The crawler reads/writes those through an injected `deps` object so the integration test needs no real SQLite. The contract types `BackfillStatus` and `IndexedMessageInput` come from `search-index.ts`.

- [ ] **Step 1: Write the full failing integration test.** Create `/Users/sparanoid/Git/laplace-comet/src/api/backfill-crawler.test.ts` with EXACTLY this content. It injects scripted fetchers (including a `-412` blocked page followed by success) and a fake index/cursor store, then asserts cursors advance and messages are indexed:
  ```ts
  import { describe, expect, it, vi } from 'vitest'
  import { createBackfillCrawler } from '@/api/backfill-crawler'
  import type { CrawlerDeps } from '@/api/backfill-crawler'
  import type { BilibiliMessagesResponse, BilibiliSessionsResponse } from '@/types/bilibili'

  // ---- scripted response builders -------------------------------------------

  function sessionsResp(
    list: Array<{ talker_id: number; session_ts: number }>,
    hasMore: number
  ): BilibiliSessionsResponse {
    return {
      code: 0,
      msg: '0',
      message: '0',
      ttl: 1,
      data: {
        session_list: list.map(s => ({
          talker_id: s.talker_id,
          session_type: 1,
          session_ts: s.session_ts,
          last_msg: null,
          unread_count: 0,
          group_name: '',
          // remaining BilibiliSession fields are not read by the crawler
        })) as BilibiliSessionsResponse['data']['session_list'],
        has_more: hasMore,
        anti_disturb_cleaning: false,
        is_address_list_empty: 0,
        show_level: false,
      },
    }
  }

  function msgsResp(
    msgs: Array<{ msg_seqno: number; msg_key: string }>,
    minSeqno: number,
    maxSeqno: number,
    hasMore: number
  ): BilibiliMessagesResponse {
    return {
      code: 0,
      msg: '0',
      message: '0',
      ttl: 1,
      data: {
        messages: msgs.map(m => ({
          sender_uid: 1,
          receiver_type: 1,
          receiver_id: 2,
          msg_type: 1,
          content: '{"content":"hi"}',
          msg_seqno: m.msg_seqno,
          timestamp: 1700000000,
          at_uids: null,
          msg_key: m.msg_key,
          msg_status: 0,
          notify_code: '',
          msg_source: 0,
        })),
        has_more: hasMore,
        min_seqno: minSeqno,
        max_seqno: maxSeqno,
      },
    }
  }

  // A blocked (-412) page surfaced by the raw fetcher when JSON.parse fails.
  const BLOCKED = { error: 'blocked', code: -412 } as const

  function makeDeps(overrides: Partial<CrawlerDeps> = {}): {
    deps: CrawlerDeps
    indexed: number[]
    convCursors: Map<string, unknown>
    progress: unknown[]
  } {
    const indexed: number[] = []
    const convCursors = new Map<string, unknown>()
    const progress: unknown[] = []

    const deps: CrawlerDeps = {
      getActiveAccountMid: () => 42,
      fetchSessions: vi.fn(async () => sessionsResp([], 0)),
      fetchSessionMsgs: vi.fn(async () => msgsResp([], 18446744073709551615, 0, 0)),
      indexSessions: vi.fn(),
      indexMessages: vi.fn((_mid: number, msgs: Array<{ msgSeqno: string }>) => {
        for (const m of msgs) indexed.push(Number(m.msgSeqno))
      }),
      getConvCursor: vi.fn((_mid: number, key: string) => convCursors.get(key) as never),
      saveConvCursor: vi.fn((_mid: number, key: string, cursor: unknown) => {
        convCursors.set(key, cursor)
      }),
      saveAccountCursor: vi.fn(),
      emitProgress: vi.fn((s: unknown) => {
        progress.push(s)
      }),
      // make delays instant so the test runs fast
      sleep: vi.fn(async () => {}),
      jitter: () => 3000,
      ...overrides,
    }
    return { deps, indexed, convCursors, progress }
  }

  describe('createBackfillCrawler', () => {
    it('crawls one conversation, indexes messages, advances cursors, finishes done', async () => {
      const { deps, indexed } = makeDeps({
        // one conversation in the session list
        fetchSessions: vi.fn(async () => sessionsResp([{ talker_id: 7, session_ts: 1000 }], 0)),
        // two message pages then genesis
        fetchSessionMsgs: vi
          .fn()
          .mockResolvedValueOnce(msgsResp([{ msg_seqno: 900, msg_key: 'k900' }], 800, 900, 1))
          .mockResolvedValueOnce(msgsResp([{ msg_seqno: 700, msg_key: 'k700' }], 600, 700, 0)),
      })

      const crawler = createBackfillCrawler(deps)
      crawler.start({ sessionType: 1 })
      await crawler.waitIdle()

      // both pages' messages indexed
      expect(indexed.sort((a, b) => a - b)).toEqual([700, 900])

      // second fetch used the exclusive end_seqno from page 1 (min_seqno=800)
      const calls = (deps.fetchSessionMsgs as ReturnType<typeof vi.fn>).mock.calls
      expect(calls[0][0]).toMatchObject({ talkerId: '7' })
      expect(calls[1][0]).toMatchObject({ endSeqno: '800' })

      // conv cursor persisted as done at the genesis floor
      expect(deps.saveConvCursor).toHaveBeenCalled()
      const lastCursor = (deps.saveConvCursor as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2] as {
        oldestSeqno: string
        backfillDone: boolean
      }
      expect(lastCursor.oldestSeqno).toBe('600')
      expect(lastCursor.backfillDone).toBe(true)

      // ended in a terminal state
      expect(crawler.getStatus().state).toBe('done')
    })

    it('retries after a -412 blocked page then succeeds (backoff applied, no data lost)', async () => {
      const { deps, indexed } = makeDeps({
        fetchSessions: vi.fn(async () => sessionsResp([{ talker_id: 7, session_ts: 1000 }], 0)),
        fetchSessionMsgs: vi
          .fn()
          .mockResolvedValueOnce(BLOCKED) // first attempt blocked
          .mockResolvedValueOnce(msgsResp([{ msg_seqno: 900, msg_key: 'k900' }], 900, 900, 0)),
      })

      const crawler = createBackfillCrawler(deps)
      crawler.start({ sessionType: 1 })
      await crawler.waitIdle()

      // the blocked page was retried and the real page indexed
      expect(indexed).toEqual([900])
      // sleep was called with the blocked backoff (30s) at least once
      const sleepArgs = (deps.sleep as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
      expect(sleepArgs).toContain(30_000)
      expect(crawler.getStatus().state).toBe('done')
    })

    it('aborts and flags error on a not-logged-in (-101) response', async () => {
      const { deps, indexed } = makeDeps({
        fetchSessions: vi.fn(async () => ({ error: 'not logged in', code: -101 })),
      })

      const crawler = createBackfillCrawler(deps)
      crawler.start({ sessionType: 1 })
      await crawler.waitIdle()

      expect(indexed).toEqual([])
      expect(crawler.getStatus().state).toBe('error')
      expect(crawler.getStatus().lastError).toContain('-101')
    })

    it('skips conversations already marked backfillDone (resumable)', async () => {
      const fetchMsgs = vi.fn(async () => msgsResp([{ msg_seqno: 1, msg_key: 'k1' }], 1, 1, 0))
      const { deps, indexed } = makeDeps({
        fetchSessions: vi.fn(async () => sessionsResp([{ talker_id: 7, session_ts: 1000 }], 0)),
        fetchSessionMsgs: fetchMsgs,
        getConvCursor: vi.fn(() => ({
          oldestSeqno: '1',
          backfillDone: true,
          newestSeqno: '1',
          newestMsgKey: 'k1',
        })),
      })

      const crawler = createBackfillCrawler(deps)
      crawler.start({ sessionType: 1 })
      await crawler.waitIdle()

      expect(fetchMsgs).not.toHaveBeenCalled()
      expect(indexed).toEqual([])
      expect(crawler.getStatus().state).toBe('done')
    })

    it('pause() halts the loop and resume() lets it finish', async () => {
      let releaseSecondPage: (v: BilibiliMessagesResponse) => void = () => {}
      const secondPage = new Promise<BilibiliMessagesResponse>(res => {
        releaseSecondPage = res
      })
      const fetchMsgs = vi
        .fn()
        .mockResolvedValueOnce(msgsResp([{ msg_seqno: 900, msg_key: 'k900' }], 800, 900, 1))
        .mockImplementationOnce(() => secondPage)

      const { deps, indexed } = makeDeps({
        fetchSessions: vi.fn(async () => sessionsResp([{ talker_id: 7, session_ts: 1000 }], 0)),
        fetchSessionMsgs: fetchMsgs,
      })

      const crawler = createBackfillCrawler(deps)
      crawler.start({ sessionType: 1 })

      // let the first page resolve, then pause before the second completes
      await vi.waitFor(() => expect(indexed).toContain(900))
      crawler.pause()
      releaseSecondPage(msgsResp([{ msg_seqno: 700, msg_key: 'k700' }], 600, 700, 0))
      await crawler.waitIdle()

      expect(crawler.getStatus().state).toBe('paused')

      crawler.resume()
      await crawler.waitIdle()
      expect(indexed.sort((a, b) => a - b)).toEqual([700, 900])
      expect(crawler.getStatus().state).toBe('done')
    })
  })
  ```

- [ ] **Step 2: Run the test and confirm it FAILS for the right reason.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm exec vitest run src/api/backfill-crawler.test.ts
  ```
  Expected FAIL: `Failed to resolve import "@/api/backfill-crawler"` (implementation file does not exist yet).

### Task 47: Backfill crawler orchestrator (`backfill-crawler.ts`) — implementation

**Files:**
- Create: `/Users/sparanoid/Git/laplace-comet/src/api/backfill-crawler.ts`
- Test: `/Users/sparanoid/Git/laplace-comet/src/api/backfill-crawler.test.ts`

This module is the testable core: a serial, resumable crawl loop with all IO injected via `CrawlerDeps`. It composes `classifyError`/`nextBackoff` (from `backfill-policy.ts`), `nextBackfillCursor`/`dedupeBoundarySessions`/`isEmptyMsgPage` (from `backfill-cursor.ts`), and `extractSearchableText` is NOT needed here (that runs inside `indexMessages`). The production `search-index.ts` wires `CrawlerDeps` to the real fetchers and SQLite cursor accessors.

- [ ] **Step 1: Write the full implementation.** Create `/Users/sparanoid/Git/laplace-comet/src/api/backfill-crawler.ts` with EXACTLY this content:
  ```ts
  /**
   * Backfill crawler orchestrator.
   *
   * A single serial, resumable walk over conversations and their message history.
   * All IO (network fetch, indexing, cursor persistence, progress emission, sleeping)
   * is injected via `CrawlerDeps` so the loop is unit-testable with scripted fakes.
   *
   * Concurrency is always 1 (spec section 10: never parallelize per account).
   */

  import type { BilibiliMessagesResponse, BilibiliSession, BilibiliSessionsResponse } from '@/types/bilibili'
  import { classifyError, nextBackoff } from '@/lib/backfill-policy'
  import type { BackoffState } from '@/lib/backfill-policy'
  import {
    dedupeBoundarySessions,
    isEmptyMsgPage,
    nextBackfillCursor,
  } from '@/lib/backfill-cursor'
  import type { ConvCursor } from '@/lib/backfill-cursor'

  // Mirrors search-index.ts exports so the production wiring is a direct pass-through.
  export interface IndexedMessageInput {
    talkerId: number
    sessionType: number
    msgSeqno: string
    msgKey: string
    senderUid: number | null
    msgType: number | null
    msgSource: number | null
    timestamp: number | null
    msgStatus: number | null
    content: string
  }

  export interface BackfillStatus {
    state: 'idle' | 'running' | 'paused' | 'done' | 'error'
    processedConversations: number
    totalConversations: number
    indexedMessages: number
    currentTalkerId: number | null
    lastError: string | null
  }

  type RawSessionsResult = BilibiliSessionsResponse | { error: string; code: number }
  type RawMsgsResult = BilibiliMessagesResponse | { error: string; code: number }

  export interface CrawlerDeps {
    getActiveAccountMid: () => number | null
    fetchSessions: (params: { sessionType: string; size: string; endTs?: string }) => Promise<RawSessionsResult>
    fetchSessionMsgs: (params: {
      talkerId: string
      sessionType: string
      size: string
      endSeqno?: string
    }) => Promise<RawMsgsResult>
    indexSessions: (mid: number, sessions: BilibiliSession[]) => void
    indexMessages: (mid: number, messages: IndexedMessageInput[]) => void
    getConvCursor: (mid: number, key: string) => ConvCursor | undefined
    saveConvCursor: (mid: number, key: string, cursor: ConvCursor) => void
    saveAccountCursor: (
      mid: number,
      cursor: { sessionEndTs: string | null; sessionHasMore: boolean }
    ) => void
    emitProgress: (status: BackfillStatus) => void
    sleep: (ms: number) => Promise<void>
    /** returns a jittered base delay in ms (production: 2000-4000) */
    jitter: (baseMs: number) => number
  }

  const SESSIONS_PAGE_SIZE = '100'
  const MSGS_PAGE_SIZE = '200'
  const BASE_DELAY_MS = 3000
  // Emit progress at most ~1/sec (spec section 15).
  const PROGRESS_THROTTLE_MS = 1000

  function convKey(talkerId: number, sessionType: number): string {
    return `${talkerId}:${sessionType}`
  }

  function isError(r: RawSessionsResult | RawMsgsResult): r is { error: string; code: number } {
    return 'error' in r
  }

  export interface BackfillCrawler {
    start: (opts?: { sessionType?: number }) => void
    pause: () => void
    resume: () => void
    getStatus: () => BackfillStatus
    /** resolves when the loop has reached a terminal/paused/idle resting state */
    waitIdle: () => Promise<void>
  }

  export function createBackfillCrawler(deps: CrawlerDeps): BackfillCrawler {
    let status: BackfillStatus = {
      state: 'idle',
      processedConversations: 0,
      totalConversations: 0,
      indexedMessages: 0,
      currentTalkerId: null,
      lastError: null,
    }

    let paused = false
    let running = false
    let runPromise: Promise<void> | null = null
    let backoff: BackoffState = { attempt: 0, baseDelayMs: BASE_DELAY_MS }
    let lastProgressAt = 0
    let sessionType = 1

    function publish(force = false): void {
      const now = Date.now()
      if (!force && now - lastProgressAt < PROGRESS_THROTTLE_MS) return
      lastProgressAt = now
      deps.emitProgress({ ...status })
    }

    /**
     * Perform one fetch with backoff handling.
     * Retries `blocked`/`too_frequent` in place; returns null on abort/pause/empty-other.
     * Returns the successful response otherwise.
     */
    async function fetchWithBackoff<T extends RawSessionsResult | RawMsgsResult>(
      doFetch: () => Promise<T>
    ): Promise<Exclude<T, { error: string; code: number }> | null> {
      // serial retry loop
      // biome-ignore lint/suspicious/noConstantCondition: intentional retry loop with internal breaks
      while (true) {
        if (paused) return null
        const result = await doFetch()

        const code = isError(result) ? result.code : result.code
        const blocked = isError(result) && result.code === -412
        const kind = classifyError(code, blocked)

        if (kind === 'ok') {
          backoff = { attempt: 0, baseDelayMs: backoff.baseDelayMs }
          return result as Exclude<T, { error: string; code: number }>
        }

        const decision = nextBackoff(kind, backoff)
        backoff = decision.nextState

        if (decision.action === 'abort') {
          status = { ...status, state: 'error', lastError: `code=${code}` }
          publish(true)
          return null
        }
        if (decision.action === 'pause') {
          status = { ...status, state: 'paused', lastError: `code=${code}` }
          publish(true)
          paused = true
          await deps.sleep(decision.delayMs)
          return null
        }
        // action === 'retry'
        await deps.sleep(decision.delayMs)
        if (paused) return null
      }
    }

    /** Backfill a single conversation backward to genesis (or until paused/aborted). */
    async function backfillConversation(mid: number, talkerId: number): Promise<boolean> {
      const key = convKey(talkerId, sessionType)
      let cursor: ConvCursor =
        deps.getConvCursor(mid, key) ?? {
          oldestSeqno: null,
          backfillDone: false,
          newestSeqno: null,
          newestMsgKey: null,
        }

      if (cursor.backfillDone) return true

      // resume from the recorded floor (exclusive end_seqno)
      let endSeqno: string | undefined = cursor.oldestSeqno ?? undefined

      // biome-ignore lint/suspicious/noConstantCondition: paged walk with internal breaks
      while (true) {
        if (paused) return false

        const resp = await fetchWithBackoff(() =>
          deps.fetchSessionMsgs({
            talkerId: String(talkerId),
            sessionType: String(sessionType),
            size: MSGS_PAGE_SIZE,
            endSeqno,
          })
        )
        if (resp === null) return false // aborted or paused mid-page

        const data = resp.data
        const messages = data.messages ?? []
        const minSeqno = String(data.min_seqno)
        const maxSeqno = String(data.max_seqno)
        const empty = isEmptyMsgPage(minSeqno, maxSeqno, data.messages === null)

        if (!empty && messages.length > 0) {
          const input: IndexedMessageInput[] = messages.map(m => ({
            talkerId,
            sessionType,
            msgSeqno: String(m.msg_seqno),
            msgKey: String(m.msg_key),
            senderUid: m.sender_uid ?? null,
            msgType: m.msg_type ?? null,
            msgSource: m.msg_source ?? null,
            timestamp: m.timestamp ?? null,
            msgStatus: m.msg_status ?? null,
            content: m.content,
          }))
          deps.indexMessages(mid, input)
          status = { ...status, indexedMessages: status.indexedMessages + input.length }
        }

        const advanced = nextBackfillCursor(cursor, {
          minSeqno,
          maxSeqno,
          hasMore: data.has_more === 1,
          empty,
        })
        cursor = advanced.cursor
        deps.saveConvCursor(mid, key, cursor)
        publish()

        if (advanced.done) return true
        endSeqno = advanced.nextEndSeqno ?? undefined

        // base inter-page delay
        await deps.sleep(deps.jitter(backoff.baseDelayMs))
      }
    }

    async function run(): Promise<void> {
      running = true
      paused = false
      status = { ...status, state: 'running', lastError: null }
      publish(true)

      const mid = deps.getActiveAccountMid()
      if (mid === null) {
        status = { ...status, state: 'error', lastError: 'no active account' }
        publish(true)
        running = false
        return
      }

      // ---- walk the conversation list, backfilling each conversation ----------
      let endTs: string | undefined
      let prevEndTs: string | null = null

      // biome-ignore lint/suspicious/noConstantCondition: paged walk with internal breaks
      while (true) {
        if (paused) break

        const resp = await fetchWithBackoff(() =>
          deps.fetchSessions({ sessionType: String(sessionType), size: SESSIONS_PAGE_SIZE, endTs })
        )
        if (resp === null) break // aborted or paused

        const list = resp.data.session_list ?? []
        if (list.length === 0) break

        // mirror session metadata for offline conversation search
        deps.indexSessions(mid, list)

        const deduped = dedupeBoundarySessions(prevEndTs, {
          sessions: list.map(s => ({ talkerId: s.talker_id, sessionTs: String(s.session_ts) })),
          hasMore: resp.data.has_more === 1,
        })

        status = { ...status, totalConversations: status.totalConversations + deduped.length }
        publish()

        for (const s of deduped) {
          if (paused) break
          status = { ...status, currentTalkerId: s.talkerId }
          publish()
          const finished = await backfillConversation(mid, s.talkerId)
          if (paused) break
          if (finished) {
            status = { ...status, processedConversations: status.processedConversations + 1 }
            publish()
          }
        }

        if (paused) break
        if (resp.data.has_more !== 1) {
          // reached the end of the conversation list
          deps.saveAccountCursor(mid, { sessionEndTs: null, sessionHasMore: false })
          break
        }

        // page back via end_ts = session_ts of the last item
        prevEndTs = String(list[list.length - 1].session_ts)
        endTs = prevEndTs
        deps.saveAccountCursor(mid, { sessionEndTs: endTs, sessionHasMore: true })
        await deps.sleep(deps.jitter(backoff.baseDelayMs))
      }

      // terminal state resolution
      if (status.state === 'error') {
        // keep error
      } else if (paused) {
        status = { ...status, state: 'paused' }
      } else {
        status = { ...status, state: 'done', currentTalkerId: null }
      }
      publish(true)
      running = false
    }

    return {
      start(opts) {
        if (running) return
        sessionType = opts?.sessionType ?? 1
        backoff = { attempt: 0, baseDelayMs: BASE_DELAY_MS }
        runPromise = run()
      },
      pause() {
        paused = true
      },
      resume() {
        if (running) return
        paused = false
        status = { ...status, state: 'running', lastError: null }
        runPromise = run()
      },
      getStatus() {
        return { ...status }
      },
      async waitIdle() {
        if (runPromise) await runPromise
      },
    }
  }
  ```

- [ ] **Step 2: Run the test and confirm it PASSES.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm exec vitest run src/api/backfill-crawler.test.ts
  ```
  Expected: all integration cases pass — single-conversation crawl indexes `[700,900]` and finishes `done`; `-412` retry indexes `[900]` after a `30_000` sleep; `-101` aborts to `error` with `lastError` containing `-101`; already-done conversation is skipped; pause/resume finishes the remaining page.

- [ ] **Step 3: Commit.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && git add src/api/backfill-crawler.ts src/api/backfill-crawler.test.ts && git commit -m "feat: add resumable serial backfill crawler orchestrator with injectable IO"
  ```

### Task 48: Wire the crawler into `search-index.ts` and the backfill public API

**Files:**
- Modify: `/Users/sparanoid/Git/laplace-comet/src/api/search-index.ts` (the `startBackfill` / `pauseBackfill` / `resumeBackfill` / `getBackfillStatus` stubs created by the backbone task)

This task assumes `search-index.ts` already exists (created by the backbone task) and exposes `initSearchIndex`, `indexMessages`, `indexSessions`, the SQLite handle, and the four backfill functions as stubs. It also assumes the raw fetchers `fetchSessionsRaw` / `fetchSessionMsgsRaw` are exported from `bilibili.ts` (from the fetcher-extraction task). Here we connect them via `createBackfillCrawler`.

- [ ] **Step 1: Read the current backfill section of `search-index.ts`.** Locate the `startBackfill`, `pauseBackfill`, `resumeBackfill`, `getBackfillStatus` function bodies and the existing `conv_cursors` / `account_cursors` read/write helpers (if the backbone task created `getConvCursor`/`saveConvCursor`/`saveAccountCursor`, reuse them; otherwise add them in Step 2). Confirm the module-level `db` handle name and the `emitBackfillProgress` helper that sends `IpcEvent.SEARCH_BACKFILL_PROGRESS` to all `BrowserWindow.getAllWindows()`.

- [ ] **Step 2: Add cursor persistence helpers backed by the real DB (only if the backbone task did not).** Insert these near the other prepared-statement helpers in `search-index.ts`. They map the `ConvCursor` shape to the `conv_cursors` / `account_cursors` schema (section 7), scoping by `account_mid`:
  ```ts
  import type { ConvCursor } from '@/lib/backfill-cursor'

  function getConvCursorRow(mid: number, key: string): ConvCursor | undefined {
    const [talkerId, sessionType] = key.split(':').map(Number)
    const row = db
      .prepare(
        `SELECT oldest_seqno, backfill_done, newest_seqno, newest_msg_key
         FROM conv_cursors
         WHERE account_mid = ? AND talker_id = ? AND session_type = ?`
      )
      .get(mid, talkerId, sessionType) as
      | { oldest_seqno: string | null; backfill_done: number; newest_seqno: string | null; newest_msg_key: string | null }
      | undefined
    if (!row) return undefined
    return {
      oldestSeqno: row.oldest_seqno,
      backfillDone: row.backfill_done === 1,
      newestSeqno: row.newest_seqno,
      newestMsgKey: row.newest_msg_key,
    }
  }

  function saveConvCursorRow(mid: number, key: string, cursor: ConvCursor): void {
    const [talkerId, sessionType] = key.split(':').map(Number)
    db.prepare(
      `INSERT INTO conv_cursors
         (account_mid, talker_id, session_type, oldest_seqno, backfill_done, newest_seqno, newest_msg_key, last_indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_mid, talker_id, session_type) DO UPDATE SET
         oldest_seqno = excluded.oldest_seqno,
         backfill_done = excluded.backfill_done,
         newest_seqno = COALESCE(excluded.newest_seqno, conv_cursors.newest_seqno),
         newest_msg_key = COALESCE(excluded.newest_msg_key, conv_cursors.newest_msg_key),
         last_indexed_at = excluded.last_indexed_at`
    ).run(
      mid,
      talkerId,
      sessionType,
      cursor.oldestSeqno,
      cursor.backfillDone ? 1 : 0,
      cursor.newestSeqno,
      cursor.newestMsgKey,
      Date.now()
    )
  }

  function saveAccountCursorRow(
    mid: number,
    cursor: { sessionEndTs: string | null; sessionHasMore: boolean }
  ): void {
    db.prepare(
      `INSERT INTO account_cursors (account_mid, session_end_ts, session_has_more, last_full_sweep_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_mid) DO UPDATE SET
         session_end_ts = excluded.session_end_ts,
         session_has_more = excluded.session_has_more,
         last_full_sweep_at = excluded.last_full_sweep_at`
    ).run(mid, cursor.sessionEndTs, cursor.sessionHasMore ? 1 : 0, Date.now())
  }
  ```

- [ ] **Step 3: Construct a singleton crawler wired to production deps.** Add this near the top of the backfill section, after the imports and after `initSearchIndex` exists. It adapts the raw fetchers (which return `code`-bearing responses or `{ error, code }`) and the DB cursor helpers into `CrawlerDeps`, and broadcasts progress through the existing `emitBackfillProgress`:
  ```ts
  import { createBackfillCrawler } from '@/api/backfill-crawler'
  import type { BackfillCrawler } from '@/api/backfill-crawler'
  import { fetchSessionMsgsRaw, fetchSessionsRaw, getActiveAccountMid } from '@/api/bilibili'

  let crawler: BackfillCrawler | null = null

  function jitteredDelay(baseMs: number): number {
    // base 2-4s band centered on baseMs (spec: 2-4s jittered)
    const spread = 1000
    return Math.round(baseMs - spread + Math.random() * (2 * spread))
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function getCrawler(): BackfillCrawler {
    if (crawler) return crawler
    crawler = createBackfillCrawler({
      getActiveAccountMid,
      fetchSessions: params => fetchSessionsRaw(params),
      fetchSessionMsgs: params => fetchSessionMsgsRaw(params),
      indexSessions,
      indexMessages,
      getConvCursor: getConvCursorRow,
      saveConvCursor: saveConvCursorRow,
      saveAccountCursor: saveAccountCursorRow,
      emitProgress: status => emitBackfillProgress(status),
      sleep,
      jitter: jitteredDelay,
    })
    return crawler
  }
  ```

- [ ] **Step 4: Replace the four backfill function stubs to delegate to the crawler.** Replace the stub bodies of `startBackfill`, `pauseBackfill`, `resumeBackfill`, and `getBackfillStatus` with:
  ```ts
  export function startBackfill(mid: number, opts?: { sessionType?: number }): void {
    void mid // active account resolved inside the crawler via getActiveAccountMid()
    getCrawler().start(opts)
  }

  export function pauseBackfill(): void {
    getCrawler().pause()
  }

  export function resumeBackfill(): void {
    getCrawler().resume()
  }

  export function getBackfillStatus(): BackfillStatus {
    return getCrawler().getStatus()
  }
  ```
  (Keep the `BackfillStatus` type re-exported from `search-index.ts` per the locked contract; if the backbone task defined it locally, ensure it is structurally identical to the crawler's `BackfillStatus` — both have the same fields, so import the crawler's type and re-export it: `export type { BackfillStatus } from '@/api/backfill-crawler'`.)

- [ ] **Step 5: Verify the wiring compiles.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm exec tsc --noEmit -p tsconfig.json
  ```
  Expected: no errors in `search-index.ts` related to `createBackfillCrawler`, the cursor helpers, or the four backfill exports. (Pre-existing unrelated errors from in-progress sibling tasks are out of scope.)

- [ ] **Step 6: Run the full crawler + policy + cursor test suite to confirm nothing regressed.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm exec vitest run src/lib/backfill-policy.test.ts src/lib/backfill-cursor.test.ts src/api/backfill-crawler.test.ts
  ```
  Expected: all three suites green.

- [ ] **Step 7: Lint and commit.**
  ```bash
  cd /Users/sparanoid/Git/laplace-comet && pnpm lint && git add src/api/search-index.ts && git commit -m "feat: wire backfill crawler into search-index with DB-backed cursors"
  ```

# G. Renderer UI, settings & jump-to-message (Phases 1–3)

### Task 49: Add fullTextIndexEnabled persisted setting to useSettings store

**Files:**
- Modify: src/stores/useSettings.ts:8-12 (interface), 33-36 (store init), 51 (partialize)
- Test: (none — Zustand store wiring; verify via typecheck + manual)

The shared contract requires a persisted `fullTextIndexEnabled` flag (default `false`, privacy-first) living next to `developerMode`. The current store (read in full above) defines `developerMode` in the `SettingsState` interface, initializes it in the store body, and persists only `developerMode` via `partialize`.

- [ ] **Step 1: Add `fullTextIndexEnabled` to the `SettingsState` interface.**
  In `src/stores/useSettings.ts`, replace the developer-mode block of the interface:
  ```ts
  interface SettingsState {
    // Persisted settings
    /** Developer mode shows detailed message info and unhides revoked messages */
    developerMode: boolean
    setDeveloperMode: (enabled: boolean) => void

    /** Full-text search index over all message history (off by default, privacy-first) */
    fullTextIndexEnabled: boolean
    setFullTextIndexEnabled: (enabled: boolean) => void

    // UI state (not persisted)
    /** Whether the settings modal is open */
    settingsOpen: boolean
    openSettings: () => void
    closeSettings: () => void
    toggleSettings: () => void

    /** Whether the about modal is open */
    aboutOpen: boolean
    openAbout: () => void
    closeAbout: () => void
  }
  ```

- [ ] **Step 2: Initialize `fullTextIndexEnabled` in the store body.**
  Replace the developer-mode init lines:
  ```ts
      // Persisted settings
      developerMode: false,
      setDeveloperMode: enabled => set({ developerMode: enabled }),

      fullTextIndexEnabled: false,
      setFullTextIndexEnabled: enabled => set({ fullTextIndexEnabled: enabled }),
  ```

- [ ] **Step 3: Persist the new flag in `partialize`.**
  Replace:
  ```ts
      partialize: state => ({ developerMode: state.developerMode }),
  ```
  with:
  ```ts
      partialize: state => ({
        developerMode: state.developerMode,
        fullTextIndexEnabled: state.fullTextIndexEnabled,
      }),
  ```

- [ ] **Step 4: Typecheck.**
  Run `pnpm exec tsc --noEmit`. Expected: no new errors from `useSettings.ts` (errors elsewhere referencing `electronAPI.search` may exist only after later tasks; this file alone must be clean).

- [ ] **Step 5: Commit.**
  ```bash
  git add src/stores/useSettings.ts
  git commit -m "feat(settings): add persisted fullTextIndexEnabled flag"
  ```

### Task 50: Add debounced FTS query action and backfill-progress listener to usePrivateMessages

**Files:**
- Modify: src/hooks/usePrivateMessages.ts:44-94 (return interface), 96-118 (state), 135-159 (refs), 577-657 (after fetchMessagesQuietly add search action), 1533-1554 (WS listener effect), 1613-1663 (return object)
- Test: (none — React hook with IPC; verify via typecheck + manual)

This adds the renderer's search state machine. It calls `window.electronAPI.search.query(params)` (preload bridge from the shared contract) with a request-id stale guard modeled on `fetchMessagesQuietly`'s guard (read above at ~:593), plus a `search:backfill-progress` listener that mirrors the `onNewMessage` cleanup pattern in the WS-listener effect (read above at ~:1536). Types `SearchQueryParams`, `SearchQueryResult`, and `BackfillStatus` come from `@/api/search-index` (the main module in the locked contract).

- [ ] **Step 1: Import the search types.**
  In `src/hooks/usePrivateMessages.ts`, the existing electron type import block ends at line 20. Add a new type import immediately after the `@/types/electron` import group (after line 20):
  ```ts
  import type { BackfillStatus, SearchQueryParams, SearchQueryResult } from '@/api/search-index'
  ```
  (Place it with the other `import type` groups; Biome will sort it.)

- [ ] **Step 2: Extend `UsePrivateMessagesReturn` with search state + actions.**
  In the `UsePrivateMessagesReturn` interface, after the `wsConnected: boolean` line (currently line 59), add:
  ```ts

    // Search state
    searchResults: SearchQueryResult | null
    searchLoading: boolean
    backfillStatus: BackfillStatus | null
  ```
  Then, inside the `// Actions` section, after `clearSelectedSession: () => void` (currently line 74), add:
  ```ts
    runSearch: (params: SearchQueryParams) => void
    clearSearch: () => void
  ```

- [ ] **Step 3: Add the search state hooks.**
  After the `const [emojiInfoMap, setEmojiInfoMap] = useState<EmojiInfoMap>({})` line (currently line 111), add:
  ```ts

    // Search state
    const [searchResults, setSearchResults] = useState<SearchQueryResult | null>(null)
    const [searchLoading, setSearchLoading] = useState(false)
    const [backfillStatus, setBackfillStatus] = useState<BackfillStatus | null>(null)
  ```

- [ ] **Step 4: Add the search refs (debounce timer + request-id guard).**
  After the `const selectedSessionRef = useRef<BilibiliSession | null>(null)` line (currently line 139), add:
  ```ts

    // Search debounce timer and stale-response request-id guard
    const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const searchRequestIdRef = useRef(0)
  ```

- [ ] **Step 5: Add the `runSearch` and `clearSearch` actions.**
  Insert this block immediately after the closing of `fetchMessagesQuietly` (after its `[mergeEmojiInfos, userInfo, fetchUserInfoBatch]` dependency line, currently line 657) and before `const selectSession = useCallback(`:
  ```ts

    // Debounced (200ms) full-text search over the local index, with a request-id
    // stale guard so out-of-order IPC responses can't overwrite newer results.
    const runSearch = useCallback((params: SearchQueryParams) => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
      }

      const trimmed = params.query.trim()
      // Trigram needs >=2 chars; below that, clear results without querying.
      if (trimmed.length < 2) {
        searchRequestIdRef.current += 1 // invalidate any in-flight response
        setSearchLoading(false)
        setSearchResults(null)
        return
      }

      setSearchLoading(true)
      searchDebounceRef.current = setTimeout(async () => {
        const requestId = ++searchRequestIdRef.current
        try {
          const result = await window.electronAPI.search.query({ ...params, query: trimmed })
          // Guard: ignore responses that arrive after a newer query was issued
          if (requestId !== searchRequestIdRef.current) return
          setSearchResults(result)
        } catch (err) {
          console.error('[usePrivateMessages] Search query failed:', err)
          if (requestId === searchRequestIdRef.current) {
            setSearchResults(null)
          }
        } finally {
          if (requestId === searchRequestIdRef.current) {
            setSearchLoading(false)
          }
        }
      }, 200)
    }, [])

    const clearSearch = useCallback(() => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
      searchRequestIdRef.current += 1
      setSearchLoading(false)
      setSearchResults(null)
    }, [])
  ```

- [ ] **Step 6: Add the `search:backfill-progress` listener effect.**
  Immediately after the WebSocket-listener `useEffect` (the one whose cleanup returns at lines 1548-1553 and whose dep array is `[handleNewMessage, handleSessionUpdate]` on line 1554), insert a new effect:
  ```ts

    // Subscribe to backfill progress events from the main process
    useEffect(() => {
      const cleanup = window.electronAPI.search.onBackfillProgress(status => {
        setBackfillStatus(status)
      })
      return () => {
        cleanup()
      }
    }, [])

    // Load the current backfill status once on mount so the UI reflects an
    // already-running/paused crawl after a renderer reload.
    useEffect(() => {
      window.electronAPI.search
        .backfillStatus()
        .then(setBackfillStatus)
        .catch(err => console.error('[usePrivateMessages] Failed to load backfill status:', err))
    }, [])
  ```

- [ ] **Step 7: Expose the new state/actions in the return object.**
  In the returned object, after the `wsConnected,` line (currently line 1628), add:
  ```ts

      // Search state
      searchResults,
      searchLoading,
      backfillStatus,
  ```
  Then, after `clearSelectedSession,` (currently line 1643), add:
  ```ts
      runSearch,
      clearSearch,
  ```

- [ ] **Step 8: Typecheck.**
  Run `pnpm exec tsc --noEmit`. Expected: `usePrivateMessages.ts` compiles once `@/api/search-index` exports `SearchQueryParams`/`SearchQueryResult`/`BackfillStatus` and the preload `search` namespace exists (both delivered by the main + preload tasks). If those tasks are not yet merged, the only acceptable remaining errors are "Property 'search' does not exist on type ElectronAPI" / missing `@/api/search-index` — resolved by the contract tasks; no other errors from this file.

- [ ] **Step 9: Commit.**
  ```bash
  git add src/hooks/usePrivateMessages.ts
  git commit -m "feat(search): add debounced FTS query action and backfill-progress listener"
  ```

### Task 51: Add jump-to-message hook state to usePrivateMessages

**Files:**
- Modify: src/hooks/usePrivateMessages.ts:44-94 (return interface), 96-159 (state + refs), 659-666 (selectSession), 1557-1596 (navigation effect, as the resolution model), 1613-1663 (return object)
- Test: (none — React hook; verify via typecheck + manual)

Adds `selectSessionAndJump(session, msgSeqno)`, `pendingJumpSeqnoRef`, `jumpToIndex`, and `highlightedSeqno`. `selectSession` (read above at ~:659) and the notification-nav resolution effect (read above at ~:1557, which refreshes sessions when the target isn't in `sessions[]`) are the models. After `fetchMessages` populates the sorted `messages[]`, an effect resolves the target seqno to an index and sets `jumpToIndex` + `highlightedSeqno`; `MessagesPanel` (separate task) consumes `jumpToIndex` to scroll. The highlight auto-clears after ~2s.

- [ ] **Step 1: Extend the return interface with jump state + action.**
  In `UsePrivateMessagesReturn`, in the search-state block added by the prior task (after `backfillStatus: BackfillStatus | null`), add:
  ```ts

    // Jump-to-message state
    jumpToIndex: number | null
    highlightedSeqno: number | null
  ```
  And in the `// Actions` section, after the `clearSearch: () => void` line, add:
  ```ts
    selectSessionAndJump: (session: BilibiliSession, msgSeqno: number) => void
  ```

- [ ] **Step 2: Add jump state hooks + refs.**
  After the search-state hooks (`const [backfillStatus, setBackfillStatus] = useState<BackfillStatus | null>(null)`), add:
  ```ts

    // Jump-to-message state
    const [jumpToIndex, setJumpToIndex] = useState<number | null>(null)
    const [highlightedSeqno, setHighlightedSeqno] = useState<number | null>(null)
  ```
  After the search refs (`const searchRequestIdRef = useRef(0)`), add:
  ```ts

    // Pending jump target seqno, resolved to an index once messages load
    const pendingJumpSeqnoRef = useRef<number | null>(null)
    const highlightClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  ```

- [ ] **Step 3: Add the `selectSessionAndJump` action.**
  Immediately after `selectSession` (after its `[fetchMessages]` dep line, currently ~:666) and before `clearSelectedSession`, add:
  ```ts

    // Select a session and jump to a specific message once its history loads.
    // Works even for conversations not in the loaded sessions[] window, mirroring
    // the notification-navigation resolution below.
    const selectSessionAndJump = useCallback(
      async (session: BilibiliSession, msgSeqno: number) => {
        const alreadySelected =
          selectedSessionRef.current?.talker_id === session.talker_id &&
          selectedSessionRef.current?.session_type === session.session_type

        // Arm the pending jump before any refetch so the resolution effect can pick it up.
        pendingJumpSeqnoRef.current = msgSeqno

        if (alreadySelected) {
          // Same conversation already open and fully loaded: resolve against current messages.
          const index = messagesRef.current.findIndex(m => m.msg_seqno === msgSeqno)
          if (index >= 0) {
            pendingJumpSeqnoRef.current = null
            setJumpToIndex(index)
            setHighlightedSeqno(msgSeqno)
          }
          return
        }

        setSelectedSession(session)
        setMessages([])
        await fetchMessages(session)
      },
      [fetchMessages]
    )
  ```

- [ ] **Step 4: Add the jump-resolution effect (resolve pending seqno + auto-clear highlight).**
  Insert this effect right after the navigation-listener `useEffect` (the one ending with dep array `[fetchMessages, refreshSessionsQuietly]` at ~:1596):
  ```ts

    // Resolve a pending jump target once the (complete, sorted) messages array is set.
    useEffect(() => {
      const target = pendingJumpSeqnoRef.current
      if (target === null) return
      if (messages.length === 0) return

      const index = messages.findIndex(m => m.msg_seqno === target)
      if (index >= 0) {
        pendingJumpSeqnoRef.current = null
        setJumpToIndex(index)
        setHighlightedSeqno(target)
      } else {
        // Seqno not present (recalled / aged out): fall back to nearest by index and notify.
        pendingJumpSeqnoRef.current = null
        toastManager.add({ type: 'info', title: '未找到该消息', description: '可能已被撤回或超出已加载范围' })
      }
    }, [messages])

    // Auto-clear the highlight ~2s after it lands.
    useEffect(() => {
      if (highlightedSeqno === null) return
      if (highlightClearTimerRef.current) {
        clearTimeout(highlightClearTimerRef.current)
      }
      highlightClearTimerRef.current = setTimeout(() => {
        setHighlightedSeqno(null)
      }, 2000)
      return () => {
        if (highlightClearTimerRef.current) {
          clearTimeout(highlightClearTimerRef.current)
        }
      }
    }, [highlightedSeqno])

    // Reset the jump index after it has been consumed by the messages panel
    // (one-shot: the panel scrolls, then we clear so re-selecting doesn't re-jump).
    useEffect(() => {
      if (jumpToIndex === null) return
      const t = setTimeout(() => setJumpToIndex(null), 500)
      return () => clearTimeout(t)
    }, [jumpToIndex])
  ```

- [ ] **Step 5: Expose jump state + action in the return object.**
  After `backfillStatus,` in the return object, add:
  ```ts

      // Jump-to-message state
      jumpToIndex,
      highlightedSeqno,
  ```
  And after `clearSearch,` in the actions area, add:
  ```ts
      selectSessionAndJump,
  ```

- [ ] **Step 6: Typecheck.**
  Run `pnpm exec tsc --noEmit`. Expected: no new errors from `usePrivateMessages.ts` (it already imports `toastManager` and `BilibiliSession`/`BilibiliMessage`). Acceptable remaining errors are only the cross-task `electronAPI.search` / `@/api/search-index` ones from the previous task until the contract lands.

- [ ] **Step 7: Commit.**
  ```bash
  git add src/hooks/usePrivateMessages.ts
  git commit -m "feat(search): add selectSessionAndJump with seqno resolution and highlight"
  ```

### Task 52: Create SearchResultRow component

**Files:**
- Create: src/components/comet/SearchResultRow.tsx
- Test: (none — presentational component; verify via typecheck + lint + manual)

Modeled on `SessionItem` (read above): avatar + name + `VerifiedBadge` + `formatTime`, with a `line-clamp-2` snippet. The snippet from the main-process query uses FTS5 `snippet(messages_fts, 0, '\u0001', '\u0002', '…', 32)` sentinels (locked contract); this row splits the snippet on `\u0001`/`\u0002` and wraps matched runs in `<mark class='bg-amber-100 dark:bg-amber-900/30'>`, reusing the split-map idiom from `parseTextWithEmojis` (read above at ~:176). Non-text hits (`typeLabel` present, empty/no snippet) show a type icon + `typeLabel`. Props accept either a `ConversationHit` or a `MessageHit` (types from `@/api/search-index`, locked contract) via a discriminated `kind`.

- [ ] **Step 1: Write the full component.**
  Create `src/components/comet/SearchResultRow.tsx`:
  ```tsx
  import { Image as ImageIcon, MessageSquareText, Smile, User, Users } from 'lucide-react'

  import type { ConversationHit, MessageHit } from '@/api/search-index'
  import type { UserCache } from '@/lib/message-utils'

  import { SESSION_TYPE } from '@/types/bilibili'

  import { formatTime } from '@/lib/message-utils'
  import { cn } from '@/lib/utils'

  import { enforceHttps } from '@/utils/enforceHttps'

  import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

  import { VerifiedBadge } from './VerifiedBadge'

  // Sentinels emitted by FTS5 snippet(); must match the main-process query layer.
  const MATCH_START = '\u0001'
  const MATCH_END = '\u0002'

  interface SearchResultRowProps {
    hit: ConversationHit | MessageHit
    kind: 'conversation' | 'message'
    userCache: UserCache
    isSelected: boolean
    onClick: () => void
  }

  // Split a snippet on the FTS5 sentinel pair and wrap matched runs in <mark>.
  function renderSnippet(snippet: string): React.ReactNode[] {
    const parts: React.ReactNode[] = []
    let buffer = ''
    let inMatch = false
    let key = 0

    const flush = () => {
      if (!buffer) return
      if (inMatch) {
        parts.push(
          <mark key={`m-${key++}`} className='rounded bg-amber-100 px-0.5 text-inherit dark:bg-amber-900/30'>
            {buffer}
          </mark>
        )
      } else {
        parts.push(buffer)
      }
      buffer = ''
    }

    for (const ch of snippet) {
      if (ch === MATCH_START) {
        flush()
        inMatch = true
      } else if (ch === MATCH_END) {
        flush()
        inMatch = false
      } else {
        buffer += ch
      }
    }
    flush()
    return parts.length > 0 ? parts : [snippet]
  }

  // Icon for a non-text message hit, derived from its type label.
  function typeIconFor(typeLabel: string | null): React.ReactNode {
    if (typeLabel === '[图片]') return <ImageIcon className='size-3.5 flex-none' aria-hidden='true' />
    if (typeLabel === '[表情]') return <Smile className='size-3.5 flex-none' aria-hidden='true' />
    return <MessageSquareText className='size-3.5 flex-none' aria-hidden='true' />
  }

  function avatarFallback(sessionType: number): React.ReactNode {
    return sessionType === SESSION_TYPE.FAN_GROUP ? (
      <Users className='size-5' aria-hidden='true' />
    ) : (
      <User className='size-5' aria-hidden='true' />
    )
  }

  export function SearchResultRow({ hit, kind, userCache, isSelected, onClick }: SearchResultRowProps) {
    const cachedUser = userCache[hit.talkerId]
    const isConversation = kind === 'conversation'

    // Resolve display name: conversation hits carry name; message hits fall back to cache/sender.
    const name = isConversation
      ? (hit as ConversationHit).name || `用户 ${hit.talkerId}`
      : cachedUser?.name || `用户 ${hit.talkerId}`

    const avatar = cachedUser?.face || null

    // Conversation hits show their session_ts-derived time isn't available as unix seconds,
    // so message hits use timestamp; conversation hits omit the time when absent.
    const timeLabel =
      !isConversation && (hit as MessageHit).timestamp ? formatTime((hit as MessageHit).timestamp as number) : null

    // Decide what the secondary line shows.
    const messageHit = !isConversation ? (hit as MessageHit) : null
    const conversationHit = isConversation ? (hit as ConversationHit) : null
    const snippet = messageHit ? messageHit.snippet : (conversationHit?.snippet ?? '')
    const typeLabel = messageHit ? messageHit.typeLabel : null
    const hasSnippet = snippet.trim().length > 0

    return (
      <button
        type='button'
        className={cn(
          'flex w-full select-none items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/50',
          { 'bg-accent': isSelected }
        )}
        onClick={onClick}
      >
        <div className='relative'>
          <Avatar className='size-10 ring-2 ring-border/50'>
            {avatar && <AvatarImage src={enforceHttps(avatar)} />}
            <AvatarFallback className='bg-linear-to-br from-pink-400 to-orange-300 text-white'>
              {avatarFallback(hit.sessionType)}
            </AvatarFallback>
          </Avatar>
          <VerifiedBadge official={cachedUser?.official} className='absolute -right-0.5 -bottom-0.5' />
        </div>

        <div className='min-w-0 flex-1'>
          <div className='flex items-center justify-between gap-2'>
            <span className='truncate font-medium'>{name}</span>
            {timeLabel && <span className='flex-none text-muted-foreground text-xs'>{timeLabel}</span>}
          </div>

          {hasSnippet ? (
            <p className='line-clamp-2 text-muted-foreground text-sm'>{renderSnippet(snippet)}</p>
          ) : typeLabel ? (
            <p className='flex items-center gap-1 text-muted-foreground text-sm'>
              {typeIconFor(typeLabel)}
              {typeLabel}
            </p>
          ) : (
            <p className='truncate text-muted-foreground text-sm'>—</p>
          )}
        </div>
      </button>
    )
  }
  ```

- [ ] **Step 2: Lint + typecheck.**
  Run `pnpm lint` then `pnpm exec tsc --noEmit`. Expected: clean for this file once `@/api/search-index` exports `ConversationHit`/`MessageHit` (locked contract). No unused-import or a11y warnings.

- [ ] **Step 3: Commit.**
  ```bash
  git add src/components/comet/SearchResultRow.tsx
  git commit -m "feat(search): add SearchResultRow with snippet highlighting"
  ```

### Task 53: Create SearchResults component

**Files:**
- Create: src/components/comet/SearchResults.tsx
- Test: (none — presentational/virtualized component; verify via typecheck + lint + manual)

Two virtualized groups — `会话` (conversations) and `消息` (messages) — each a `react-virtuoso` `Virtuoso` with `endReached` pagination and a coverage-caveat banner. Consumes `SearchQueryResult` (locked contract) and renders `SearchResultRow` rows. The empty-state CTA links to `openSettings()` when indexing is off (spec section 14). Uses the same `CustomScroller` forwardRef idiom as `SessionList`/`MessagesList` (read above).

- [ ] **Step 1: Write the full component.**
  Create `src/components/comet/SearchResults.tsx`:
  ```tsx
  import { ArrowRight, Loader2, Search } from 'lucide-react'
  import { forwardRef } from 'react'
  import type { ScrollerProps } from 'react-virtuoso'
  import { Virtuoso } from 'react-virtuoso'

  import type { ConversationHit, MessageHit, SearchQueryResult } from '@/api/search-index'
  import type { UserCache } from '@/lib/message-utils'

  import { Button } from '@/components/ui/button'
  import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress'

  import { SearchResultRow } from './SearchResultRow'

  const CustomScroller = forwardRef<HTMLDivElement, ScrollerProps>(({ children, ...props }, ref) => (
    <div ref={ref} {...props} className='scrollbar-thin'>
      {children}
    </div>
  ))

  interface SearchResultsProps {
    results: SearchQueryResult | null
    loading: boolean
    userCache: UserCache
    selectedTalkerId: number | null
    /** Index on: true if full-text index is enabled. */
    indexEnabled: boolean
    /** Backfill is mid-flight (determinate progress shown atop messages group). */
    backfillRunning: boolean
    /** 0..1 determinate progress for the in-progress banner. */
    backfillProgress: number
    onConversationClick: (hit: ConversationHit) => void
    onMessageClick: (hit: MessageHit) => void
    onLoadMoreMessages: () => void
    onOpenSettings: () => void
  }

  export function SearchResults({
    results,
    loading,
    userCache,
    selectedTalkerId,
    indexEnabled,
    backfillRunning,
    backfillProgress,
    onConversationClick,
    onMessageClick,
    onLoadMoreMessages,
    onOpenSettings,
  }: SearchResultsProps) {
    const conversationHits = results?.conversationHits ?? []
    const messageHits = results?.messageHits ?? []

    // Coverage caveat: index off OR mid-backfill → only loaded/indexed data is searched.
    const showCaveat = !indexEnabled || backfillRunning

    if (loading && !results) {
      return (
        <div className='flex flex-1 items-center justify-center'>
          <Loader2 className='size-5 animate-spin text-muted-foreground' aria-hidden='true' />
        </div>
      )
    }

    return (
      <div className='flex min-h-0 flex-1 flex-col'>
        {showCaveat && (
          <div className='flex-none border-border/50 border-b bg-amber-50/60 px-4 py-1.5 text-amber-700 text-xs dark:bg-amber-900/15 dark:text-amber-400'>
            仅搜索已加载/已索引的消息
          </div>
        )}

        <div className='min-h-0 flex-1 overflow-y-auto scrollbar-thin'>
          {/* Conversations group */}
          <div className='px-4 pt-3 pb-1 font-medium text-muted-foreground text-xs'>会话 · {conversationHits.length}</div>
          {conversationHits.length === 0 ? (
            <p className='px-4 pb-3 text-muted-foreground text-sm'>没有匹配的会话</p>
          ) : (
            conversationHits.map(hit => (
              <SearchResultRow
                key={`conv-${hit.sessionType}-${hit.talkerId}`}
                hit={hit}
                kind='conversation'
                userCache={userCache}
                isSelected={selectedTalkerId === hit.talkerId}
                onClick={() => onConversationClick(hit)}
              />
            ))
          )}

          {/* Messages group */}
          <div className='px-4 pt-3 pb-1 font-medium text-muted-foreground text-xs'>消息 · {messageHits.length}</div>

          {backfillRunning && (
            <div className='px-4 pb-2'>
              <Progress value={Math.round(backfillProgress * 100)}>
                <ProgressTrack className='h-1'>
                  <ProgressIndicator style={{ width: `${Math.round(backfillProgress * 100)}%` }} />
                </ProgressTrack>
              </Progress>
            </div>
          )}

          {!indexEnabled ? (
            <div className='flex flex-col items-start gap-2 px-4 py-4 text-muted-foreground text-sm'>
              <p>开启全文搜索以检索全部历史消息</p>
              <Button variant='outline' size='sm' onClick={onOpenSettings}>
                前往设置
                <ArrowRight className='size-4' aria-hidden='true' />
              </Button>
            </div>
          ) : messageHits.length === 0 ? (
            <div className='flex flex-col items-center justify-center py-8 text-muted-foreground'>
              <Search className='mb-3 size-8 opacity-50' aria-hidden='true' />
              <p className='text-sm'>没有匹配的消息</p>
            </div>
          ) : (
            <Virtuoso
              useWindowScroll
              data={messageHits}
              endReached={onLoadMoreMessages}
              overscan={20}
              itemContent={(_, hit) => (
                <SearchResultRow
                  hit={hit}
                  kind='message'
                  userCache={userCache}
                  isSelected={false}
                  onClick={() => onMessageClick(hit)}
                />
              )}
              components={{ Scroller: CustomScroller }}
            />
          )}
        </div>
      </div>
    )
  }
  ```

- [ ] **Step 2: Lint + typecheck.**
  Run `pnpm lint` then `pnpm exec tsc --noEmit`. Expected: clean once `@/api/search-index` exports `SearchQueryResult`/`ConversationHit`/`MessageHit`. Verify no unused imports.

- [ ] **Step 3: Commit.**
  ```bash
  git add src/components/comet/SearchResults.tsx
  git commit -m "feat(search): add SearchResults grouped virtualized view with coverage caveats"
  ```

### Task 54: Wire search scope toggle and SearchResults into SessionList

**Files:**
- Modify: src/components/comet/SessionList.tsx:1-30 (imports), 38-60 (props/types), 62-127 (state + filter), 136-189 (header: badge + scope menu), 191-221 (body swap)
- Test: (none — container wiring; verify via typecheck + lint + manual)

Adds a `搜索范围: 当前会话 / 全部会话` `MenuRadioGroup` modeled on the existing visibility one (read above at ~:177). When `filterText` is non-empty, render `<SearchResults>` instead of the session `Virtuoso`; repurpose the count badge (read above at ~:151) to `会话 N · 消息 M`. `SessionList` receives the new search props from `App.tsx` (wired in the next task) and drives `runSearch` whenever `filterText`/scope change. The in-memory `filteredSessions` path is retained only for the non-search (empty filter) state.

- [ ] **Step 1: Add imports for the new pieces.**
  Add `useEffect` to the React import and import the search results component + `ConversationHit`/`MessageHit`/`SearchQueryResult`/`BackfillStatus` types. Replace the top imports:
  ```tsx
  import { Loader2, MessageSquare, RefreshCw, Search, Settings, X } from 'lucide-react'
  import { forwardRef, useEffect, useMemo, useState } from 'react'
  import type { ScrollerProps } from 'react-virtuoso'
  import { Virtuoso } from 'react-virtuoso'

  import type { BackfillStatus, ConversationHit, MessageHit, SearchQueryResult } from '@/api/search-index'
  import type { UserCache } from '@/lib/message-utils'
  import type { BilibiliSession } from '@/types/bilibili'
  import type { CheckLoginResult, StoredAccountInfo } from '@/types/electron'

  import { getLastMessagePreview, getSessionName } from '@/lib/message-utils'

  import { isMacOS } from '@/utils/platform'

  import { Button } from '@/components/ui/button'
  import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
  import {
    Menu,
    MenuGroup,
    MenuGroupLabel,
    MenuItem,
    MenuPopup,
    MenuRadioGroup,
    MenuRadioItem,
    MenuSeparator,
    MenuTrigger,
  } from '@/components/ui/menu'
  import { Skeleton } from '@/components/ui/skeleton'

  import { SearchResults } from './SearchResults'
  import { SessionItem } from './SessionItem'
  import { UserMenu } from './UserMenu'
  ```

- [ ] **Step 2: Add the `SearchScope` type and extend props.**
  After the existing `type SessionVisibilityFilter = 'all' | 'unread' | 'read'` line, add:
  ```tsx
  type SearchScope = 'current' | 'all'
  ```
  Then extend `SessionListProps` — after the existing `activeAccountMid?: number | null` line, add the search props:
  ```tsx
    // Search
    searchResults: SearchQueryResult | null
    searchLoading: boolean
    backfillStatus: BackfillStatus | null
    indexEnabled: boolean
    onSearch: (query: string, scope: SearchScope) => void
    onClearSearch: () => void
    onConversationHitClick: (hit: ConversationHit) => void
    onMessageHitClick: (hit: MessageHit) => void
    onLoadMoreMessageHits: (query: string, scope: SearchScope, offset: number) => void
    onOpenSettings: () => void
  ```

- [ ] **Step 3: Destructure the new props.**
  In the `SessionList({ ... })` destructuring, after `activeAccountMid,` add:
  ```tsx
    searchResults,
    searchLoading,
    backfillStatus,
    indexEnabled,
    onSearch,
    onClearSearch,
    onConversationHitClick,
    onMessageHitClick,
    onLoadMoreMessageHits,
    onOpenSettings,
  ```

- [ ] **Step 4: Add scope state, derive search-mode flag, and fire searches.**
  After the existing `const [visibilityFilter, setVisibilityFilter] = useState<SessionVisibilityFilter>('all')` line, add:
  ```tsx
    const [searchScope, setSearchScope] = useState<SearchScope>('all')

    const trimmedFilter = filterText.trim()
    const isSearching = trimmedFilter.length > 0

    // Drive the FTS search whenever the query or scope changes; clear when emptied.
    // biome-ignore lint/correctness/useExhaustiveDependencies: onSearch/onClearSearch are stable callbacks
    useEffect(() => {
      if (trimmedFilter.length > 0) {
        onSearch(trimmedFilter, searchScope)
      } else {
        onClearSearch()
      }
    }, [trimmedFilter, searchScope])
  ```

- [ ] **Step 5: Repurpose the count badge to `会话 N · 消息 M`.**
  Replace the existing badge text expression (read above at ~:151):
  ```tsx
                {isFiltering ? `${filteredSessions.length} / ${sessions.length}` : `${sessions.length}`}
  ```
  with:
  ```tsx
                {isSearching
                  ? `会话 ${searchResults?.conversationHits.length ?? 0} · 消息 ${searchResults?.messageHits.length ?? 0}`
                  : isFiltering
                    ? `${filteredSessions.length} / ${sessions.length}`
                    : `${sessions.length}`}
  ```

- [ ] **Step 6: Add the 搜索范围 radio group to the settings menu.**
  In the `<MenuPopup align='end'>`, after the existing `显示会话` `MenuGroup` (which closes before `</MenuPopup>`), insert a separator + the scope group:
  ```tsx
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>搜索范围</MenuGroupLabel>
                <MenuRadioGroup value={searchScope} onValueChange={value => setSearchScope(value as SearchScope)}>
                  <MenuRadioItem value='current'>当前会话</MenuRadioItem>
                  <MenuRadioItem value='all'>全部会话</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
  ```

- [ ] **Step 7: Swap the body to render SearchResults while searching.**
  Replace the body conditional block (the `loading ? ... : filteredSessions.length === 0 ? ... : <Virtuoso .../>` region, read above at ~:191-221) with a version that branches on `isSearching`:
  ```tsx
        {loading ? (
          <div className='flex-1 overflow-hidden'>
            <SessionListSkeleton />
          </div>
        ) : isSearching ? (
          <SearchResults
            results={searchResults}
            loading={searchLoading}
            userCache={userCache}
            selectedTalkerId={selectedSession?.talker_id ?? null}
            indexEnabled={indexEnabled}
            backfillRunning={backfillStatus?.state === 'running'}
            backfillProgress={
              backfillStatus && backfillStatus.totalConversations > 0
                ? backfillStatus.processedConversations / backfillStatus.totalConversations
                : 0
            }
            onConversationClick={onConversationHitClick}
            onMessageClick={onMessageHitClick}
            onLoadMoreMessages={() =>
              onLoadMoreMessageHits(trimmedFilter, searchScope, searchResults?.messageHits.length ?? 0)
            }
            onOpenSettings={onOpenSettings}
          />
        ) : filteredSessions.length === 0 ? (
          <div className='flex-1 overflow-hidden'>{isFiltering ? <SessionListNoResults /> : <SessionListEmpty />}</div>
        ) : (
          <Virtuoso
            className='flex-1'
            data={filteredSessions}
            endReached={handleEndReached}
            overscan={20}
            itemContent={(_, session) => (
              <SessionItem
                session={session}
                isSelected={selectedSession?.talker_id === session.talker_id}
                userCache={userCache}
                onClick={() => onSessionClick(session)}
              />
            )}
            components={{
              Scroller: CustomScroller,
              Footer: () =>
                hasMoreSessions && !isFiltering ? (
                  <div className='flex items-center justify-center p-4'>
                    <Loader2 className='size-5 animate-spin text-muted-foreground' aria-hidden='true' />
                  </div>
                ) : null,
            }}
          />
        )}
  ```

- [ ] **Step 8: Lint + typecheck.**
  Run `pnpm lint` then `pnpm exec tsc --noEmit`. Expected: `SessionList.tsx` compiles; the only acceptable remaining errors are the `App.tsx` call site not yet passing the new required props (fixed in the next task) and the cross-task `@/api/search-index` export until the main module lands.

- [ ] **Step 9: Commit.**
  ```bash
  git add src/components/comet/SessionList.tsx
  git commit -m "feat(search): add scope toggle and SearchResults to SessionList"
  ```

### Task 55: Wire search props through App.tsx

**Files:**
- Modify: src/App.tsx:15-56 (hook destructure), 59-60 (settings selectors), 165-209 (SessionList + MessagesPanel props)
- Test: (none — container wiring; verify via typecheck + lint + manual)

Connects the new hook state/actions (`searchResults`, `searchLoading`, `backfillStatus`, `runSearch`, `clearSearch`, `selectSessionAndJump`, `jumpToIndex`, `highlightedSeqno`) and the `fullTextIndexEnabled` setting through to `SessionList` and `MessagesPanel`. Conversation-hit clicks call `selectSession`; message-hit clicks call `selectSessionAndJump`. The hit's `talkerId`/`sessionType` must resolve to a `BilibiliSession`; when absent from `sessions[]` we synthesize a minimal session object (the hook's `selectSessionAndJump`/notification-nav path tolerates a non-listed conversation, and `fetchMessages` only needs `talker_id`/`session_type`/`max_seqno`).

- [ ] **Step 1: Destructure the new hook values.**
  In the `usePrivateMessages()` destructure, after `userInfo,` add the search/jump values. After the existing `hasMoreSessions,` and `userInfo,` lines, insert:
  ```tsx
      // Search + jump state
      searchResults,
      searchLoading,
      backfillStatus,
      jumpToIndex,
      highlightedSeqno,
  ```
  And in the `// Actions` destructure area, after `selectSession,` add:
  ```tsx
      selectSessionAndJump,
      runSearch,
      clearSearch,
  ```

- [ ] **Step 2: Read the index-enabled setting.**
  After the existing `const openAbout = useSettings(state => state.openAbout)` line, add:
  ```tsx
    const fullTextIndexEnabled = useSettings(state => state.fullTextIndexEnabled)
  ```

- [ ] **Step 3: Add a helper to resolve a hit into a session, plus search handlers.**
  Immediately before the `// Show loading state while checking initial login` block (just before `if (initialLoading) {`), add:
  ```tsx
    // Resolve a search hit's (talkerId, sessionType) to a session object. Falls back
    // to a synthetic minimal session for conversations outside the loaded window.
    const resolveSession = useCallback(
      (talkerId: number, sessionType: number): import('@/types/bilibili').BilibiliSession => {
        const existing = sessions.find(s => s.talker_id === talkerId && s.session_type === sessionType)
        if (existing) return existing
        return {
          talker_id: talkerId,
          session_type: sessionType,
          unread_count: 0,
          last_msg: null,
          session_ts: 0,
          max_seqno: 0,
          is_dnd: 0,
          top_ts: 0,
          is_follow: 0,
        } as import('@/types/bilibili').BilibiliSession
      },
      [sessions]
    )

    const handleSearch = useCallback(
      (query: string, scope: 'current' | 'all') => {
        runSearch({
          query,
          scope,
          talkerId: scope === 'current' ? (selectedSession?.talker_id ?? undefined) : undefined,
          sessionType: scope === 'current' ? (selectedSession?.session_type ?? undefined) : undefined,
          limit: 50,
          offset: 0,
        })
      },
      [runSearch, selectedSession]
    )

    const handleConversationHitClick = useCallback(
      (hit: { talkerId: number; sessionType: number }) => {
        selectSession(resolveSession(hit.talkerId, hit.sessionType))
      },
      [selectSession, resolveSession]
    )

    const handleMessageHitClick = useCallback(
      (hit: { talkerId: number; sessionType: number; msgSeqno: string }) => {
        selectSessionAndJump(resolveSession(hit.talkerId, hit.sessionType), Number(hit.msgSeqno))
      },
      [selectSessionAndJump, resolveSession]
    )

    const handleLoadMoreMessageHits = useCallback(
      (query: string, scope: 'current' | 'all', offset: number) => {
        runSearch({
          query,
          scope,
          talkerId: scope === 'current' ? (selectedSession?.talker_id ?? undefined) : undefined,
          sessionType: scope === 'current' ? (selectedSession?.session_type ?? undefined) : undefined,
          limit: 50,
          offset,
        })
      },
      [runSearch, selectedSession]
    )
  ```

- [ ] **Step 4: Pass the new props to `SessionList`.**
  In the `<SessionList ... />` element, after the existing `onReauthAccount={startReauthAccount}` prop, add:
  ```tsx
                searchResults={searchResults}
                searchLoading={searchLoading}
                backfillStatus={backfillStatus}
                indexEnabled={fullTextIndexEnabled}
                onSearch={handleSearch}
                onClearSearch={clearSearch}
                onConversationHitClick={handleConversationHitClick}
                onMessageHitClick={handleMessageHitClick}
                onLoadMoreMessageHits={handleLoadMoreMessageHits}
                onOpenSettings={openSettings}
  ```

- [ ] **Step 5: Pass jump props to `MessagesPanel`.**
  In the `<MessagesPanel ... />` element, after the existing `onToggleSticky={toggleSticky}` prop, add:
  ```tsx
                jumpToIndex={jumpToIndex}
                highlightedSeqno={highlightedSeqno}
  ```

- [ ] **Step 6: Lint + typecheck.**
  Run `pnpm lint` then `pnpm exec tsc --noEmit`. Expected: `App.tsx` compiles; remaining errors only from `MessagesPanel` not yet accepting `jumpToIndex`/`highlightedSeqno` (next task) and the cross-task `@/api/search-index`/preload `search` namespace until those land.

- [ ] **Step 7: Commit.**
  ```bash
  git add src/App.tsx
  git commit -m "feat(search): wire search and jump props through App"
  ```

### Task 56: Add computeItemKey, jump, and highlight to MessagesList

**Files:**
- Modify: src/components/comet/MessagesList.tsx:18-26 (props), 29-65 (component + Virtuoso)
- Test: (none — virtualized component; verify via typecheck + lint + manual)

Adds `computeItemKey={(_, m) => m.msg_key ?? m.msg_seqno}` to the message `<Virtuoso>` (read above at ~:39) for stable keys across merges, and threads an optional `highlightedSeqno` through to `MessageBubble` as `isHighlighted`. (`jumpToIndex` is consumed in `MessagesPanel`, which owns the `virtuosoRef`; `MessagesList` only needs the highlight.)

- [ ] **Step 1: Extend `MessagesListProps`.**
  Replace the props interface:
  ```tsx
  export interface MessagesListProps {
    messages: BilibiliMessage[]
    emojiInfoMap: EmojiInfoMap
    session: BilibiliSession
    userCache: UserCache
    userInfo: CheckLoginResult | null
    onRecall?: (msgSeqno: number, msgKeyStr: string) => Promise<{ success: boolean; error?: string }>
    virtuosoRef?: React.Ref<VirtuosoHandle>
    /** Seqno of the message to visually flash after a jump (null when none). */
    highlightedSeqno?: number | null
  }
  ```

- [ ] **Step 2: Accept the prop, add `computeItemKey`, and pass `isHighlighted`.**
  Replace the component body:
  ```tsx
  // Memoized messages list to prevent re-renders when input changes
  export const MessagesList = memo(function MessagesList({
    messages,
    emojiInfoMap,
    session,
    userCache,
    userInfo,
    onRecall,
    virtuosoRef,
    highlightedSeqno,
  }: MessagesListProps) {
    return (
      <Virtuoso
        ref={virtuosoRef}
        className='flex-1'
        data={messages}
        overscan={20}
        initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
        followOutput='smooth'
        computeItemKey={(_, m) => String(m.msg_key ?? m.msg_seqno)}
        itemContent={(_, msg) => (
          <div className='px-4 pb-4'>
            <MessageBubble
              message={msg}
              emojiInfoMap={emojiInfoMap}
              isSent={msg.sender_uid === userInfo?.mid}
              isHighlighted={highlightedSeqno != null && msg.msg_seqno === highlightedSeqno}
              session={session}
              userCache={userCache}
              userInfo={userInfo}
              onRecall={onRecall}
            />
          </div>
        )}
        components={{
          Scroller: CustomScroller,
          Header: () => <div className='pt-4' />,
        }}
      />
    )
  })
  ```

- [ ] **Step 3: Lint + typecheck.**
  Run `pnpm lint` then `pnpm exec tsc --noEmit`. Expected: error only that `MessageBubble` does not yet accept `isHighlighted` (fixed in the MessageBubble task). No other errors from this file.

- [ ] **Step 4: Commit.**
  ```bash
  git add src/components/comet/MessagesList.tsx
  git commit -m "feat(search): add computeItemKey and highlight passthrough to MessagesList"
  ```

### Task 57: Drive scrollToIndex from jumpToIndex in MessagesPanel

**Files:**
- Modify: src/components/comet/MessagesPanel.tsx:14 (imports), 40-72 (panel props), 100-130 (ChatView props), 130-169 (ChatView refs/effects), 332-342 (MessagesList usage)
- Test: (none — imperative scroll; verify via typecheck + lint + manual)

Threads `jumpToIndex`/`highlightedSeqno` from `App.tsx` through `MessagesPanel` → `ChatView`, and imperatively calls `virtuosoRef.current?.scrollToIndex({ index, align: 'center' })` (the ref already exists at ~:132) when `jumpToIndex` changes. The scroll is fired in a microtask and retried once after `rangeChanged`-style settling so variable-height bubbles measure correctly (spec section 13). `highlightedSeqno` is forwarded to `MessagesList`.

- [ ] **Step 1: Ensure `useEffect` is imported.**
  The file already imports `{ useCallback, useEffect, useRef, useState }` (read above at line 14) — no change needed. Confirm by reading line 14 if uncertain.

- [ ] **Step 2: Extend `MessagesPanelProps`.**
  After the existing `onToggleSticky: (session: BilibiliSession, pinned: boolean) => Promise<boolean>` line in `MessagesPanelProps`, add:
  ```tsx
    /** Index of a message to scroll to (from a search jump); null when none. */
    jumpToIndex: number | null
    /** Seqno of the message to flash after a jump; null when none. */
    highlightedSeqno: number | null
  ```

- [ ] **Step 3: Destructure and forward the new props to `ChatView`.**
  In `MessagesPanel({ ... })`, after `onToggleSticky,` add `jumpToIndex,` and `highlightedSeqno,` to the destructure. Then in the `<ChatView ... />` element (inside `selectedSession ? (`), after `onToggleSticky={onToggleSticky}`, add:
  ```tsx
            jumpToIndex={jumpToIndex}
            highlightedSeqno={highlightedSeqno}
  ```

- [ ] **Step 4: Extend `ChatViewProps`.**
  After the existing `onToggleSticky: (session: BilibiliSession, pinned: boolean) => Promise<boolean>` line in `ChatViewProps`, add:
  ```tsx
    jumpToIndex: number | null
    highlightedSeqno: number | null
  ```

- [ ] **Step 5: Destructure in `ChatView` and add the jump effect.**
  In `ChatView({ ... })`, after `onToggleSticky,` add `jumpToIndex,` and `highlightedSeqno,`. Then, immediately after the existing `scrollToBottom` `useCallback` (which ends at ~:169, dep `[messages.length]`), add:
  ```tsx

    // Imperatively scroll to a jumped-to message and retry once after layout settles
    // so variable-height bubbles are measured before the final centering.
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the jump target changes
    useEffect(() => {
      if (jumpToIndex === null) return
      if (jumpToIndex < 0 || jumpToIndex >= messages.length) return

      const scroll = () => {
        virtuosoRef.current?.scrollToIndex({ index: jumpToIndex, align: 'center' })
      }
      // First pass in a microtask, second pass after a short delay for height re-measure.
      const raf = requestAnimationFrame(scroll)
      const retry = setTimeout(scroll, 120)
      return () => {
        cancelAnimationFrame(raf)
        clearTimeout(retry)
      }
    }, [jumpToIndex])
  ```

- [ ] **Step 6: Forward `highlightedSeqno` to `MessagesList`.**
  In the `<MessagesList ... />` usage (read above at ~:333-341), after `onRecall={onRecall}`, add:
  ```tsx
            highlightedSeqno={highlightedSeqno}
  ```

- [ ] **Step 7: Lint + typecheck.**
  Run `pnpm lint` then `pnpm exec tsc --noEmit`. Expected: `MessagesPanel.tsx` compiles; the only remaining error is `MessageBubble` lacking `isHighlighted` until the next task. No other errors from this file.

- [ ] **Step 8: Commit.**
  ```bash
  git add src/components/comet/MessagesPanel.tsx
  git commit -m "feat(search): drive scrollToIndex from jumpToIndex in MessagesPanel"
  ```

### Task 58: Add isHighlighted flash ring to MessageBubble

**Files:**
- Modify: src/components/comet/MessageBubble.tsx:37-45 (props), 1000-1016 (bubble ring className)
- Test: (none — visual prop; verify via typecheck + lint + manual)

Adds an optional `isHighlighted` prop that applies the existing amber ring (read above at ~:1012, currently used for `isRecalledInDevMode`) with a brief flash animation. The bubble's `ContextMenuTrigger render` div already composes ring classes via `cn()`, so we append a highlighted branch there.

- [ ] **Step 1: Add `isHighlighted` to `MessageBubbleProps`.**
  Replace the props interface (read above at ~:37-45):
  ```tsx
  interface MessageBubbleProps {
    message: BilibiliMessage
    emojiInfoMap: EmojiInfoMap
    isSent: boolean
    session: BilibiliSession
    userCache: UserCache
    userInfo: CheckLoginResult | null
    onRecall?: (msgSeqno: number, msgKeyStr: string) => Promise<{ success: boolean; error?: string }>
    /** Flash an amber ring when this message was jumped to from search. */
    isHighlighted?: boolean
  }
  ```

- [ ] **Step 2: Destructure `isHighlighted` in the component signature.**
  Find the `MessageBubble` function's destructured params (the signature destructures `message, emojiInfoMap, isSent, session, userCache, userInfo, onRecall`). Add `isHighlighted` to that list. For example, locate:
  ```tsx
  export function MessageBubble({ message, emojiInfoMap, isSent, session, userCache, userInfo, onRecall }: MessageBubbleProps) {
  ```
  and change it to:
  ```tsx
  export function MessageBubble({
    message,
    emojiInfoMap,
    isSent,
    session,
    userCache,
    userInfo,
    onRecall,
    isHighlighted,
  }: MessageBubbleProps) {
  ```
  (Read the exact existing signature first and match its current single-line/multi-line form before editing.)

- [ ] **Step 3: Apply the highlight ring on the bubble container.**
  In the `ContextMenuTrigger render` div `cn(...)` call (read above at ~:1001-1013), the last argument is `isRecalledInDevMode && 'ring-2 ring-amber-500/50 ring-offset-1'`. Append a highlighted branch after it:
  ```tsx
                  // Show recalled indicator styling in developer mode
                  isRecalledInDevMode && 'ring-2 ring-amber-500/50 ring-offset-1',
                  // Flash an amber ring when jumped to from search
                  isHighlighted && 'animate-pulse ring-2 ring-amber-400 ring-offset-2'
  ```

- [ ] **Step 4: Lint + typecheck.**
  Run `pnpm lint` then `pnpm exec tsc --noEmit`. Expected: no errors from `MessageBubble.tsx`; with this task plus the prior UI tasks merged, the messages-panel jump/highlight chain type-checks end to end (remaining errors only the cross-task `@/api/search-index`/preload `search` namespace until the contract lands).

- [ ] **Step 5: Commit.**
  ```bash
  git add src/components/comet/MessageBubble.tsx
  git commit -m "feat(search): add isHighlighted flash ring to MessageBubble"
  ```

### Task 59: Add index-management section to SettingsDialog

**Files:**
- Modify: src/components/comet/SettingsDialog.tsx:1-30 (imports), 86-93 (props + useSettings), 150-202 (sections JSX)
- Test: (none — settings UI; verify via typecheck + lint + manual)

Adds the `索引全部历史消息` section (spec section 14): a master `Switch` bound to `fullTextIndexEnabled`, a `Progress` bar bound to backfill status, a `暂停/继续` button + state pill with `Spinner`, `最后更新`/`占用空间` from `search.stats`, and a `清除索引` `AlertDialog`. Backfill status comes in as a prop (the hook owns it via the progress listener); `search.backfillStart/Pause/Resume/Clear/stats` are called directly on `window.electronAPI.search` (preload bridge, locked contract). `IndexStats`/`BackfillStatus` types come from `@/api/search-index`.

- [ ] **Step 1: Add imports for the new UI pieces and types.**
  Add to the imports: `useCallback` already imported; add `useState` is already imported. Add the icons, AlertDialog parts, Button, Progress parts, Spinner, and the types. After the existing `import { Switch } from '@/components/ui/switch'` line, the import block becomes (insert these grouped imports; Biome will sort):
  ```tsx
  import { Check, Database, GripVertical, Pause, Play, Trash2 } from 'lucide-react'
  ```
  (replace the existing `import { Check, GripVertical } from 'lucide-react'` line with the above), and add after the `Switch` import:
  ```tsx
  import {
    AlertDialog,
    AlertDialogClose,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogPopup,
    AlertDialogTitle,
    AlertDialogTrigger,
  } from '@/components/ui/alert-dialog'
  import { Button } from '@/components/ui/button'
  import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress'
  import { Spinner } from '@/components/ui/spinner'
  ```
  And add the type import alongside the existing `import type { StoredAccountInfo } from '@/types/electron'`:
  ```tsx
  import type { BackfillStatus, IndexStats } from '@/api/search-index'
  ```

- [ ] **Step 2: Extend props and read the index setting.**
  Replace the `SettingsDialogProps` interface and the `useSettings` destructure. New props:
  ```tsx
  interface SettingsDialogProps {
    accounts?: StoredAccountInfo[]
    activeAccountMid?: number | null
    onReorderAccounts?: (mids: number[]) => Promise<boolean>
    backfillStatus?: BackfillStatus | null
  }
  ```
  And the component signature + settings hook:
  ```tsx
  export function SettingsDialog({
    accounts = [],
    activeAccountMid,
    onReorderAccounts,
    backfillStatus,
  }: SettingsDialogProps) {
    const {
      developerMode,
      setDeveloperMode,
      fullTextIndexEnabled,
      setFullTextIndexEnabled,
      settingsOpen,
      openSettings,
      closeSettings,
    } = useSettings()
  ```

- [ ] **Step 3: Add index-stats local state + handlers.**
  After the existing `const [localAccounts, setLocalAccounts] = useState(accounts)` line, add:
  ```tsx
    const [indexStats, setIndexStats] = useState<IndexStats | null>(null)

    // Refresh index stats whenever the dialog opens or backfill progresses.
    useEffect(() => {
      if (!settingsOpen) return
      window.electronAPI.search
        .stats({})
        .then(setIndexStats)
        .catch(err => console.error('[SettingsDialog] Failed to load index stats:', err))
    }, [settingsOpen, backfillStatus])

    const handleToggleIndex = useCallback(
      (enabled: boolean) => {
        setFullTextIndexEnabled(enabled)
        if (enabled) {
          window.electronAPI.search.backfillStart({}).catch(err => console.error('[SettingsDialog] backfillStart:', err))
        } else {
          window.electronAPI.search.backfillPause().catch(err => console.error('[SettingsDialog] backfillPause:', err))
        }
      },
      [setFullTextIndexEnabled]
    )

    const handlePauseResume = useCallback(() => {
      if (backfillStatus?.state === 'running') {
        window.electronAPI.search.backfillPause().catch(err => console.error('[SettingsDialog] backfillPause:', err))
      } else {
        window.electronAPI.search.backfillResume().catch(err => console.error('[SettingsDialog] backfillResume:', err))
      }
    }, [backfillStatus])

    const handleClearIndex = useCallback(() => {
      window.electronAPI.search
        .backfillClear({})
        .then(() => window.electronAPI.search.stats({}))
        .then(setIndexStats)
        .catch(err => console.error('[SettingsDialog] backfillClear:', err))
    }, [])
  ```

- [ ] **Step 4: Add small formatting helpers above the component.**
  Immediately before `interface SettingsDialogProps {`, add:
  ```tsx
  function formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
  }

  function backfillStatePill(status: BackfillStatus | null | undefined): { label: string; spinning: boolean } {
    switch (status?.state) {
      case 'running':
        return { label: '索引中…', spinning: true }
      case 'paused':
        return { label: '已暂停', spinning: false }
      case 'done':
        return { label: '已完成', spinning: false }
      case 'error':
        return { label: '索引失败', spinning: false }
      default:
        return { label: '未开始', spinning: false }
    }
  }
  ```

- [ ] **Step 5: Insert the index section into the dialog JSX.**
  Inside the `<div className='space-y-6'>`, after the Developer Settings Section `</div>` (the block that closes just before the wrapping `</div></DialogPanel>`), insert the new section:
  ```tsx
              {/* Full-Text Index Section */}
              <div className='space-y-4'>
                <Separator />
                <div className='flex items-center justify-between gap-4'>
                  <div className='space-y-0.5'>
                    <label htmlFor='full-text-index' className='font-medium text-sm'>
                      索引全部历史消息
                    </label>
                    <p className='text-muted-foreground text-xs'>
                      开启后在本地加密索引全部会话与消息，以便全文搜索。仅搜索已加载/已索引的消息。
                    </p>
                  </div>
                  <Switch id='full-text-index' checked={fullTextIndexEnabled} onCheckedChange={handleToggleIndex} />
                </div>

                {fullTextIndexEnabled && (
                  <div className='space-y-3 rounded-lg border bg-background p-3'>
                    {/* State pill + progress */}
                    <div className='flex items-center justify-between gap-2'>
                      <div className='flex items-center gap-2 text-muted-foreground text-xs'>
                        {(() => {
                          const pill = backfillStatePill(backfillStatus)
                          return (
                            <>
                              {pill.spinning && <Spinner className='size-3.5' aria-hidden='true' />}
                              <span>{pill.label}</span>
                            </>
                          )
                        })()}
                      </div>
                      {(backfillStatus?.state === 'running' || backfillStatus?.state === 'paused') && (
                        <Button variant='ghost' size='sm' onClick={handlePauseResume}>
                          {backfillStatus.state === 'running' ? (
                            <>
                              <Pause className='size-4' aria-hidden='true' />
                              暂停
                            </>
                          ) : (
                            <>
                              <Play className='size-4' aria-hidden='true' />
                              继续
                            </>
                          )}
                        </Button>
                      )}
                    </div>

                    <Progress
                      value={
                        backfillStatus && backfillStatus.totalConversations > 0
                          ? Math.round((backfillStatus.processedConversations / backfillStatus.totalConversations) * 100)
                          : 0
                      }
                    >
                      <ProgressTrack>
                        <ProgressIndicator
                          style={{
                            width: `${
                              backfillStatus && backfillStatus.totalConversations > 0
                                ? Math.round(
                                    (backfillStatus.processedConversations / backfillStatus.totalConversations) * 100
                                  )
                                : 0
                            }%`,
                          }}
                        />
                      </ProgressTrack>
                    </Progress>

                    <p className='text-muted-foreground text-xs'>
                      已索引 {backfillStatus?.processedConversations ?? 0} / {backfillStatus?.totalConversations ?? 0} 个会话
                      · 约 {(backfillStatus?.indexedMessages ?? indexStats?.messageCount ?? 0).toLocaleString('zh-CN')} 条消息
                    </p>

                    {/* Last updated + storage */}
                    <div className='flex items-center gap-4 text-muted-foreground text-xs'>
                      <span className='inline-flex items-center gap-1'>
                        <Database className='size-3.5' aria-hidden='true' />
                        占用 {formatBytes(indexStats?.sizeBytes ?? 0)}
                      </span>
                      <span>
                        最后更新{' '}
                        {indexStats?.lastUpdatedAt
                          ? new Date(indexStats.lastUpdatedAt).toLocaleString('zh-CN')
                          : '—'}
                      </span>
                    </div>

                    {/* Clear index */}
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button variant='outline' size='sm' className='text-destructive'>
                            <Trash2 className='size-4' aria-hidden='true' />
                            清除索引
                          </Button>
                        }
                      />
                      <AlertDialogPopup>
                        <AlertDialogHeader>
                          <AlertDialogTitle>清除索引？</AlertDialogTitle>
                          <AlertDialogDescription>
                            将删除本账号的全部本地搜索索引数据。此操作不可撤销，但可重新开启索引以重建。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogClose render={<Button variant='outline'>取消</Button>} />
                          <AlertDialogClose
                            render={
                              <Button variant='destructive' onClick={handleClearIndex}>
                                清除
                              </Button>
                            }
                          />
                        </AlertDialogFooter>
                      </AlertDialogPopup>
                    </AlertDialog>
                  </div>
                )}
              </div>
  ```

- [ ] **Step 6: Pass `backfillStatus` from App.tsx into SettingsDialog.**
  In `src/App.tsx`, in the `<SettingsDialog ... />` element (read above at ~:188-192), after `onReorderAccounts={reorderAccounts}`, add:
  ```tsx
              backfillStatus={backfillStatus}
  ```

- [ ] **Step 7: Lint + typecheck.**
  Run `pnpm lint` then `pnpm exec tsc --noEmit`. Expected: `SettingsDialog.tsx` + `App.tsx` compile; the only acceptable remaining errors are the cross-task `@/api/search-index` types and the preload `electronAPI.search` namespace until the main/preload contract tasks land. Confirm `useEffect` is imported in `SettingsDialog.tsx` (it already is, line 18).

- [ ] **Step 8: Commit.**
  ```bash
  git add src/components/comet/SettingsDialog.tsx src/App.tsx
  git commit -m "feat(search): add full-text index management section to settings"
  ```

### Task 60: Manual end-to-end verification of search UI

**Files:**
- Test: manual (no automated component test setup in this repo)

Final manual click-through once the main-process, IPC contract, and preload tasks are merged so `window.electronAPI.search.*` resolves at runtime. This validates the renderer wiring: search-as-you-type, scope toggle, jump-to-message scroll+highlight, coverage caveats, and the settings index section.

- [ ] **Step 1: Full typecheck + lint gate.**
  Run `pnpm exec tsc --noEmit` then `pnpm lint`. Expected: both clean (zero errors). If `electronAPI.search` or `@/api/search-index` errors remain, the contract/main/preload tasks are not yet merged — block here until they are.

- [ ] **Step 2: Launch the app.**
  Run `pnpm start`. Expected: app window opens, logs in to the active account, session list renders normally with the count badge showing `N` (total sessions).

- [ ] **Step 3: Verify search-as-you-type + scope.**
  Type a ≥2-char query that exists in a message into the search box. Expected: the session list is replaced by the grouped `会话` / `消息` view; the count badge reads `会话 N · 消息 M`; matched substrings are wrapped in an amber `<mark>` in snippets. Open the settings menu (gear), under `搜索范围` switch between `当前会话` and `全部会话`. Expected: results re-query and narrow/widen accordingly. Clear the box. Expected: the normal session list returns and infinite scroll still works.

- [ ] **Step 4: Verify coverage caveat + off-state CTA.**
  With `fullTextIndexEnabled` OFF (default), perform a search. Expected: the amber `仅搜索已加载/已索引的消息` banner shows atop results, and the `消息` group shows the `开启全文搜索以检索全部历史消息` CTA with a `前往设置` button that opens the settings dialog.

- [ ] **Step 5: Verify jump-to-message.**
  Click a message hit in a long conversation. Expected: the conversation opens (or stays open if already selected), the list scrolls so the target message is centered, and the target bubble flashes an amber ring that clears after ~2s. Click a conversation hit. Expected: the conversation opens at the bottom (newest), no jump.

- [ ] **Step 6: Verify settings index section.**
  Open Settings (`Cmd/Ctrl+,`). Toggle `索引全部历史消息` ON. Expected: the progress card appears with a state pill (`索引中…` + spinner), a determinate `Progress` bar advancing with `已索引 N / M 个会话 · 约 K 条消息`, a working `暂停/继续` button, `占用 …`/`最后更新 …` lines, and a `清除索引` button that opens an `AlertDialog`; confirming clears the index and refreshes the stats. Toggle OFF. Expected: backfill pauses and the card collapses.

- [ ] **Step 7: Commit (verification notes only if any fixes were required).**
  No code change if all checks pass. If a fix was needed, commit it with a focused message, e.g.:
  ```bash
  git add -A
  git commit -m "fix(search): correct <specific issue found during manual verification>"
  ```
