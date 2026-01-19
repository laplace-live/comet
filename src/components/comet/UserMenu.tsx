import { AlertTriangle, Check, LogOut, Plus, RefreshCw, Trash2 } from 'lucide-react'

import type { CheckLoginResult, StoredAccountInfo } from '@/types/electron'

import { enforceHttps } from '@/utils/enforceHttps'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'

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
}: UserMenuProps) {
  if (!userInfo?.uname) return null

  const hasMultipleAccounts = accounts.length > 1

  return (
    <div className='flex-none border-border/50 border-t p-3'>
      <Menu>
        <MenuTrigger className='flex w-full cursor-pointer items-center gap-3 rounded-lg p-2 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring'>
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
                <MenuGroupLabel>切换账号</MenuGroupLabel>
                {accounts.map(account => {
                  const isActive = account.mid === activeAccountMid
                  const isExpired = account.isExpired

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
                      <div className='flex w-full items-center gap-3'>
                        <div className='relative'>
                          <Avatar className={`size-6 ${isExpired ? 'opacity-50' : ''}`}>
                            {account.face && <AvatarImage src={enforceHttps(account.face)} alt={account.uname} />}
                            <AvatarFallback className='text-xs'>{account.uname.charAt(0)}</AvatarFallback>
                          </Avatar>
                          {isExpired && (
                            <div className='absolute -right-0.5 -bottom-0.5 rounded-full bg-background p-0.5'>
                              <AlertTriangle className='size-2.5 text-amber-500' />
                            </div>
                          )}
                        </div>
                        <div className='flex flex-1 flex-col items-start overflow-hidden'>
                          <span className={`w-full truncate text-sm ${isExpired ? 'text-muted-foreground' : ''}`}>
                            {account.uname}
                          </span>
                          {isExpired && <span className='text-amber-500 text-xs'>需重新登录</span>}
                        </div>
                        {isExpired ? (
                          <RefreshCw className='size-4 text-amber-500' />
                        ) : (
                          isActive && <Check className='size-4 text-primary' />
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
                <Plus className='size-4' />
                添加账号
              </MenuItem>
            </>
          )}

          {/* Logout and remove */}
          <MenuSeparator />
          {hasMultipleAccounts && onRemoveAccount && userInfo.mid !== undefined && (
            <MenuItem
              onClick={() => onRemoveAccount(userInfo.mid as number)}
              className='text-destructive focus:text-destructive'
            >
              <Trash2 className='size-4' />
              移除当前账号
            </MenuItem>
          )}
          {onLogout && (
            <MenuItem onClick={onLogout}>
              <LogOut className='size-4' />
              退出登录
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </div>
  )
}
