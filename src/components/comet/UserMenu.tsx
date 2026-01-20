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
import { IconBrandDiscordFilled } from '@tabler/icons-react'
import { Check, GripVertical, Info, LogOut, Plus, RefreshCw, Settings, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { CheckLoginResult, StoredAccountInfo } from '@/types/electron'

import { enforceHttps } from '@/utils/enforceHttps'
import { modifierKey } from '@/utils/platform'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from '@/components/ui/menu'
import { Separator } from '@/components/ui/separator'
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

interface UserMenuProps {
  userInfo?: CheckLoginResult | null
  isConnected?: boolean
  accounts?: StoredAccountInfo[]
  activeAccountMid?: number | null
  onLogout?: () => void
  onSwitchAccount?: (mid: number) => void
  onAddAccount?: () => void
  onRemoveAccount?: (mid: number) => void
  onReauthAccount?: (mid: number) => void
  onReorderAccounts?: (mids: number[]) => Promise<boolean>
}

export function UserMenu({
  userInfo,
  isConnected,
  accounts = [],
  activeAccountMid,
  onLogout,
  onSwitchAccount,
  onAddAccount,
  onRemoveAccount,
  onReauthAccount,
  onReorderAccounts,
}: UserMenuProps) {
  const { developerMode, setDeveloperMode, settingsOpen, openSettings, closeSettings, openAbout } = useSettings()

  // Local state for accounts during drag (for optimistic update)
  const [localAccounts, setLocalAccounts] = useState(accounts)

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

  if (!userInfo?.uname) return null

  const hasMultipleAccounts = accounts.length > 1

  return (
    <div className='flex-none border-border/50 border-t p-3'>
      <Menu>
        <MenuTrigger className='flex w-full select-none items-center gap-3 rounded-lg p-2 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring'>
          <Avatar className='size-8'>
            {userInfo.face && <AvatarImage src={enforceHttps(userInfo.face)} alt={userInfo.uname} />}
            <AvatarFallback className='text-sm'>{userInfo.uname.charAt(0)}</AvatarFallback>
          </Avatar>
          <div className='flex flex-1 flex-col items-start overflow-hidden text-left'>
            <span className='w-full truncate font-medium text-sm'>{userInfo.uname}</span>
            {userInfo.mid && <span className='text-muted-foreground text-xs'>UID:{userInfo.mid}</span>}
          </div>
        </MenuTrigger>
        <MenuPopup align='start' side='top' className='min-w-56'>
          {/* Current account info */}
          <MenuGroup>
            <MenuGroupLabel className='flex flex-col items-start gap-2 font-normal'>
              <div className='flex flex-col'>
                <span className='truncate'>{userInfo.uname}</span>
                {userInfo.mid && <span className='text-muted-foreground text-xs'>UID:{userInfo.mid}</span>}
              </div>
              {isConnected && (
                <Badge variant='success' className='gap-1 px-1.5 py-0.5 text-xs'>
                  <span className='size-1.5 animate-pulse rounded-full bg-emerald-500' />
                  已连接
                </Badge>
              )}
            </MenuGroupLabel>
          </MenuGroup>

          {/* Account list for switching */}
          {accounts.length > 0 && (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel className='select-none'>切换账号</MenuGroupLabel>
                {accounts.map((account, index) => {
                  const isActive = account.mid === activeAccountMid
                  const isExpired = account.isExpired
                  // 1-9 for first 9 accounts, 0 for 10th account
                  const shortcutKey = index < 9 ? index + 1 : index === 9 ? 0 : null

                  const handleClick = () => {
                    if (isExpired) {
                      onReauthAccount?.(account.mid)
                    } else if (!isActive) {
                      onSwitchAccount?.(account.mid)
                    }
                  }

                  return (
                    <MenuItem
                      key={account.mid}
                      onClick={handleClick}
                      className={isActive && !isExpired ? 'bg-accent/50' : ''}
                    >
                      <div className='flex w-full items-center gap-1'>
                        <div className='relative'>
                          <Avatar className={`size-6 ${isExpired ? 'opacity-50' : ''}`}>
                            {account.face && <AvatarImage src={enforceHttps(account.face)} alt={account.uname} />}
                            <AvatarFallback className='text-xs'>{account.uname.charAt(0)}</AvatarFallback>
                          </Avatar>
                        </div>
                        <div className='flex flex-1 flex-col items-start overflow-hidden'>
                          <span className={`w-full truncate text-sm ${isExpired ? 'text-muted-foreground' : ''}`}>
                            {account.uname}
                          </span>
                          {isExpired && <span className='text-amber-500 text-xs'>需重新登录</span>}
                        </div>
                        {isExpired ? (
                          <RefreshCw className='size-4 text-amber-500' aria-hidden='true' />
                        ) : isActive ? (
                          <Check className='size-4 text-primary' aria-hidden='true' />
                        ) : (
                          shortcutKey !== null && (
                            <MenuShortcut>
                              {modifierKey}+{shortcutKey}
                            </MenuShortcut>
                          )
                        )}
                      </div>
                    </MenuItem>
                  )
                })}
              </MenuGroup>
            </>
          )}

          {/* Add account */}
          {onAddAccount && (
            <>
              <MenuSeparator />
              <MenuItem onClick={onAddAccount}>
                <Plus className='size-4' aria-hidden='true' />
                添加账号
              </MenuItem>
            </>
          )}

          {/* Settings */}
          <MenuSeparator />
          <MenuItem onClick={openSettings}>
            <Settings className='size-4' aria-hidden='true' />
            设置
            <MenuShortcut>{modifierKey}+,</MenuShortcut>
          </MenuItem>
          <MenuItem onClick={() => window.open('https://discord.gg/hDc6jfmr7c', '_blank')}>
            <IconBrandDiscordFilled />
            问题反馈
          </MenuItem>
          <MenuItem onClick={openAbout}>
            <Info className='size-4' aria-hidden='true' />
            关于
          </MenuItem>

          {/* Logout and remove */}
          <MenuSeparator />
          {hasMultipleAccounts && onRemoveAccount && userInfo.mid !== undefined && (
            <MenuItem
              onClick={() => onRemoveAccount(userInfo.mid as number)}
              className='text-destructive focus:text-destructive'
            >
              <Trash2 className='size-4' aria-hidden='true' />
              移除当前账号
            </MenuItem>
          )}
          {onLogout && (
            <MenuItem onClick={onLogout}>
              <LogOut className='size-4' aria-hidden='true' />
              退出登录
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>

      {/* Settings Dialog */}
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
                <Separator />
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
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
