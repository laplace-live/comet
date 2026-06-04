import { createHash, randomUUID } from 'node:crypto'
import { Byte, Encoder } from '@nuintun/qrcode'
import { BrowserWindow, ipcMain, safeStorage } from 'electron'
import Store from 'electron-store'

import type { BackfillStatus, IndexedMessageInput, SearchQueryParams } from '@/api/search-index'
import type {
  BilibiliCredentials,
  BilibiliImageUploadResponse,
  BilibiliMessagesResponse,
  BilibiliNavResponse,
  BilibiliQRCodeGenerateResponse,
  BilibiliQRCodePollResponse,
  BilibiliSendMessageResponse,
  BilibiliSessionsResponse,
  BilibiliUserCardsResponse,
} from '@/types/bilibili'

import { SESSION_TYPE } from '@/types/bilibili'

import { BILIBILI_ENDPOINTS, BILIBILI_HEADERS, COMMON_HEADERS, getImageExtension } from '@/lib/const'
import { IpcChannel, IpcEvent } from '@/lib/ipc'

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

/**
 * Preserve large integer fields as strings in JSON response text.
 * JavaScript's Number type cannot accurately represent integers larger than 2^53 - 1,
 * but Bilibili's msg_key values exceed this limit. This function converts large integer
 * values to strings before JSON parsing to preserve precision.
 *
 * @param responseText - Raw JSON response text
 * @returns Modified JSON text with large msg_key integers converted to strings
 */
function preserveLargeIntegers(responseText: string): string {
  // Match "msg_key": followed by a large integer (15+ digits to be safe)
  // and convert it to a string value
  return responseText.replace(/"msg_key"\s*:\s*(\d{15,})/g, '"msg_key":"$1"')
}

// ============================================================================
// Wbi signing
//
// Bilibili gates certain endpoints (e.g. web_im send_msg) behind a "Wbi"
// signature. The w_* query params must be signed with a `w_rid` (md5) and
// `wts` (timestamp), salted with a mixin key derived from two rotating keys
// (img_key + sub_key) exposed by the nav endpoint. Requests without a valid
// signature get a 412 risk-control HTML block page instead of JSON.
// ============================================================================

// Permutation table used to derive the 32-char mixin key from img_key + sub_key.
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
]

function getMixinKey(rawWbiKey: string): string {
  return MIXIN_KEY_ENC_TAB.map(n => rawWbiKey[n])
    .join('')
    .slice(0, 32)
}

/**
 * Sign a set of params with the Wbi algorithm.
 * Adds `wts`, sorts params alphabetically, builds the query string, then
 * appends `w_rid = md5(query + mixinKey)`.
 *
 * @returns The signed query string (without leading `?`)
 */
