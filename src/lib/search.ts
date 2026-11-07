import type { MessageMatch } from '@/lib/account-cache'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliSession } from '@/types/bilibili'

import { chatKey, matchOf } from '@/lib/account-cache'
import { getLastMessagePreview, getSessionName } from '@/lib/message-utils'

// A result's row has room for about a dozen characters beside its sender and time. A match that ends within this many
// shows with the text from its start; one further in shows from a few characters before it, or the row's end would
// cut it off.
const EXCERPT_FITS = 10
const EXCERPT_LEAD = 4

/**
 * Where `query` occurs in `text`, ignoring case, as [start, end) pairs in order, none overlapping. None when `query`
 * is empty, or when lowercasing changes the text's length (İ's lowercase is two characters), as the places found in
 * the lowercase text wouldn't line up with it.
 */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const needle = query.toLowerCase()
  const haystack = text.toLowerCase()
  if (!needle || haystack.length !== text.length) return []
  const ranges: Array<[number, number]> = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    ranges.push([at, at + needle.length])
  }
  return ranges
}

/**
 * What a one-line row shows of `text`: its whitespace collapsed into single spaces, starting a few characters before
 * the first match of `query`, behind an ellipsis, when the match sits too far in for the row to show it
 */
export function excerpt(text: string, query: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const first = matchRanges(line, query)[0]
  if (!first || first[1] <= EXCERPT_FITS || first[0] <= EXCERPT_LEAD) return line
  let start = first[0] - EXCERPT_LEAD
  // Not between the halves of a character outside the BMP (an emoji, say)
  const code = line.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start--
  return `…${line.slice(start).trimStart()}`
}

/** What a search found of a chat: whether by its name or UID, and its messages that hold the text, newest first */
export interface ChatFound {
  byName: boolean
  hits: MessageMatch[]
}

/**
 * What a search for `query` finds of a session, null when it finds nothing: its name or UID, its last message as the
 * list shows it, and the messages held of it (`held`, by chat key, newest first: see searchHeldChats). The last message
 * is among the hits unless those held hold it already.
 */
export function findChat(
  session: BilibiliSession,
  query: string,
  userCache: UserCache,
  held: Map<string, MessageMatch[]> | null
): ChatFound | null {
  const lower = query.toLowerCase()
  const byName =
    getSessionName(session, userCache).toLowerCase().includes(lower) || String(session.talker_id).includes(query)

  let hits = held?.get(chatKey(session)) ?? []
  const last = session.last_msg
  const preview = getLastMessagePreview(session)
  if (last && preview.toLowerCase().includes(lower)) {
    const lastHit = matchOf(last, preview)
    if (!hits.some(hit => hit.msgKey === lastHit.msgKey)) {
      hits = [lastHit, ...hits].sort((a, b) => b.timestamp - a.timestamp)
    }
  }

  return byName || hits.length > 0 ? { byName, hits } : null
}
