import type { ReactNode } from 'react'

import { excerpt, matchRanges, oneLine } from '@/lib/search'
import { cn } from '@/lib/utils'

interface HighlightProps {
  text: string
  /** The text to mark wherever it occurs, ignoring case; without it, nothing is marked */
  query?: string | null
  /** Classes for the marks, merged over their default look */
  className?: string
}

/** `text` with every occurrence of `query` marked, as a search found it */
export function Highlight({ text, query, className }: HighlightProps) {
  const ranges = query ? matchRanges(text, query) : []
  if (ranges.length === 0) return text

  const markClassName = cn(
    'rounded-[0.2em] bg-amber-300/50 box-decoration-clone text-foreground dark:bg-amber-400/30',
    className
  )
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(
      <mark key={start} className={markClassName}>
        {text.slice(start, end)}
      </mark>
    )
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

/**
 * What a one-line row shows of `text`, marked: from a little before the first match of `query` when it sits too far
 * in (see excerpt), the query on one line as the text is; without a query, all of it as it is
 */
export function HighlightExcerpt({ text, query }: Omit<HighlightProps, 'className'>) {
  if (!query) return text
  const needle = oneLine(query)
  return <Highlight text={excerpt(text, needle)} query={needle} />
}
