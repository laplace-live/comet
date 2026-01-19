import { useCallback, useEffect, useState } from 'react'

import { usePrivateMessages } from '@/hooks/usePrivateMessages'

import { AddAccountDialog, LoginScreen, MessagesPanel, SessionList } from '@/components/comet'
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
    clearSelectedSession,
    sendMessage,
    sendImageMessage,
    recallMessage,
    // Multi-account actions
    switchAccount,
    removeAccount,
    startAddingAccount,
    cancelAddingAccount,
    onAccountAdded,
    startReauthAccount,
    cancelReauthAccount,
    onReauthSuccess,
  } = usePrivateMessages()

  const [initialLoading, setInitialLoading] = useState(true)
  const toggleSettings = useSettings(state => state.toggleSettings)

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
        toggleSettings()
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
  }, [isConnected, toggleSettings, accounts, activeAccountMid, switchAccount])

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
    fetchSessions()
  }, [checkLogin, fetchSessions])

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
