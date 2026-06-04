import { useCallback, useEffect, useState } from 'react'

import { usePrivateMessages } from '@/hooks/usePrivateMessages'

import { AboutDialog } from '@/components/comet/AboutDialog'
import { AddAccountDialog } from '@/components/comet/AddAccountDialog'
import { LoginScreen } from '@/components/comet/LoginScreen'
import { MessagesPanel } from '@/components/comet/MessagesPanel'
import { SessionList } from '@/components/comet/SessionList'
import { SettingsDialog } from '@/components/comet/SettingsDialog'
import { ToastProvider } from '@/components/ui/toast'

import { useSettings } from '@/stores/useSettings'

export default function App() {
  const {
    sessions,
    selectedSession,
    messages,
    emojiInfoMap,
    loading,
    loadingMore,
    messagesLoading,
    sendingMessage,
    isConnected,
    userCache,
    hasMoreSessions,
    userInfo,
    // Search + jump state
    searchResults,
    searchLoading,
    backfillStatus,
    jumpToIndex,
    highlightedSeqno,
    // Multi-account state
    accounts,
    activeAccountMid,
    isAddingAccount,
    reauthAccount,
    // Actions
    checkLogin,
    logout,
    fetchSessions,
    loadMoreSessions,
    selectSession,
    selectSessionAndJump,
    runSearch,
    clearSearch,
    clearSelectedSession,
    sendMessage,
    sendImageMessage,
    recallMessage,
    toggleDnd,
    toggleSticky,
    // Multi-account actions
    switchAccount,
    removeAccount,
    reorderAccounts,
    startAddingAccount,
    cancelAddingAccount,
    onAccountAdded,
    startReauthAccount,
    cancelReauthAccount,
    onReauthSuccess,
  } = usePrivateMessages()

  const [initialLoading, setInitialLoading] = useState(true)
  const openSettings = useSettings(state => state.openSettings)
  const openAbout = useSettings(state => state.openAbout)
  const fullTextIndexEnabled = useSettings(state => state.fullTextIndexEnabled)

  // Listen for About menu event from main process (always available)
  useEffect(() => {
    const cleanupAbout = window.electronAPI.onOpenAbout(() => {
      openAbout()
    })
    return () => {
      cleanupAbout()
    }
  }, [openAbout])

  // Listen for Settings menu event from main process (only when logged in)
  useEffect(() => {
    if (!isConnected) return

    const cleanupSettings = window.electronAPI.onOpenSettings(() => {
      openSettings()
    })
    return () => {
      cleanupSettings()
    }
  }, [isConnected, openSettings])

  // Global keyboard shortcuts (only when logged in)
  useEffect(() => {
    if (!isConnected) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle shortcuts with Cmd (macOS) or Ctrl (Windows/Linux)
      if (!e.metaKey && !e.ctrlKey) return

      // Cmd+, (macOS) or Ctrl+, (Windows/Linux) to open settings
      // Check both e.key and e.code for better cross-platform compatibility
      const isCommaKey = e.key === ',' || e.code === 'Comma'
      if (isCommaKey) {
        e.preventDefault()
        openSettings()
        return
      }

      // Cmd/Ctrl + 1-9 to switch to accounts 1-9, Cmd/Ctrl + 0 for account 10
      const digitMatch = e.code.match(/^Digit([0-9])$/)
      if (digitMatch && accounts.length > 1) {
        const digit = Number.parseInt(digitMatch[1], 10)
        // 1-9 maps to index 0-8, 0 maps to index 9
        const accountIndex = digit === 0 ? 9 : digit - 1

        if (accountIndex < accounts.length) {
          const targetAccount = accounts[accountIndex]
          // Only switch if not already active and not expired
          if (targetAccount.mid !== activeAccountMid && !targetAccount.isExpired) {
            e.preventDefault()
            switchAccount(targetAccount.mid)
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isConnected, openSettings, accounts, activeAccountMid, switchAccount])

  // Check login on mount
  useEffect(() => {
    const init = async () => {
      await checkLogin()
      setInitialLoading(false)
    }
    init()
  }, [checkLogin])

  // Fetch sessions when connected
  useEffect(() => {
    if (isConnected && !initialLoading) {
      fetchSessions()
    }
  }, [isConnected, initialLoading, fetchSessions])

  const handleLoginSuccess = useCallback(async () => {
    await checkLogin()
    await fetchSessions()
  }, [checkLogin, fetchSessions])

  // Resolve a search hit's (talkerId, sessionType) to a session object. Falls back
  // to a synthetic minimal session for conversations outside the loaded window.
  const resolveSession = useCallback(
    (talkerId: number, sessionType: number): import('@/types/bilibili').BilibiliSession => {
      const existing = sessions.find(s => s.talker_id === talkerId && s.session_type === sessionType)
      if (existing) return existing
      return {
        talker_id: talkerId,
        session_type: sessionType,
        unread_count: 0,
        last_msg: null,
        session_ts: 0,
        max_seqno: 0,
        is_dnd: 0,
        top_ts: 0,
        is_follow: 0,
      } as import('@/types/bilibili').BilibiliSession
    },
    [sessions]
  )

  const handleSearch = useCallback(
    (query: string, scope: 'current' | 'all') => {
      runSearch({
        query,
        scope,
        talkerId: scope === 'current' ? (selectedSession?.talker_id ?? undefined) : undefined,
        sessionType: scope === 'current' ? (selectedSession?.session_type ?? undefined) : undefined,
        limit: 50,
        offset: 0,
      })
    },
    [runSearch, selectedSession]
  )

  const handleConversationHitClick = useCallback(
    (hit: { talkerId: number; sessionType: number }) => {
      selectSession(resolveSession(hit.talkerId, hit.sessionType))
    },
    [selectSession, resolveSession]
  )

  const handleMessageHitClick = useCallback(
    (hit: { talkerId: number; sessionType: number; msgSeqno: string }) => {
      selectSessionAndJump(resolveSession(hit.talkerId, hit.sessionType), Number(hit.msgSeqno))
    },
    [selectSessionAndJump, resolveSession]
  )

  const handleLoadMoreMessageHits = useCallback(
    (query: string, scope: 'current' | 'all', offset: number) => {
      runSearch({
        query,
        scope,
        talkerId: scope === 'current' ? (selectedSession?.talker_id ?? undefined) : undefined,
        sessionType: scope === 'current' ? (selectedSession?.session_type ?? undefined) : undefined,
        limit: 50,
        offset,
      })
    },
    [runSearch, selectedSession]
  )

  // Show loading state while checking initial login
  if (initialLoading) {
    return (
      <div className='flex h-screen flex-col bg-linear-to-br from-slate-50 via-zinc-50 to-stone-100 font-sans dark:from-zinc-950 dark:via-neutral-950 dark:to-stone-950'>
        <div className='flex flex-1 items-center justify-center'>
          <div className='size-8 animate-spin rounded-full border-4 border-pink-500 border-t-transparent' />
        </div>
      </div>
    )
  }

  return (
    <ToastProvider>
      {/* About Dialog - always available, even on login screen */}
      <AboutDialog />

      <div className='flex h-screen bg-linear-to-br from-slate-50 via-zinc-50 to-stone-100 font-sans dark:from-zinc-950 dark:via-neutral-950 dark:to-stone-950'>
        {!isConnected ? (
          <LoginScreen onLoginSuccess={handleLoginSuccess} />
        ) : (
          <>
            <SessionList
              sessions={sessions}
              selectedSession={selectedSession}
              loading={loading}
              loadingMore={loadingMore}
              hasMoreSessions={hasMoreSessions}
              isHidden={!!selectedSession}
              isConnected={isConnected}
              userCache={userCache}
              userInfo={userInfo}
              accounts={accounts}
              activeAccountMid={activeAccountMid}
              onSessionClick={selectSession}
              onLoadMore={loadMoreSessions}
              onRefresh={fetchSessions}
              onLogout={logout}
              onSwitchAccount={switchAccount}
              onAddAccount={startAddingAccount}
              onRemoveAccount={removeAccount}
              onReauthAccount={startReauthAccount}
              searchResults={searchResults}
              searchLoading={searchLoading}
              backfillStatus={backfillStatus}
              indexEnabled={fullTextIndexEnabled}
              onSearch={handleSearch}
              onClearSearch={clearSearch}
              onConversationHitClick={handleConversationHitClick}
              onMessageHitClick={handleMessageHitClick}
              onLoadMoreMessageHits={handleLoadMoreMessageHits}
              onOpenSettings={openSettings}
            />

            {/* Settings Dialog */}
            <SettingsDialog
              accounts={accounts}
              activeAccountMid={activeAccountMid}
              onReorderAccounts={reorderAccounts}
              backfillStatus={backfillStatus}
            />

            <MessagesPanel
              selectedSession={selectedSession}
              messages={messages}
              emojiInfoMap={emojiInfoMap}
              messagesLoading={messagesLoading}
              sendingMessage={sendingMessage}
              isVisible={!!selectedSession}
              userCache={userCache}
              userInfo={userInfo}
              onBack={clearSelectedSession}
              onSendMessage={sendMessage}
              onSendImage={sendImageMessage}
              onRecall={recallMessage}
              onToggleDnd={toggleDnd}
              onToggleSticky={toggleSticky}
              jumpToIndex={jumpToIndex}
              highlightedSeqno={highlightedSeqno}
            />

            {/* Add Account / Re-auth Dialog */}
            <AddAccountDialog
              open={isAddingAccount}
              onOpenChange={open => {
                if (!open) {
                  if (reauthAccount) {
                    cancelReauthAccount()
                  } else {
                    cancelAddingAccount()
                  }
                }
              }}
              onSuccess={reauthAccount ? onReauthSuccess : onAccountAdded}
              reauthAccount={reauthAccount}
            />
          </>
        )}
      </div>
    </ToastProvider>
  )
}
