import { IconBoltFilled } from '@tabler/icons-react'

import type { UserCacheEntry } from '@/lib/message-utils'

import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'

interface VerifiedBadgeProps {
  official: UserCacheEntry['official']
  /** Size variant for the badge */
  size?: 'sm' | 'md'
  /** Position class overrides (if not using absolute positioning) */
  className?: string
}

/**
 * Verified badge component for displaying user verification status
 * official.type: -1 = none, 0 = personal (yellow/orange badge), 1 = organization (blue badge)
 */
export function VerifiedBadge({ official, size = 'sm', className = '' }: VerifiedBadgeProps) {
  if (!official || official.type < 0) return null

  const isOrganization = official.type === 1
  const sizeClasses = size === 'sm' ? 'size-4' : 'size-5'
  const iconClasses = size === 'sm' ? 'size-2.5' : 'size-3.5'

  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className={`flex cursor-default items-center justify-center rounded-full border border-white dark:border-zinc-900 ${sizeClasses} ${
          isOrganization ? 'bg-sky-500 text-white' : 'bg-yellow-500 text-white'
        } ${className}`}
      >
        <IconBoltFilled className={iconClasses} aria-hidden='true' />
      </TooltipTrigger>
      <TooltipPopup side='right' className='max-w-48'>
        <p className='font-medium'>{isOrganization ? '机构认证' : '个人认证'}</p>
        {official.title && <p className='text-muted-foreground text-xs'>{official.title}</p>}
      </TooltipPopup>
    </Tooltip>
  )
}

/**
 * Helper to check if a user has verification
 */
export function hasVerification(official: UserCacheEntry['official']): boolean {
  return !!official && official.type >= 0
}
