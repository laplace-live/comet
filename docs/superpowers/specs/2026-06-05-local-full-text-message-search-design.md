# Design: Local Encrypted Full-Text Message Search

**Date:** 2026-06-05
**Status:** Approved design — ready for implementation planning
**Scope:** All three phases in one spec (backbone + backfill + jump-to-message polish)

## 1. Problem

Search in [`SessionList.tsx`](../../../src/components/comet/SessionList.tsx) is a pure in-memory filter over the
`sessions[]` array currently loaded via infinite scroll. It matches only username, UID, and each
session's **last-message preview** (`last_msg`). Two failures result:

1. **Un-paged conversations are invisible** — a person further down the list than the user has
   scrolled cannot be found.
2. **Message history is unsearchable** — only the last-message preview is matched, never the
   actual content of older messages inside a conversation.

Bilibili's private-message API has **no server-side search endpoint** — only `get_sessions`
(paginated conversation list) and `fetch_session_msgs` (paginated messages per conversation).
Therefore all search must run client-side over data fetched and stored locally.

## 2. Goals

- Search spans **every conversation** and the **full text of every message**, regardless of scroll
  position or which conversations have been opened.
- Search is **instant** in the common case (queries hit a local index, not the network).
- The local store is **encrypted at rest** (the app is privacy-first).
- Coverage is honest: the UI never implies completeness it doesn't have.
- Multi-account safe: each account's data is fully isolated.

## 3. Non-goals

- No server-side / cloud search (Bilibili exposes none; nothing leaves the device).
- No OCR of image messages — images are indexed by type label only, not pixel content.
- No cross-account global search in v1 (search is scoped to the active account).

## 4. Constraints discovered during research

