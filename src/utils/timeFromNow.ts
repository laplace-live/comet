import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime' // import plugin

import 'dayjs/locale/zh-cn'

type RelativeTimeProps = {
  locale?: string
}

export function timeFromNow(time: number, { locale = 'zh-CN' }: RelativeTimeProps = {}) {
  dayjs.locale(locale)
  dayjs.extend(relativeTime)
  return dayjs(time).fromNow()
}
