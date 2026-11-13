import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, GripVertical, Volume2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { SystemNotificationSoundOption } from '@/lib/notification-sounds'
import type { StoredAccountInfo } from '@/types/electron'

import { LOGIN_CONFIG } from '@/lib/const'
import {
  CUSTOM_NOTIFICATION_SOUNDS,
  getSystemSoundGroupLabel,
  NOTIFICATION_SOUND_CATEGORIES,
  NOTIFICATION_SOUND_DEFAULT,
  NOTIFICATION_SOUND_NONE,
  SYSTEM_SOUND_PREFIX,
} from '@/lib/notification-sounds'
import { previewNotificationSound, stopPreviewPlayback } from '@/lib/sound-player'

import { enforceHttps } from '@/utils/enforceHttps'
import { formatDateShort } from '@/utils/formatTimeWithZone'
import { modifierKey } from '@/utils/platform'
import { timeFromNowGranular } from '@/utils/timeFromNow'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'

import { useSettings } from '@/stores/useSettings'
import { TimeTooltip } from './TimeTooltip'

const REFRESH_CHECK_INTERVAL_HOURS = Math.round(LOGIN_CONFIG.COOKIE_CHECK_INTERVAL / (60 * 60 * 1000))
const TIME_TOOLTIP_CLASS = 'cursor-default text-foreground underline decoration-dotted underline-offset-2'

function formatSessionRemaining(expiresAtSec: number): string {
  const diffSec = expiresAtSec - Math.floor(Date.now() / 1000)
  if (diffSec <= 0) {
    return '已到期'
  }
  if (diffSec >= 86_400) {
    return `${Math.round(diffSec / 86_400)} 天后`
  }
  return timeFromNowGranular(expiresAtSec * 1000)
}

function formatNextCheckTime(nextCheckAtSec: number): string {
  if (nextCheckAtSec <= Math.floor(Date.now() / 1000)) {
    return '即将检查'
  }
  return timeFromNowGranular(nextCheckAtSec * 1000)
}

// Sortable account item for drag-and-drop reordering
interface SortableAccountItemProps {
  account: StoredAccountInfo
  index: number
  activeAccountMid: number | null
}

