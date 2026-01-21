import { Byte, Encoder } from '@nuintun/qrcode'
import { ipcMain, safeStorage } from 'electron'
import Store from 'electron-store'

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

import { BILIBILI_ENDPOINTS, BILIBILI_HEADERS, getImageExtension, USER_AGENT } from '@/lib/const'
import { IpcChannel } from '@/lib/ipc'

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
}

// Initialize electron-store for persistent storage
// Credentials are encrypted using OS keychain via safeStorage
const store = new Store<AccountsStoreSchema>({
  defaults: {
    accounts: null,
    activeAccountMid: null,
  },
})

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
export { getCredentials, getAccounts, getActiveAccount, getActiveAccountMid, clearAllAccounts }

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

export function registerBilibiliIpcHandlers() {
  // Generate QR code for login
  ipcMain.handle(IpcChannel.BILIBILI_QR_GENERATE, async () => {
    try {
      const resp = await fetch(BILIBILI_ENDPOINTS.QR_GENERATE, {
        headers: {
          'User-Agent': USER_AGENT,
        },
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
        headers: {
          'User-Agent': USER_AGENT,
        },
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
          headers: {
            Cookie: cookieHeader,
            'User-Agent': USER_AGENT,
          },
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
          headers: {
            Cookie: cookieHeader,
            'User-Agent': USER_AGENT,
          },
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
      // Active account is valid - clear any expired flag
      const accounts = getAccounts()
      const account = accounts.find(a => a.userInfo.mid === activeAccountMid)
      if (account?.isExpired) {
        account.isExpired = false
        saveAccounts(accounts)
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
        // Found a valid account - switch to it
        setActiveAccount(account.userInfo.mid)
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
        headers: {
          Cookie: cookieHeader,
          'User-Agent': USER_AGENT,
        },
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
            'User-Agent': USER_AGENT,
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
            'User-Agent': USER_AGENT,
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
            'User-Agent': USER_AGENT,
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
        const cookieHeader = cookieStringFromCredentials(credentials)

        // Generate a UUID for dev_id
        const devId = crypto.randomUUID().toUpperCase()
        const timestamp = Math.floor(Date.now() / 1000)

        const formData = new URLSearchParams()
        formData.append('msg[sender_uid]', String(credentials.DedeUserID))
        formData.append('msg[receiver_id]', receiverId)
        formData.append('msg[receiver_type]', receiverType)
        formData.append('msg[msg_type]', msgType)
        formData.append('msg[msg_status]', '0')
        formData.append('msg[dev_id]', devId)
        formData.append('msg[timestamp]', String(timestamp))
        formData.append('msg[new_face_version]', '1')
        formData.append('msg[content]', content)
        formData.append('csrf', credentials.bili_jct)
        formData.append('csrf_token', credentials.bili_jct)
        formData.append('build', '0')
        formData.append('mobi_app', 'web')

        // Build URL with optional Wbi signature params
        const url = new URL(BILIBILI_ENDPOINTS.SEND_MESSAGE)
        url.searchParams.set('w_sender_uid', String(credentials.DedeUserID))
        url.searchParams.set('w_receiver_id', receiverId)
        url.searchParams.set('w_dev_id', devId)

        const resp = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: BILIBILI_HEADERS.REFERER,
            Origin: BILIBILI_HEADERS.ORIGIN,
          },
          body: formData.toString(),
        })

        // Get response as text first, then preserve large integers before parsing
        const responseText = await resp.text()
        const data: BilibiliSendMessageResponse = JSON.parse(preserveLargeIntegers(responseText))

        if (data.code !== 0) {
          return { error: data.message || 'Failed to send message', code: data.code }
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
            'User-Agent': USER_AGENT,
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
            'User-Agent': USER_AGENT,
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
}