function encWbi(params: Record<string, string | number>, imgKey: string, subKey: string, timestampSec: number): string {
  const mixinKey = getMixinKey(imgKey + subKey)
  const signedParams: Record<string, string | number> = { ...params, wts: timestampSec }
  // Bilibili strips these characters from values before signing
  const charFilter = /[!'()*]/g
  const query = Object.keys(signedParams)
    .sort()
    .map(key => {
      const value = String(signedParams[key]).replace(charFilter, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')
  const wRid = createHash('md5')
    .update(query + mixinKey)
    .digest('hex')
  return `${query}&w_rid=${wRid}`
}

// Cached Wbi keys (they rotate, so refresh periodically or on demand).
let wbiKeyCache: { imgKey: string; subKey: string; fetchedAt: number } | null = null
const WBI_KEY_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

/** Extract the key (filename without extension) from a wbi img/sub URL. */
function keyFromWbiUrl(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1, url.lastIndexOf('.'))
}

/**
 * Fetch (and cache) the Wbi img_key/sub_key from the nav endpoint.
 * @param forceRefresh - bypass the cache (used after a 412 to pick up rotated keys)
 */
async function getWbiKeys(
  cookieHeader: string,
  forceRefresh = false
): Promise<{ imgKey: string; subKey: string } | null> {
  if (!forceRefresh && wbiKeyCache && Date.now() - wbiKeyCache.fetchedAt < WBI_KEY_TTL_MS) {
    return { imgKey: wbiKeyCache.imgKey, subKey: wbiKeyCache.subKey }
  }

  try {
    const resp = await fetch(BILIBILI_ENDPOINTS.NAV, {
      headers: { Cookie: cookieHeader, ...COMMON_HEADERS },
    })
    const data: BilibiliNavResponse = await resp.json()
    const wbiImg = data.data?.wbi_img
    if (!wbiImg?.img_url || !wbiImg?.sub_url) {
      return null
    }
    const imgKey = keyFromWbiUrl(wbiImg.img_url)
    const subKey = keyFromWbiUrl(wbiImg.sub_url)
    wbiKeyCache = { imgKey, subKey, fetchedAt: Date.now() }
    return { imgKey, subKey }
  } catch (error) {
    console.error('Failed to fetch Wbi keys:', error)
    return null
  }
}

// Types for multi-account storage
export interface StoredAccountUserInfo {
  mid: number
  uname: string
  face?: string
}

export interface StoredAccount {
  credentials: BilibiliCredentials
  userInfo: StoredAccountUserInfo
  isExpired?: boolean
}

interface AccountsStoreSchema {
  // Encrypted JSON string containing StoredAccount[]
  accounts: string | null
  // The mid of the currently active account
  activeAccountMid: number | null
  // Stable per-account device ids (mid -> uuid), mirrors Bilibili's im_deviceid_<uid>
  deviceIds: Record<string, string>
  // Device fingerprint cookies (buvid3/buvid4) required by gaia risk control
  buvid3: string | null
  buvid4: string | null
}

// Initialize electron-store for persistent storage
// Credentials are encrypted using OS keychain via safeStorage
const store = new Store<AccountsStoreSchema>({
  defaults: {
    accounts: null,
    activeAccountMid: null,
    deviceIds: {},
    buvid3: null,
    buvid4: null,
  },
})

/**
 * Fetch (and cache) buvid3/buvid4 device-fingerprint cookies.
 * Bilibili's gaia risk control gates write endpoints (e.g. send_msg) on these;
 * they are anonymous device IDs from /x/frontend/finger/spi, persisted so the
 * device identity stays stable across sends.
 */
async function getBuvids(): Promise<{ buvid3: string; buvid4: string } | null> {
  const cached3 = store.get('buvid3')
  const cached4 = store.get('buvid4')
  if (cached3 && cached4) {
    return { buvid3: cached3, buvid4: cached4 }
  }

  try {
    const resp = await fetch(BILIBILI_ENDPOINTS.FINGER_SPI, {
      headers: { ...COMMON_HEADERS },
    })
    const data: { code: number; data?: { b_3?: string; b_4?: string } } = await resp.json()
    const b3 = data.data?.b_3
    const b4 = data.data?.b_4
    if (data.code !== 0 || !b3 || !b4) {
      return null
    }
    store.set('buvid3', b3)
    store.set('buvid4', b4)
    return { buvid3: b3, buvid4: b4 }
  } catch (error) {
    console.error('Failed to fetch buvid fingerprint:', error)
    return null
  }
}

/**
 * Get (or lazily create + persist) a stable device id for an account.
 * Bilibili's web client derives dev_id from the sender uid and persists it in
 * localStorage (`im_deviceid_<uid>`); a fresh dev_id on every send looks
 * bot-like and is rejected by risk control, so we persist one per account.
 */
function getOrCreateDevId(mid: number | string): string {
  const key = String(mid)
  const deviceIds = store.get('deviceIds') || {}
  if (deviceIds[key]) {
    return deviceIds[key]
  }
  const devId = randomUUID().toUpperCase()
  store.set('deviceIds', { ...deviceIds, [key]: devId })
  return devId
}

// Helper to encrypt data
function encryptData(data: unknown): string {
  const jsonString = JSON.stringify(data)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(jsonString)
    return encrypted.toString('base64')
  }
  // Fallback to unencrypted storage if safeStorage is not available
  console.warn('safeStorage not available, storing data unencrypted')
  return Buffer.from(jsonString).toString('base64')
}

// Helper to decrypt data
function decryptData<T>(encrypted: string): T | null {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      return JSON.parse(decrypted)
    }
    // Fallback for unencrypted storage
    return JSON.parse(Buffer.from(encrypted, 'base64').toString('utf-8'))
  } catch (error) {
    console.error('Failed to decrypt data:', error)
    return null
  }
}

// Get all stored accounts
function getAccounts(): StoredAccount[] {
  const encrypted = store.get('accounts')
  if (!encrypted) return []

  const accounts = decryptData<StoredAccount[]>(encrypted)
  return accounts || []
}

// Save all accounts (replaces existing)
function saveAccounts(accounts: StoredAccount[]): void {
  if (accounts.length === 0) {
    store.set('accounts', null)
    store.set('activeAccountMid', null)
    return
  }
  store.set('accounts', encryptData(accounts))
}

// Add or update an account
function saveAccount(credentials: BilibiliCredentials, userInfo: StoredAccountUserInfo): void {
  const accounts = getAccounts()
  const existingIndex = accounts.findIndex(a => a.userInfo.mid === userInfo.mid)

  const newAccount: StoredAccount = { credentials, userInfo, isExpired: false }

  if (existingIndex >= 0) {
    // Update existing account - preserve userInfo but update credentials and clear expired
    accounts[existingIndex] = newAccount
  } else {
    // Add new account
    accounts.push(newAccount)
  }

  saveAccounts(accounts)

  // If this is the first account or no active account, set it as active
  const activeAccountMid = store.get('activeAccountMid')
  if (!activeAccountMid || accounts.length === 1) {
    store.set('activeAccountMid', userInfo.mid)
  }
}

