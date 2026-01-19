/**
 * Bilibili Broadcast WebSocket Manager
 * Handles real-time message notifications via WebSocket
 */

import { BrowserWindow, ipcMain } from 'electron'
import type protobuf from 'protobufjs'
import { WebSocket } from 'ws'

import { BILIBILI_ENDPOINTS, BILIBILI_HEADERS, USER_AGENT, WEBSOCKET_CONFIG } from '@/lib/const'

import { cookieStringFromCredentials, getCredentials } from '@/api/bilibili'
import { getMessageType, MessageTypes, TargetPaths } from '@/proto/broadcast'

// Generate UUID v1-like identifier
function generateGuid(): string {
  const s: string[] = []
  const hexDigits = '0123456789ABCDEF'
  for (let i = 0; i < 36; i++) {
    s[i] = hexDigits.charAt(Math.floor(Math.random() * 0x10))
  }
  s[14] = '4' // bits 12-15 of the time_hi_and_version field to 0010
  s[19] = hexDigits.charAt((Number.parseInt(s[19], 16) & 0x3) | 0x8) // bits 6-7 of the clock_seq_hi_and_reserved to 01
  s[8] = s[13] = s[18] = s[23] = '-'
  return s.join('')
}

export interface BroadcastWebSocketConfig {
  onNewMessage?: (data: NewMessageNotification) => void
  onSessionUpdate?: (data: SessionUpdateNotification) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

export interface NewMessageNotification {
  talkerId: number
  sessionType: number
  msgType?: number
  latestSeqno?: number
  instantMsg?: {
    senderUid: number
    receiverType: number
    receiverId: number
    msgType: number
    content: string
    msgSeqno: number
    timestamp: number
    // msgKey is stored as string to preserve precision for large integers
    msgKey: string
  }
}

export interface SessionUpdateNotification {
  type: 'session_list' | 'total_unread' | 'quick_link' | 'fetch_message'
  sessionId?: {
    privateId?: { uid: number }
    groupId?: { groupId: number }
    systemId?: { systemMsgType: number }
  }
}

export class BroadcastWebSocketManager {
  private ws: WebSocket | null = null
  private guid: string
  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private sequence = 1
  private isConnected = false
  private isAuthenticated = false
  private shouldReconnect = true
  private config: BroadcastWebSocketConfig

  constructor(config: BroadcastWebSocketConfig = {}) {
    this.config = config
    this.guid = generateGuid()
  }

  /**
   * Connect to the Bilibili broadcast WebSocket
   */
  async connect(): Promise<void> {
    if (this.ws) {
      this.disconnect()
    }

    this.shouldReconnect = true

    try {
      // Get credentials for authentication cookies
      const credentials = await getCredentials()
      if (!credentials) {
        console.error('[BroadcastWS] No credentials found, cannot connect')
        this.config.onError?.(new Error('Not logged in'))
        return
      }

      const cookieHeader = cookieStringFromCredentials(credentials)
      console.log('[BroadcastWS] Connecting to:', BILIBILI_ENDPOINTS.BROADCAST_WS)

      // Must use "proto" subprotocol - server requires this
      // Include authentication cookies so server knows which user this is
      this.ws = new WebSocket(BILIBILI_ENDPOINTS.BROADCAST_WS, 'proto', {
        headers: {
          Cookie: cookieHeader,
          'User-Agent': USER_AGENT,
          Origin: BILIBILI_HEADERS.ORIGIN,
        },
      })

      this.ws.on('open', () => {
        console.log('[BroadcastWS] Connected')
        this.isConnected = true
        this.sendAuth()
      })

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data)
      })

      this.ws.on('close', (code, reason) => {
        console.log('[BroadcastWS] Disconnected:', code, reason.toString())
        this.cleanup()
        this.config.onDisconnected?.()

        if (this.shouldReconnect) {
          this.scheduleReconnect()
        }
      })