- **`msg_key` exceeds 2^53** and is preserved as a string by `preserveLargeIntegers()`
  ([`bilibili.ts:32-36`](../../../src/api/bilibili.ts#L32)). It MUST be stored as SQLite `TEXT`.
  `msg_seqno` can be ~15–16 digits — treat seqno cursors as strings/BigInt too.
- The active account `mid` lives **only in the main process** in `electron-store`
  (`getActiveAccountMid()`, [`bilibili.ts:283-285`](../../../src/api/bilibili.ts#L283)). Data
  handlers never receive `mid` as a param — the indexer reads it itself at write time.
- Bilibili **risk control (风控)** is real and stochastic. `-412` is returned as an HTML block page
  (already detected by catching `JSON.parse` failure, [`bilibili.ts:1039-1047`](../../../src/api/bilibili.ts#L1039));
  `-509`/`-799` are "too frequent"; `-101` is "not logged in". Read endpoints authenticate by
  cookie only and do **not** require Wbi signing (only `send_msg` does).
- Electron 42.2.0 → Node 24 → **ABI 134**; no prebuilt native binary exists for the chosen SQLite
  package at this ABI, so it builds **from source** at package time.

## 5. Architecture overview

A single new **main-process** module [`src/api/search-index.ts`](../../../src/api/search-index.ts)
(sibling to `bilibili.ts`) owns the encrypted SQLite database and the FTS5 index. All message data
stays in main, where the API/WebSocket payloads are already decoded and decrypted. The renderer only
sends search queries and backfill-control messages over IPC and renders results.

```
Renderer (search box, results, settings)
        │  IPC: search:query / search:backfill-* / event: search:backfill-progress
        ▼
Main process
  ├─ bilibili.ts handlers ──(fire-and-forget upsert)──┐
  ├─ broadcast-websocket.ts onNewMessage ─────────────┤
  │                                                    ▼
  └─ search-index.ts ──► encrypted SQLite (FTS5 trigram)
        ├─ progressive indexer (side-effect of existing fetches)
        ├─ backfill crawler  (opt-in, throttled, resumable)
        └─ query layer        (bm25-ranked, snippet())
```

The index fills two ways: **progressively** as a side-effect of fetches the app already makes, and
via an opt-in **backfill crawler** for complete retroactive history.

## 6. Storage stack & build configuration

### 6.1 Dependency

- **`better-sqlite3-multiple-ciphers`** `^12.10.0` (in `dependencies`, not dev). It is the only
  option that simultaneously provides on-disk encryption (SQLite3MultipleCiphers / SQLCipher cipher),
  FTS5 + the `trigram` tokenizer, active maintenance, and the synchronous better-sqlite3 API.

### 6.2 ESM + native loading

- The main bundle is ESM (`"type": "module"`, `formats: ['es']`). Add
  `'better-sqlite3-multiple-ciphers'` to `build.rollupOptions.external` in
  [`vite.main.config.ts`](../../../vite.main.config.ts) (alongside the existing `bufferutil`,
  `utf-8-validate`).
- Load it at runtime via `createRequire(import.meta.url)` inside `search-index.ts` — never let Vite
  bundle the `.node` binding.

### 6.3 Packaging

- **Enable `AutoUnpackNativesPlugin` in [`forge.config.ts`](../../../forge.config.ts)** — the plugin
  is installed but currently **absent from the `plugins[]` array**. Without it, `asar: true` builds
  cannot `dlopen` the `.node` and will crash at runtime in packaged builds (dev works because it's
  unpacked). Fallback if needed: `packagerConfig.asar = { unpack: '**/*.node' }`.
- Set `rebuildConfig: { force: true, onlyModules: ['better-sqlite3-multiple-ciphers'] }` so
  `@electron/rebuild` compiles from source for ABI 134. Requires a C/C++ toolchain (Xcode CLT /
  MSVC + Python) on every build/CI machine — **this is a CI prerequisite to call out.**
- The `OnlyLoadAppFromAsar` / integrity fuses are compatible: they govern the JS asar, not the
  unpacked native `.node`.

### 6.4 FTS5 tokenizer

- Use the built-in **`trigram`** tokenizer. The default `unicode61` does not segment Chinese.
- Per the approved trade-off, use **default FTS detail** (positions retained) so `snippet()` can
  return highlighted match offsets. Accept the larger index (~1.5–3× raw text).
- **Hard limitation:** trigram cannot index-match queries shorter than 3 characters. 1–2 char CJK
  queries fall back to a bounded `LIKE '%x%'` scan over a recency-limited window (Phase 3).

### 6.5 Encryption key management

1. First run: `crypto.randomBytes(32)` → hex → SQLCipher raw key via `PRAGMA key = "x'…'"`.
2. Wrap with `safeStorage.encryptString()` (already used at
   [`bilibili.ts:213-237`](../../../src/api/bilibili.ts#L213)); persist the wrapped base64 blob in a
   `userData` file. Never store the raw key.
3. On launch (after `app.whenReady()`): decrypt → open DB → `PRAGMA key` → probe
   `SELECT count(*) FROM sqlite_master` to confirm before use.
4. **Linux degraded mode:** if `safeStorage.isEncryptionAvailable()` is false or the backend is
   `basic_text`, surface a one-time warning that at-rest protection is reduced. (A user-passphrase
   wrapping option is deferred to future work.)
5. **Key loss / decrypt failure:** offer to clear and rebuild the index rather than hard-failing.

## 7. Database schema

All rows scoped by `account_mid`. The indexer reads `getActiveAccountMid()` at write time.

```sql
-- messages: one row per message
CREATE TABLE messages (
  account_mid     INTEGER NOT NULL,
  talker_id       INTEGER NOT NULL,   -- peer uid (USER) or group id (FAN_GROUP)
  session_type    INTEGER NOT NULL,   -- 1 USER / 2 FAN_GROUP
  msg_seqno       TEXT    NOT NULL,   -- ordering key (string/BigInt-safe); drives scroll
  msg_key         TEXT    NOT NULL,   -- globally-unique id, exceeds 2^53 → TEXT
  sender_uid      INTEGER,
  msg_type        INTEGER,            -- MSG_TYPE (const.ts)
  msg_source      INTEGER,            -- MSG_SOURCE (const.ts)
  timestamp       INTEGER,            -- unix seconds
  msg_status      INTEGER,            -- 1 = recalled
  searchable_text TEXT,               -- output of extractSearchableText()
  type_label      TEXT,               -- synthetic label e.g. [图片] [表情] (kept out of FTS ranking)
  raw_json        TEXT,               -- original content for re-render / re-extraction
  PRIMARY KEY (account_mid, talker_id, session_type, msg_key)
);

-- FTS5 over searchable_text only (external-content to avoid double storage)
CREATE VIRTUAL TABLE messages_fts USING fts5(
  searchable_text,
  content='messages', content_rowid='rowid',
  tokenize='trigram'                 -- default detail (positions) for snippet() highlighting
);
-- + triggers to keep messages_fts in sync on insert/update/delete

-- sessions: mirror of session metadata for offline conversation search
CREATE TABLE sessions (
  account_mid   INTEGER NOT NULL,
  talker_id     INTEGER NOT NULL,
  session_type  INTEGER NOT NULL,
  name          TEXT,                -- resolved display name (USER via userCache, group_name for FAN_GROUP)
  group_name    TEXT,
  last_msg_text TEXT,                -- extractSearchableText(last_msg)
  session_ts    TEXT,               -- microsecond ts (string)
  unread_count  INTEGER,
  PRIMARY KEY (account_mid, talker_id, session_type)
);

-- optional: user display names/faces for sender attribution in fan groups
CREATE TABLE users (
  account_mid INTEGER NOT NULL,
  mid         INTEGER NOT NULL,
  name        TEXT,
  face        TEXT,
  PRIMARY KEY (account_mid, mid)
);

-- resumable crawl cursors
CREATE TABLE account_cursors (
  account_mid            INTEGER PRIMARY KEY,
  session_end_ts         TEXT,      -- last session_ts used as end_ts; null = newest
  session_has_more       INTEGER,   -- 0 once get_sessions returned has_more=0
  newest_seen_session_ts TEXT,
  last_full_sweep_at     INTEGER
);

CREATE TABLE conv_cursors (
  account_mid    INTEGER NOT NULL,
  talker_id      INTEGER NOT NULL,
  session_type   INTEGER NOT NULL,
  oldest_seqno   TEXT,              -- min_seqno of last backfill page; next end_seqno
  backfill_done  INTEGER,           -- 1 once has_more=0 (reached genesis)
  newest_seqno   TEXT,              -- high-water mark for forward indexing
  newest_msg_key TEXT,
  last_indexed_at INTEGER,
  total_indexed  INTEGER,
  PRIMARY KEY (account_mid, talker_id, session_type)
);

-- schema_version table for migrations
```

**Indexed-range invariant:** for each conversation the indexed range is the contiguous interval
`[oldest_seqno|genesis, newest_seqno]`. Backfill only extends the lower bound; forward/progressive
only extends the upper bound. The two sweeps meet at the high-water mark and can never desync or
leave a middle gap, as long as each updates its own bound atomically. `msg_key` upsert covers any
boundary race.

## 8. Content extraction — `extractSearchableText(message)`

Mirrors the existing renderer logic ([`message-utils.ts`](../../../src/lib/message-utils.ts) /
[`MessageBubble.tsx:154-173`](../../../src/components/comet/MessageBubble.tsx#L154)) so indexed text
matches what the UI shows. `message.content` is a JSON string (sometimes a plain string) — always
`JSON.parse` in try/catch, falling back to the raw string.

| MSG_TYPE | Value | Searchable text | Extraction |
|---|---|---|---|
| TEXT | 1 | yes | `content.content` (keep `[emoji]` codes as literal text) |
| IMAGE | 2 | label only | `[图片]` |
| REVOKE | 5 | no | technical recall trigger — skip |
| CUSTOM_EMOJI | 6 | label only | `[表情]` |
| SHARE | 7 | yes | `sketch.title‖title`, `sketch.desc_text‖desc`, `source` |
| NOTIFICATION | 10 | yes | `title`, `text`, `modules[].title`, `modules[].detail` |
| VIDEO_PUSH | 11 | yes | `title`, `desc`, `attach_msg` |
| LOTTERY/MINI_PROGRAM/ARTICLE/LIVE_CARD | 13/21/22/27 | best-effort | generic `extractTextContent` precedence |
| SYSTEM_TIP | 18 | yes | **double-encoded** — parse `content.content` again → `[].text` joined |
| AI_GENERATED | 52 | yes | walk `paragraphs[].text.nodes[].raw_text ‖ word.words` |
| FAN_GROUP_SYSTEM | 306 | yes | `content.content` |

Generic fallback precedence: `content → text → title → desc → pure_text → abs_text` (recurse into
nested `content`).

**Rules:** keep `[xxx]` emoji codes as literal text; recalled (`msg_status===1`) messages store
`raw_json` but their content is excluded from `searchable_text` (store the `[已撤回的消息]` label);
image/emoji synthetic labels go in `type_label` so they're filterable but don't dilute real-text
ranking.

## 9. Progressive indexing — four fire-and-forget hooks

Each hook sits right before the existing `return data`, where decoded objects are already in scope.
Every call is wrapped in try/catch so indexing can never break message delivery, and scoped via
`getActiveAccountMid()`.

| Source | Location | Notes |
|---|---|---|
| Sessions list | [`bilibili.ts:813`](../../../src/api/bilibili.ts#L813) | upserts sessions + each `last_msg`. Covers `fetchSessions`, `loadMoreSessions`, `refreshSessionsQuietly` (same channel) |
| **Message history (primary)** | [`bilibili.ts:883`](../../../src/api/bilibili.ts#L883) | `fetchMessages` already auto-loads a conversation's *entire* history (`while(hasMore)`, `size:1000`), so opening any chat fully indexes it |
| Sent messages | [`bilibili.ts:1067`](../../../src/api/bilibili.ts#L1067) | on `code===0`; `senderUid = DedeUserID`; `msgType==='5'` is recall → status update |
| Real-time inbound (WebSocket) | [`broadcast-websocket.ts:543`](../../../src/api/broadcast-websocket.ts#L543) | currently forwards to renderer only — add `upsertMessage` alongside `webContents.send`. Only when `instantMsg` present; after `IGNORED_WS_MSG_TYPES` filter |

This alone makes **forward coverage complete** and indexes everything the user browses.

## 10. Backfill crawler (opt-in, throttled, resumable)

Read-only walk. **Wbi signing not required** on `get_sessions` / `fetch_session_msgs` (cookie auth
only). Still send realistic headers + persisted buvid cookies to lower 风控 odds.

**Pagination:**
- `get_sessions`: `size=100`, walk back via `end_ts = session_ts of last item`, **drop the
  duplicate boundary session** (dedup on `talker_id`), stop on `has_more === 0` or
  `session_list === null`.
- `fetch_session_msgs`: `size=200`, walk back via **exclusive** `end_seqno = min_seqno` of the
  previous page (no overlap), stop on `has_more === 0` / `messages === null`. Empty-history sentinel:
  `min_seqno === 18446744073709551615` & `max_seqno === 0`.

**Throttle policy:**

| Knob | Value |
|---|---|
| Concurrency | 1 (fully serial, never parallelize per account) |
| Base delay | 2–4 s jittered |
| Page sizes | `get_sessions` 100, `fetch_session_msgs` 200 |
| On `-412` | refresh Wbi/buvid, exp backoff `30→60→120→300s`, then pause crawl 30–60 min; persist cursor |
| On `-509`/`-799` | exp backoff `10→30→90s`, then raise base delay to 6–8 s |
| On `-101` | stop, mark account expired, surface re-auth |
| Daily cap | ~3,000–5,000 requests/account in a ≤12h window; 30–60 s pause every ~200 requests |

**Resume rules:** backfill resumes from `oldest_seqno` (exclusive `end_seqno` → no dup/gap); forward
sweep walks the newest page down until reaching `msg_seqno <= newest_seqno`. Idempotent upsert on
`msg_key`. New conversations get a fresh `conv_cursor` with `backfill_done=0`.

**Cost estimate:** heavy user (1,000 conversations × ~200 msgs ≈ 200k messages) ≈ **~1,010 requests
≈ ~1 hour** at `size=200`.

## 11. Search query layer (main process)

- `search:query({ query, sessionType?, talkerId?, scope, limit, offset })` returns
  `{ conversationHits[], messageHits[], total }`.
- Conversation hits: match `sessions.name` / `talker_id` / `last_msg_text`.
- Message hits: FTS5 `MATCH` on `messages_fts`, ranked by `bm25(messages_fts)`, with
  `snippet(messages_fts, 0, '<b>', '</b>', '…', 32)` returning a ~32-token window with matches
  wrapped in the given markers (use a sentinel pair the renderer maps to `<mark>`; pick markers
  that never occur in user text). Returns `talker_id`, `session_type`, `msg_seqno`, `timestamp`,
  `sender_uid`, `type_label`, and the marked snippet.
- All queries filtered by active `account_mid`.
- 1–2 char CJK queries: bounded `LIKE` fallback over a recency-limited window (Phase 3).
- `LIMIT 50 OFFSET …` for message hits; conversation hits capped ~20.

## 12. IPC contract additions

Edit all three contract locations per CLAUDE.md ([`ipc.ts`](../../../src/lib/ipc.ts) →
handler in `registerBilibiliIpcHandlers()` → [`preload.ts`](../../../src/preload.ts) →
[`electron.d.ts`](../../../src/types/electron.d.ts)):

```
// Invoke (IpcChannel)
SEARCH_QUERY:           'search:query'
SEARCH_BACKFILL_START:  'search:backfill-start'
SEARCH_BACKFILL_PAUSE:  'search:backfill-pause'
SEARCH_BACKFILL_RESUME: 'search:backfill-resume'
SEARCH_BACKFILL_STATUS: 'search:backfill-status'
SEARCH_BACKFILL_CLEAR:  'search:backfill-clear'
SEARCH_STATS:           'search:stats'

// Event (IpcEvent, main → renderer; mirrors BILIBILI_NEW_MESSAGE)
SEARCH_BACKFILL_PROGRESS: 'search:backfill-progress'
```

Each invoke channel needs a `{ params; result }` entry in `IpcInvokeContract`; the event needs a
payload type in `IpcEventContract`, or TypeScript won't compile the preload/handler.

Clearing an account's partition also hooks into `removeAccount`
([`bilibili.ts:317-339`](../../../src/api/bilibili.ts#L317)) and `clearAllAccounts`.

## 13. Search UX (renderer)

**Grouped results in the left pane** — not a separate view, not a command palette (the command
palette can't show the conversation in the right pane while browsing, and caps height badly).

- When the existing search box ([`SessionList.tsx:141`](../../../src/components/comet/SessionList.tsx#L141))
  is non-empty, **replace** the `<Virtuoso data={filteredSessions}>` block with a `<SearchResults>`
  component holding two virtualized sections: **会话 (Conversations)** and **消息 (Messages)**. When
  empty, the normal session list (and its infinite scroll) is unchanged.
- Add a `搜索范围: 当前会话 / 全部会话` radio group modeled on the existing visibility
  `MenuRadioGroup` ([`SessionList.tsx:177-184`](../../../src/components/comet/SessionList.tsx#L177)).
  `visibilityFilter` applies to the Conversations group only.
- Repurpose the count badge ([`:151`](../../../src/components/comet/SessionList.tsx#L151)) to
  `会话 N · 消息 M`.
- **`SearchResultRow`** modeled on `SessionItem` (NOT the heavy `MessageBubble`): small avatar +
  name + `VerifiedBadge` + `formatTime` + a `line-clamp-2` snippet. Renderer splits the snippet on
  the sentinel delimiter and wraps matches in `<mark>` (`bg-amber-100 dark:bg-amber-900/30`), reusing
  the split-map technique at [`MessageBubble.tsx:176-227`](../../../src/components/comet/MessageBubble.tsx#L176).
  Non-text hits show a type icon + `type_label` instead of a snippet.

**Jump-to-message:**
- New hook action `selectSessionAndJump(session, msgSeqno)` + `pendingJumpSeqnoRef`, building on
  `selectSession` ([`usePrivateMessages.ts:659-665`](../../../src/hooks/usePrivateMessages.ts#L659))
  and the notification-nav resolution
  ([`:1557-1596`](../../../src/hooks/usePrivateMessages.ts#L1557)) so it works even for conversations
  not in the loaded `sessions[]` window.
- After `fetchMessages` sets the (complete, sorted) array, resolve
  `findIndex(m => m.msg_seqno === target)`, then imperatively
  `virtuosoRef.current?.scrollToIndex({ index, align: 'center' })` via the existing ref
  ([`MessagesPanel.tsx:132,165-168`](../../../src/components/comet/MessagesPanel.tsx#L132)). Fire in a
  microtask / on `rangeChanged` so variable-height bubbles are measured; small re-scroll retry for
  robustness.
- Add `computeItemKey={(_, m) => m.msg_key ?? m.msg_seqno}` to the message `<Virtuoso>`
  ([`MessagesList.tsx:39`](../../../src/components/comet/MessagesList.tsx#L39)) for stable keys.
- Flash the landed message with the existing amber ring
  ([`MessageBubble.tsx:1012`](../../../src/components/comet/MessageBubble.tsx#L1012)) via a
  `highlightedSeqno` cleared on a ~2 s timeout.
- Edge cases: already-selected session → skip refetch, just scroll+highlight; seqno not found
  (recalled/aged out) → scroll to nearest by timestamp + toast.

**Perf:** 200–250 ms debounce on the message FTS IPC query (the local conversation filter stays
instant/undebounced); ≥2-char minimum; top-50 ranked, `endReached` pagination
([`SessionList.tsx:201`](../../../src/components/comet/SessionList.tsx#L201)); stale-response
request-id guard like
[`fetchMessagesQuietly`](../../../src/hooks/usePrivateMessages.ts#L593).

## 14. Index management & coverage UI

A new section in [`SettingsDialog.tsx`](../../../src/components/comet/SettingsDialog.tsx) (following
the developer-mode block pattern), plus a `fullTextIndexEnabled` flag in
[`useSettings.ts`](../../../src/stores/useSettings.ts) (alongside `developerMode`). Live progress is
ephemeral state from main over the `search:backfill-progress` event (not persisted).

Section `索引全部历史消息`:
- Master switch (`Switch`), **off by default** (privacy-first).
- `Progress` + `ProgressValue` bound to `done/total`, labeled `已索引 N / M 个会话` + `约 K 条消息`.
- `暂停 / 继续` button + state pill (`索引中… / 已暂停 / 已完成 / 索引失败`) with `Spinner`.
- `最后更新` timestamp + `占用空间` storage used (from `search:stats`).
- `清除索引` → `AlertDialog` confirm → `search:backfill-clear`.

**Coverage caveat (trust-critical):**
- In the search results header, when the index is off OR mid-backfill, show
  `仅搜索已加载/已索引的消息`.
- When indexing is **off entirely**, the Messages group shows a CTA empty state
  (`开启全文搜索以检索全部历史消息 →` linking to `openSettings()`) rather than silently returning
  zero hits.
- When **in progress**, a thin determinate `Progress` bar tops the Messages group.

## 15. Error handling & edge cases

- Indexing failures are swallowed (try/catch) and never block message delivery.
- DB open/decrypt failure → offer rebuild; never hard-crash the app.
- `-101` during backfill → stop + flag re-auth (`markAccountExpired`).
- Account removal → purge that `mid`'s partition.
- Recalled messages (`msg_status===1`) → kept as rows, content excluded from FTS.
- Migrations gated by a `schema_version` table.
- Backfill is single-writer; progress events throttled to ~1/sec; writes batched in a transaction
  per conversation, yielding between conversations so the main thread stays responsive.

## 16. Security & privacy

- Encrypted at rest (SQLCipher cipher, key wrapped via `safeStorage`).
- Nothing leaves the device; no telemetry on message content.
- Linux degraded-keychain mode is detected and surfaced, not silently trusted.
- Off by default; the user opts into full-history indexing explicitly.

## 17. Testing strategy

- **Unit:** `extractSearchableText` across every MSG_TYPE (incl. double-encoded SYSTEM_TIP and
  AI_GENERATED node walking, plain-string fallback, recalled exclusion); cursor resume math
  (no-gap/no-dup invariant); throttle/backoff state machine; key wrap/unwrap.
- **Integration:** progressive upsert from mocked fetch responses; backfill crawl over a mocked
  paginated API (incl. `-412`/`-509` injection → backoff); FTS query correctness incl. CJK
  substring, ranking, snippet delimiters; per-account isolation.
- **Manual/E2E:** jump-to-message scroll+highlight on a long conversation; packaged-build native
  load (verifies auto-unpack + rebuild); coverage caveats render correctly across off/in-progress/done.

## 18. Milestones (all in this spec; can merge independently)

- **Phase 1 — Indexed search backbone:** dependency + build config (externals, auto-unpack,
  rebuild); `search-index.ts` (encrypted DB open, schema, migrations, key mgmt);
  `extractSearchableText`; four progressive hooks; `search:query` + query layer; grouped search UI
  (`SearchResults`, `SearchResultRow`, scope toggle); IPC wiring. *Delivers: instant search across
  everything browsed + everything new.*
- **Phase 2 — Backfill:** crawler + cursors + throttle/backoff/resume; backfill IPC + progress
  event; `SettingsDialog` index section + coverage caveats. *Delivers: complete retroactive history.*
- **Phase 3 — Polish:** `selectSessionAndJump` + Virtuoso scroll/highlight + `computeItemKey`; 1–2
  char CJK `LIKE` fallback; storage-management UX. *Delivers: precise navigation to any hit.*

## 19. Open questions / future work

- User-passphrase wrapping as an alternative to `safeStorage` on Linux (or for users wanting an
  app-level lock).
- Upgrade path to `sqlite-better-trigram` if 1–2 char CJK search becomes a priority (drop-in
  tokenizer swap).
- Cross-account unified search (currently scoped to active account).
- Background incremental "trickle" backfill (auto-run a few requests on idle) vs. purely manual.

## 20. File-by-file change map

- **New** `src/api/search-index.ts` — DB, schema, key mgmt, extract, progressive upsert, backfill
  crawler, query layer.
- **New** `src/components/comet/SearchResults.tsx`, `SearchResultRow.tsx`.
- **Edit** `src/api/bilibili.ts` — four upsert hooks (`:813`, `:883`, `:1067`), register search/
  backfill IPC handlers, purge on account removal.
- **Edit** `src/api/broadcast-websocket.ts` — `upsertMessage` in `onNewMessage` (`:543`).
- **Edit** `src/lib/ipc.ts`, `src/preload.ts`, `src/types/electron.d.ts` — IPC contract.
- **Edit** `src/hooks/usePrivateMessages.ts` — `selectSessionAndJump`, `pendingJumpSeqnoRef`,
  `jumpToIndex`/`highlightedSeqno`, FTS query actions, `search:backfill-progress` listener.
- **Edit** `src/components/comet/SessionList.tsx` — scope toggle, swap body for `SearchResults`,
  repurpose count badge.
- **Edit** `src/components/comet/MessagesList.tsx` — `computeItemKey`, optional jump index/highlight.
- **Edit** `src/components/comet/MessagesPanel.tsx` — drive `scrollToIndex` from `jumpToIndex`.
- **Edit** `src/components/comet/MessageBubble.tsx` — accept `isHighlighted`.
- **Edit** `src/components/comet/SettingsDialog.tsx`, `src/stores/useSettings.ts` — index section +
  `fullTextIndexEnabled`.
- **Edit** `vite.main.config.ts` — externals; `forge.config.ts` — `AutoUnpackNativesPlugin` +
  `rebuildConfig`; `package.json` — add dependency.
