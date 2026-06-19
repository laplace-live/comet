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
import { Check, Database, GripVertical, Pause, Play, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { BackfillStatus, IndexStats } from '@/api/search-index'
import type { StoredAccountInfo } from '@/types/electron'

import { enforceHttps } from '@/utils/enforceHttps'
import { modifierKey } from '@/utils/platform'

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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'

import { useSettings } from '@/stores/useSettings'

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
        {isExpired && <span className='text-amber-500 text-xs'>需重新登录</span>}
      </div>
      <div className='flex items-center gap-2'>
        {isActive && <Check className='size-4 text-primary' aria-hidden='true' />}
        {shortcutKey !== null && (
          <kbd className='rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs'>
            {modifierKey}+{shortcutKey}
          </kbd>
        )}
      </div>
    </div>
  )
}

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

interface SettingsDialogProps {
  accounts?: StoredAccountInfo[]
  activeAccountMid?: number | null
  onReorderAccounts?: (mids: number[]) => Promise<boolean>
  backfillStatus?: BackfillStatus | null
}

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

  // Local state for accounts during drag (for optimistic update)
  const [localAccounts, setLocalAccounts] = useState(accounts)
  const [indexStats, setIndexStats] = useState<IndexStats | null>(null)

  // Refresh index stats whenever the dialog opens or backfill progresses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: backfillStatus intentionally re-runs stats as backfill advances
  useEffect(() => {
    if (!settingsOpen) return
    window.electronAPI.search
      .stats()
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
      .then(() => window.electronAPI.search.stats())
      .then(setIndexStats)
      .catch(err => console.error('[SettingsDialog] backfillClear:', err))
  }, [])

  // Sync local accounts with prop when it changes (e.g., after reorder is confirmed)
  useEffect(() => {
    setLocalAccounts(accounts)
  }, [accounts])

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
                  <h3 className='font-medium text-sm'>账号顺序</h3>
                  <p className='text-muted-foreground text-xs'>
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

            {/* Developer Settings Section */}
            <div className='space-y-4'>
              {localAccounts.length > 1 && <Separator />}
              <div className='flex items-center justify-between gap-4'>
                <div className='space-y-0.5'>
                  <label htmlFor='developer-mode' className='font-medium text-sm'>
                    开发者模式
                  </label>
                  <p className='text-muted-foreground text-xs'>显示消息事件的原始内容，便于调试消息列表</p>
                </div>
                <Switch id='developer-mode' checked={developerMode} onCheckedChange={setDeveloperMode} />
              </div>
            </div>

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
                    已索引 {backfillStatus?.processedConversations ?? 0} / {backfillStatus?.totalConversations ?? 0}{' '}
                    个会话 · 约{' '}
                    {(backfillStatus?.indexedMessages ?? indexStats?.messageCount ?? 0).toLocaleString('zh-CN')} 条消息
                  </p>

                  {/* Last updated + storage */}
                  <div className='flex items-center gap-4 text-muted-foreground text-xs'>
                    <span className='inline-flex items-center gap-1'>
                      <Database className='size-3.5' aria-hidden='true' />
                      占用 {formatBytes(indexStats?.sizeBytes ?? 0)}
                    </span>
                    <span>
                      最后更新{' '}
                      {indexStats?.lastUpdatedAt ? new Date(indexStats.lastUpdatedAt).toLocaleString('zh-CN') : '—'}
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
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
