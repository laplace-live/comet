import type { MessageMatch } from '@/lib/account-cache'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliSession } from '@/types/bilibili'

import { MSG_TYPE } from '@/types/bilibili'

import { chatKey, matchOf } from '@/lib/account-cache'
import { getLastMessagePreview, getSessionName } from '@/lib/message-utils'

// A result's row has room for about a dozen characters beside its sender and time. A match that ends within this many
// shows with the text from its start; one further in shows from a few characters before it, or the row's end would
// cut it off.
const EXCERPT_FITS = 10
const EXCERPT_LEAD = 4

/**
 * The lowercase of `text`, with where each of its characters came from in `text`, when lowercasing changes the text's
 * length (İ's lowercase is two characters); null when it doesn't, and the places line up as they are
 */
function lowercaseOrigins(text: string): { lower: string; from: number[] } | null {
  if (text.toLowerCase().length === text.length) return null
  let lower = ''
  const from: number[] = []
  let at = 0
  for (const char of text) {
    const lowered = char.toLowerCase()
    for (let i = 0; i < lowered.length; i++) from.push(at)
    lower += lowered
    at += char.length
  }
  from.push(text.length)
  return { lower, from }
}

/**
 * Where `query` occurs in `text`, ignoring case as a search does, as [start, end) pairs in order, none overlapping;
 * none when `query` is empty
 */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const needle = query.toLowerCase()
  if (!needle) return []
  const origins = lowercaseOrigins(text)
  const haystack = origins?.lower ?? text.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    const end = at + needle.length
    if (!origins) {
      ranges.push([at, end])
      continue
    }
    // Back to places in `text`: a match ending partway through a character's lowercase takes in all of it
    const { from } = origins
    let after = end
    while (from[after] === from[end - 1]) after++
    ranges.push([from[at], from[after]])
  }
  return ranges
}

/** `text` on one line: each run of whitespace a single space, as a one-line row shows it */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/**
 * What a one-line row shows of `text`: on one line (see oneLine), starting a few characters before the first match of
 * `query`, behind an ellipsis, when the match sits too far in for the row to show it
 */
export function excerpt(text: string, query: string): string {
  const line = oneLine(text).trim()
  const first = matchRanges(line, oneLine(query))[0]
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
 * list shows it, unless recalled, and the messages held of it (`held`, by chat key, newest first: see
 * searchHeldChats). The last message is among the hits unless those held hold it already.
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
  // A recalled message shows as recalled, so what it said doesn't count, as with those held (see findMessages)
  const recalled = !!last?.msg_status || last?.msg_type === MSG_TYPE.REVOKE
  if (last && !recalled && preview.toLowerCase().includes(lower)) {
    const lastHit = matchOf(last, preview)
    if (!hits.some(hit => hit.msgKey === lastHit.msgKey)) {
      hits = [lastHit, ...hits].sort((a, b) => b.timestamp - a.timestamp)
    }
  }

  return byName || hits.length > 0 ? { byName, hits } : null
}
