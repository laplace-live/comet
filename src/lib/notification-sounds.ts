import { MSG_TYPE, SESSION_TYPE } from '../types/bilibili'

export type NotificationSoundCategory = 'direct' | 'group' | 'system'

export type NotificationSoundId = string

export type NotificationSoundSettings = Record<NotificationSoundCategory, NotificationSoundId>

export const NOTIFICATION_SOUND_DEFAULT = 'default'
export const NOTIFICATION_SOUND_NONE = 'none'
export const CUSTOM_SOUND_PREFIX = 'custom:'
export const SYSTEM_SOUND_PREFIX = 'system:'

export interface CustomNotificationSoundOption {
  id: string
  label: string
  fileName: string
}

export interface SystemNotificationSoundOption {
  id: string
  label: string
}

export const CUSTOM_NOTIFICATION_SOUNDS: readonly CustomNotificationSoundOption[] = [
  {
    id: 'custom:snd-sine-notification',
    label: '正弦 · 清脆',
    fileName: 'snd-sine-notification.wav',
  },
  {
    id: 'custom:snd-sine-toggle-on',
    label: '正弦 · 轻跃',
    fileName: 'snd-sine-toggle-on.wav',
  },
  {
    id: 'custom:snd-sine-transition-up',
    label: '正弦 · 上扬',
    fileName: 'snd-sine-transition-up.wav',
  },
  {
    id: 'custom:snd-sine-caution',
    label: '正弦 · 双脉冲',
    fileName: 'snd-sine-caution.wav',
  },
  {
    id: 'custom:snd-sine-celebration',
    label: '正弦 · 星光',
    fileName: 'snd-sine-celebration.wav',
  },
  {
    id: 'custom:snd-piano-button',
    label: '钢琴 · 清音',
    fileName: 'snd-piano-button.wav',
  },
  {
    id: 'custom:snd-piano-transition-up',
    label: '钢琴 · 上行',
    fileName: 'snd-piano-transition-up.wav',
  },
  {
    id: 'custom:snd-piano-toggle-on',
    label: '钢琴 · 柔和',
    fileName: 'snd-piano-toggle-on.wav',
  },
  {
    id: 'custom:snd-piano-notification',
    label: '钢琴 · 泛音',
    fileName: 'snd-piano-notification.wav',
  },
] as const

export const CUSTOM_NOTIFICATION_SOUND_FILES: readonly string[] = CUSTOM_NOTIFICATION_SOUNDS.map(
  sound => sound.fileName
)

export const DEFAULT_NOTIFICATION_SOUNDS: NotificationSoundSettings = {
  direct: 'custom:snd-sine-notification',
  group: 'custom:snd-sine-toggle-on',
  system: 'custom:snd-sine-transition-up',
}

export interface NotificationSoundCategoryInfo {
  id: NotificationSoundCategory
  label: string
  description: string
}

export const NOTIFICATION_SOUND_CATEGORIES: readonly NotificationSoundCategoryInfo[] = [
  {
    id: 'direct',
    label: '私信消息',
    description: '单人私信聊天的新消息提示音',
  },
  {
    id: 'group',
    label: '粉丝团消息',
    description: '粉丝团群聊的新消息提示音',
  },
  {
    id: 'system',
    label: '系统与其他通知',
    description: '系统通知、客服消息及应用后台提醒',
  },
] as const

export function normalizeNotificationSoundSettings(
  value?: Partial<Record<NotificationSoundCategory, unknown>> | null
): NotificationSoundSettings {
  return {
    direct:
      typeof value?.direct === 'string' && value.direct.length > 0 ? value.direct : DEFAULT_NOTIFICATION_SOUNDS.direct,
    group: typeof value?.group === 'string' && value.group.length > 0 ? value.group : DEFAULT_NOTIFICATION_SOUNDS.group,
    system:
      typeof value?.system === 'string' && value.system.length > 0 ? value.system : DEFAULT_NOTIFICATION_SOUNDS.system,
  }
}

export function getSystemSoundGroupLabel(platform?: string): string {
  if (platform === 'darwin') return 'macOS 系统音效'
  if (platform === 'win32') return 'Windows 系统音效'
  return '系统音效'
}

export const WINDOWS_APP_USER_MODEL_ID = 'live.laplace.comet'

export interface NotificationCategoryInput {
  sessionType: number
  systemMsgType?: number
  msgType?: number
  isCustomerService?: boolean
}

export function getNotificationSoundCategory(input: NotificationCategoryInput): NotificationSoundCategory {
  if (input.isCustomerService) return 'system'
  if (
    (input.systemMsgType ?? 0) > 0 ||
    input.msgType === MSG_TYPE.NOTIFICATION ||
    input.msgType === MSG_TYPE.FAN_GROUP_SYSTEM
  ) {
    return 'system'
  }
  if (input.sessionType === SESSION_TYPE.FAN_GROUP) return 'group'
  return 'direct'
}