// Get the active account's mid
function getActiveAccountMid(): number | null {
  return store.get('activeAccountMid')
}

// Set the active account by mid
function setActiveAccount(mid: number): boolean {
  const accounts = getAccounts()
  const account = accounts.find(a => a.userInfo.mid === mid)
  if (!account) return false

  store.set('activeAccountMid', mid)
  return true
}

// Get credentials for the active account
function getCredentials(): BilibiliCredentials | null {
  const activeAccountMid = getActiveAccountMid()
  if (!activeAccountMid) return null

  const accounts = getAccounts()
  const account = accounts.find(a => a.userInfo.mid === activeAccountMid)
  return account?.credentials || null
}

// Get the active account (credentials + userInfo)
function getActiveAccount(): StoredAccount | null {
  const activeAccountMid = getActiveAccountMid()
  if (!activeAccountMid) return null

  const accounts = getAccounts()
  return accounts.find(a => a.userInfo.mid === activeAccountMid) || null
}

// Remove an account by mid
function removeAccount(mid: number): boolean {
  const accounts = getAccounts()
  const filteredAccounts = accounts.filter(a => a.userInfo.mid !== mid)

  if (filteredAccounts.length === accounts.length) {
    // Account not found
    return false
  }

  saveAccounts(filteredAccounts)

  // If we removed the active account, switch to another one
  const activeAccountMid = getActiveAccountMid()
  if (activeAccountMid === mid) {
    if (filteredAccounts.length > 0) {
      store.set('activeAccountMid', filteredAccounts[0].userInfo.mid)
    } else {
      store.set('activeAccountMid', null)
    }
  }

  return true
}

// Reorder accounts by an array of mids
function reorderAccounts(mids: number[]): boolean {
  const accounts = getAccounts()

  // Create a map for quick lookup
  const accountMap = new Map(accounts.map(a => [a.userInfo.mid, a]))

  // Build reordered list
  const reordered: StoredAccount[] = []
  for (const mid of mids) {
    const account = accountMap.get(mid)
    if (account) {
      reordered.push(account)
      accountMap.delete(mid) // Remove to track any missing
    }
  }

  // Add any remaining accounts that weren't in the mids list (shouldn't happen, but safety)
  for (const account of accountMap.values()) {
    reordered.push(account)
  }

  saveAccounts(reordered)
  return true
}

// Mark an account as expired
function markAccountExpired(mid: number): boolean {
  const accounts = getAccounts()
  const account = accounts.find(a => a.userInfo.mid === mid)
  if (!account) return false

  account.isExpired = true
  saveAccounts(accounts)
  return true
}

// Update credentials for an existing account (re-authentication)
function updateAccountCredentials(mid: number, credentials: BilibiliCredentials): boolean {
  const accounts = getAccounts()
  const account = accounts.find(a => a.userInfo.mid === mid)
  if (!account) return false

  account.credentials = credentials
  account.isExpired = false // Clear expired flag on successful re-auth
  saveAccounts(accounts)
  return true
}

// Clear all accounts (full logout)
function clearAllAccounts(): void {
  store.set('accounts', null)
  store.set('activeAccountMid', null)
}

// Export for use by other modules (like WebSocket)
export { clearAllAccounts, getAccounts, getActiveAccount, getActiveAccountMid, getCredentials }

// Helper function to build cookie string from credentials
export function cookieStringFromCredentials(credentials: BilibiliCredentials): string {
  return [
    `SESSDATA=${encodeURIComponent(credentials.SESSDATA)}`,
    `DedeUserID=${credentials.DedeUserID}`,
    credentials.DedeUserID__ckMd5 ? `DedeUserID__ckMd5=${credentials.DedeUserID__ckMd5}` : '',
    `bili_jct=${credentials.bili_jct}`,
  ]
    .filter(Boolean)
    .join('; ')
}

// Broadcast backfill progress to all renderer windows (mirrors BILIBILI_NEW_MESSAGE fan-out).
// Exported so the search-index backfill loop can push status updates as they happen.
export function broadcastBackfillProgress(status: BackfillStatus): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send(IpcEvent.SEARCH_BACKFILL_PROGRESS, status)
  }
}