function SortableAccountItem({ account, index, activeAccountMid }: SortableAccountItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: account.mid })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const isActive = account.mid === activeAccountMid
  const isExpired = account.isExpired
  // 1-9 for first 9 accounts, 0 for 10th account
  const shortcutKey = index < 9 ? index + 1 : index === 9 ? 0 : null

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 rounded-lg border bg-background p-3 ${isDragging ? 'z-50 opacity-90 shadow-lg' : ''}`}
    >
      <button
        type='button'
        className='cursor-grab touch-none text-muted-foreground hover:text-foreground focus:outline-none active:cursor-grabbing'
        {...attributes}
        {...listeners}
      >
        <GripVertical className='size-4' aria-hidden='true' />
      </button>
      <Avatar className={`size-8 ${isExpired ? 'opacity-50' : ''}`}>
        {account.face && <AvatarImage src={enforceHttps(account.face)} alt={account.uname} />}
        <AvatarFallback className='text-sm'>{account.uname.charAt(0)}</AvatarFallback>
      </Avatar>
      <div className='flex flex-1 flex-col items-start overflow-hidden'>
        <span className={`w-full truncate text-sm ${isExpired ? 'text-muted-foreground' : ''}`}>{account.uname}</span>
        {isExpired && <span className='text-xs text-amber-500'>需重新登录</span>}
      </div>
      <div className='flex items-center gap-2'>
        {isActive && <Check className='size-4 text-primary' aria-hidden='true' />}
        {shortcutKey !== null && (
          <kbd className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground'>
            {modifierKey}+{shortcutKey}
          </kbd>
        )}
      </div>
    </div>
  )
}

interface SettingsDialogProps {
  accounts?: StoredAccountInfo[]
  activeAccountMid?: number | null
  onReorderAccounts?: (mids: number[]) => Promise<boolean>
  /** 收起未关注人消息, the signed-in account's setting on Bilibili; null until read */
  unfollowFold?: boolean | null
  onToggleUnfollowFold?: (enabled: boolean) => Promise<boolean>
}

export function SettingsDialog({
  accounts = [],
  activeAccountMid,
  onReorderAccounts,
  unfollowFold = null,
  onToggleUnfollowFold,
}: SettingsDialogProps) {
  const {
    developerMode,
    setDeveloperMode,
    keepChatsOnDevice,
    setKeepChatsOnDevice,
    notificationSounds,
    setNotificationSound,
    settingsOpen,
    openSettings,
    closeSettings,
  } = useSettings()

  const [systemSounds, setSystemSounds] = useState<SystemNotificationSoundOption[] | null>(null)
  const [systemSoundsError, setSystemSoundsError] = useState(false)
  const systemGroupLabel = getSystemSoundGroupLabel(window.electronAPI?.platform)

  useEffect(() => {
    if (!settingsOpen || systemSounds !== null) return
    const listSystemSounds = window.electronAPI?.notificationSounds?.listSystemSounds
    if (!listSystemSounds) {
      setSystemSounds([])
      return
    }
    let cancelled = false
    setSystemSoundsError(false)
    void listSystemSounds()
      .then(items => {
        if (!cancelled) {
          setSystemSoundsError(false)
          setSystemSounds(items)
        }
      })
      .catch(() => {
        if (!cancelled) setSystemSoundsError(true)
      })
    return () => {
      cancelled = true
    }
  }, [settingsOpen, systemSounds])

  useEffect(() => {
    if (!settingsOpen) return
    return () => {
      stopPreviewPlayback()
    }
  }, [settingsOpen])

  const soundItemLabels = useMemo(() => {
    const labels: Record<string, string> = {
      [NOTIFICATION_SOUND_DEFAULT]: '系统默认',
      [NOTIFICATION_SOUND_NONE]: '无（静音）',
    }
    for (const sound of CUSTOM_NOTIFICATION_SOUNDS) {
      labels[sound.id] = sound.label
    }
    if (systemSounds) {
      for (const sound of systemSounds) {
        labels[sound.id] = sound.label
      }
    } else {
      for (const category of NOTIFICATION_SOUND_CATEGORIES) {
        const id = notificationSounds[category.id]
        if (id && !Object.hasOwn(labels, id) && id.startsWith(SYSTEM_SOUND_PREFIX)) {
          labels[id] = id.slice(SYSTEM_SOUND_PREFIX.length).replace(/\.[^.]+$/, '')
        }
      }
    }
    return labels
  }, [systemSounds, notificationSounds])

  // 收起未关注人消息 as the user just set it, while Bilibili saves it
  const [pendingUnfollowFold, setPendingUnfollowFold] = useState<boolean | null>(null)
  const handleUnfollowFoldChange = useCallback(
    async (enabled: boolean) => {
      if (!onToggleUnfollowFold) return
      setPendingUnfollowFold(enabled)
      await onToggleUnfollowFold(enabled)
      setPendingUnfollowFold(null)
    },
    [onToggleUnfollowFold]
  )

  // Local state for accounts during drag (for optimistic update)
  const [localAccounts, setLocalAccounts] = useState(accounts)

  // Sync local accounts with prop when it changes (e.g., after reorder is confirmed)
  useEffect(() => {
    setLocalAccounts(accounts)
  }, [accounts])

  const activeAccount = localAccounts.find(a => a.mid === activeAccountMid) ?? localAccounts[0]
  const [, setClockTick] = useState(0)
  const statusBadge = activeAccount?.isExpired
    ? { variant: 'warning' as const, label: '需重新登录' }
    : activeAccount?.hasRefreshToken
      ? { variant: 'success' as const, label: '自动续期已开启' }
      : { variant: 'secondary' as const, label: '未开启自动续期' }

  // Keep relative expiration and refresh countdown labels live while Settings is open
  useEffect(() => {
    if (!settingsOpen || !activeAccount) return
    let timerId: ReturnType<typeof setTimeout>
    const scheduleTick = () => {
      timerId = setTimeout(() => {
        setClockTick(tick => tick + 1)
        scheduleTick()
      }, 1_000)
    }
    scheduleTick()
    return () => clearTimeout(timerId)
  }, [settingsOpen, activeAccount])

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // Handle drag end for reordering accounts
  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event

      if (over && active.id !== over.id) {
        const oldIndex = localAccounts.findIndex(a => a.mid === active.id)
        const newIndex = localAccounts.findIndex(a => a.mid === over.id)

        if (oldIndex !== -1 && newIndex !== -1) {
          // Save previous state for potential rollback
          const previousAccounts = localAccounts

          // Create new order
          const newAccounts = [...localAccounts]
          const [removed] = newAccounts.splice(oldIndex, 1)
          newAccounts.splice(newIndex, 0, removed)

          // Optimistic update
          setLocalAccounts(newAccounts)

          // Persist the new order and rollback on failure
          if (onReorderAccounts) {
            const success = await onReorderAccounts(newAccounts.map(a => a.mid))
            if (!success) {
              // Rollback to previous state on failure
              setLocalAccounts(previousAccounts)
            }
          }
        }
      }
    },
    [localAccounts, onReorderAccounts]
  )

  return (
    <Dialog open={settingsOpen} onOpenChange={open => (open ? openSettings() : closeSettings())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>应用程序设置</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className='space-y-6'>
            {/* Account Ordering Section */}
            {localAccounts.length > 1 && (
              <div className='space-y-4'>
                <div className='space-y-0.5'>
                  <h3 className='text-sm font-medium'>账号顺序</h3>
                  <p className='text-xs text-muted-foreground'>
                    拖拽调整账号顺序，快捷键将按此顺序分配（{modifierKey}+1 至 {modifierKey}+0）
                  </p>
                </div>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={localAccounts.map(a => a.mid)} strategy={verticalListSortingStrategy}>
                    <div className='space-y-2'>
                      {localAccounts.map((account, index) => (
                        <SortableAccountItem
                          key={account.mid}
                          account={account}
                          index={index}
                          activeAccountMid={activeAccountMid ?? null}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            )}

            {/* Login Session Status Section */}
            {activeAccount && (
              <div className='space-y-4'>
                {localAccounts.length > 1 && <Separator />}
                <div className='space-y-1.5'>
                  <div className='flex items-center justify-between gap-4'>
                    <h3 className='text-sm font-medium'>登录状态</h3>
                    <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
                  </div>
                  <div className='space-y-0.5 text-xs text-muted-foreground'>
                    <p>
                      {activeAccount.isExpired ? (
                        '当前会话已过期，请重新扫码登录'
                      ) : activeAccount.expiresAt ? (
                        <>
                          当前会话将于{' '}
                          <TimeTooltip timestamp={activeAccount.expiresAt} className={TIME_TOOLTIP_CLASS}>
                            {formatDateShort(activeAccount.expiresAt * 1000)}（
                            {formatSessionRemaining(activeAccount.expiresAt)}）
                          </TimeTooltip>{' '}
                          过期
                        </>
                      ) : (
                        '当前登录会话有效'
                      )}
                    </p>
                    {!activeAccount.isExpired && (
                      <p>
                        {activeAccount.hasRefreshToken ? (
                          <>
                            每 {REFRESH_CHECK_INTERVAL_HOURS} 小时检查一次并在需要时自动续期
                            {activeAccount.nextRefreshCheckAt !== undefined && (
                              <>
                                ，下次检查：
                                <TimeTooltip
                                  timestamp={activeAccount.nextRefreshCheckAt}
                                  className={TIME_TOOLTIP_CLASS}
                                >
                                  {formatNextCheckTime(activeAccount.nextRefreshCheckAt)}
                                </TimeTooltip>
                              </>
                            )}
                            {activeAccount.lastRefreshedAt !== undefined && (
                              <>
                                ，上次续期：
                                <TimeTooltip timestamp={activeAccount.lastRefreshedAt} className={TIME_TOOLTIP_CLASS}>
                                  {timeFromNowGranular(activeAccount.lastRefreshedAt * 1000)}
                                </TimeTooltip>
                              </>
                            )}
                          </>
                        ) : (
                          '当前会话缺少刷新凭据，重新登录后可启用自动续期'
                        )}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Message Settings Section */}
            <div className='space-y-4'>
              {activeAccount && <Separator />}
              <div className='flex items-center justify-between gap-4'>
                <div className='space-y-0.5'>
                  <label htmlFor='unfollow-fold' className='text-sm font-medium'>
                    收起未关注人消息
                  </label>
                  <p className='text-xs text-muted-foreground'>
                    开启后，未关注人消息将被折叠起来。与哔哩哔哩同步，仅对当前账号生效
                  </p>
                </div>
                <Switch
                  id='unfollow-fold'
                  checked={pendingUnfollowFold ?? unfollowFold === true}
                  disabled={unfollowFold === null || pendingUnfollowFold !== null}
                  onCheckedChange={handleUnfollowFoldChange}
                />
              </div>
            </div>

            {/* Notification Sounds Section */}
            <div className='space-y-4'>
              <Separator />
              <div className='space-y-0.5'>
                <h3 className='text-sm font-medium'>通知音效</h3>
                <p className='text-xs text-muted-foreground'>
                  为不同类型的通知选择专属提示音（应用处于前台时不会发出通知）
                </p>
                {systemSoundsError && (
                  <p className='text-xs text-muted-foreground'>暂时无法读取系统音效列表，重新打开设置后将自动重试</p>
                )}
              </div>
              <div className='space-y-3'>
                {NOTIFICATION_SOUND_CATEGORIES.map(category => {
                  const selectId = `notification-sound-${category.id}`
                  const descId = `notification-sound-${category.id}-desc`
                  const storedValue = notificationSounds[category.id]
                  const value = Object.hasOwn(soundItemLabels, storedValue) ? storedValue : NOTIFICATION_SOUND_DEFAULT
                  const isMuted = value === NOTIFICATION_SOUND_NONE

                  return (
                    <div key={category.id} className='flex items-center justify-between gap-4'>
                      <div className='min-w-0 space-y-0.5'>
                        <label htmlFor={selectId} className='text-sm font-medium'>
                          {category.label}
                        </label>
                        <p id={descId} className='text-xs text-muted-foreground'>
                          {category.description}
                        </p>
                      </div>
                      <div className='flex shrink-0 items-center gap-1.5'>
                        <Select
                          id={selectId}
                          name={selectId}
                          items={soundItemLabels}
                          value={value}
                          onValueChange={nextValue => {
                            if (!nextValue) return
                            setNotificationSound(category.id, nextValue)
                            void previewNotificationSound(nextValue)
                          }}
                        >
                          <SelectTrigger size='sm' className='w-44' aria-describedby={descId}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup alignItemWithTrigger={false}>
                            <SelectItem value={NOTIFICATION_SOUND_DEFAULT}>系统默认</SelectItem>
                            <SelectItem value={NOTIFICATION_SOUND_NONE}>无（静音）</SelectItem>
                            <SelectSeparator />
                            <SelectGroup>
                              <SelectGroupLabel>内置音效</SelectGroupLabel>
                              {CUSTOM_NOTIFICATION_SOUNDS.map(sound => (
                                <SelectItem key={sound.id} value={sound.id}>
                                  {sound.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                            {systemSounds && systemSounds.length > 0 ? (
                              <>
                                <SelectSeparator />
                                <SelectGroup>
                                  <SelectGroupLabel>{systemGroupLabel}</SelectGroupLabel>
                                  {systemSounds.map(sound => (
                                    <SelectItem key={sound.id} value={sound.id}>
                                      {sound.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </>
                            ) : (
                              systemSounds === null &&
                              storedValue.startsWith(SYSTEM_SOUND_PREFIX) &&
                              Object.hasOwn(soundItemLabels, storedValue) && (
                                <>
                                  <SelectSeparator />
                                  <SelectGroup>
                                    <SelectGroupLabel>{systemGroupLabel}</SelectGroupLabel>
                                    <SelectItem value={storedValue}>{soundItemLabels[storedValue]}</SelectItem>
                                  </SelectGroup>
                                </>
                              )
                            )}
                          </SelectPopup>
                        </Select>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          disabled={isMuted}
                          aria-label={`试听${category.label}提示音`}
                          onClick={() => {
                            void previewNotificationSound(value)
                          }}
                        >
                          <Volume2 className='size-4' aria-hidden='true' />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Storage Section */}
            <div className='space-y-4'>
              <Separator />
              <div className='flex items-center justify-between gap-4'>
                <div className='space-y-0.5'>
                  <label htmlFor='keep-chats-on-device' className='text-sm font-medium'>
                    在本机保留聊天记录
                  </label>
                  <p className='text-xs text-muted-foreground'>
                    加密保存会话列表和打开过的聊天，下次启动时立即显示。关闭后将删除已保存的内容
                  </p>
                </div>
                <Switch id='keep-chats-on-device' checked={keepChatsOnDevice} onCheckedChange={setKeepChatsOnDevice} />
              </div>
            </div>

            {/* Developer Settings Section */}
            <div className='space-y-4'>
              <Separator />
              <div className='flex items-center justify-between gap-4'>
                <div className='space-y-0.5'>
                  <label htmlFor='developer-mode' className='text-sm font-medium'>
                    开发者模式
                  </label>
                  <p className='text-xs text-muted-foreground'>显示消息事件的原始内容，便于调试消息列表</p>
                </div>
                <Switch id='developer-mode' checked={developerMode} onCheckedChange={setDeveloperMode} />
              </div>
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