      this.ws.on('error', error => {
        console.error('[BroadcastWS] Error:', error)
        this.config.onError?.(error)
      })
    } catch (error) {
      console.error('[BroadcastWS] Failed to connect:', error)
      this.config.onError?.(error as Error)
      if (this.shouldReconnect) {
        this.scheduleReconnect()
      }
    }
  }

  /**
   * Disconnect from the WebSocket
   */
  disconnect(): void {
    this.shouldReconnect = false
    this.cleanup()

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Check if connected
   */
  getStatus(): { connected: boolean; authenticated: boolean } {
    return {
      connected: this.isConnected,
      authenticated: this.isAuthenticated,
    }
  }

  /**
   * Clean up timers and state
   */
  private cleanup(): void {
    this.isConnected = false
    this.isAuthenticated = false

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    console.log(`[BroadcastWS] Reconnecting in ${WEBSOCKET_CONFIG.RECONNECT_DELAY / 1000}s...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, WEBSOCKET_CONFIG.RECONNECT_DELAY)
  }

  /**
   * Encode body as google.protobuf.Any with proper type_url format
   */
  private encodeAny(
    payload: protobuf.Message,
    type: protobuf.Type,
    typeUrl: string
  ): { type_url: string; value: Uint8Array } {
    // type_url must be in format: "type.googleapis.com/package.MessageType"
    const fullTypeUrl = `type.googleapis.com/${typeUrl}`
    return {
      type_url: fullTypeUrl,
      value: type.encode(payload).finish(),
    }
  }

  /**
   * Send authentication request
   */
  private sendAuth(): void {
    const AuthReq = getMessageType(MessageTypes.AuthReq)
    const BroadcastFrame = getMessageType(MessageTypes.BroadcastFrame)

    // Only send guid - connId and lastMsgId are optional for initial connection
    const authPayload = AuthReq.create({
      guid: this.guid,
    })

    const frame = BroadcastFrame.create({
      options: {
        sequence: this.sequence++,
      },
      targetPath: '/bilibili.broadcast.v1.Broadcast/Auth',
      body: this.encodeAny(authPayload, AuthReq, MessageTypes.AuthReq),
    })

    const frameBytes = BroadcastFrame.encode(frame).finish()
    this.ws?.send(frameBytes)
    console.log('[BroadcastWS] Auth request sent, guid:', this.guid)
  }

  /**
   * Send subscription request
   */
  private sendSubscribe(): void {
    const TargetPath = getMessageType(MessageTypes.TargetPath)
    const BroadcastFrame = getMessageType(MessageTypes.BroadcastFrame)

    // Create TargetPath message with the paths to subscribe
    const targetPathPayload = TargetPath.create({
      targetPaths: [TargetPaths.WatchNotify],
    })

    const frame = BroadcastFrame.create({
      options: {
        sequence: this.sequence++,
      },
      targetPath: '/bilibili.broadcast.v1.Broadcast/Subscribe',
      body: this.encodeAny(targetPathPayload, TargetPath, MessageTypes.TargetPath),
    })

    const frameBytes = BroadcastFrame.encode(frame).finish()
    this.ws?.send(frameBytes)
    console.log('[BroadcastWS] Subscribe request sent for:', TargetPaths.WatchNotify)
  }

  /**
   * Send heartbeat
   */
  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const HeartbeatReq = getMessageType(MessageTypes.HeartbeatReq)
    const BroadcastFrame = getMessageType(MessageTypes.BroadcastFrame)

    const heartbeatPayload = HeartbeatReq.create({})

    const frame = BroadcastFrame.create({
      options: {
        sequence: this.sequence++,
      },
      targetPath: '/bilibili.broadcast.v1.Broadcast/Heartbeat',
      body: this.encodeAny(heartbeatPayload, HeartbeatReq, MessageTypes.HeartbeatReq),
    })

    const frameBytes = BroadcastFrame.encode(frame).finish()
    this.ws.send(frameBytes)
    console.log('[BroadcastWS] Heartbeat sent')
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat()
    }, WEBSOCKET_CONFIG.HEARTBEAT_INTERVAL)
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const buffer = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer)
      const BroadcastFrame = getMessageType(MessageTypes.BroadcastFrame)

      const frame = BroadcastFrame.decode(new Uint8Array(buffer)) as unknown as {
        options?: {
          messageId?: number
          sequence?: number
          isAck?: boolean
          status?: { code?: number; message?: string }
        }
        targetPath?: string
        body?: {
          type_url?: string
          value?: Uint8Array
        }
      }

      const targetPath = frame.targetPath || ''
      const status = frame.options?.status

      // Log all incoming messages for debugging
      console.log('[BroadcastWS] Message received:', {
        targetPath,
        sequence: frame.options?.sequence,
        hasBody: !!frame.body?.value,
        bodyTypeUrl: frame.body?.type_url,
        status: status ? { code: status.code, message: status.message } : undefined,
      })

      // Check for error status
      if (status && status.code !== 0) {
        console.error('[BroadcastWS] Server error:', status.code, status.message)
      }

      // Handle Auth response
      if (targetPath.includes('/Auth')) {
        console.log('[BroadcastWS] Auth response received')
        this.isAuthenticated = true
        this.sendSubscribe()
        this.startHeartbeat()
        this.config.onConnected?.()
        return
      }

      // Handle Heartbeat response
      if (targetPath.includes('/Heartbeat')) {
        // Reduce log spam for heartbeat
        return
      }

      // Handle Subscribe response
      if (targetPath.includes('/Subscribe')) {
        console.log('[BroadcastWS] Subscribe response received, status:', status?.code)
        return
      }

      // Handle WatchNotify - new message notification
      if (targetPath.includes('/WatchNotify') || targetPath.includes('im.Notify')) {
        this.handleNotification(frame)
        return
      }

      console.log('[BroadcastWS] Unhandled message type:', targetPath)
    } catch (error) {
      console.error('[BroadcastWS] Failed to parse message:', error)
    }
  }

  /**
   * Handle notification message
   */
  private handleNotification(frame: {
    body?: {
      type_url?: string
      value?: Uint8Array
    }
  }): void {
    try {
      if (!frame.body?.value) {
        console.log('[BroadcastWS] Notification received (no body)')
        return
      }

      const NotifyRsp = getMessageType(MessageTypes.NotifyRsp)
      const notifyRsp = NotifyRsp.decode(frame.body.value) as unknown as {
        uid?: number
        cmd?: number
        payload?: {
          lastestSeqno?: number
          instantMsg?: {
            senderUid?: number
            receiverType?: number
            receiverId?: number
            msgType?: number
            content?: string
            msgSeqno?: number
            timestamp?: number
            msgKey?: number
          }
          notifyInfo?: {
            msgType?: number
            talkerId?: number
            sessionType?: number
          }
          commandMsgs?: Array<{
            updateTotalUnreadCommand?: Record<string, unknown>
            updateSessionListCommand?: {
              sessionId?: {
                privateId?: { uid?: number }
                groupId?: { groupId?: number }
                systemId?: { systemMsgType?: number }
              }
            }
            updateQuickLinkCommand?: Record<string, unknown>
            fetchMessageCommand?: {
              sessionId?: {
                privateId?: { uid?: number }
                groupId?: { groupId?: number }
                systemId?: { systemMsgType?: number }
              }
            }
          }>
        }
        payloadType?: number
      }

      console.log('[BroadcastWS] NotifyRsp received:', JSON.stringify(notifyRsp, null, 2))

      const payload = notifyRsp.payload
      if (!payload) return

      // Handle instant message notification
      if (payload.instantMsg || payload.notifyInfo) {
        const notifyInfo = payload.notifyInfo
        const instantMsg = payload.instantMsg

        const notification: NewMessageNotification = {
          talkerId: Number(notifyInfo?.talkerId || instantMsg?.senderUid || 0),
          sessionType: Number(notifyInfo?.sessionType || instantMsg?.receiverType || 1),
          msgType: notifyInfo?.msgType,
          latestSeqno: payload.lastestSeqno ? Number(payload.lastestSeqno) : undefined,
          instantMsg: instantMsg
            ? {
                senderUid: Number(instantMsg.senderUid || 0),
                receiverType: Number(instantMsg.receiverType || 1),
                receiverId: Number(instantMsg.receiverId || 0),
                msgType: Number(instantMsg.msgType || 1),
                content: instantMsg.content || '',
                msgSeqno: Number(instantMsg.msgSeqno || 0),
                timestamp: Number(instantMsg.timestamp || 0),
                // Keep msgKey as string to preserve precision for large integers
                msgKey: String(instantMsg.msgKey || ''),
              }
            : undefined,
        }

        this.config.onNewMessage?.(notification)
      }

      // Handle command messages
      if (payload.commandMsgs && payload.commandMsgs.length > 0) {
        for (const cmdMsg of payload.commandMsgs) {
          if (cmdMsg.updateSessionListCommand) {
            this.config.onSessionUpdate?.({
              type: 'session_list',
              sessionId: cmdMsg.updateSessionListCommand.sessionId as SessionUpdateNotification['sessionId'],
            })
          } else if (cmdMsg.updateTotalUnreadCommand) {
            this.config.onSessionUpdate?.({
              type: 'total_unread',
            })
          } else if (cmdMsg.fetchMessageCommand) {
            this.config.onSessionUpdate?.({
              type: 'fetch_message',
              sessionId: cmdMsg.fetchMessageCommand.sessionId as SessionUpdateNotification['sessionId'],
            })
          } else if (cmdMsg.updateQuickLinkCommand) {
            this.config.onSessionUpdate?.({
              type: 'quick_link',
            })
          }
        }
      }
    } catch (error) {
      console.error('[BroadcastWS] Failed to handle notification:', error)
    }
  }
}

// Singleton instance
let wsManager: BroadcastWebSocketManager | null = null

/**
 * Get or create the WebSocket manager instance
 */
export function getBroadcastWebSocketManager(): BroadcastWebSocketManager | null {
  return wsManager
}

/**
 * Initialize the WebSocket manager and register IPC handlers
 */
export function initBroadcastWebSocket(): void {
  // Handler to connect WebSocket
  ipcMain.handle('bilibili:ws-connect', () => {
    if (!wsManager) {
      wsManager = new BroadcastWebSocketManager({
        onNewMessage: notification => {
          // Send notification to all renderer windows
          const windows = BrowserWindow.getAllWindows()
          for (const win of windows) {
            win.webContents.send('bilibili:new-message', notification)
          }
        },
        onSessionUpdate: notification => {
          const windows = BrowserWindow.getAllWindows()
          for (const win of windows) {
            win.webContents.send('bilibili:session-update', notification)
          }
        },
        onConnected: () => {
          const windows = BrowserWindow.getAllWindows()
          for (const win of windows) {
            win.webContents.send('bilibili:ws-connected')
          }
        },
        onDisconnected: () => {
          const windows = BrowserWindow.getAllWindows()
          for (const win of windows) {
            win.webContents.send('bilibili:ws-disconnected')
          }
        },
        onError: error => {
          console.error('[BroadcastWS] Error:', error)
        },
      })
    }

    wsManager.connect()
    return { success: true }
  })

  // Handler to disconnect WebSocket
  ipcMain.handle('bilibili:ws-disconnect', () => {
    if (wsManager) {
      wsManager.disconnect()
    }
    return { success: true }
  })

  // Handler to get WebSocket status
  ipcMain.handle('bilibili:ws-status', () => {
    if (!wsManager) {
      return { connected: false, authenticated: false }
    }
    return wsManager.getStatus()
  })
}

/**
 * Cleanup WebSocket manager on app quit
 */
export function cleanupBroadcastWebSocket(): void {
  if (wsManager) {
    wsManager.disconnect()
    wsManager = null
  }
}