export function registerBilibiliIpcHandlers() {
  // Generate QR code for login
  ipcMain.handle(IpcChannel.BILIBILI_QR_GENERATE, async () => {
    try {
      const resp = await fetch(BILIBILI_ENDPOINTS.QR_GENERATE, {
        headers: { ...COMMON_HEADERS },
      })

      const data: BilibiliQRCodeGenerateResponse = await resp.json()

      if (data.code !== 0) {
        return { error: data.message || 'Failed to generate QR code', code: data.code }
      }

      // Generate QR code as data URL
      const encoder = new Encoder({ level: 'H' })
      const qrcode = encoder.encode(new Byte(data.data.url))
      const qrImageUrl = qrcode.toDataURL(4)

      return {
        ...data,
        qrImageUrl,
      }
    } catch (error) {
      console.error('Failed to generate QR code:', error)
      return { error: 'Failed to generate QR code', code: 500 }
    }
  })

  // Poll QR code login status
  // skipSave: when true, don't auto-save the account (used during re-auth to validate first)
  ipcMain.handle(IpcChannel.BILIBILI_QR_POLL, async (_event, params: { qrcodeKey: string; skipSave?: boolean }) => {
    const { qrcodeKey, skipSave } = params

    if (!qrcodeKey) {
      return { error: 'Missing qrcode_key parameter', code: 400 }
    }

    try {
      const url = new URL(BILIBILI_ENDPOINTS.QR_POLL)
      url.searchParams.set('qrcode_key', qrcodeKey)

      const resp = await fetch(url.toString(), {
        headers: { ...COMMON_HEADERS },
      })

      const data: BilibiliQRCodePollResponse = await resp.json()

      // If login successful, extract and store credentials
      if (data.code === 0 && data.data.code === 0 && data.data.url) {
        const urlParams = new URLSearchParams(data.data.url.split('?')[1])

        const credentials: BilibiliCredentials = {
          SESSDATA: decodeURIComponent(urlParams.get('SESSDATA') || ''),
          DedeUserID: Number.parseInt(urlParams.get('DedeUserID') || '0', 10),
          DedeUserID__ckMd5: urlParams.get('DedeUserID__ckMd5') || undefined,
          bili_jct: urlParams.get('bili_jct') || '',
        }

        // Fetch user info to complete the account data
        const cookieHeader = cookieStringFromCredentials(credentials)
        const navResp = await fetch(BILIBILI_ENDPOINTS.NAV, {
          headers: { Cookie: cookieHeader, ...COMMON_HEADERS },
        })
        const navData: BilibiliNavResponse = await navResp.json()

        if (navData.code === 0 && navData.data.isLogin && navData.data.mid) {
          const userInfo: StoredAccountUserInfo = {
            mid: navData.data.mid,
            uname: navData.data.uname || `User ${navData.data.mid}`,
            face: navData.data.face,
          }

          // Store the complete account (credentials + user info)
          // Skip saving if skipSave is true (used during re-auth to validate first)
          if (!skipSave) {
            saveAccount(credentials, userInfo)
          }

          return {
            ...data,
            credentials,
            userInfo,
          }
        }

        // Fallback: save with basic info from credentials
        const fallbackUserInfo: StoredAccountUserInfo = {
          mid: credentials.DedeUserID,
          uname: `User ${credentials.DedeUserID}`,
        }
        // Skip saving if skipSave is true
        if (!skipSave) {
          saveAccount(credentials, fallbackUserInfo)
        }

        return {
          ...data,
          credentials,
          userInfo: fallbackUserInfo,
        }
      }

      return data
    } catch (error) {
      console.error('Failed to poll QR code status:', error)
      return { error: 'Failed to poll QR code status', code: 500 }
    }
  })

  // Get stored credentials
  ipcMain.handle(IpcChannel.BILIBILI_GET_CREDENTIALS, () => {
    return getCredentials()
  })

  // Logout current account (removes only the active account)
  ipcMain.handle(IpcChannel.BILIBILI_LOGOUT, () => {
    const activeAccountMid = getActiveAccountMid()
    if (activeAccountMid) {
      removeAccount(activeAccountMid)
    }
    return { success: true }
  })

  // Check if credentials are valid
  // This function validates the active account and automatically tries the next account if expired
  ipcMain.handle(IpcChannel.BILIBILI_CHECK_LOGIN, async () => {
    // Helper function to check a specific account's credentials
    const checkAccountCredentials = async (
      credentials: BilibiliCredentials
    ): Promise<{ isLogin: boolean; mid?: number; uname?: string; face?: string }> => {
      try {
        const cookieHeader = cookieStringFromCredentials(credentials)

        const resp = await fetch(BILIBILI_ENDPOINTS.NAV, {
          headers: { Cookie: cookieHeader, ...COMMON_HEADERS },
        })

        const data: BilibiliNavResponse = await resp.json()

        if (data.code === 0 && data.data.isLogin) {
          return {
            isLogin: true,
            mid: data.data.mid,
            uname: data.data.uname,
            face: data.data.face,
          }
        }

        return { isLogin: false }
      } catch (error) {
        console.error('Failed to check login status:', error)
        return { isLogin: false }
      }
    }

    const activeAccountMid = getActiveAccountMid()
    const credentials = getCredentials()

    if (!credentials || !activeAccountMid) {
      return { isLogin: false }
    }

    // Check the active account
    const result = await checkAccountCredentials(credentials)

    if (result.isLogin) {
      // Active account is valid - clear any expired flag and update user info (avatar, etc.)
      const accounts = getAccounts()
      const account = accounts.find(a => a.userInfo.mid === activeAccountMid)
      if (account) {
        let needsSave = false

        // Clear expired flag if it was set
        if (account.isExpired) {
          account.isExpired = false
          needsSave = true
        }

        // Update user info if changed (e.g., avatar, username)
        if (result.face && result.face !== account.userInfo.face) {
          account.userInfo.face = result.face
          needsSave = true
        }
        if (result.uname && result.uname !== account.userInfo.uname) {
          account.userInfo.uname = result.uname
          needsSave = true
        }

        if (needsSave) {
          saveAccounts(accounts)
        }
      }
      return result
    }

    // Active account is expired - mark it as expired instead of removing
    markAccountExpired(activeAccountMid)

    // Try to find another non-expired account with valid credentials
    const accounts = getAccounts()
    for (const account of accounts) {
      if (account.userInfo.mid === activeAccountMid) continue // Skip the one we just marked expired
      if (account.isExpired) continue // Skip already-expired accounts

      const accountResult = await checkAccountCredentials(account.credentials)
      if (accountResult.isLogin) {
        // Found a valid account - switch to it and update user info
        setActiveAccount(account.userInfo.mid)

        // Re-fetch accounts to get fresh state (previous markAccountExpired calls may have modified the store)
        const freshAccounts = getAccounts()
        const freshAccount = freshAccounts.find(a => a.userInfo.mid === account.userInfo.mid)

        // Update user info if changed (e.g., avatar, username)
        if (freshAccount) {
          let needsSave = false
          if (accountResult.face && accountResult.face !== freshAccount.userInfo.face) {
            freshAccount.userInfo.face = accountResult.face
            needsSave = true
          }
          if (accountResult.uname && accountResult.uname !== freshAccount.userInfo.uname) {
            freshAccount.userInfo.uname = accountResult.uname
            needsSave = true
          }
          if (needsSave) {
            saveAccounts(freshAccounts)
          }
        }

        return accountResult
      }
      // This account is also expired - mark it
      markAccountExpired(account.userInfo.mid)
    }

    // No valid accounts found - return expired state with the active account mid
    // The frontend can use this to prompt re-authentication
    return { isLogin: false, expiredAccountMid: activeAccountMid }
  })

  // Get all stored accounts (for account switcher UI)
  ipcMain.handle(IpcChannel.BILIBILI_GET_ACCOUNTS, () => {
    const accounts = getAccounts()
    const activeAccountMid = getActiveAccountMid()

    // Return accounts without credentials (only user info for display)
    return {
      accounts: accounts.map(a => ({
        mid: a.userInfo.mid,
        uname: a.userInfo.uname,
        face: a.userInfo.face,
        isExpired: a.isExpired || false,
      })),
      activeAccountMid,
    }
  })

  // Switch to a different account
  ipcMain.handle(IpcChannel.BILIBILI_SET_ACTIVE_ACCOUNT, (_event, params: { mid: number }) => {
    const { mid } = params
    const success = setActiveAccount(mid)
    return { success }
  })

  // Remove an account
  ipcMain.handle(IpcChannel.BILIBILI_REMOVE_ACCOUNT, (_event, params: { mid: number }) => {
    const { mid } = params
    const success = removeAccount(mid)
    const accounts = getAccounts()
    const activeAccountMid = getActiveAccountMid()

    return {
      success,
      remainingAccounts: accounts.map(a => ({
        mid: a.userInfo.mid,
        uname: a.userInfo.uname,
        face: a.userInfo.face,
        isExpired: a.isExpired || false,
      })),
      activeAccountMid,
    }
  })

  // Reorder accounts (for keyboard shortcut ordering)
  ipcMain.handle(IpcChannel.BILIBILI_REORDER_ACCOUNTS, (_event, params: { mids: number[] }) => {
    const { mids } = params
    const success = reorderAccounts(mids)
    const accounts = getAccounts()
    const activeAccountMid = getActiveAccountMid()

    return {
      success,
      accounts: accounts.map(a => ({
        mid: a.userInfo.mid,
        uname: a.userInfo.uname,
        face: a.userInfo.face,
        isExpired: a.isExpired || false,
      })),
      activeAccountMid,
    }
  })

  // Re-authenticate an expired account (update credentials for existing account)
  ipcMain.handle(
    IpcChannel.BILIBILI_REAUTH_ACCOUNT,
    async (_event, params: { mid: number; credentials: BilibiliCredentials }) => {
      const { mid, credentials } = params
      const accounts = getAccounts()
      const account = accounts.find(a => a.userInfo.mid === mid)

      if (!account) {
        return { success: false, error: 'Account not found' }
      }

      // Verify the new credentials are valid
      const cookieHeader = cookieStringFromCredentials(credentials)
      const resp = await fetch(BILIBILI_ENDPOINTS.NAV, {
        headers: { Cookie: cookieHeader, ...COMMON_HEADERS },
      })

      const data: BilibiliNavResponse = await resp.json()

      if (data.code !== 0 || !data.data.isLogin) {
        return { success: false, error: 'Invalid credentials' }
      }

      // Verify the mid matches the expected account
      if (data.data.mid !== mid) {
        return {
          success: false,
          error: 'Credentials are for a different account',
          actualMid: data.data.mid,
        }
      }

      // Update the account credentials
      updateAccountCredentials(mid, credentials)

      return {
        success: true,
        userInfo: {
          mid: data.data.mid,
          uname: data.data.uname,
          face: data.data.face,
        },
      }
    }
  )

  // Fetch sessions (updated to use stored credentials)
  // Note: msg_key values in last_msg are large integers that exceed JavaScript's Number.MAX_SAFE_INTEGER
  // We preserve them as strings by using a custom JSON parsing approach
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

        // Get response as text first, then preserve large integers before parsing
        const responseText = await resp.text()
        const data: BilibiliSessionsResponse = JSON.parse(preserveLargeIntegers(responseText))

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
              if (!lm?.msg_key) continue
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

  // Fetch messages
  // Note: msg_key values are large integers that exceed JavaScript's Number.MAX_SAFE_INTEGER
  // We preserve them as strings by using a custom JSON parsing approach
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
      const { talkerId, sessionType = '1', size = '20', beginSeqno, endSeqno } = params
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

        // Add pagination parameters if provided
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

        // Get response as text first, then preserve large integers before parsing
        const responseText = await resp.text()
        const data: BilibiliMessagesResponse = JSON.parse(preserveLargeIntegers(responseText))

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

  // Fetch user info batch
  ipcMain.handle(
    IpcChannel.BILIBILI_FETCH_USERS,
    async (
      _event,
      params: {
        uids: string
      }
    ) => {
      const { uids } = params
      const credentials = getCredentials()

      if (!credentials) {
        return { error: 'Not logged in. Please scan QR code to login.', code: 401 }
      }

      if (!uids) {
        return { error: 'Missing uids parameter', code: 400 }
      }

      try {
        const cookieHeader = cookieStringFromCredentials(credentials)

        const url = new URL(BILIBILI_ENDPOINTS.USER_INFOS)
        url.searchParams.set('uids', uids)

        const resp = await fetch(url.toString(), {
          headers: {
            Cookie: cookieHeader,
            ...COMMON_HEADERS,
            Referer: BILIBILI_HEADERS.REFERER,
            Origin: BILIBILI_HEADERS.ORIGIN,
          },
        })

        const data: BilibiliUserCardsResponse = await resp.json()

        if (data.code !== 0) {
          return { error: data.message || 'Failed to fetch user info', code: data.code }
        }

        return data
      } catch (error) {
        console.error('Failed to fetch user info:', error)
        return { error: 'Failed to fetch user info from Bilibili', code: 500 }
      }
    }
  )

  // Send message
  ipcMain.handle(
    IpcChannel.BILIBILI_SEND_MESSAGE,
    async (
      _event,
      params: {
        receiverId: string
        receiverType: string
        msgType: string
        content: string
      }
    ) => {
      const { receiverId, receiverType, msgType, content } = params
      const credentials = getCredentials()

      if (!credentials) {
        return { error: 'Not logged in. Please scan QR code to login.', code: 401 }
      }

      if (!receiverId || !receiverType || !msgType || !content) {
        return { error: 'Missing required parameters', code: 400 }
      }

      try {
        // send_msg is gated by gaia risk control, which requires the buvid3/buvid4
        // device-fingerprint cookies in addition to the login credentials.
        const buvids = await getBuvids()
        const cookieHeader = [
          cookieStringFromCredentials(credentials),
          buvids ? `buvid3=${buvids.buvid3}` : '',
          buvids ? `buvid4=${buvids.buvid4}` : '',
        ]
          .filter(Boolean)
          .join('; ')

        // Stable device id for this account (persisted, not regenerated per send)
        const devId = getOrCreateDevId(credentials.DedeUserID)
        const timestamp = Math.floor(Date.now() / 1000)

        // Body params mirror the web client's send_msg request exactly
        const formData = new URLSearchParams()
        formData.append('msg[sender_uid]', String(credentials.DedeUserID))
        formData.append('msg[receiver_type]', receiverType)
        formData.append('msg[receiver_id]', receiverId)
        formData.append('msg[msg_type]', msgType)
        formData.append('msg[msg_status]', '0')
        formData.append('msg[content]', content)
        formData.append('msg[new_face_version]', '0')
        formData.append('msg[canal_token]', '')
        formData.append('msg[dev_id]', devId)
        formData.append('msg[timestamp]', String(timestamp))
        formData.append('from_firework', '0')
        formData.append('build', '0')
        formData.append('mobi_app', 'web')
        formData.append('csrf', credentials.bili_jct)

        // The send_msg endpoint is gated behind Wbi risk control: the w_* query
        // params must be signed with w_rid/wts, otherwise it returns a 412 HTML
        // block page. Sign and POST; if the keys have rotated (412/non-JSON),
        // refresh them once and retry.
        type SendResult =
          | { kind: 'ok'; data: BilibiliSendMessageResponse }
          | { kind: 'blocked'; status: number; snippet?: string }
          | { kind: 'no-keys' }

        const sendOnce = async (forceRefreshKeys: boolean): Promise<SendResult> => {
          const wbiKeys = await getWbiKeys(cookieHeader, forceRefreshKeys)
          if (!wbiKeys) {
            return { kind: 'no-keys' }
          }

          const signedQuery = encWbi(
            {
              w_sender_uid: String(credentials.DedeUserID),
              w_receiver_id: receiverId,
              w_dev_id: devId,
            },
            wbiKeys.imgKey,
            wbiKeys.subKey,
            timestamp
          )

          const resp = await fetch(`${BILIBILI_ENDPOINTS.SEND_MESSAGE}?${signedQuery}`, {
            method: 'POST',
            headers: {
              Cookie: cookieHeader,
              ...COMMON_HEADERS,
              'Content-Type': 'application/x-www-form-urlencoded',
              Referer: BILIBILI_HEADERS.REFERER,
              Origin: BILIBILI_HEADERS.ORIGIN,
            },
            body: formData.toString(),
          })

          // Get response as text first, then preserve large integers before parsing
          const responseText = await resp.text()
          try {
            const data: BilibiliSendMessageResponse = JSON.parse(preserveLargeIntegers(responseText))
            return { kind: 'ok', data }
          } catch {
            // Non-JSON response (risk-control block page)
            // DIAGNOSTIC: surface status + body snippet to the renderer console
            return {
              kind: 'blocked',
              status: resp.status,
              snippet: responseText.replace(/\s+/g, ' ').slice(0, 300),
            }
          }
        }

        let result = await sendOnce(false)
        // Risk-control block: keys may have rotated — refresh and retry once
        if (result.kind === 'blocked') {
          result = await sendOnce(true)
        }

        if (result.kind === 'no-keys') {
          return { error: 'Failed to obtain Wbi signature keys', code: 412 }
        }
        if (result.kind === 'blocked') {
          return {
            error: `[diag] blocked HTTP ${result.status} devId=${devId} body=${result.snippet ?? ''}`,
            code: 412,
          }
        }

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

  // Mark session as read
  ipcMain.handle(
    IpcChannel.BILIBILI_UPDATE_ACK,
    async (
      _event,
      params: {
        talkerId: string
        sessionType: string
        ackSeqno: string
      }
    ) => {
      const { talkerId, sessionType, ackSeqno } = params
      const credentials = getCredentials()

      if (!credentials) {
        return { error: 'Not logged in. Please scan QR code to login.', code: 401 }
      }

      if (!talkerId || !sessionType || !ackSeqno) {
        return { error: 'Missing required parameters', code: 400 }
      }

      try {
        const cookieHeader = cookieStringFromCredentials(credentials)

        const formData = new URLSearchParams()
        formData.append('talker_id', talkerId)
        formData.append('session_type', sessionType)
        formData.append('ack_seqno', ackSeqno)
        formData.append('csrf', credentials.bili_jct)
        formData.append('csrf_token', credentials.bili_jct)
        formData.append('build', '0')
        formData.append('mobi_app', 'web')

        const resp = await fetch(BILIBILI_ENDPOINTS.UPDATE_ACK, {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            ...COMMON_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: BILIBILI_HEADERS.REFERER,
            Origin: BILIBILI_HEADERS.ORIGIN,
          },
          body: formData.toString(),
        })

        const data = await resp.json()

        if (data.code !== 0) {
          return { error: data.message || 'Failed to update ack', code: data.code }
        }

        return data
      } catch (error) {
        console.error('Failed to update ack:', error)
        return { error: 'Failed to update ack', code: 500 }
      }
    }
  )

  // Set Do Not Disturb status for a session
  ipcMain.handle(
    IpcChannel.BILIBILI_SET_DND,
    async (
      _event,
      params: {
        dndUid?: number
        dndGroupId?: number
        sessionType: number
        enabled: boolean
      }
    ) => {
      const { dndUid, dndGroupId, sessionType, enabled } = params
      const credentials = getCredentials()

      if (!credentials) {
        return { success: false, error: 'Not logged in. Please scan QR code to login.' }
      }

      // Validate parameters based on session type
      if (sessionType === SESSION_TYPE.USER && !dndUid) {
        return { success: false, error: 'Missing dndUid for user session' }
      }
      if (sessionType === SESSION_TYPE.FAN_GROUP && !dndGroupId) {
        return { success: false, error: 'Missing dndGroupId for fan group session' }
      }

      try {
        const cookieHeader = cookieStringFromCredentials(credentials)

        const formData = new URLSearchParams()
        formData.append('uid', String(credentials.DedeUserID))
        formData.append('setting', enabled ? '1' : '0')
        if (dndUid) {
          formData.append('dnd_uid', String(dndUid))
        }
        if (dndGroupId) {
          formData.append('dnd_group_id', String(dndGroupId))
        }
        formData.append('csrf', credentials.bili_jct)
        formData.append('csrf_token', credentials.bili_jct)
        formData.append('build', '0')
        formData.append('mobi_app', 'web')

        const resp = await fetch(BILIBILI_ENDPOINTS.SET_DND, {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            ...COMMON_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: BILIBILI_HEADERS.REFERER,
            Origin: BILIBILI_HEADERS.ORIGIN,
          },
          body: formData.toString(),
        })

        const data = await resp.json()

        if (data.code !== 0) {
          return { success: false, error: data.message || 'Failed to set DND status' }
        }

        return { success: true }
      } catch (error) {
        console.error('Failed to set DND status:', error)
        return { success: false, error: 'Failed to set DND status' }
      }
    }
  )

  // Pin/unpin (sticky) a session
  ipcMain.handle(
    IpcChannel.BILIBILI_SET_TOP,
    async (
      _event,
      params: {
        talkerId: number
        sessionType: number
        pinned: boolean
      }
    ) => {
      const { talkerId, sessionType, pinned } = params
      const credentials = getCredentials()

      if (!credentials) {
        return { success: false, error: 'Not logged in. Please scan QR code to login.' }
      }

      try {
        const cookieHeader = cookieStringFromCredentials(credentials)

        const formData = new URLSearchParams()
        formData.append('talker_id', String(talkerId))
        formData.append('session_type', String(sessionType))
        formData.append('op_type', pinned ? '0' : '1') // 0 = pin, 1 = unpin
        formData.append('csrf', credentials.bili_jct)
        formData.append('csrf_token', credentials.bili_jct)
        formData.append('build', '0')
        formData.append('mobi_app', 'web')

        const resp = await fetch(BILIBILI_ENDPOINTS.SET_TOP, {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            ...COMMON_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: BILIBILI_HEADERS.REFERER,
            Origin: BILIBILI_HEADERS.ORIGIN,
          },
          body: formData.toString(),
        })

        const data = await resp.json()

        if (data.code !== 0) {
          return { success: false, error: data.message || 'Failed to set pin status' }
        }

        return { success: true }
      } catch (error) {
        console.error('Failed to set pin status:', error)
        return { success: false, error: 'Failed to set pin status' }
      }
    }
  )

  // Upload image to Bilibili CDN
  ipcMain.handle(
    IpcChannel.BILIBILI_UPLOAD_IMAGE,
    async (
      _event,
      params: {
        imageData: string
        mimeType: string
      }
    ) => {
      const { imageData, mimeType } = params
      const credentials = getCredentials()

      if (!credentials) {
        return { success: false, error: 'Not logged in. Please scan QR code to login.' }
      }

      if (!imageData || !mimeType) {
        return { success: false, error: 'Missing image data or MIME type' }
      }

      try {
        const cookieHeader = cookieStringFromCredentials(credentials)

        // Convert base64 to buffer
        const imageBuffer = Buffer.from(imageData, 'base64')

        // Determine file extension from MIME type
        const ext = getImageExtension(mimeType)
        const filename = `image.${ext}`

        // Create multipart form data
        // Using the built-in FormData from Node.js 18+
        const formData = new FormData()
        const blob = new Blob([imageBuffer], { type: mimeType })
        formData.append('file_up', blob, filename)
        formData.append('category', 'daily')
        formData.append('csrf', credentials.bili_jct)
        formData.append('csrf_token', credentials.bili_jct)

        const resp = await fetch(BILIBILI_ENDPOINTS.UPLOAD_IMAGE, {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            ...COMMON_HEADERS,
            Referer: BILIBILI_HEADERS.REFERER,
            Origin: BILIBILI_HEADERS.ORIGIN,
          },
          body: formData,
        })

        const data: BilibiliImageUploadResponse = await resp.json()

        if (data.code !== 0 || !data.data) {
          return { success: false, error: data.message || 'Failed to upload image' }
        }

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
  ipcMain.handle(IpcChannel.SEARCH_STATS, () => {
    const mid = getActiveAccountMid()
    if (!mid) {
      return { messageCount: 0, conversationCount: 0, sizeBytes: 0, lastUpdatedAt: null }
    }
    return getIndexStats(mid)
  })
}
