import dayjs, { extend, locale } from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

import 'dayjs/locale/zh-cn'

extend(relativeTime)

type RelativeTimeProps = {
  locale?: string
}

export function timeFromNow(time: number, { locale: loc = 'zh-CN' }: RelativeTimeProps = {}) {
  locale(loc)
  return dayjs(time).fromNow()
}

/**
 * Granular relative time, e.g. "2 分钟 29 秒前".
 *
 * Unlike `timeFromNow` (which rounds to a single unit like "2 分钟前"), this
 * combines the largest unit with the next smaller one for sub-day deltas, which
 * is helpful inside detailed timestamp tooltips.
 */
export function timeFromNowGranular(time: number, { locale: loc = 'zh-CN' }: RelativeTimeProps = {}): string {
  const diffSec = Math.floor(Date.now() / 1000) - Math.floor(time / 1000)
  const isPast = diffSec >= 0
  const totalSec = Math.abs(diffSec)

  if (loc !== 'zh-CN') {
    locale(loc)
    return dayjs(time).fromNow()
  }

  const suffix = isPast ? '前' : '后'

  if (totalSec < 5) {
    return isPast ? '刚刚' : '即将'
  }
  if (totalSec < 60) {
    return `${totalSec} 秒${suffix}`
  }

  const totalMin = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  if (totalMin < 60) {
    return seconds > 0 ? `${totalMin} 分钟 ${seconds} 秒${suffix}` : `${totalMin} 分钟${suffix}`
  }

  const totalHour = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  if (totalHour < 24) {
    return minutes > 0 ? `${totalHour} 小时 ${minutes} 分钟${suffix}` : `${totalHour} 小时${suffix}`
  }

  const totalDay = Math.floor(totalHour / 24)
  if (totalDay < 30) {
    return `${totalDay} 天${suffix}`
  }

  const totalMonth = Math.floor(totalDay / 30)
  if (totalMonth < 12) {
    return `${totalMonth} 个月${suffix}`
  }

  const totalYear = Math.floor(totalDay / 365)
  return `${totalYear} 年${suffix}`
}
