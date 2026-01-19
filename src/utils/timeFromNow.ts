import dayjs, { extend, locale } from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

import 'dayjs/locale/zh-cn'

type RelativeTimeProps = {
  locale?: string
}

export function timeFromNow(time: number, { locale: loc = 'zh-CN' }: RelativeTimeProps = {}) {
  locale(loc)
  extend(relativeTime)
  return dayjs(time).fromNow()
}
