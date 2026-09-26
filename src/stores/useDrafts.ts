import { create } from 'zustand'

import type { BilibiliSession } from '@/types/bilibili'

// ============================================================================
// Drafts Types
// ============================================================================

interface DraftsState {
  /** Unsent message text, keyed by getDraftKey() */
  drafts: Record<string, string>
  /** Set a draft; empty text removes it */
  setDraft: (key: string, text: string) => void
  /** Remove every draft belonging to an account (logout / account removal) */
  clearAccountDrafts: (accountMid: number) => void
}

// ============================================================================
// Draft Keys
// ============================================================================

/** Drafts are scoped per account, since two logged-in accounts can talk to the same user */
export function getDraftKey(accountMid: number, session: Pick<BilibiliSession, 'session_type' | 'talker_id'>): string {
  return `${accountMid}:${session.session_type}:${session.talker_id}`
}

// ============================================================================
// Drafts Store
// ============================================================================

// Kept in memory only (no persist): drafts are private message text, and localStorage
// would write it to disk unencrypted, unlike credentials which go through safeStorage.
export const useDrafts = create<DraftsState>()(set => ({
  drafts: {},
  setDraft: (key, text) =>
    set(state => ({
      drafts: text
        ? { ...state.drafts, [key]: text }
        : Object.fromEntries(Object.entries(state.drafts).filter(([k]) => k !== key)),
    })),
  clearAccountDrafts: accountMid =>
    set(state => ({
      drafts: Object.fromEntries(Object.entries(state.drafts).filter(([key]) => !key.startsWith(`${accountMid}:`))),
    })),
}))
