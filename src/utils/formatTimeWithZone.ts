/**
 * IANA timezone string for China Standard Time (UTC+8).
 *
 * Bilibili and most of its users live in this timezone, so we always show this
 * row in the timestamp tooltip when the user's local timezone is not UTC+8.
 */
export const CST_TIME_ZONE = 'Asia/Shanghai'

/**
 * Display label for the CST row in the tooltip.
 *
 * Uses the GMT+8 offset rather than "CST" because it's unambiguous (the
 * abbreviation "CST" also collides with US Central Standard Time).
 */
export const CST_TIME_ZONE_LABEL = 'GMT+8'

/**
 * Minutes offset from UTC for UTC+8 (CST). `Date.prototype.getTimezoneOffset`
 * returns the inverted offset, so UTC+8 is `-480`.
 */
const CST_OFFSET_MINUTES = -480

/**
 * Returns true when the user's local timezone is currently equivalent to UTC+8.
 *
 * Includes Asia/Shanghai, Asia/Hong_Kong, Asia/Taipei, Asia/Singapore, etc. -
 * any zone that resolves to a +08:00 offset right now (DST aware).
 */
export function isInCstTimeZone(referenceDate: Date = new Date()): boolean {
  return referenceDate.getTimezoneOffset() === CST_OFFSET_MINUTES
}

/**
 * Best-effort short label for the local timezone, e.g. "PDT", "EST", "GMT+8".
 *
 * Falls back to "Local" if the runtime can't produce a `timeZoneName` part.
 */
export function getLocalTimeZoneLabel(referenceDate: Date = new Date()): string {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      timeZoneName: 'short',
    })
    const parts = dtf.formatToParts(referenceDate)
    const tzPart = parts.find(p => p.type === 'timeZoneName')
    return tzPart?.value || 'Local'
  } catch {
    return 'Local'
  }
}

function formatZhParts(timestampMs: number, options: Intl.DateTimeFormatOptions) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...options,
  }).formatToParts(new Date(timestampMs))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value || ''
  return { datePart: `${get('year')}/${get('month')}/${get('day')}`, get }
}

/**
 * Format a date in a specific timezone as `YYYY/MM/DD周X HH:mm:ss`.
 *
 * Example: `2026/05/01周五 23:45:25`. Constructed from `formatToParts` so the
 * layout stays stable across runtimes that disagree on the default zh-CN
 * `toLocaleString` ordering.
 */
export function formatDateInZone(timestampMs: number, timeZone?: string): string {
  const { datePart, get } = formatZhParts(timestampMs, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
  })

  return `${datePart}${get('weekday')}  ${get('hour')}:${get('minute')}:${get('second')}`
}

/**
 * Format a date in a specific timezone as `YYYY/MM/DD`.
 */
export function formatDateShort(timestampMs: number, timeZone?: string): string {
  return formatZhParts(timestampMs, { timeZone }).datePart
}
