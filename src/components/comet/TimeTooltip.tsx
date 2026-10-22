import type { ReactNode } from 'react'

import {
  CST_TIME_ZONE,
  CST_TIME_ZONE_LABEL,
  formatDateInZone,
  getLocalTimeZoneLabel,
  isInCstTimeZone,
} from '@/utils/formatTimeWithZone'
import { timeFromNowGranular } from '@/utils/timeFromNow'

import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'

interface TimeTooltipProps {
  /** Unix timestamp in seconds (Bilibili convention). */
  timestamp: number
  /** Trigger content. The tooltip popup is rendered next to it on hover/focus. */
  children: ReactNode
  /** Optional className applied to the trigger wrapper. */
  className?: string
  /** Tooltip side, defaults to 'top'. */
  side?: 'top' | 'right' | 'bottom' | 'left'
}

interface ZoneRowProps {
  label: string
  value: string
}

function ZoneRow({ label, value }: ZoneRowProps) {
  return (
    <div className='flex items-center gap-2 text-xs leading-tight whitespace-nowrap'>
      <span className='w-12 rounded bg-secondary px-1 text-center font-mono text-xs text-secondary-foreground'>
        {label}
      </span>
      <span className='font-mono tabular-nums'>{value}</span>
    </div>
  )
}

/**
 * Tooltip showing a granular relative time and the absolute time in the user's
 * local timezone. When the local timezone is not UTC+8, also shows a CST/GMT+8
 * row underneath so Bilibili users abroad can cross-reference timestamps.
 */
export function TimeTooltip({ timestamp, children, className, side = 'top' }: TimeTooltipProps) {
  const timestampMs = timestamp * 1000
  const localLabel = getLocalTimeZoneLabel()
  const localTime = formatDateInZone(timestampMs)
  const showCst = !isInCstTimeZone()
  const cstTime = showCst ? formatDateInZone(timestampMs, CST_TIME_ZONE) : null

  return (
    <Tooltip>
      <TooltipTrigger render={<span />} className={className}>
        {children}
      </TooltipTrigger>
      <TooltipPopup side={side} className='max-w-none'>
        <div className='flex flex-col gap-1.5 py-0.5'>
          <div className='text-xs leading-tight'>{timeFromNowGranular(timestampMs)}</div>
          <ZoneRow label={localLabel} value={localTime} />
          {cstTime && <ZoneRow label={CST_TIME_ZONE_LABEL} value={cstTime} />}
        </div>
      </TooltipPopup>
    </Tooltip>
  )
}
